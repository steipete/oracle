// Regression suite for oracle-72u: `oracle remote attach --host …`
// MUST probe the explicit host even when ORACLE_REMOTE_HOST is set to
// a different (stale) value. The bug was a precedence inversion in
// resolveRemoteServiceConfig — env > cli > config > default — which
// silently overrode the explicit attach target.
//
// The fix is additive: a `preferCli: true` option on the resolver
// flips precedence to `cli > env > config > default`. Existing
// callers (e.g. bridge doctor) keep the historical sticky-env
// behaviour; attach opts in.
//
// These tests exercise the REAL resolver (no mocks) plus an end-to-end
// attach run with stubbed health probes — proving the resolved host
// flows through to checkTcpConnection / checkRemoteHealth.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveRemoteServiceConfig } from "../../src/remote/remoteServiceConfig.js";

const ENV_KEYS = ["ORACLE_REMOTE_HOST", "ORACLE_REMOTE_TOKEN", "ORACLE_REMOTE_BROWSER"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = snapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("resolveRemoteServiceConfig precedence (oracle-72u)", () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv(original);
  });

  describe("default precedence — env > cli > config > default (historical)", () => {
    it("env-host wins over cli-host when preferCli is omitted", () => {
      const resolved = resolveRemoteServiceConfig({
        cliHost: "explicit.example.com:9222",
        cliToken: "tok",
        env: { ORACLE_REMOTE_HOST: "stale.example.com:9222" },
      });
      expect(resolved.host).toBe("stale.example.com:9222");
      expect(resolved.sources.host).toBe("env");
    });

    it("env-token wins over cli-token", () => {
      const resolved = resolveRemoteServiceConfig({
        cliHost: "h.example.com:9222",
        cliToken: "cli-token",
        env: { ORACLE_REMOTE_HOST: "h.example.com:9222", ORACLE_REMOTE_TOKEN: "env-token" },
      });
      expect(resolved.token).toBe("env-token");
      expect(resolved.sources.token).toBe("env");
    });
  });

  describe("preferCli=true — cli > env > config > default (oracle-72u fix)", () => {
    it("cli-host wins over a different ORACLE_REMOTE_HOST", () => {
      const resolved = resolveRemoteServiceConfig({
        cliHost: "explicit.example.com:9222",
        cliToken: "tok",
        env: { ORACLE_REMOTE_HOST: "stale.example.com:9222" },
        preferCli: true,
      });
      expect(resolved.host).toBe("explicit.example.com:9222");
      expect(resolved.sources.host).toBe("cli");
    });

    it("cli-token wins over ORACLE_REMOTE_TOKEN", () => {
      const resolved = resolveRemoteServiceConfig({
        cliHost: "host.example.com:9222",
        cliToken: "cli-token",
        env: { ORACLE_REMOTE_HOST: "host.example.com:9222", ORACLE_REMOTE_TOKEN: "env-token" },
        preferCli: true,
      });
      expect(resolved.token).toBe("cli-token");
      expect(resolved.sources.token).toBe("cli");
    });

    it("falls back to env when cli value is absent", () => {
      const resolved = resolveRemoteServiceConfig({
        cliHost: undefined,
        cliToken: undefined,
        env: { ORACLE_REMOTE_HOST: "env.example.com:9222", ORACLE_REMOTE_TOKEN: "env-tok" },
        preferCli: true,
      });
      expect(resolved.host).toBe("env.example.com:9222");
      expect(resolved.sources.host).toBe("env");
    });

    it("falls back to config.browser when both cli and env are absent", () => {
      const resolved = resolveRemoteServiceConfig({
        cliHost: undefined,
        cliToken: undefined,
        env: {},
        userConfig: {
          browser: { remoteHost: "config.example.com:9222", remoteToken: "config-tok" },
        } as Parameters<typeof resolveRemoteServiceConfig>[0]["userConfig"],
        preferCli: true,
      });
      expect(resolved.host).toBe("config.example.com:9222");
      expect(resolved.sources.host).toBe("config.browser");
    });

    it("cli-mode wins over ORACLE_REMOTE_BROWSER", () => {
      const resolved = resolveRemoteServiceConfig({
        cliHost: "h.example.com:9222",
        cliToken: "tok",
        cliMode: "required",
        env: { ORACLE_REMOTE_HOST: "h.example.com:9222", ORACLE_REMOTE_BROWSER: "off" },
        preferCli: true,
      });
      expect(resolved.mode).toBe("required");
      expect(resolved.sources.mode).toBe("cli");
    });

    it("hostHash reflects the actually-resolved host (the cli value), not the env one", () => {
      const explicit = resolveRemoteServiceConfig({
        cliHost: "explicit.example.com:9222",
        cliToken: "tok",
        env: { ORACLE_REMOTE_HOST: "stale.example.com:9222" },
        preferCli: true,
      });
      const baseline = resolveRemoteServiceConfig({
        cliHost: "explicit.example.com:9222",
        cliToken: "tok",
        env: {},
        preferCli: true,
      });
      // Same host → same hash, regardless of what's in the env.
      expect(explicit.hostHash).toBe(baseline.hostHash);
    });
  });
});

// ─── End-to-end: attach probes the explicit host ───────────────────────────
//
// We stub the network probes at the module level (vi.mock hoisting)
// so the assertion can prove that resolveRemoteServiceConfig's
// preferCli wiring flows into the actual TCP / health calls. The
// previous test suite mocked resolveRemoteServiceConfig itself and
// therefore could never have caught the precedence bug.

const checkTcpConnection = vi.fn(async (_host: string, _timeoutMs?: number) => ({ ok: true }));
const checkRemoteHealth = vi.fn(
  async (_args: { host: string; token?: string; timeoutMs?: number }) => ({
    ok: true,
    version: "1.2.3",
    uptimeSeconds: 42,
    authProfileIdHash: "auth-hash",
    providerLocks: [] as string[],
  }),
);
vi.mock("../../src/remote/health.js", () => ({
  checkTcpConnection: (...args: unknown[]) =>
    checkTcpConnection(...(args as [string, number | undefined])),
  checkRemoteHealth: (...args: unknown[]) =>
    checkRemoteHealth(...(args as [{ host: string; token?: string; timeoutMs?: number }])),
}));

describe("runRemoteAttach end-to-end (oracle-72u)", () => {
  let original: Record<string, string | undefined>;
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    original = snapshotEnv();
    originalConsoleLog = console.log;
    console.log = () => {};
    checkTcpConnection.mockClear();
    checkRemoteHealth.mockClear();
  });
  afterEach(() => {
    restoreEnv(original);
    console.log = originalConsoleLog;
  });

  it("probes the --host value when ORACLE_REMOTE_HOST is set to a different host", async () => {
    process.env.ORACLE_REMOTE_HOST = "stale.example.com:9222";
    process.env.ORACLE_REMOTE_TOKEN = "stale-token";

    // Dynamic import after vi.mock has set up — ensures attach picks
    // up the stubbed health module.
    const { runRemoteAttach } = await import("../../src/cli/remote/attach.js");

    await runRemoteAttach({
      host: "explicit.example.com:9222",
      tokenEnv: "ORACLE_REMOTE_TOKEN",
      json: true,
    });

    expect(checkTcpConnection).toHaveBeenCalledTimes(1);
    expect(checkTcpConnection.mock.calls[0][0]).toBe("explicit.example.com:9222");

    expect(checkRemoteHealth).toHaveBeenCalledTimes(1);
    expect(checkRemoteHealth.mock.calls[0][0].host).toBe("explicit.example.com:9222");
  });

  it("token comes from --token-env, not from cli argv", async () => {
    process.env.ORACLE_REMOTE_HOST = "stale.example.com:9222";
    process.env.MY_PRIVATE_TOKEN = "from-token-env";

    const { runRemoteAttach } = await import("../../src/cli/remote/attach.js");

    await runRemoteAttach({
      host: "explicit.example.com:9222",
      tokenEnv: "MY_PRIVATE_TOKEN",
      json: true,
    });

    expect(checkRemoteHealth.mock.calls[0][0].token).toBe("from-token-env");
    expect(checkRemoteHealth.mock.calls[0][0].host).toBe("explicit.example.com:9222");

    delete process.env.MY_PRIVATE_TOKEN;
  });
});
