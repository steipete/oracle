import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import { sessionStore } from "../../src/sessionStore.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  registerWaitTool,
  runWaitTool,
  waitForSessionTerminal,
  type SessionChangeSource,
  type WaitForSessionDeps,
} from "../../src/mcp/tools/wait.js";

function metadata(status: string): SessionMetadata {
  return {
    id: "session-1",
    createdAt: "2026-08-28T00:00:00.000Z",
    status,
    cwd: "/tmp",
    model: "gpt-5.6-sol",
    mode: "browser",
    options: { prompt: "review", file: [], model: "gpt-5.6-sol" },
  };
}

function fakeSource(waitImpl: SessionChangeSource["wait"] = async () => undefined) {
  return {
    source: { wait: vi.fn(waitImpl), close: vi.fn() } satisfies SessionChangeSource,
    create: vi.fn(),
  };
}

describe("waitForSessionTerminal", () => {
  test.each(["completed", "partial", "error", "cancelled"])(
    "returns immediately for %s",
    async (status) => {
      const source = fakeSource();
      source.create.mockReturnValue(source.source);
      const deps: WaitForSessionDeps = {
        readSession: vi.fn(async () => metadata(status)),
        getSessionDir: vi.fn(async () => "/tmp/session-1"),
        createChangeSource: source.create,
        now: () => 0,
      };

      await expect(waitForSessionTerminal({ id: "session-1" }, deps)).resolves.toMatchObject({
        metadata: { status },
        waitStatus: "terminal",
        timedOut: false,
      });
      expect(source.create).not.toHaveBeenCalled();
    },
  );

  test("wakes on a session change and rereads durable metadata", async () => {
    const source = fakeSource();
    source.create.mockReturnValue(source.source);
    const readSession = vi
      .fn<() => Promise<SessionMetadata | null>>()
      .mockResolvedValueOnce(metadata("running"))
      .mockResolvedValueOnce(metadata("running"))
      .mockResolvedValueOnce(metadata("completed"));
    const deps: WaitForSessionDeps = {
      readSession,
      getSessionDir: vi.fn(async () => "/tmp/session-1"),
      createChangeSource: source.create,
      now: () => 0,
    };

    const result = await waitForSessionTerminal({ id: "session-1", timeoutMs: 60_000 }, deps);

    expect(result).toMatchObject({
      metadata: { status: "completed" },
      waitStatus: "terminal",
      timedOut: false,
    });
    expect(readSession).toHaveBeenCalledTimes(3);
    expect(source.source.wait).toHaveBeenCalledTimes(1);
    expect(source.source.close).toHaveBeenCalledTimes(1);
  });

  test("times out without changing the running session", async () => {
    const source = fakeSource();
    source.create.mockReturnValue(source.source);
    let nowCalls = 0;
    const readSession = vi.fn(async () => metadata("running"));
    const deps: WaitForSessionDeps = {
      readSession,
      getSessionDir: vi.fn(async () => "/tmp/session-1"),
      createChangeSource: source.create,
      now: () => (nowCalls++ === 0 ? 0 : 10),
    };

    await expect(
      waitForSessionTerminal({ id: "session-1", timeoutMs: 10 }, deps),
    ).resolves.toMatchObject({
      metadata: { status: "running" },
      waitStatus: "timed_out",
      timedOut: true,
    });
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(source.source.wait).not.toHaveBeenCalled();
    expect(source.source.close).toHaveBeenCalledTimes(1);
  });

  test("request cancellation stops only the waiter", async () => {
    const controller = new AbortController();
    const source = fakeSource(async (_delayMs, signal) => {
      controller.abort(new DOMException("caller cancelled", "AbortError"));
      signal?.throwIfAborted();
    });
    source.create.mockReturnValue(source.source);
    const readSession = vi.fn(async () => metadata("running"));
    const deps: WaitForSessionDeps = {
      readSession,
      getSessionDir: vi.fn(async () => "/tmp/session-1"),
      createChangeSource: source.create,
      now: () => 0,
    };

    await expect(
      waitForSessionTerminal({ id: "session-1", signal: controller.signal }, deps),
    ).rejects.toThrow("caller cancelled");
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(source.source.close).toHaveBeenCalledTimes(1);
  });

  test("rejects a missing session before installing a watcher", async () => {
    const source = fakeSource();
    source.create.mockReturnValue(source.source);
    const deps: WaitForSessionDeps = {
      readSession: vi.fn(async () => null),
      getSessionDir: vi.fn(async () => "/tmp/missing"),
      createChangeSource: source.create,
      now: () => 0,
    };

    await expect(waitForSessionTerminal({ id: "missing" }, deps)).rejects.toThrow(
      'Session "missing" not found.',
    );
    expect(source.create).not.toHaveBeenCalled();
  });
});

test("the registered waiter observes the SDK v2 request cancellation signal", async () => {
  let handler: ((input: unknown, context: unknown) => Promise<unknown>) | undefined;
  registerWaitTool({
    registerTool: (_name: string, _schema: unknown, callback: typeof handler) => {
      handler = callback;
    },
  } as never);
  const controller = new AbortController();
  const reason = new Error("request was cancelled");
  controller.abort(reason);
  await expect(handler!({ id: "unused" }, { mcpReq: { signal: controller.signal } })).rejects.toBe(
    reason,
  );
});

describe("wait MCP result", () => {
  afterEach(() => {
    setOracleHomeDirOverrideForTest(null);
  });

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid caller timeout %s before opening a session",
    async (timeoutMs) => {
      await expect(runWaitTool({ id: "missing", timeoutMs })).rejects.toThrow();
    },
  );

  test("observes durable completion on the real filesystem", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-wait-notify-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const created = await sessionStore.createSession(
        { prompt: "filesystem waiter", file: [], model: "gpt-5.4", mode: "api" },
        home,
      );
      await sessionStore.updateSession(created.id, { status: "running" });
      const waiting = waitForSessionTerminal({ id: created.id, timeoutMs: 3_000 });
      await sessionStore.updateSession(created.id, { status: "completed" });
      await expect(waiting).resolves.toMatchObject({
        metadata: { status: "completed" },
        waitStatus: "terminal",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 5_000);

  test("returns terminal output and artifact summaries without another sessions call", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-wait-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const created = await sessionStore.createSession(
        { prompt: "review", file: [], model: "gpt-5.6-sol", mode: "browser" },
        "/tmp",
      );
      const writer = sessionStore.createLogWriter(created.id);
      writer.logLine("final answer");
      await new Promise<void>((resolve) => writer.stream.end(resolve));
      await sessionStore.updateSession(created.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        artifacts: [{ kind: "transcript", path: "artifacts/transcript.md" }],
      });

      const result = (await runWaitTool({ id: created.id, timeoutMs: 0 })) as {
        structuredContent: {
          sessionId: string;
          status: string;
          waitStatus: string;
          timedOut: boolean;
          output: string;
          artifacts?: Array<{ kind: string; path: string }>;
        };
      };

      expect(result.structuredContent).toMatchObject({
        sessionId: created.id,
        status: "completed",
        waitStatus: "terminal",
        timedOut: false,
        output: expect.stringContaining("final answer"),
        artifacts: [{ kind: "transcript", path: "artifacts/transcript.md" }],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
