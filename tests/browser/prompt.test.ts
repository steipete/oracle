import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { assembleBrowserPrompt, isRawUploadFile } from "../../src/browser/prompt.js";
import { findAttachmentBasenameCollisions } from "../../src/browser/attachmentValidation.js";
import { createStoredZip } from "../../src/browser/zipBundle.js";
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
    browserBundleFiles: overrides.browserBundleFiles,
    browserBundleFormat: overrides.browserBundleFormat,
  } as RunOracleOptions;
}

const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const LOCAL_FILE_HEADER = 0x04034b50;

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error("End of central directory not found.");
}

function readStoredZipEntries(zip: Buffer): Map<string, Buffer> {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, Buffer>();
  let centralCursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    expect(zip.readUInt32LE(centralCursor)).toBe(CENTRAL_DIRECTORY_HEADER);
    const compressedSize = zip.readUInt32LE(centralCursor + 20);
    const nameLength = zip.readUInt16LE(centralCursor + 28);
    const extraLength = zip.readUInt16LE(centralCursor + 30);
    const commentLength = zip.readUInt16LE(centralCursor + 32);
    const localOffset = zip.readUInt32LE(centralCursor + 42);
    const nameStart = centralCursor + 46;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");

    expect(zip.readUInt32LE(localOffset)).toBe(LOCAL_FILE_HEADER);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, zip.subarray(contentStart, contentStart + compressedSize));

    centralCursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe("findAttachmentBasenameCollisions", () => {
  test("returns every collision sorted by basename and display path", () => {
    const collisions = findAttachmentBasenameCollisions([
      { path: "/repo/z/SKILL.md", displayPath: "z/SKILL.md" },
      { path: "/repo/b/README.md", displayPath: "b/README.md" },
      { path: "/repo/a/SKILL.md", displayPath: "a/SKILL.md" },
      { path: "/repo/a/README.md", displayPath: "a/README.md" },
      { path: "/repo/unique.txt", displayPath: "unique.txt" },
    ]);

    expect(collisions).toEqual([
      {
        basename: "README.md",
        attachments: [
          { path: "/repo/a/README.md", displayPath: "a/README.md" },
          { path: "/repo/b/README.md", displayPath: "b/README.md" },
        ],
      },
      {
        basename: "SKILL.md",
        attachments: [
          { path: "/repo/a/SKILL.md", displayPath: "a/SKILL.md" },
          { path: "/repo/z/SKILL.md", displayPath: "z/SKILL.md" },
        ],
      },
    ]);
  });
});

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
    expect(result.markdown).toContain("Lines: 1-1");
    expect(result.markdown).toContain('1 | console.log("hi")');
    expect(result.markdown).toContain("```");
    expect(result.composerText).not.toContain(DEFAULT_SYSTEM_PROMPT);
    expect(result.composerText).toContain("Explain the bug");
    expect(result.composerText).not.toContain("[SYSTEM]");
    expect(result.composerText).not.toContain("[USER]");
    expect(result.composerText).toContain("### File: a.txt");
    expect(result.composerText).toContain("Lines: 1-1");
    expect(result.composerText).toContain('1 | console.log("hi")');
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

  test("auto inline fallback bundles multiple text files as a ZIP", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-inline-fallback-zip-"));
    try {
      await fs.writeFile(path.join(tempDir, "one.txt"), "one", "utf8");
      await fs.writeFile(path.join(tempDir, "two.txt"), "two", "utf8");

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: ["one.txt", "two.txt"],
          browserAttachments: "auto",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachmentMode).toBe("inline");
      expect(result.attachments).toEqual([]);
      expect(result.fallback?.attachments).toHaveLength(1);
      expect(result.fallback?.attachments[0]?.displayPath).toMatch(/attachments-bundle\.zip$/);
      expect(result.fallback?.bundled?.format).toBe("zip");
      expect(result.fallback?.composerText).toContain("Extract it into a temporary directory");
      const entries = readStoredZipEntries(
        await fs.readFile(result.fallback!.attachments[0]!.path),
      );
      expect(entries.get("one.txt")?.toString("utf8")).toBe("one");
      expect(entries.get("two.txt")?.toString("utf8")).toBe("two");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("always mode forces uploads even when small", async () => {
    const options = buildOptions({
      prompt: "Explain the bug",
      file: ["a.txt"],
      browserAttachments: "always",
    });
    const tokenizedContents: string[] = [];
    const result = await assembleBrowserPrompt(options, {
      cwd: "/repo",
      readFilesImpl: async () => [{ path: "/repo/a.txt", content: "tiny" }],
      tokenizeImpl: (messages) => {
        const typed = messages as Array<{ content: string }>;
        tokenizedContents.push(...typed.map((message) => message.content));
        return fastTokenizer(messages);
      },
    });
    expect(result.attachmentMode).toBe("upload");
    expect(result.attachments).toEqual([
      expect.objectContaining({ path: "/repo/a.txt", displayPath: "a.txt" }),
    ]);
    expect(result.composerText).toBe("Explain the bug");
    expect(result.composerText).not.toContain("### File: a.txt");
    expect(tokenizedContents).toContain("### File: a.txt\n```\ntiny\n```");
    expect(tokenizedContents.some((content) => content.includes("1 | tiny"))).toBe(false);
    expect(result.fallback).toBeNull();
  });

  test("always mode rejects upload attachments with the same basename", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-duplicate-basename-"));
    const firstPath = path.join(tempDir, "first", "SKILL.md");
    const secondPath = path.join(tempDir, "second", "SKILL.md");
    try {
      await fs.mkdir(path.dirname(firstPath), { recursive: true });
      await fs.mkdir(path.dirname(secondPath), { recursive: true });
      await fs.writeFile(firstPath, "first");
      await fs.writeFile(secondPath, "second");

      await expect(
        assembleBrowserPrompt(
          buildOptions({
            file: [firstPath, secondPath],
            browserAttachments: "always",
          }),
          { cwd: tempDir, tokenizeImpl: fastTokenizer },
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('multiple files named "SKILL.md"'),
        details: {
          collisions: [{ basename: "SKILL.md", files: [firstPath, secondPath] }],
          files: [firstPath, secondPath],
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("auto mode rejects basename collisions when it selects upload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-auto-upload-collision-"));
    const firstPath = path.join(tempDir, "first", "SKILL.md");
    const secondPath = path.join(tempDir, "second", "SKILL.md");
    const firstUniquePath = path.join(tempDir, "first", "FIRST.md");
    const secondUniquePath = path.join(tempDir, "second", "SECOND.md");
    const largeContent = "x".repeat(31_000);
    try {
      await fs.mkdir(path.dirname(firstPath), { recursive: true });
      await fs.mkdir(path.dirname(secondPath), { recursive: true });
      await Promise.all([
        fs.writeFile(firstPath, largeContent),
        fs.writeFile(secondPath, largeContent),
        fs.writeFile(firstUniquePath, largeContent),
        fs.writeFile(secondUniquePath, largeContent),
      ]);

      const uploadControl = await assembleBrowserPrompt(
        buildOptions({
          file: [firstUniquePath, secondUniquePath],
          browserAttachments: "auto",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );
      expect(uploadControl.attachmentMode).toBe("upload");
      expect(uploadControl.fallback).toBeNull();

      await expect(
        assembleBrowserPrompt(
          buildOptions({
            file: [firstPath, secondPath],
            browserAttachments: "auto",
          }),
          { cwd: tempDir, tokenizeImpl: fastTokenizer },
        ),
      ).rejects.toMatchObject({
        details: {
          collisions: [{ basename: "SKILL.md", files: [firstPath, secondPath] }],
          files: [firstPath, secondPath],
        },
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("auto mode keeps tiny duplicate-basename text files inline", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-auto-inline-collision-"));
    const firstPath = path.join(tempDir, "first", "SKILL.md");
    const secondPath = path.join(tempDir, "second", "SKILL.md");
    try {
      await fs.mkdir(path.dirname(firstPath), { recursive: true });
      await fs.mkdir(path.dirname(secondPath), { recursive: true });
      await fs.writeFile(firstPath, "first");
      await fs.writeFile(secondPath, "second");

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: [firstPath, secondPath],
          browserAttachments: "auto",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachmentMode).toBe("inline");
      expect(result.attachments).toEqual([]);
      expect(result.composerText).toContain("### File: first/SKILL.md");
      expect(result.composerText).toContain("1 | first");
      expect(result.composerText).toContain("### File: second/SKILL.md");
      expect(result.composerText).toContain("1 | second");
      expect(result.fallback?.attachments).toHaveLength(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("never mode keeps duplicate-basename text files inline", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-never-inline-collision-"));
    const firstPath = path.join(tempDir, "first", "SKILL.md");
    const secondPath = path.join(tempDir, "second", "SKILL.md");
    try {
      await fs.mkdir(path.dirname(firstPath), { recursive: true });
      await fs.mkdir(path.dirname(secondPath), { recursive: true });
      await fs.writeFile(firstPath, "first");
      await fs.writeFile(secondPath, "second");

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: [firstPath, secondPath],
          browserAttachments: "never",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachmentMode).toBe("inline");
      expect(result.attachments).toEqual([]);
      expect(result.composerText).toContain("### File: first/SKILL.md");
      expect(result.composerText).toContain("1 | first");
      expect(result.composerText).toContain("### File: second/SKILL.md");
      expect(result.composerText).toContain("1 | second");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("bundling resolves duplicate attachment basenames", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bundled-collision-"));
    const firstPath = path.join(tempDir, "first", "SKILL.md");
    const secondPath = path.join(tempDir, "second", "SKILL.md");
    try {
      await fs.mkdir(path.dirname(firstPath), { recursive: true });
      await fs.mkdir(path.dirname(secondPath), { recursive: true });
      await fs.writeFile(firstPath, "first");
      await fs.writeFile(secondPath, "second");

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: [firstPath, secondPath],
          browserAttachments: "always",
          browserBundleFiles: true,
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.bundled?.format).toBe("text");
      const bundleText = await fs.readFile(result.attachments[0]!.path, "utf8");
      expect(bundleText).toContain("### File: first/SKILL.md");
      expect(bundleText).toContain("1 | first");
      expect(bundleText).toContain("### File: second/SKILL.md");
      expect(bundleText).toContain("1 | second");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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

  test("respects custom cwd and multiple inline files", async () => {
    const options = buildOptions({
      file: ["docs/one.md", "docs/two.md"],
      browserAttachments: "never",
    });
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

  test("rejects raw files when browser attachments are disabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-disabled-raw-upload-"));
    try {
      await fs.writeFile(path.join(tempDir, "archive.zip"), Buffer.from("PK"));
      await expect(
        assembleBrowserPrompt(
          buildOptions({
            file: ["archive.zip"],
            browserAttachments: "never",
          }),
          { cwd: tempDir, tokenizeImpl: fastTokenizer },
        ),
      ).rejects.toThrow(/cannot be pasted inline/i);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("explicit text format skips empty bundles for raw-only inputs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-raw-text-bundle-"));
    try {
      const archivePath = path.join(tempDir, "archive.zip");
      await fs.writeFile(archivePath, Buffer.from("PK"));
      const result = await assembleBrowserPrompt(
        buildOptions({
          file: ["archive.zip"],
          browserAttachments: "always",
          browserBundleFiles: true,
          browserBundleFormat: "text",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachments).toEqual([
        expect.objectContaining({ path: archivePath, displayPath: "archive.zip" }),
      ]);
      expect(result.attachmentMode).toBe("upload");
      expect(result.bundled).toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("explicit text format keeps the legacy multi-file text bundle", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-explicit-text-bundle-"));
    try {
      await fs.writeFile(path.join(tempDir, "one.txt"), "one", "utf8");
      await fs.writeFile(path.join(tempDir, "two.txt"), "two", "utf8");
      const result = await assembleBrowserPrompt(
        buildOptions({
          file: ["one.txt", "two.txt"],
          browserAttachments: "always",
          browserBundleFormat: "text",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.txt$/);
      expect(result.bundled?.format).toBe("text");
      expect(result.composerText).toBe("Explain the bug");
      const bundleText = await fs.readFile(result.attachments[0]!.path, "utf8");
      expect(bundleText).toContain("### File: one.txt");
      expect(bundleText).toContain("1 | one");
      expect(bundleText).toContain("### File: two.txt");
      expect(bundleText).toContain("1 | two");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("explicit text format bundles text files to keep mixed uploads within the limit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-mixed-text-bundle-"));
    try {
      const textFiles = ["one.txt", "two.txt"];
      const rawFiles = Array.from({ length: 9 }, (_, index) => `archive-${index}.zip`);
      await Promise.all([
        ...textFiles.map((file) => fs.writeFile(path.join(tempDir, file), file, "utf8")),
        ...rawFiles.map((file) => fs.writeFile(path.join(tempDir, file), Buffer.from("PK"))),
      ]);
      const result = await assembleBrowserPrompt(
        buildOptions({
          file: [...textFiles, ...rawFiles],
          browserAttachments: "always",
          browserBundleFormat: "text",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachments).toHaveLength(10);
      expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.txt$/);
      expect(result.bundled?.format).toBe("text");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps ordinary raw uploads uncapped when no explicit file-size limit is set", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-raw-upload-default-size-"));
    try {
      const archivePath = path.join(tempDir, "archive.zip");
      await fs.writeFile(archivePath, Buffer.alloc(2 * 1024 * 1024));
      const result = await assembleBrowserPrompt(
        buildOptions({
          file: ["archive.zip"],
          browserAttachments: "always",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachments).toEqual([
        expect.objectContaining({ path: archivePath, sizeBytes: 2 * 1024 * 1024 }),
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects oversized in-memory ZIP bundles before reading source bytes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-zip-memory-limit-"));
    try {
      const archivePath = path.join(tempDir, "archive.zip");
      await fs.writeFile(archivePath, "");
      await fs.truncate(archivePath, 128 * 1024 * 1024 + 1);
      await expect(
        assembleBrowserPrompt(
          buildOptions({
            file: ["archive.zip"],
            browserAttachments: "always",
            browserBundleFiles: true,
          }),
          { cwd: tempDir, tokenizeImpl: fastTokenizer },
        ),
      ).rejects.toThrow(/in-memory limit/i);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects raw files that exceed the configured file-size limit before bundling", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-large-raw-upload-"));
    try {
      await fs.writeFile(path.join(tempDir, "archive.zip"), Buffer.alloc(5));
      await expect(
        assembleBrowserPrompt(
          buildOptions({
            file: ["archive.zip"],
            browserAttachments: "always",
            browserBundleFiles: true,
            maxFileSizeBytes: 4,
          }),
          { cwd: tempDir, tokenizeImpl: fastTokenizer },
        ),
      ).rejects.toThrow(/exceeds the 4-byte limit/i);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects too many raw uploads when explicit text format cannot bundle them", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-many-raw-uploads-"));
    try {
      const files = Array.from({ length: 11 }, (_, index) => `archive-${index}.zip`);
      await Promise.all(
        files.map((file) => fs.writeFile(path.join(tempDir, file), Buffer.from("PK"))),
      );
      await expect(
        assembleBrowserPrompt(
          buildOptions({
            file: files,
            browserAttachments: "always",
            browserBundleFormat: "text",
          }),
          { cwd: tempDir, tokenizeImpl: fastTokenizer },
        ),
      ).rejects.toThrow(/use --browser-bundle-format auto or zip/i);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("classifies package, disk-image, and office containers as raw uploads", () => {
    for (const file of ["package.deb", "package.rpm", "disk.iso", "slides.pptx", "book.epub"]) {
      expect(isRawUploadFile(file)).toBe(true);
    }
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

  test("auto bundles more than 10 text uploads as a ZIP", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-many-text-zip-bundle-"));
    try {
      const fileNames = Array.from({ length: 11 }, (_, i) => `file${i + 1}.txt`);
      await Promise.all(
        fileNames.map((file) =>
          fs.writeFile(path.join(tempDir, file), `content for ${file}`, "utf8"),
        ),
      );
      const tokenizedContents: string[] = [];
      const result = await assembleBrowserPrompt(
        buildOptions({ file: fileNames, browserAttachments: "always" }),
        {
          cwd: tempDir,
          tokenizeImpl: (messages) => {
            const typed = messages as Array<{ content: string }>;
            tokenizedContents.push(...typed.map((message) => message.content));
            return fastTokenizer(messages);
          },
        },
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.zip$/);
      expect(result.attachments[0]?.generatedBundle).toBe(true);
      const entries = readStoredZipEntries(await fs.readFile(result.attachments[0]!.path));
      expect(entries.size).toBe(11);
      expect(entries.get("file1.txt")?.toString("utf8")).toBe("content for file1.txt");
      expect(tokenizedContents.some((content) => content.includes("content for file1.txt"))).toBe(
        true,
      );
      expect(
        tokenizedContents.some((content) => content.includes("1 | content for file1.txt")),
      ).toBe(false);
      expect(result.composerText).toContain("Extract it into a temporary directory");
      expect(result.inlineFileCount).toBe(0);
      expect(result.bundled).toEqual({
        originalCount: 11,
        bundlePath: result.attachments[0]?.displayPath,
        format: "zip",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("auto bundles two text uploads as a ZIP", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-text-zip-bundle-"));
    try {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src", "a.ts"), "content for src/a.ts", "utf8");
      await fs.writeFile(path.join(tempDir, "src", "b.ts"), "content for src/b.ts", "utf8");
      const options = buildOptions({
        file: ["src/a.ts", "src/b.ts"],
        browserAttachments: "always",
      });
      const tokenizedContents: string[] = [];
      const result = await assembleBrowserPrompt(options, {
        cwd: tempDir,
        tokenizeImpl: (messages) => {
          const typed = messages as Array<{ content: string }>;
          tokenizedContents.push(...typed.map((message) => message.content));
          return fastTokenizer(messages);
        },
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.zip$/);
      expect(result.attachments[0]?.generatedBundle).toBe(true);
      expect(result.bundled).toEqual({
        originalCount: 2,
        bundlePath: result.attachments[0]?.displayPath,
        format: "zip",
      });
      const zipBytes = await fs.readFile(result.attachments[0]!.path);
      expect(zipBytes.subarray(0, 4).toString("hex")).toBe("504b0304");
      const entries = readStoredZipEntries(zipBytes);
      expect(entries.get("src/a.ts")?.toString("utf8")).toBe("content for src/a.ts");
      expect(entries.get("src/b.ts")?.toString("utf8")).toBe("content for src/b.ts");
      expect(zipBytes.toString("utf8")).not.toContain("1 | content for src/a.ts");
      expect(tokenizedContents.some((content) => content.includes("content for src/a.ts"))).toBe(
        true,
      );
      expect(
        tokenizedContents.some((content) => content.includes("1 | content for src/a.ts")),
      ).toBe(false);
      expect(result.composerText).toContain(
        "The attached `attachments-bundle.zip` contains 2 selected files",
      );
      expect(result.composerText).toContain("inspect the resulting file tree");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps native attachments alongside an automatic source ZIP", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-mixed-native-source-zip-"));
    try {
      await fs.writeFile(path.join(tempDir, "one.ts"), "export const one = 1;\n", "utf8");
      await fs.writeFile(path.join(tempDir, "two.ts"), "export const two = 2;\n", "utf8");
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      const imagePath = path.join(tempDir, "reference.png");
      await fs.writeFile(imagePath, imageBytes);

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: ["one.ts", "two.ts", "reference.png"],
          browserAttachments: "always",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachmentMode).toBe("bundle");
      expect(result.attachments).toHaveLength(2);
      const zipAttachment = result.attachments.find((attachment) => attachment.generatedBundle);
      expect(zipAttachment?.displayPath).toMatch(/attachments-bundle\.zip$/);
      expect(result.attachments).toContainEqual(
        expect.objectContaining({ path: imagePath, displayPath: "reference.png" }),
      );
      expect(result.bundled?.originalCount).toBe(2);
      const entries = readStoredZipEntries(await fs.readFile(zipAttachment!.path));
      expect(entries.get("one.ts")?.toString("utf8")).toBe("export const one = 1;\n");
      expect(entries.get("two.ts")?.toString("utf8")).toBe("export const two = 2;\n");
      expect(entries.has("reference.png")).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps native uploads direct when a source ZIP reduces the upload count to 10", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-source-zip-upload-cap-"));
    try {
      const textFiles = ["one.ts", "two.ts"];
      const rawFiles = Array.from({ length: 9 }, (_, index) => `archive-${index}.zip`);
      await Promise.all([
        ...textFiles.map((file) => fs.writeFile(path.join(tempDir, file), file, "utf8")),
        ...rawFiles.map((file) => fs.writeFile(path.join(tempDir, file), Buffer.from("PK"))),
      ]);

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: [...textFiles, ...rawFiles],
          browserAttachments: "always",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachments).toHaveLength(10);
      const zipAttachment = result.attachments.find((attachment) => attachment.generatedBundle);
      expect(zipAttachment?.displayPath).toMatch(/attachments-bundle\.zip$/);
      expect(result.bundled?.originalCount).toBe(2);
      expect(result.attachments.filter((attachment) => !attachment.generatedBundle)).toHaveLength(
        9,
      );
      const entries = readStoredZipEntries(await fs.readFile(zipAttachment!.path));
      expect([...entries.keys()].sort()).toEqual(textFiles);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("automatically folds native uploads into the ZIP when the upload cap still overflows", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-all-files-upload-cap-"));
    try {
      const textFiles = ["one.ts", "two.ts"];
      const rawFiles = Array.from({ length: 10 }, (_, index) => `archive-${index}.zip`);
      await Promise.all([
        ...textFiles.map((file) => fs.writeFile(path.join(tempDir, file), file, "utf8")),
        ...rawFiles.map((file, index) =>
          fs.writeFile(path.join(tempDir, file), Buffer.from(`PK-${index}`)),
        ),
      ]);

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: [...textFiles, ...rawFiles],
          browserAttachments: "always",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.zip$/);
      expect(result.bundled?.originalCount).toBe(12);
      const entries = readStoredZipEntries(await fs.readFile(result.attachments[0]!.path));
      expect([...entries.keys()].sort()).toEqual([...textFiles, ...rawFiles].sort());
      expect(entries.get("one.ts")?.toString("utf8")).toBe("one.ts");
      expect(entries.get("archive-9.zip")?.toString("utf8")).toBe("PK-9");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps multiple native attachments separate by default", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-native-uploads-"));
    try {
      const firstPath = path.join(tempDir, "first.png");
      const secondPath = path.join(tempDir, "second.pdf");
      await fs.writeFile(firstPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await fs.writeFile(secondPath, Buffer.from("%PDF-1.7\n", "utf8"));

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: ["first.png", "second.pdf"],
          browserAttachments: "always",
        }),
        { cwd: tempDir, tokenizeImpl: fastTokenizer },
      );

      expect(result.attachmentMode).toBe("upload");
      expect(result.bundled).toBeNull();
      expect(result.attachments).toEqual([
        expect.objectContaining({ path: firstPath, displayPath: "first.png" }),
        expect.objectContaining({ path: secondPath, displayPath: "second.pdf" }),
      ]);
      expect(result.composerText).toBe("Explain the bug");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("forced auto bundle uses ZIP and preserves archive bytes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-auto-zip-bundle-"));
    try {
      const notePath = path.join(tempDir, "note.txt");
      const archivePath = path.join(tempDir, "inner.zip");
      const noteBytes = Buffer.from("hello from text\n", "utf8");
      const archiveBytes = createStoredZip([
        { path: "binary.bin", content: Buffer.from([0, 1, 2, 3, 255, 254, 253, 128]) },
      ]);
      await fs.writeFile(notePath, noteBytes);
      await fs.writeFile(archivePath, archiveBytes);

      const result = await assembleBrowserPrompt(
        {
          ...buildOptions({
            file: ["note.txt", "inner.zip"],
            browserAttachments: "always",
            browserBundleFiles: true,
          }),
          browserBundleFormat: undefined,
        },
        {
          cwd: tempDir,
          tokenizeImpl: fastTokenizer,
        },
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.zip$/);
      expect(result.bundled).toEqual({
        originalCount: 2,
        bundlePath: result.attachments[0]?.displayPath,
        format: "zip",
      });
      const entries = readStoredZipEntries(await fs.readFile(result.attachments[0]!.path));
      expect(entries.get("note.txt")).toEqual(noteBytes);
      expect(entries.get("inner.zip")).toEqual(archiveBytes);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("forced auto bundle includes archives found by directory expansion", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-dir-zip-bundle-"));
    try {
      const sourceDir = path.join(tempDir, "source");
      const notePath = path.join(sourceDir, "note.txt");
      const archivePath = path.join(sourceDir, "inner.zip");
      const noteBytes = Buffer.from("hello from directory text\n", "utf8");
      const archiveBytes = createStoredZip([
        { path: "binary.bin", content: Buffer.from([0, 1, 2, 3, 255, 254, 253, 128]) },
      ]);
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(notePath, noteBytes);
      await fs.writeFile(archivePath, archiveBytes);

      const result = await assembleBrowserPrompt(
        {
          ...buildOptions({
            file: ["source"],
            browserAttachments: "always",
            browserBundleFiles: true,
          }),
          browserBundleFormat: undefined,
        },
        {
          cwd: tempDir,
          tokenizeImpl: fastTokenizer,
        },
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.zip$/);
      expect(result.bundled).toEqual({
        originalCount: 2,
        bundlePath: result.attachments[0]?.displayPath,
        format: "zip",
      });
      const entries = readStoredZipEntries(await fs.readFile(result.attachments[0]!.path));
      expect(entries.get("source/note.txt")).toEqual(noteBytes);
      expect(entries.get("source/inner.zip")).toEqual(archiveBytes);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("explicit ZIP bundle format preserves original bytes for all bundled files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-explicit-zip-bundle-"));
    try {
      const textPath = path.join(tempDir, "src", "a.ts");
      const gzipPath = path.join(tempDir, "artifact.gz");
      const textBytes = Buffer.from("export const value = 1;\n", "utf8");
      const gzipBytes = Buffer.from([0x1f, 0x8b, 0x08, 0, 0xff, 0xfe, 0xfd, 0xfc]);
      await fs.mkdir(path.dirname(textPath), { recursive: true });
      await fs.writeFile(textPath, textBytes);
      await fs.writeFile(gzipPath, gzipBytes);

      const result = await assembleBrowserPrompt(
        buildOptions({
          file: ["src/a.ts", "artifact.gz"],
          browserAttachments: "always",
          browserBundleFiles: true,
          browserBundleFormat: "zip",
        }),
        {
          cwd: tempDir,
          tokenizeImpl: fastTokenizer,
        },
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.zip$/);
      const entries = readStoredZipEntries(await fs.readFile(result.attachments[0]!.path));
      expect(entries.get("src/a.ts")).toEqual(textBytes);
      expect(entries.get("artifact.gz")).toEqual(gzipBytes);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
