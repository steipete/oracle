import { describe, it, expect, vi, beforeEach } from "vitest";

const { openWebBrowserSession, runProviderDomFlow, typePrompt, submitPrompt, waitForResponse } =
  vi.hoisted(() => ({
    openWebBrowserSession: vi.fn(),
    runProviderDomFlow: vi.fn(),
    typePrompt: vi.fn(async () => undefined),
    submitPrompt: vi.fn(async () => undefined),
    waitForResponse: vi.fn(async () => ({ text: "" })),
  }));

vi.mock("../../src/browser/webSessionManager.js", () => ({ openWebBrowserSession }));
vi.mock("../../src/browser/providerDomFlow.js", () => ({ runProviderDomFlow }));
vi.mock("../../src/browser/providers/perplexityDomProvider.js", () => ({
  perplexityDomProvider: { typePrompt, submitPrompt, waitForResponse },
  extractPerplexitySources: vi.fn(async () => []),
  extractPerplexityImages: vi.fn(async () => []),
}));

function fakeSession() {
  const noop = vi.fn(async () => undefined);
  return {
    profileDir: "/tmp/profile",
    port: 1234,
    targetId: "target-1",
    close: vi.fn(async () => undefined),
    client: {
      Runtime: {
        enable: noop,
        evaluate: vi.fn(async () => ({ result: { value: 1 } })),
      },
      Page: { enable: noop, navigate: noop },
      Input: {},
      DOM: { enable: noop },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  openWebBrowserSession.mockResolvedValue(fakeSession());
  runProviderDomFlow.mockResolvedValue({ text: "first answer", thoughts: null });
  waitForResponse.mockResolvedValue({ text: "" });
});

async function runExecutor(runOptions: Record<string, unknown>) {
  const { createPerplexityWebExecutor } = await import("../../src/perplexity-web/executor.js");
  const execute = createPerplexityWebExecutor({});
  return execute({
    prompt: "initial prompt",
    config: { desiredModel: "Search" },
    ...runOptions,
  } as never);
}

describe("createPerplexityWebExecutor artifacts", () => {
  it("returns no artifacts when nothing was saved", async () => {
    const result = await runExecutor({});
    expect(result.artifacts).toBeUndefined();
  });
});

describe("createPerplexityWebExecutor follow-ups", () => {
  it("returns the single answer unchanged when there are no follow-ups", async () => {
    const result = await runExecutor({});
    expect(result.answerText).toBe("first answer");
    expect(typePrompt).not.toHaveBeenCalled();
  });

  it("runs each follow-up in the same conversation and builds a turn transcript", async () => {
    // sessionRunner passes followUpPrompts to every executor; ignoring them silently
    // returned only the first answer.
    waitForResponse.mockResolvedValueOnce({ text: "second answer" });

    const result = await runExecutor({ followUpPrompts: ["and then?"] });

    expect(typePrompt).toHaveBeenCalledTimes(1);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(result.answerMarkdown).toContain("## Initial");
    expect(result.answerMarkdown).toContain("## Follow-up 1");
    expect(result.answerMarkdown).toContain("first answer");
    expect(result.answerMarkdown).toContain("second answer");
  });

  it("does not re-upload attachments on a follow-up turn", async () => {
    waitForResponse.mockResolvedValueOnce({ text: "second answer" });

    await runExecutor({
      attachments: [{ path: "/tmp/a.png", displayPath: "a.png" }],
      followUpPrompts: ["and then?"],
    });

    const [followUpCtx] = typePrompt.mock.calls[0] as unknown as [
      { state?: { attachments?: unknown[] } },
    ];
    expect(followUpCtx?.state?.attachments).toEqual([]);
  });

  it("ignores blank follow-up entries", async () => {
    const result = await runExecutor({ followUpPrompts: ["   ", ""] });
    expect(typePrompt).not.toHaveBeenCalled();
    expect(result.answerText).toBe("first answer");
  });
});
