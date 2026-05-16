import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

vi.mock("../../src/browser/reattach.js", () => ({ resumeBrowserSession: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser reattach end-to-end (simulated)", () => {
  test("marks session completed after reconnection", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({ answerText: "ok text", answerMarkdown: "ok markdown" });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
          },
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
      const runs = updated?.models ?? [];
      expect(runs.some((r) => r.status === "completed")).toBe(true);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("does not reattach an errored chrome-disconnected session without a conversation URL", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({ answerText: "should not happen", answerMarkdown: "nope" });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "error",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/",
          },
        },
        response: { status: "error", incompleteReason: "chrome-disconnected" },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches a live chrome-disconnected session with a stale cached URL", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({ answerText: "ok text", answerMarkdown: "ok markdown" });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromeProfileRoot: path.join(tmpHome, "chrome-profile"),
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/",
            promptSubmitted: true,
          },
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).toHaveBeenCalledTimes(1);
      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches completed Deep Research sessions that only captured a tool placeholder", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({
        answerText: "# Deep report\n\nRecovered report body.",
        answerMarkdown: "# Deep report\n\nRecovered report body.",
      });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Deep research prompt",
          model: "gpt-5.5-pro",
          mode: "browser",
          browserConfig: { researchMode: "deep" },
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.5-pro", {
        status: "completed",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        mode: "browser",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
        browser: {
          config: { researchMode: "deep" },
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/deep",
          },
        },
        response: { status: "completed" },
      });
      const paths = await sessionStore.getPaths(sessionMeta.id);
      await fs.writeFile(paths.log, "Answer:\nCalled tool\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      const log = await sessionStore.readLog(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(log).toContain("Recovered report body");
      expect(log).not.toContain("Called tool");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches completed Deep Research placeholders from a project URL", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({
        answerText: "# Deep report\n\nRecovered report body.",
        answerMarkdown: "# Deep report\n\nRecovered report body.",
      });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Deep research prompt",
          model: "gpt-5.5-pro",
          mode: "browser",
          browserConfig: { researchMode: "deep" },
        },
        "/repo",
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        mode: "browser",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
        browser: {
          config: { researchMode: "deep" },
          runtime: {
            tabUrl: "https://chatgpt.com/g/g-p-demo/project",
          },
        },
        response: { status: "completed" },
      });
      const paths = await sessionStore.getPaths(sessionMeta.id);
      await fs.writeFile(paths.log, "Answer:\nCalled tool\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches when controller pid is gone even without incompleteReason", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({ answerText: "ok text", answerMarkdown: "ok markdown" });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
            controllerPid: undefined,
          },
        },
      });

      const deadController = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(deadController, "exit");
      await sessionStore.updateSession(sessionMeta.id, {
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
            controllerPid: deadController.pid ?? undefined,
          },
        },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches after CLI termination when Chrome is left running", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({ answerText: "ok text", answerMarkdown: "ok markdown" });

      const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: { config: {} },
        response: { status: "running" },
      });

      const deadController = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(deadController, "exit");
      const deadControllerPid = deadController.pid ?? undefined;

      const emitRuntimeHint = async () => {
        await sessionStore.updateSession(sessionMeta.id, {
          browser: {
            config: {},
            runtime: {
              chromePort: 51559,
              chromeHost: "127.0.0.1",
              chromeTargetId: "t-1",
              tabUrl: "https://chatgpt.com/c/demo",
              controllerPid: deadControllerPid,
            },
          },
        });
      };

      const chrome = {
        pid: 4242,
        port: 51559,
        kill: vi.fn().mockResolvedValue(undefined),
      };
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const removeHooks = registerTerminationHooks(
        chrome as unknown as import("chrome-launcher").LaunchedChrome,
        path.join(tmpHome, "chrome-profile"),
        false,
        () => {},
        { isInFlight: () => true, emitRuntimeHint },
      );

      process.emit("SIGINT");
      for (let i = 0; i < 20; i += 1) {
        const refreshed = await sessionStore.readSession(sessionMeta.id);
        if (refreshed?.browser?.runtime?.chromePort) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      removeHooks();
      exitSpy.mockRestore();

      expect(chrome.kill).not.toHaveBeenCalled();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });
      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);
});
