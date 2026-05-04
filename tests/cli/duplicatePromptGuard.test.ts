import { describe, expect, test, vi } from "vitest";
import { shouldBlockDuplicatePrompt } from "../../src/cli/duplicatePromptGuard.js";
import type { SessionStore, SessionMetadata } from "../../src/sessionStore.js";

const makeStore = (sessions: Partial<SessionMetadata>[]): SessionStore =>
  ({
    listSessions: vi.fn().mockResolvedValue(
      sessions.map((s, idx) => ({
        id: `sess-${idx + 1}`,
        status: "running",
        createdAt: new Date().toISOString(),
        options: {},
        ...s,
      })),
    ),
  }) as unknown as SessionStore;

describe("shouldBlockDuplicatePrompt", () => {
  test("allows when no running session matches prompt", async () => {
    const store = makeStore([{ options: { prompt: "other prompt" } }]);
    const blocked = await shouldBlockDuplicatePrompt({
      prompt: "target prompt",
      force: false,
      sessionStore: store,
      log: vi.fn(),
    });
    expect(blocked).toBe(false);
  });

  test("blocks when identical prompt is already running", async () => {
    const log = vi.fn();
    const store = makeStore([{ options: { prompt: "same prompt" } }]);
    const blocked = await shouldBlockDuplicatePrompt({
      prompt: "same prompt",
      force: false,
      sessionStore: store,
      log,
    });
    expect(blocked).toBe(true);
    expect(log).toHaveBeenCalled();
  });

  test("treats browser follow-ups as part of the duplicate signature", async () => {
    const store = makeStore([
      { options: { prompt: "same prompt", browserFollowUps: ["challenge it"] } },
    ]);
    const blockedDifferentFollowup = await shouldBlockDuplicatePrompt({
      prompt: "same prompt",
      browserFollowUps: ["summarize it"],
      force: false,
      sessionStore: store,
      log: vi.fn(),
    });
    const blockedSameFollowup = await shouldBlockDuplicatePrompt({
      prompt: "same prompt",
      browserFollowUps: ["challenge it"],
      force: false,
      sessionStore: store,
      log: vi.fn(),
    });

    expect(blockedDifferentFollowup).toBe(false);
    expect(blockedSameFollowup).toBe(true);
  });

  test("allows duplicate prompt when force is true", async () => {
    const store = makeStore([{ options: { prompt: "same prompt" } }]);
    const blocked = await shouldBlockDuplicatePrompt({
      prompt: "same prompt",
      force: true,
      sessionStore: store,
      log: vi.fn(),
    });
    expect(blocked).toBe(false);
  });
});
