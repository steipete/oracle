import { beforeEach, describe, expect, test, vi } from "vitest";
import { runBrowserSessionExecution } from "../../src/browser/sessionRunner.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";

const providers = vi.hoisted(() => {
  const reply = (text: string) => ({
    answerText: text,
    answerMarkdown: text,
    tookMs: 1,
    answerTokens: 1,
    answerChars: text.length,
  });
  const chatgpt = vi.fn(async () => reply("CHATGPT_FIXTURE"));
  const gemini = vi.fn(async () => reply("GEMINI_FIXTURE"));
  return { chatgpt, gemini, createGemini: vi.fn(() => gemini) };
});
vi.mock("../../src/browserMode.js", () => ({ runBrowserMode: providers.chatgpt }));
vi.mock("../../src/gemini-web/index.js", () => ({
  createGeminiWebExecutor: providers.createGemini,
}));

const assemblePrompt = async () => ({
  markdown: "fixture",
  composerText: "fixture",
  estimatedInputTokens: 1,
  attachments: [],
  inlineFileCount: 0,
  tokenEstimateIncludesInlineFiles: false,
  attachmentsPolicy: "auto" as const,
  attachmentMode: "inline" as const,
  fallback: null,
});

beforeEach(() => vi.clearAllMocks());

describe("browser provider routing", () => {
  test("rejects unknown local providers without running ChatGPT", async () => {
    await expect(
      runBrowserSessionExecution(
        {
          runOptions: { prompt: "fixture", model: "unknown-provider" },
          browserConfig: {},
          cwd: process.cwd(),
          log: vi.fn(),
        },
        { assemblePrompt },
      ),
    ).rejects.toThrow(/Unsupported browser model/);
    expect(providers.chatgpt).not.toHaveBeenCalled();
    expect(providers.createGemini).not.toHaveBeenCalled();
  });

  test("rejects unknown canonical remote models before reading attachments", async () => {
    const execute = createRemoteBrowserExecutor({ host: "127.0.0.1:1", token: "synthetic" });
    await expect(
      execute({
        model: "unknown-provider",
        prompt: "fixture",
        attachments: [{ path: "/must-not-be-read", displayPath: "context.txt" }],
      }),
    ).rejects.toThrow(/Unsupported browser model/);
  });

  test("selects Gemini at the shared session boundary and forwards its options", async () => {
    const runOptions = {
      prompt: "fixture",
      model: "gemini-3.1-pro",
      youtube: "https://example.test/video",
      editImage: "input.png",
      generateImage: "generated.png",
      outputPath: "output.png",
      aspectRatio: "1:1",
      geminiShowThoughts: true,
      geminiAllowModelFallback: false,
    };
    const result = await runBrowserSessionExecution(
      {
        runOptions,
        browserConfig: { desiredModel: "Unrelated UI label" },
        cwd: process.cwd(),
        log: vi.fn(),
      },
      { assemblePrompt },
    );
    expect(result.answerText).toBe("GEMINI_FIXTURE");
    expect(providers.chatgpt).not.toHaveBeenCalled();
    expect(providers.createGemini).toHaveBeenCalledWith({
      youtube: runOptions.youtube,
      editImage: "input.png",
      generateImage: "generated.png",
      outputPath: "output.png",
      aspectRatio: "1:1",
      showThoughts: true,
      allowModelFallback: false,
    });
    expect(providers.gemini).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3.1-pro" }),
    );
  });

  test("keeps ChatGPT as the default for GPT models", async () => {
    const result = await runBrowserSessionExecution(
      {
        runOptions: { prompt: "fixture", model: "gpt-5.5" },
        browserConfig: {},
        cwd: process.cwd(),
        log: vi.fn(),
      },
      { assemblePrompt },
    );
    expect(result.answerText).toBe("CHATGPT_FIXTURE");
    expect(providers.createGemini).not.toHaveBeenCalled();
  });

  test("preserves an explicitly supplied executor", async () => {
    const executeBrowser = vi.fn(async () => ({
      answerText: "CUSTOM_FIXTURE",
      answerMarkdown: "CUSTOM_FIXTURE",
      tookMs: 1,
      answerTokens: 1,
      answerChars: 14,
    }));
    const result = await runBrowserSessionExecution(
      {
        runOptions: { prompt: "fixture", model: "gemini-3.1-pro" },
        browserConfig: {},
        cwd: process.cwd(),
        log: vi.fn(),
      },
      { assemblePrompt, executeBrowser },
    );
    expect(result.answerText).toBe("CUSTOM_FIXTURE");
    expect(providers.createGemini).not.toHaveBeenCalled();
  });

  test.each([
    { model: "gemini-3.1-pro", config: { desiredModel: "Pro" } },
    { config: { desiredModel: "Gemini 3.1 Pro" } },
  ])("refuses remote Gemini before reading attachments (%j)", async (selection) => {
    const execute = createRemoteBrowserExecutor({ host: "127.0.0.1:1", token: "synthetic" });
    await expect(
      execute({
        ...selection,
        prompt: "fixture",
        attachments: [{ path: "/must-not-be-read", displayPath: "context.txt" }],
      }),
    ).rejects.toThrow(/Gemini.*local.*ChatGPT/i);
  });
});
