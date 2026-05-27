import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";
import { PROVIDER_BOUNDARY_PAV_SCHEMA_VERSION } from "../src/oracle/provider_boundaries_pav.js";

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

  test("rejects path traversal ids at the session storage boundary", async () => {
    const escapedDir = path.join(oracleHomeDir, "escape");
    await mkdir(escapedDir, { recursive: true });
    await writeFile(
      path.join(escapedDir, "meta.json"),
      JSON.stringify(
        {
          id: "escape",
          createdAt: new Date().toISOString(),
          status: "completed",
          options: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(sessionModule.readSessionMetadata("../escape")).resolves.toBeNull();
    await expect(sessionModule.getSessionPaths("../escape")).rejects.toThrow(/Invalid session id/);
  });
});

describe("session lifecycle", () => {
  test("initializeSession records prompt byte evidence hashes without rewriting prompt text", async () => {
    const prompt = [
      "  - keep leading markdown whitespace",
      "```toon",
      "items[2]{id,name}:",
      "  1,Ada",
      "  2,Linus",
      "```",
      "",
    ].join("\n");
    const expectedSha = `sha256:${createHash("sha256")
      .update(Buffer.from(prompt, "utf8"))
      .digest("hex")}`;
    const metadata = await sessionModule.initializeSession(
      {
        prompt,
        model: "gpt-5.2-pro",
      },
      "/tmp/cwd",
    );

    expect(metadata.options.prompt).toBe(prompt);
    expect(metadata.evidence).toEqual({
      prompt_sha256: expectedSha,
      prompt_manifest_sha256: expectedSha,
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    });

    const baseDir = path.join(sessionModule.getSessionsDir(), metadata.id);
    const storedMeta = JSON.parse(await readFile(path.join(baseDir, "meta.json"), "utf8"));
    expect(storedMeta.options.prompt).toBe(prompt);
    expect(storedMeta.evidence.prompt_sha256).toBe(expectedSha);

    const modelMeta = JSON.parse(
      await readFile(path.join(baseDir, "models", "gpt-5.2-pro.json"), "utf8"),
    );
    expect(modelMeta.evidence).toEqual(storedMeta.evidence);

    const updatedModelMeta = await sessionModule.updateModelRunMetadata(
      metadata.id,
      "gpt-5.2-pro",
      { status: "completed", response: { id: "resp-1" } },
    );
    expect(updatedModelMeta.evidence).toEqual(storedMeta.evidence);
  });

  test("initializeSession can persist optional PAV boundary metadata without raw prompt text", async () => {
    const prompt = ["unique-session-boundary-prompt", "```toon", "rows[1]{id}: 1", "```", ""].join(
      "\n",
    );
    const metadata = await sessionModule.initializeSession(
      {
        prompt,
        model: "gpt-5.2-pro",
        providerBoundary: {
          providerFamily: "chatgpt",
          providerSlot: "chatgpt_pro_first_plan",
          requestedMode: "browser",
          accessPath: "oracle_browser_remote",
        },
      },
      "/tmp/cwd",
    );

    const boundary = metadata.evidence?.provider_boundary_pav;
    expect(boundary).toMatchObject({
      schema_version: PROVIDER_BOUNDARY_PAV_SCHEMA_VERSION,
      provider_family: "chatgpt",
      provider_slot: "chatgpt_pro_first_plan",
      requested_mode: "browser",
      prompt_sha256: metadata.evidence?.prompt_sha256,
      prompt_semantics: "unchanged",
      raw_prompt_in_metadata: false,
      policy_scope: "protected_workflow_slot",
    });
    expect(boundary?.protected_slot_metadata).toMatchObject({
      protected_slot: true,
      api_substitution_allowed_for_this_slot: false,
    });
    expect(boundary?.context_serialization).toMatchObject({
      provider_payload_format: "text",
      provider_payload_semantics: "unchanged",
    });
    expect(JSON.stringify(boundary)).not.toContain(prompt);
    expect(JSON.stringify(boundary)).not.toContain("unique-session-boundary-prompt");

    const baseDir = path.join(sessionModule.getSessionsDir(), metadata.id);
    const storedMeta = JSON.parse(await readFile(path.join(baseDir, "meta.json"), "utf8"));
    expect(storedMeta.evidence.provider_boundary_pav).toEqual(boundary);

    const modelMeta = JSON.parse(
      await readFile(path.join(baseDir, "models", "gpt-5.2-pro.json"), "utf8"),
    );
    expect(modelMeta.evidence.provider_boundary_pav).toEqual(boundary);
  });

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

  test("initializeSession reserves unique ids for concurrent same-slug sessions", async () => {
    const sessions = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        sessionModule.initializeSession(
          {
            prompt: `Concurrent session ${index}`,
            model: "gpt-5.2-pro",
            slug: "shared slug name",
          },
          "/tmp/cwd",
        ),
      ),
    );
    const ids = sessions.map((session) => session.id);
    const expected = new Set([
      "shared-slug-name",
      "shared-slug-name-2",
      "shared-slug-name-3",
      "shared-slug-name-4",
      "shared-slug-name-5",
      "shared-slug-name-6",
    ]);

    expect(new Set(ids)).toEqual(expected);
    for (const id of expected) {
      await expect(sessionModule.readSessionMetadata(id)).resolves.toMatchObject({ id });
    }
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
