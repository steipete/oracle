import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  launchChrome,
  connectWithNewTab,
  closeTab,
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
} = vi.hoisted(() => ({
  launchChrome: vi.fn(),
  connectWithNewTab: vi.fn(),
  closeTab: vi.fn(async () => undefined),
  readDevToolsPort: vi.fn(async () => null),
  writeDevToolsActivePort: vi.fn(async () => undefined),
  writeChromePid: vi.fn(async () => undefined),
  cleanupStaleProfileState: vi.fn(async () => undefined),
  verifyDevToolsReachable: vi.fn(async () => ({ ok: false, error: "unreachable" })),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  launchChrome,
  connectWithNewTab,
  closeTab,
}));

vi.mock("../../src/browser/profileState.js", () => ({
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
}));

describe("openGeminiBrowserSession", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    launchChrome.mockResolvedValue({
      port: 9222,
      pid: 12345,
      kill: vi.fn(),
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-1",
      client: {
        close: vi.fn(async () => undefined),
      },
    });
    readDevToolsPort.mockResolvedValue(null);
    verifyDevToolsReachable.mockResolvedValue({ ok: false, error: "unreachable" });
    delete process.env.ORACLE_BROWSER_PROFILE_DIR;
  });

  afterEach(async () => {
    delete process.env.ORACLE_BROWSER_PROFILE_DIR;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("prefers explicit manualLoginProfileDir over ORACLE_BROWSER_PROFILE_DIR", async () => {
    const explicitDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-explicit-"));
    const envDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-env-"));
    tempDirs.push(explicitDir, envDir);
    process.env.ORACLE_BROWSER_PROFILE_DIR = envDir;

    const { openGeminiBrowserSession } = await import(
      "../../src/gemini-web/browserSessionManager.js"
    );

    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: explicitDir },
      keepBrowserDefault: false,
      purpose: "test explicit profile",
      log: () => {},
    });

    expect(session.profileDir).toBe(explicitDir);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        manualLogin: true,
        manualLoginProfileDir: explicitDir,
      }),
      explicitDir,
      expect.any(Function),
    );

    await session.close();
  });

  it("uses ORACLE_BROWSER_PROFILE_DIR when manualLoginProfileDir is not set", async () => {
    const envDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-env-"));
    tempDirs.push(envDir);
    process.env.ORACLE_BROWSER_PROFILE_DIR = envDir;

    const { openGeminiBrowserSession } = await import(
      "../../src/gemini-web/browserSessionManager.js"
    );

    const session = await openGeminiBrowserSession({
      browserConfig: {},
      keepBrowserDefault: false,
      purpose: "test env profile",
      log: () => {},
    });

    expect(session.profileDir).toBe(envDir);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        manualLogin: true,
        manualLoginProfileDir: envDir,
      }),
      envDir,
      expect.any(Function),
    );

    await session.close();
  });

  it("ignores blank ORACLE_BROWSER_PROFILE_DIR values", async () => {
    process.env.ORACLE_BROWSER_PROFILE_DIR = "   ";

    const { openGeminiBrowserSession } = await import(
      "../../src/gemini-web/browserSessionManager.js"
    );

    const session = await openGeminiBrowserSession({
      browserConfig: {},
      keepBrowserDefault: false,
      purpose: "test blank env profile",
      log: () => {},
    });

    const expectedDefault = path.join(os.homedir(), ".oracle", "browser-profile");
    expect(session.profileDir).toBe(expectedDefault);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        manualLogin: true,
      }),
      expectedDefault,
      expect.any(Function),
    );

    await session.close();
  });
});
