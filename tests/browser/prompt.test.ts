import path from "node:path";
import { describe, expect, test } from "vitest";
import { assembleBrowserPrompt } from "../../src/browser/prompt.js";
import { DEFAULT_SYSTEM_PROMPT, type MODEL_CONFIGS } from "../../src/oracle.js";
import type { RunOracleOptions } from "../../src/oracle.js";

const fastTokenizer: (typeof MODEL_CONFIGS)["gpt-5.1"]["tokenizer"] = (messages) => {
  const typed = messages as Array<{ content: string }>;
  return typed.reduce(
    (sum: number, message) => sum + Math.max(1, Math.ceil(message.content.length / 1000)),
    0,
  );
};

function buildOptions(overrides: Partial<RunOracleOptions> = {}): RunOracleOptions {
  return {
    prompt: overrides.prompt ?? "Explain the bug",
    model: overrides.model ?? "gpt-5.2-pro",
    file: overrides.file ?? ["a.txt"],
    system: overrides.system,
    browserAttachments: overrides.browserAttachments ?? "auto",
    browserInlineFiles: overrides.browserInlineFiles,
    maxFileSizeBytes: overrides.maxFileSizeBytes,
  } as RunOracleOptions;
}

describe("assembleBrowserPrompt", () => {
  test("builds markdown bundle with system/user/file blocks", async () => {
    const options = buildOptions();
    const result = await assembleBrowserPrompt(options, {
      cwd: "/repo",
      readFilesImpl: async () => [{ path: "/repo/a.txt", content: 'console.log("hi")\n' }],
    });
    expect(result.markdown).toContain("[SYSTEM]");
    expect(result.markdown).toContain("[USER]");
    expect(result.markdown).toContain("### File: a.txt");
    expect(result.markdown).toContain("```");
    expect(result.composerText).not.toContain(DEFAULT_SYSTEM_PROMPT);
    expect(result.composerText).toContain("Explain the bug");
    expect(result.composerText).not.toContain("[SYSTEM]");
    expect(result.composerText).not.toContain("[USER]");
    expect(result.composerText).toContain("### File: a.txt");
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.attachments).toEqual([]);
    expect(result.inlineFileCount).toBe(1);
    expect(result.tokenEstimateIncludesInlineFiles).toBe(true);
  });

  test("auto mode uploads when inline composer exceeds ~60k chars", async () => {
    const options = buildOptions({
      prompt: "Explain the bug",
      file: ["big.txt"],
      browserAttachments: "auto",
    });
    // Keep this just over the threshold; huge strings make tokenization slow on CI.
    const huge = "x".repeat(62_000);
    const result = await assembleBrowserPrompt(options, {
      cwd: "/repo",
      readFilesImpl: async () => [{ path: "/repo/big.txt", content: huge }],
      tokenizeImpl: fastTokenizer,
    });
    expect(result.attachmentMode).toBe("upload");
    expect(result.attachments).toEqual([
      expect.objectContaining({ path: "/repo/big.txt", displayPath: "big.txt" }),
    ]);
    expect(result.inlineFileCount).toBe(0);
    expect(result.tokenEstimateIncludesInlineFiles).toBe(false);
    expect(result.composerText).toBe("Explain the bug");
    expect(result.composerText).not.toContain("### File: big.txt");
    expect(result.fallback).toBeNull();
  });

  test("auto inline mode includes upload fallback", async () => {
    const options = buildOptions({
      prompt: "Explain the bug",
      file: ["a.txt"],
      browserAttachments: "auto",
    });
    const result = await assembleBrowserPrompt(options, {
      cwd: "/repo",
      readFilesImpl: async () => [{ path: "/repo/a.txt", content: "tiny" }],
    });
    expect(result.attachmentMode).toBe("inline");
    expect(result.attachments).toEqual([]);
    expect(result.inlineFileCount).toBe(1);
    expect(result.fallback).toEqual(
      expect.objectContaining({
        composerText: "Explain the bug",
        attachments: [expect.objectContaining({ path: "/repo/a.txt", displayPath: "a.txt" })],
      }),
    );
  });

  test("always mode forces uploads even when small", async () => {
    const options = buildOptions({
      prompt: "Explain the bug",
      file: ["a.txt"],
      browserAttachments: "always",
    });
    const result = await assembleBrowserPrompt(options, {
      cwd: "/repo",
      readFilesImpl: async () => [{ path: "/repo/a.txt", content: "tiny" }],
    });
    expect(result.attachmentMode).toBe("upload");
    expect(result.attachments).toEqual([
      expect.objectContaining({ path: "/repo/a.txt", displayPath: "a.txt" }),
    ]);
    expect(result.composerText).toBe("Explain the bug");
    expect(result.composerText).not.toContain("### File: a.txt");
    expect(result.fallback).toBeNull();
  });

  test("legacy browserInlineFiles forces inline and disables auto fallback", async () => {
    const options = buildOptions({
      prompt: "Explain the bug",
      file: ["big.txt"],
      browserInlineFiles: true,
      browserAttachments: "auto",
    });
    const huge = "x".repeat(62_000);
    const result = await assembleBrowserPrompt(options, {
      cwd: "/repo",
      readFilesImpl: async () => [{ path: "/repo/big.txt", content: huge }],
      tokenizeImpl: fastTokenizer,
    });
    expect(result.attachmentsPolicy).toBe("never");
    expect(result.attachmentMode).toBe("inline");
    expect(result.attachments).toEqual([]);
    expect(result.composerText).toContain("### File: big.txt");
    expect(result.fallback).toBeNull();
  });

  test("respects custom cwd and multiple files", async () => {
    const options = buildOptions({ file: ["docs/one.md", "docs/two.md"] });
    const result = await assembleBrowserPrompt(options, {
      cwd: "/root/project",
      readFilesImpl: async (paths) =>
        paths.map((entry, index) => ({
          path: path.resolve("/root/project", entry),
          content: `file-${index}`,
        })),
    });
    expect(result.markdown).toContain("### File: docs/one.md");
    expect(result.markdown).toContain("### File: docs/two.md");
    expect(result.markdown).toContain("```");
    expect(result.composerText).toContain("### File: docs/one.md");
    expect(result.composerText).toContain("### File: docs/two.md");
    expect(result.attachments).toEqual([]);
    expect(result.inlineFileCount).toBe(2);
  });

  test("passes maxFileSizeBytes to file reading", async () => {
    const options = buildOptions({ file: ["big.txt"], maxFileSizeBytes: 2_000_000 });
    let observedMaxFileSizeBytes: number | undefined;

    await assembleBrowserPrompt(options, {
      cwd: "/repo",
      readFilesImpl: async (_paths, readOptions) => {
        observedMaxFileSizeBytes = readOptions?.maxFileSizeBytes;
        return [{ path: "/repo/big.txt", content: "large enough" }];
      },
    });

    expect(observedMaxFileSizeBytes).toBe(2_000_000);
  });

  test("inlines files when browserInlineFiles enabled", async () => {
    const options = buildOptions({
      file: ["a.txt"],
      browserInlineFiles: true,
    } as Partial<RunOracleOptions>);
    const result = await assembleBrowserPrompt(options as RunOracleOptions, {
      cwd: "/repo",
      readFilesImpl: async () => [{ path: "/repo/a.txt", content: "inline test" }],
    });
    expect(result.composerText).toContain("### File: a.txt");
    expect(result.composerText).not.toContain("[SYSTEM]");
    expect(result.composerText).not.toContain("[USER]");
    expect(result.attachments).toEqual([]);
    expect(result.inlineFileCount).toBe(1);
    expect(result.tokenEstimateIncludesInlineFiles).toBe(true);
  });

  test("counts uploaded file content in token estimate", async () => {
    const withFile = await assembleBrowserPrompt(buildOptions({ file: ["doc.md"] }), {
      cwd: "/repo",
      readFilesImpl: async () => [{ path: "/repo/doc.md", content: "hello world" }],
    });
    const withoutFile = await assembleBrowserPrompt(buildOptions({ file: [] }), {
      cwd: "/repo",
      readFilesImpl: async () => [],
    });

    expect(withFile.estimatedInputTokens).toBeGreaterThan(withoutFile.estimatedInputTokens);
  });

  test("inline file mode boosts estimate compared to prompt-only", async () => {
    const readFilesImpl = async (paths: string[]) =>
      paths.length > 0 ? [{ path: "/repo/doc.md", content: "inline payload" }] : [];
    const promptOnly = await assembleBrowserPrompt(buildOptions({ file: [] }), {
      cwd: "/repo",
      readFilesImpl,
    });
    const inline = await assembleBrowserPrompt(
      { ...buildOptions({ file: ["doc.md"] }), browserInlineFiles: true } as RunOracleOptions,
      { cwd: "/repo", readFilesImpl },
    );
    expect(inline.estimatedInputTokens).toBeGreaterThan(promptOnly.estimatedInputTokens / 2);
    expect(inline.tokenEstimateIncludesInlineFiles).toBe(true);
  });

  test("bundles attachments when more than 10 files", async () => {
    const fileNames = Array.from({ length: 11 }, (_, i) => `file${i + 1}.txt`);
    const options = buildOptions({ file: fileNames, browserAttachments: "always" });
    const result = await assembleBrowserPrompt(options, {
      cwd: "/repo",
      readFilesImpl: async (paths) =>
        paths.map((entry) => ({
          path: path.resolve("/repo", entry),
          content: `content for ${entry}`,
        })),
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.txt$/);
    expect(result.inlineFileCount).toBe(0);
    expect(result.bundled).toEqual({
      originalCount: 11,
      bundlePath: result.attachments[0]?.displayPath,
    });
  });
});
