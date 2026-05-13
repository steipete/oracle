import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runBridgeDoctor } from "../../../src/cli/bridge/doctor.js";

const { loadUserConfig } = vi.hoisted(() => ({
  loadUserConfig: vi.fn(async () => ({
    config: {},
    path: "/mock/config.json",
    loaded: true,
  })),
}));

const { resolveRemoteServiceConfig } = vi.hoisted(() => ({
  resolveRemoteServiceConfig: vi.fn(() => ({
    host: "remote.host:9222",
    token: "mock-token",
    mode: "preferred",
    hostHash: "mock-hash",
    redactedToken: "***",
    sources: { host: "env", token: "env", mode: "default" },
  })),
}));

const { checkTcpConnection, checkRemoteHealth } = vi.hoisted(() => {
  // Hoisted mocks need explicit return types — vi.fn infers from the
  // default implementation, which would narrow to the success shape and
  // reject mockResolvedValueOnce calls that use the failure variants.
  type TcpResult = { ok: boolean; error?: string };
  type HealthResult = {
    ok: boolean;
    statusCode?: number;
    error?: string;
    version?: string;
    uptimeSeconds?: number;
    authProfileIdHash?: string;
    providerLocks?: string[];
  };
  return {
    checkTcpConnection: vi.fn<(host: string, timeoutMs?: number) => Promise<TcpResult>>(
      async () => ({ ok: true }),
    ),
    checkRemoteHealth: vi.fn<
      (args: { host: string; token?: string; timeoutMs?: number }) => Promise<HealthResult>
    >(async () => ({
      ok: true,
      version: "1.2.3",
      uptimeSeconds: 100,
      authProfileIdHash: "auth-hash-123",
      providerLocks: ["chatgpt", "gemini"],
    })),
  };
});

vi.mock("../../../src/config.js", () => ({ loadUserConfig }));
vi.mock("../../../src/remote/remoteServiceConfig.js", () => ({ resolveRemoteServiceConfig }));
vi.mock("../../../src/remote/health.js", () => ({ checkTcpConnection, checkRemoteHealth }));
vi.mock("../../../src/browser/detect.js", () => ({
  detectChromeBinary: async () => ({ path: null }),
  detectChromeCookieDb: async () => null,
}));

describe("runBridgeDoctor --json", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  // process.exitCode widened in newer @types/node to allow string | null;
  // capture it with the actual property type rather than narrowing.
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("outputs healthy endpoint JSON", async () => {
    await runBridgeDoctor({ json: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    
    expect(jsonOutput._schema).toBe("remote_browser_endpoint.v1");
    expect(jsonOutput.status).toBe("healthy");
    expect(jsonOutput.version).toBe("1.2.3");
    expect(jsonOutput.auth_profile_id_hash).toBe("auth-hash-123");
    expect(jsonOutput.provider_locks).toEqual(["chatgpt", "gemini"]);
    expect(jsonOutput.mode).toBe("preferred");
    expect(jsonOutput.no_plaintext_secrets).toBe(true);
    expect(jsonOutput.token_env).toBeNull(); // process.env.ORACLE_REMOTE_TOKEN is not set in this test
    expect(process.exitCode).toBe(0);
  });

  it("outputs missing_token JSON when token is omitted", async () => {
    resolveRemoteServiceConfig.mockReturnValueOnce({
      host: "remote.host:9222",
      token: undefined,
      mode: "preferred",
      hostHash: "mock-hash",
      redactedToken: undefined,
      sources: { host: "env", token: "unset", mode: "default" },
    } as any);

    await runBridgeDoctor({ json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe("missing_token");
    expect(process.exitCode).toBe(1);
  });

  it("outputs unreachable JSON when TCP fails", async () => {
    checkTcpConnection.mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" });

    await runBridgeDoctor({ json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe("unreachable");
    expect(jsonOutput.error).toBe("ECONNREFUSED");
    expect(process.exitCode).toBe(1);
  });

  it("outputs auth_failed JSON when /health fails", async () => {
    checkRemoteHealth.mockResolvedValueOnce({ ok: false, statusCode: 401, error: "Unauthorized" });

    await runBridgeDoctor({ json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe("auth_failed");
    expect(jsonOutput.error).toBe("HTTP 401 (Unauthorized)");
    expect(process.exitCode).toBe(1);
  });
});
