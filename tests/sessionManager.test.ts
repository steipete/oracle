import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");
type SessionMetadata = Awaited<ReturnType<SessionModule["initializeSession"]>>;

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-session-tests-"));
  setOracleHomeDirOverrideForTest(oracleHomeDir);
  sessionModule = await import("../src/sessionManager.ts");
  await sessionModule.ensureSessionStorage();
});

beforeEach(async () => {
  await rm(sessionModule.getSessionsDir(), { recursive: true, force: true });
  await sessionModule.ensureSessionStorage();
});

afterAll(async () => {
  await rm(oracleHomeDir, { recursive: true, force: true });
  setOracleHomeDirOverrideForTest(null);
});

describe("session storage setup", () => {
  test("ensureSessionStorage creates the sessions directory", async () => {
    await rm(sessionModule.getSessionsDir(), { recursive: true, force: true });
    await sessionModule.ensureSessionStorage();
    const stats = await stat(sessionModule.getSessionsDir());
    expect(stats.isDirectory()).toBe(true);
  });

  test("ensureSessionStorage hardens existing artifacts without following symlinks", async () => {
    if (process.platform === "win32") {
      return;
    }
    const migrationHome = await mkdtemp(path.join(os.tmpdir(), "oracle-session-migration-"));
    try {
      const sessionsDir = path.join(migrationHome, "sessions");
      const sessionDir = path.join(sessionsDir, "existing-session");
      const modelsDir = path.join(sessionDir, "models");
      const nestedArtifactsDir = path.join(sessionDir, "artifacts", "nested");
      const outsideDir = path.join(migrationHome, "outside-dir");
      const outsideFile = path.join(migrationHome, "outside.txt");

      await mkdir(modelsDir, { recursive: true });
      await mkdir(nestedArtifactsDir, { recursive: true });
      await mkdir(outsideDir);
      await writeFile(path.join(sessionDir, "output.log"), "sensitive transcript", "utf8");
      await writeFile(path.join(modelsDir, "gpt.json"), "{}", "utf8");
      await writeFile(path.join(nestedArtifactsDir, "report.md"), "sensitive report", "utf8");
      await writeFile(outsideFile, "outside", "utf8");
      await symlink(outsideDir, path.join(sessionDir, "linked-dir"));
      await symlink(outsideFile, path.join(sessionDir, "linked-file"));

      for (const dir of [
        sessionsDir,
        sessionDir,
        modelsDir,
        path.dirname(nestedArtifactsDir),
        nestedArtifactsDir,
        outsideDir,
      ]) {
        await chmod(dir, 0o755);
      }
      for (const file of [
        path.join(sessionDir, "output.log"),
        path.join(modelsDir, "gpt.json"),
        path.join(nestedArtifactsDir, "report.md"),
        outsideFile,
      ]) {
        await chmod(file, 0o644);
      }

      setOracleHomeDirOverrideForTest(migrationHome);
      await sessionModule.ensureSessionStorage();

      const mode = async (targetPath: string) => (await stat(targetPath)).mode & 0o777;
      expect(await mode(sessionsDir)).toBe(0o700);
      expect(await mode(sessionDir)).toBe(0o700);
      expect(await mode(modelsDir)).toBe(0o700);
      expect(await mode(nestedArtifactsDir)).toBe(0o700);
      expect(await mode(path.join(sessionDir, "output.log"))).toBe(0o600);
      expect(await mode(path.join(modelsDir, "gpt.json"))).toBe(0o600);
      expect(await mode(path.join(nestedArtifactsDir, "report.md"))).toBe(0o600);
      expect((await lstat(path.join(sessionDir, "linked-dir"))).isSymbolicLink()).toBe(true);
      expect((await lstat(path.join(sessionDir, "linked-file"))).isSymbolicLink()).toBe(true);
      expect(await mode(outsideDir)).toBe(0o755);
      expect(await mode(outsideFile)).toBe(0o644);
    } finally {
      setOracleHomeDirOverrideForTest(oracleHomeDir);
      await rm(migrationHome, { recursive: true, force: true });
    }
  });
});

describe("session identifiers", () => {
  test("createSessionId slugifies prompts without timestamps", () => {
    const id = sessionModule.createSessionId("  Hello, WORLD??? -- Example ");
    expect(id).toBe("hello-world-example");
  });

  test("createSessionId preserves whole words up to max limit", () => {
    const id = sessionModule.createSessionId("Alpha beta gamma delta epsilon zeta");
    expect(id).toBe("alpha-beta-gamma-delta-epsilon");
  });

  test("createSessionId accepts custom slugs and enforces word bounds", () => {
    const id = sessionModule.createSessionId("ignored", "Launch plan QA sync ready??");
    expect(id).toBe("launch-plan-qa-sync-ready");
    expect(() => sessionModule.createSessionId("ignored", "only two")).toThrow(/Custom slug/i);
  });

  test("createSessionId truncates overly long words to keep slugs readable", () => {
    const id = sessionModule.createSessionId("abcdefghijklm nopqrstuvwxyz shorty");
    expect(id).toBe("abcdefghij-nopqrstuvw-shorty");
  });
});

describe("session lifecycle", () => {
  test("initializeSession writes metadata, request, and log files", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-04-01T00:00:00Z"));
    const metadata = await sessionModule.initializeSession(
      {
        prompt: "Inspect code",
        model: "gpt-5.2-pro",
        file: ["notes.md"],
        previousResponseId: "resp-parent-123",
        followupSessionId: "parent-session",
        followupModel: "gpt-5.1",
        browserFollowUps: ["challenge the plan", "summarize final recommendation"],
        maxFileSizeBytes: 2_097_152,
        maxInput: 123,
        system: "SYS",
        maxOutput: 456,
        silent: false,
        filesReport: true,
        modelOverrides: {
          "gpt-5.2-pro": { apiModel: "gateway-model", reasoning: { effort: "high" } },
        },
      },
      "/tmp/cwd",
    );
    vi.useRealTimers();
    const baseDir = path.join(sessionModule.getSessionsDir(), metadata.id);
    const storedMeta = JSON.parse(await readFile(path.join(baseDir, "meta.json"), "utf8"));
    expect(storedMeta.options.file).toEqual(["notes.md"]);
    expect(storedMeta.options.maxFileSizeBytes).toBe(2_097_152);
    expect(storedMeta.options.previousResponseId).toBe("resp-parent-123");
    expect(storedMeta.options.followupSessionId).toBe("parent-session");
    expect(storedMeta.options.followupModel).toBe("gpt-5.1");
    expect(storedMeta.options.modelOverrides).toEqual({
      "gpt-5.2-pro": { apiModel: "gateway-model", reasoning: { effort: "high" } },
    });
    expect(storedMeta.options.browserFollowUps).toEqual([
      "challenge the plan",
      "summarize final recommendation",
    ]);
    await expect(readFile(path.join(baseDir, "request.json"), "utf8")).rejects.toThrow();
    const modelMeta = JSON.parse(
      await readFile(path.join(baseDir, "models", "gpt-5.2-pro.json"), "utf8"),
    );
    expect(modelMeta.status).toBe("pending");
    const perModelLog = await readFile(path.join(baseDir, "models", "gpt-5.2-pro.log"), "utf8");
    expect(perModelLog).toBe("");
    const logContent = await readFile(path.join(baseDir, "output.log"), "utf8");
    expect(logContent).toBe("");
    if (process.platform !== "win32") {
      expect((await stat(path.join(baseDir, "meta.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("session directory and log artifacts are owner-only (no world/group read)", async () => {
    if (process.platform === "win32") {
      return;
    }
    const meta = await sessionModule.initializeSession(
      { prompt: "sensitive prompt", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const baseDir = path.join(sessionModule.getSessionsDir(), meta.id);
    // The output log receives the full prompt + attached file contents + model response,
    // so it must not be readable by other local users.
    const writer = sessionModule.createSessionLogWriter(meta.id);
    writer.writeChunk("SENSITIVE MODEL RESPONSE\n");
    writer.stream.end();
    await new Promise((resolve) => writer.stream.on("close", resolve));

    const mode = async (p: string) => (await stat(p)).mode & 0o777;
    expect(await mode(sessionModule.getSessionsDir())).toBe(0o700);
    expect(await mode(baseDir)).toBe(0o700);
    expect(await mode(path.join(baseDir, "models"))).toBe(0o700);
    expect(await mode(path.join(baseDir, "output.log"))).toBe(0o600);
    expect(await mode(path.join(baseDir, "models", "gpt-5.2-pro.json"))).toBe(0o600);
    expect(await mode(path.join(baseDir, "models", "gpt-5.2-pro.log"))).toBe(0o600);
  });

  test("readSessionMetadata returns null for missing sessions and updateSessionMetadata persists changes", async () => {
    expect(await sessionModule.readSessionMetadata("missing")).toBeNull();
    const meta = await sessionModule.initializeSession(
      { prompt: "Update me", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "complete",
      promptPreview: "value",
    });
    const updated = await sessionModule.readSessionMetadata(meta.id);
    expect(updated?.status).toBe("complete");
    expect(updated?.promptPreview).toBe("value");
    const sessionFiles = await readdir(path.join(sessionModule.getSessionsDir(), meta.id));
    expect(sessionFiles.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("retries transient metadata rename failures without leaving temporary files", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Retry metadata rename", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const originalRename = fs.rename.bind(fs);
    let attempts = 0;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      attempts += 1;
      if (attempts <= 2) {
        throw Object.assign(new Error("transient Windows metadata lock"), { code: "EPERM" });
      }
      return originalRename(source, target);
    });

    try {
      await sessionModule.updateSessionMetadata(meta.id, { promptPreview: "retry succeeded" });
    } finally {
      renameSpy.mockRestore();
    }

    expect(attempts).toBe(3);
    expect((await sessionModule.readSessionMetadata(meta.id))?.promptPreview).toBe(
      "retry succeeded",
    );
    const sessionFiles = await readdir(path.join(sessionModule.getSessionsDir(), meta.id));
    expect(sessionFiles.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("createSessionLogWriter appends logs and supports chunk writes", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Log history", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const writer = sessionModule.createSessionLogWriter(meta.id);
    writer.logLine("First line");
    writer.writeChunk("Second chunk");
    writer.stream.end();
    await new Promise<void>((resolve) => writer.stream.once("close", () => resolve()));
    const logText = await sessionModule.readSessionLog(meta.id);
    expect(logText).toContain("First line");
    expect(logText).toContain("Second chunk");
  });

  test("createSessionLogWriter recreates missing per-model log directory", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Model log history", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    await rm(path.join(sessionModule.getSessionsDir(), meta.id, "models"), {
      recursive: true,
      force: true,
    });
    const writer = sessionModule.createSessionLogWriter(meta.id, "gemini-3-pro");
    writer.logLine("Gemini line");
    writer.stream.end();
    await new Promise<void>((resolve) => writer.stream.once("close", () => resolve()));
    const logText = await sessionModule.readModelLog(meta.id, "gemini-3-pro");
    expect(logText).toContain("Gemini line");
  });

  test("readSessionLog falls back to empty string when no log exists", async () => {
    expect(await sessionModule.readSessionLog("missing")).toBe("");
  });

  test("initializeSession appends numeric suffix when slug already exists", async () => {
    const first = await sessionModule.initializeSession(
      { prompt: "Duplicate slug please", model: "gpt-5.2-pro", slug: "alpha beta gamma" },
      "/tmp/cwd",
    );
    const second = await sessionModule.initializeSession(
      { prompt: "Duplicate slug please again", model: "gpt-5.2-pro", slug: "alpha beta gamma" },
      "/tmp/cwd",
    );
    expect(first.id).toBe("alpha-beta-gamma");
    expect(second.id).toBe("alpha-beta-gamma-2");
  });

  test("initializeSession atomically allocates unique ids under parallel same-slug creation", async () => {
    const sessions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sessionModule.initializeSession(
          {
            prompt: `Parallel slug ${index}`,
            model: "gpt-5.2-pro",
            slug: "parallel slug race",
          },
          "/tmp/cwd",
        ),
      ),
    );
    const ids = sessions.map((session) => session.id).sort();
    expect(new Set(ids).size).toBe(sessions.length);
    expect(ids).toContain("parallel-slug-race");
    expect(ids).toContain("parallel-slug-race-8");
  });

  test("initializeSession can restart from a base slug override and appends suffix on conflict", async () => {
    const first = await sessionModule.initializeSession(
      { prompt: "Original", model: "gpt-5.2-pro", slug: "alpha beta gamma" },
      "/tmp/cwd",
    );
    const restarted = await sessionModule.initializeSession(
      { prompt: "Restarted", model: "gpt-5.2-pro" },
      "/tmp/cwd",
      undefined,
      first.id,
    );
    expect(restarted.id).toBe("alpha-beta-gamma-2");
  });

  test("marks stale running sessions as zombies after 60 minutes", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Zombie", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const staleStarted = new Date(
      Date.now() - sessionModule.ZOMBIE_MAX_AGE_MS - 60_000,
    ).toISOString();
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      startedAt: staleStarted,
    });
    const listed = await sessionModule.listSessionsMetadata();
    const zombie = listed.find((m) => m.id === meta.id);
    expect(zombie?.status).toBe("error");
    expect(zombie?.errorMessage).toMatch(/zombie/i);
    const persisted = await sessionModule.readSessionMetadata(meta.id);
    expect(persisted?.status).toBe("error");
    const storedRaw = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), meta.id, "meta.json"), "utf8"),
    );
    expect(storedRaw.status).toBe("error");
    expect(storedRaw.errorMessage).toMatch(/zombie/i);
  });

  test("keeps running browser sessions when Chrome runtime is reachable", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Browser live", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          chromePid: process.pid,
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe("running");
  });

  test("keeps running browser sessions while their detached worker is alive", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Browser worker live", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      mode: "browser",
      lifecycle: {
        engine: "browser",
        execution: "background",
        attached: false,
        detached: true,
        workerPid: process.pid,
        reattachCommand: `oracle session ${meta.id}`,
      },
      browser: {
        runtime: {
          chromePid: 999999,
          chromePort: 1,
          chromeHost: "127.0.0.1",
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe("running");
    const listed = await sessionModule.listSessionsMetadata();
    expect(listed.find((entry) => entry.id === meta.id)?.status).toBe("running");
    const stored = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), meta.id, "meta.json"), "utf8"),
    );
    expect(stored.status).toBe("running");
  });

  test("marks running browser sessions as error when Chrome runtime is gone", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Browser dead", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          chromePid: 999999,
          chromePort: 1,
          chromeHost: "127.0.0.1",
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe("error");
    expect(refreshed?.errorMessage).toMatch(/chrome/i);
    const rawBeforeList = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), meta.id, "meta.json"), "utf8"),
    );
    expect(rawBeforeList.status).toBe("running");
    await sessionModule.listSessionsMetadata();
    const rawAfterList = JSON.parse(
      await readFile(path.join(sessionModule.getSessionsDir(), meta.id, "meta.json"), "utf8"),
    );
    expect(rawAfterList.status).toBe("error");
    expect(rawAfterList.errorMessage).toMatch(/chrome/i);
  });

  test("marks running browser sessions as error when only controllerPid is recorded and it is gone", async () => {
    // chromePid / chromePort absent → signals[] starts empty → falls through to controllerPid check
    const meta = await sessionModule.initializeSession(
      { prompt: "Controller dead", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          controllerPid: 999_999_999, // definitely not alive
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe("error");
    expect(refreshed?.errorMessage).toMatch(/chrome.*no longer reachable/i);
  });

  test("keeps running browser sessions when only controllerPid is recorded and it is alive", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Controller live", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      mode: "browser",
      browser: {
        runtime: {
          controllerPid: process.pid, // current process is definitely alive
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe("running");
  });
});

describe("session listing and filtering", () => {
  test("listSessionsMetadata sorts newest first and filterSessionsByRange enforces limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    await sessionModule.initializeSession(
      { prompt: "Old session", model: "gpt-5.2-pro" },
      "/tmp/a",
    );
    vi.setSystemTime(new Date("2025-01-02T12:00:00Z"));
    const recent = await sessionModule.initializeSession(
      { prompt: "Recent session", model: "gpt-5.2-pro" },
      "/tmp/b",
    );
    vi.setSystemTime(new Date("2025-01-03T00:00:00Z"));
    const metas = await sessionModule.listSessionsMetadata();
    expect(metas[0].id).toBe(recent.id);

    const rangeResult = sessionModule.filterSessionsByRange(metas, { hours: 24 });
    expect(rangeResult.entries.map((entry: SessionMetadata) => entry.id)).toEqual([recent.id]);

    const limited = sessionModule.filterSessionsByRange(metas, { includeAll: true, limit: 1 });
    expect(limited.entries).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(limited.total).toBe(2);
    vi.useRealTimers();
  });

  test("deleteSessionsOlderThan removes only sessions past the cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const oldMeta = await sessionModule.initializeSession(
      { prompt: "Old", model: "gpt-5.2-pro" },
      "/tmp/a",
    );
    vi.setSystemTime(new Date("2025-01-03T00:00:00Z"));
    const freshMeta = await sessionModule.initializeSession(
      { prompt: "Fresh", model: "gpt-5.2-pro" },
      "/tmp/b",
    );
    vi.setSystemTime(new Date("2025-01-03T12:00:00Z"));

    const result = await sessionModule.deleteSessionsOlderThan({ hours: 24 });
    expect(result).toEqual({ deleted: 1, remaining: 1 });
    expect(await sessionModule.readSessionMetadata(oldMeta.id)).toBeNull();
    expect(await sessionModule.readSessionMetadata(freshMeta.id)).not.toBeNull();
    vi.useRealTimers();
  });

  test("deleteSessionsOlderThan clears everything when includeAll is true", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Only", model: "gpt-5.2-pro" },
      "/tmp/c",
    );
    const result = await sessionModule.deleteSessionsOlderThan({ includeAll: true });
    expect(result).toEqual({ deleted: 1, remaining: 0 });
    expect(await sessionModule.readSessionMetadata(meta.id)).toBeNull();
  });
});

describe("wait helper", () => {
  test("wait resolves after the requested duration", async () => {
    vi.useFakeTimers();
    const pending = sessionModule.wait(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
