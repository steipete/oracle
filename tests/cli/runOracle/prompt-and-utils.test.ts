import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPrompt,
  renderPromptMarkdown,
  readFiles,
  createFileSections,
  MODEL_CONFIGS,
  buildRequestBody,
  extractTextOutput,
  formatUSD,
  formatNumber,
  formatElapsed,
  getFileTokenStats,
  printFileTokenStats,
} from "@src/oracle.ts";
import { collectPaths, parseIntOption } from "@src/cli/options.ts";
import { createTempFile } from "./helpers.ts";

const testNonWindows = process.platform === "win32" ? test.skip : test;

describe("buildPrompt", () => {
  test("includes attached file sections with relative paths", async () => {
    const { dir, filePath } = await createTempFile("hello from file");
    try {
      const prompt = buildPrompt("Base", [{ path: filePath, content: "hello from file" }], dir);
      expect(prompt).toContain("### File 1: sample.txt");
      expect(prompt).toContain("Lines: 1-1");
      expect(prompt).toContain("1 | hello from file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("renderPromptMarkdown", () => {
  test("emits markdown bundle with system and files", async () => {
    const { dir, filePath } = await createTempFile("rendered content");
    try {
      const markdown = await renderPromptMarkdown(
        {
          prompt: "Hello world",
          file: [filePath],
        },
        { cwd: dir },
      );
      expect(markdown).toContain("[SYSTEM]");
      expect(markdown).toContain("[USER]");
      expect(markdown).toContain("### File: sample.txt");
      expect(markdown).toContain("Lines: 1-1");
      expect(markdown).toContain("1 | rendered content");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("warns when render-markdown exceeds token threshold", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "oracle-warn-"));
    const filePath = path.join(cwd, "big.txt");
    const chunk = "a".repeat(50_000);
    await writeFile(filePath, chunk.repeat(4), "utf8"); // ~200k chars → ~50k tokens
    const logs: string[] = [];
    try {
      await renderPromptMarkdown(
        {
          prompt: "Hello world",
          file: [filePath],
        },
        { cwd },
      );
      const { warnIfOversizeBundle } = await import("../../../src/cli/bundleWarnings.ts");
      const warned = warnIfOversizeBundle(200_000, 196_000, (msg: string) => logs.push(msg));
      expect(warned).toBe(true);
      expect(logs.join("\n")).toMatch(/Warning: bundle is ~200,000 tokens/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("oracle utility helpers", () => {
  test("collectPaths flattens inputs and trims whitespace", () => {
    const result = collectPaths([" alpha, beta ", "gamma", ""]);
    expect(result).toEqual(["alpha", "beta", "gamma"]);
    const unchanged = collectPaths(undefined, ["start"]);
    expect(unchanged).toEqual(["start"]);
  });

  test("collectPaths honors multiple flags and comma-separated batches", () => {
    const initial = collectPaths(["src/docs", "tests,examples"], []);
    expect(initial).toEqual(["src/docs", "tests", "examples"]);
    const appended = collectPaths(["more", "assets,notes"], initial);
    expect(appended).toEqual(["src/docs", "tests", "examples", "more", "assets", "notes"]);
  });

  test("parseIntOption handles undefined and invalid values", () => {
    expect(parseIntOption(undefined)).toBeUndefined();
    expect(parseIntOption("42")).toBe(42);
    expect(() => parseIntOption("not-a-number")).toThrow("Value must be an integer.");
  });

  test("formatElapsed chooses human-friendly units", () => {
    expect(formatElapsed(150)).toBe("150ms");
    expect(formatElapsed(44_000)).toBe("44s");
    expect(formatElapsed(2 * 60 * 1000 + 21 * 1000)).toBe("2m 21s");
    expect(formatElapsed(44 * 60 * 1000 + 3 * 1000)).toBe("44m 3s");
    expect(formatElapsed(81 * 60 * 60 * 1000 + 23 * 60 * 1000)).toBe("81h 23m");
  });

  testNonWindows("readFiles deduplicates and expands directories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-"));
    try {
      const nestedDir = path.join(dir, "nested");
      await mkdir(nestedDir, { recursive: true });
      const nestedFile = path.join(nestedDir, "note.txt");
      await writeFile(nestedFile, "nested", "utf8");

      const duplicateFiles = await readFiles([nestedFile, nestedFile], { cwd: dir });
      expect(duplicateFiles).toHaveLength(1);
      expect(duplicateFiles[0].content).toBe("nested");

      const expandedFiles = await readFiles([dir], { cwd: dir });
      expect(expandedFiles.map((file) => path.basename(file.path))).toContain("note.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readFiles rejects immediately when a referenced file is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-missing-"));
    try {
      await expect(readFiles(["ghost.txt"], { cwd: dir })).rejects.toThrow(
        /Missing file or directory/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows("readFiles respects glob include/exclude syntax and size limits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-glob-"));
    try {
      const nestedDir = path.join(dir, "src", "nested");
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(dir, "src", "alpha.ts"), "alpha", "utf8");
      await writeFile(path.join(dir, "src", "beta.test.ts"), "beta", "utf8");
      await writeFile(path.join(nestedDir, "gamma.ts"), "gamma", "utf8");

      const files = await readFiles(["src/**/*.ts", "!src/**/*.test.ts"], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain("alpha.ts");
      expect(basenames).toContain("gamma.ts");
      expect(basenames).not.toContain("beta.test.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows("readFiles skips dotfiles by default when expanding directories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-dot-"));
    try {
      const dotFile = path.join(dir, ".env");
      const visibleFile = path.join(dir, "app.ts");
      await writeFile(dotFile, "SECRET=1", "utf8");
      await writeFile(visibleFile, "console.log(1)", "utf8");

      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain("app.ts");
      expect(basenames).not.toContain(".env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readFiles can opt-in to dotfiles with explicit globs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-dot-include-"));
    try {
      const dotFile = path.join(dir, ".env");
      await writeFile(dotFile, "SECRET=1", "utf8");

      const files = await readFiles(["**/.env"], { cwd: dir });
      expect(files).toHaveLength(1);
      expect(path.basename(files[0].path)).toBe(".env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows("readFiles honors .gitignore when present", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-gitignore-"));
    try {
      const gitignore = path.join(dir, ".gitignore");
      const ignoredFile = path.join(dir, "secret.log");
      const nestedIgnored = path.join(dir, "build", "asset.js");
      const keptFile = path.join(dir, "kept.txt");
      await mkdir(path.join(dir, "dist"), { recursive: true });
      await mkdir(path.join(dir, "build"), { recursive: true });
      await writeFile(gitignore, "secret.log\nbuild/\n", "utf8");
      await writeFile(ignoredFile, "should skip", "utf8");
      await writeFile(nestedIgnored, "ignored build asset", "utf8");
      await writeFile(keptFile, "keep me", "utf8");

      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain("kept.txt");
      expect(basenames).not.toContain("secret.log");
      expect(basenames).not.toContain("asset.js");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows("readFiles honors nested .gitignore files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-gitignore-nested-"));
    try {
      const subdir = path.join(dir, "dist");
      await mkdir(subdir, { recursive: true });
      await writeFile(path.join(subdir, ".gitignore"), "*.map\n", "utf8");
      const ignored = path.join(subdir, "bundle.js.map");
      const kept = path.join(subdir, "bundle.js");
      await writeFile(ignored, "ignored", "utf8");
      await writeFile(kept, "kept", "utf8");

      const files = await readFiles([path.join(dir, "dist")], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain("bundle.js");
      expect(basenames).not.toContain("bundle.js.map");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows(
    "readFiles only reads .gitignore files that can apply to the request",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-gitignore-scope-"));
      try {
        const pack = path.join(dir, "work", "pack");
        await mkdir(pack, { recursive: true });
        await mkdir(path.join(dir, "unrelated"), { recursive: true });
        await writeFile(path.join(dir, ".gitignore"), "**/*.log\n", "utf8");
        await writeFile(path.join(dir, "unrelated", ".gitignore"), "*.md\n", "utf8");
        await writeFile(path.join(pack, ".gitignore"), "skip.md\n", "utf8");
        await writeFile(path.join(pack, "a.md"), "alpha", "utf8");
        await writeFile(path.join(pack, "b.log"), "log", "utf8");
        await writeFile(path.join(pack, "skip.md"), "skip", "utf8");

        const { vi } = await import("vitest");
        const fsPromises = (await import("node:fs/promises")).default;
        const readSpy = vi.spyOn(fsPromises, "readFile");
        try {
          for (const input of [pack, path.join(pack, "*")]) {
            const files = await readFiles([input], { cwd: dir });
            expect(files.map((file) => path.basename(file.path))).toEqual(["a.md"]);
          }
          const readPaths = readSpy.mock.calls.map(([target]) => path.resolve(String(target)));
          expect(readPaths).toContain(path.join(dir, ".gitignore"));
          expect(readPaths).toContain(path.join(pack, ".gitignore"));
          expect(readPaths).not.toContain(path.join(dir, "unrelated", ".gitignore"));
        } finally {
          readSpy.mockRestore();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("readFiles combines bounded ignores with matching expansion roots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-combined-roots-"));
    try {
      const pack = path.join(dir, "pack");
      const build = path.join(pack, "build");
      const unrelatedIgnore = path.join(dir, "unrelated", ".gitignore");
      await mkdir(build, { recursive: true });
      await mkdir(path.dirname(unrelatedIgnore), { recursive: true });
      await writeFile(path.join(pack, ".gitignore"), "build/blocked.ts\n", "utf8");
      await writeFile(unrelatedIgnore, "*.md\n", "utf8");
      await writeFile(path.join(pack, "a.md"), "alpha", "utf8");
      await writeFile(path.join(build, "tool.ts"), "tool", "utf8");
      await writeFile(path.join(build, "blocked.ts"), "blocked", "utf8");
      await writeFile(path.join(build, "notes.md"), "ignored descendant", "utf8");

      const { vi } = await import("vitest");
      const fsPromises = (await import("node:fs/promises")).default;
      const readSpy = vi.spyOn(fsPromises, "readFile");
      try {
        const files = await readFiles(["pack/**/*.md", "pack/build/*.ts"], { cwd: dir });
        expect(files.map((file) => path.basename(file.path)).sort()).toEqual(["a.md", "tool.ts"]);
        const readPaths = readSpy.mock.calls.map(([target]) => path.resolve(String(target)));
        expect(readPaths).toContain(path.join(pack, ".gitignore"));
        expect(readPaths).not.toContain(unrelatedIgnore);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readFiles applies a .gitignore only inside its own directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-gitignore-prefix-"));
    try {
      await mkdir(path.join(dir, "foo"), { recursive: true });
      await mkdir(path.join(dir, "foobar"), { recursive: true });
      await writeFile(path.join(dir, "foo", ".gitignore"), "**/*.md\n", "utf8");
      await writeFile(path.join(dir, "foobar", "x.md"), "x", "utf8");
      await writeFile(path.join(dir, "foobar", "keep.txt"), "keep", "utf8");

      // `.` loads foo/.gitignore, so it exercises the matcher's path-boundary check.
      for (const input of ["foobar/*", "."]) {
        const files = await readFiles([input], { cwd: dir });
        expect(files.map((file) => path.basename(file.path)).sort()).toEqual(["keep.txt", "x.md"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows("readFiles applies ancestor .gitignore files with a relative cwd", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-gitignore-relative-"));
    try {
      const work = path.join(dir, "work");
      await mkdir(path.join(work, "pack"), { recursive: true });
      await writeFile(path.join(work, ".gitignore"), "**/*.log\n", "utf8");
      await writeFile(path.join(work, "pack", "a.md"), "alpha", "utf8");
      await writeFile(path.join(work, "pack", "private.log"), "private", "utf8");

      const cwd = path.relative(process.cwd(), work);
      for (const input of ["pack", "pack/*"]) {
        const files = await readFiles([input], { cwd });
        expect(files.map((file) => path.basename(file.path))).toEqual(["a.md"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows("readFiles does not read .gitignore files behind a symlinked dir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-gitignore-symlink-"));
    try {
      const real = path.join(dir, "real");
      await mkdir(real, { recursive: true });
      await writeFile(path.join(real, ".gitignore"), "skip.md\n", "utf8");
      await writeFile(path.join(real, "skip.md"), "skip", "utf8");
      await writeFile(path.join(real, "keep.txt"), "keep", "utf8");
      await symlink(real, path.join(dir, "link"), "dir");

      // Matches the cwd-wide walk, which never followed the link to real/.gitignore.
      const files = await readFiles(["link/*"], { cwd: dir });
      expect(files.map((file) => path.basename(file.path)).sort()).toEqual(["keep.txt", "skip.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readFiles skips default-ignored dirs when walking project roots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-ignore-default-"));
    try {
      const nodeModules = path.join(dir, "node_modules");
      await mkdir(nodeModules, { recursive: true });
      const ignoredFile = path.join(nodeModules, "leftpad.ts");
      const keptFile = path.join(dir, "src", "index.ts");
      await mkdir(path.dirname(keptFile), { recursive: true });
      await writeFile(ignoredFile, "ignored", "utf8");
      await writeFile(keptFile, "kept", "utf8");

      const logSpy = (await import("vitest")).vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const files = await readFiles(["**/*.ts"], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain("index.ts");
      expect(basenames).not.toContain("leftpad.ts");
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("node_modules"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows("readFiles allows explicitly passed default-ignored dirs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-allow-default-"));
    try {
      const nodeModules = path.join(dir, "node_modules");
      await mkdir(nodeModules, { recursive: true });
      const filePath = path.join(nodeModules, "package.json");
      await writeFile(filePath, '{"name":"ok"}', "utf8");

      const files = await readFiles([nodeModules], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain("package.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows(
    "readFiles ignores default-ignored ancestors above the requested directory or glob",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-ignored-ancestor-"));
      try {
        const pack = path.join(dir, "build", "pack");
        const cwd = path.join(dir, "work");
        await mkdir(path.join(pack, "node_modules"), { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(path.join(pack, "a.md"), "alpha", "utf8");
        await writeFile(path.join(pack, "b.md"), "beta", "utf8");
        await writeFile(path.join(pack, "node_modules", "dep.md"), "dep", "utf8");

        const { vi } = await import("vitest");
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        try {
          for (const input of [pack, path.join(pack, "**/*.md")]) {
            const files = await readFiles([input], { cwd });
            const basenames = files.map((file) => path.basename(file.path)).sort();
            expect(basenames).toEqual(["a.md", "b.md"]);
          }
          const logged = logSpy.mock.calls.flat().map((arg) => String(arg ?? ""));
          expect(logged.some((line) => line.includes("(matches build)"))).toBe(false);
          expect(logged.some((line) => line.includes("(matches node_modules)"))).toBe(true);
        } finally {
          logSpy.mockRestore();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  testNonWindows(
    "readFiles resolves overlapping roots and whitelisted ignored dirs from the requested root",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-root-edges-"));
      try {
        const dist = path.join(dir, "dist");
        await mkdir(path.join(dist, "sub"), { recursive: true });
        await writeFile(path.join(dist, ".gitignore"), "*.map\n", "utf8");
        await writeFile(path.join(dist, "a.ts"), "a", "utf8");
        await writeFile(path.join(dist, "sub", "b.ts"), "b", "utf8");
        const pack = path.join(dir, "build", "pack");
        await mkdir(pack, { recursive: true });
        await mkdir(path.join(dir, "a-much-longer-sibling-name"), { recursive: true });
        await writeFile(path.join(pack, "c.md"), "c", "utf8");

        const { vi } = await import("vitest");
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        try {
          // dist/ has its own .gitignore, so it stays whitelisted when the root sits above cwd.
          const fromDist = await readFiles(["../.."], { cwd: path.join(dist, "sub") });
          const distNames = fromDist.map((file) => path.basename(file.path));
          expect(distNames).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));

          // A root spelled with `..` must not outrank the deeper root that holds the file.
          const overlapping = await readFiles(
            [`${path.join(dir, "a-much-longer-sibling-name")}${path.sep}..${path.sep}`, pack],
            { cwd: path.join(dist, "sub") },
          );
          expect(overlapping.map((file) => path.basename(file.path))).toContain("c.md");
        } finally {
          logSpy.mockRestore();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  testNonWindows(
    "readFiles measures each file from the root of an input that matched it",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-root-attribution-"));
      try {
        await mkdir(path.join(dir, "build", "pack"), { recursive: true });
        await writeFile(path.join(dir, "kept.md"), "kept", "utf8");
        await writeFile(path.join(dir, "build", "notes.md"), "notes", "utf8");
        await writeFile(path.join(dir, "build", "tool.ts"), "tool", "utf8");
        await writeFile(path.join(dir, "build", "pack", "a.md"), "a", "utf8");

        const { vi } = await import("vitest");
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const names = async (inputs: string[]) =>
          (await readFiles(inputs, { cwd: dir, readContents: false }))
            .map((file) => path.relative(dir, file.path))
            .sort();
        try {
          // A deeper glob that matches nothing must not change what the broad glob selects.
          expect(await names(["**/*.md", "build/*.NO_MATCH"])).toEqual(["kept.md"]);
          // A deeper glob keeps its own match without admitting other files under build/.
          expect(await names(["**/*.md", "build/*.ts"])).toEqual(["build/tool.ts", "kept.md"]);
          // Brace alternatives get their own roots, like separate inputs.
          expect(await names(["{*.md,build/pack/*.md}"])).toEqual(
            await names(["*.md", "build/pack/*.md"]),
          );
          expect(await names(["*.md", "build/pack/*.md"])).toEqual(["build/pack/a.md", "kept.md"]);
        } finally {
          logSpy.mockRestore();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  testNonWindows("readFiles logs and skips default-ignored dirs under project roots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-ignore-logs-"));
    const ignoredDirs = ["node_modules", "dist", "coverage"];
    try {
      for (const ignored of ignoredDirs) {
        const ignoredDir = path.join(dir, ignored);
        await mkdir(ignoredDir, { recursive: true });
        await writeFile(path.join(ignoredDir, `${ignored}-ignored.txt`), "ignored", "utf8");
      }
      const keepFile = path.join(dir, "src", "keep.ts");
      await mkdir(path.dirname(keepFile), { recursive: true });
      await writeFile(keepFile, "keep", "utf8");

      const { vi } = await import("vitest");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));

      expect(basenames).toContain("keep.ts");
      for (const ignored of ignoredDirs) {
        expect(basenames.some((name) => name.includes(`${ignored}-ignored.txt`))).toBe(false);
        const logged = logSpy.mock.calls.flat().some((arg) => String(arg ?? "").includes(ignored));
        expect(logged).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readFiles rejects files larger than 1 MB", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-large-"));
    try {
      const largeFile = path.join(dir, "huge.bin");
      await writeFile(largeFile, "a".repeat(1_200_000), "utf8");
      await expect(readFiles([largeFile], { cwd: dir })).rejects.toThrow(/exceed the 1 MB limit/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readFiles accepts larger files when maxFileSizeBytes is raised", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-readfiles-large-override-"));
    try {
      const largeFile = path.join(dir, "huge.bin");
      await writeFile(largeFile, "a".repeat(1_200_000), "utf8");
      const files = await readFiles([largeFile], { cwd: dir, maxFileSizeBytes: 2_000_000 });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(largeFile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("createFileSections renders relative paths", () => {
    const sections = createFileSections(
      [{ path: "/tmp/example/file.txt", content: "contents" }],
      "/tmp/example",
    );
    expect(sections[0].displayPath).toBe("file.txt");
    expect(sections[0].sectionText).toContain("### File 1: file.txt");
    expect(sections[0].sectionText).toContain("```\ncontents\n```");
  });

  test("buildRequestBody respects search toggles", () => {
    const base = buildRequestBody({
      modelConfig: MODEL_CONFIGS["gpt-5.2-pro"],
      systemPrompt: "sys",
      userPrompt: "user",
      searchEnabled: false,
      maxOutputTokens: 222,
    });
    expect(base.tools).toBeUndefined();
    expect(base.max_output_tokens).toBe(222);

    const withSearch = buildRequestBody({
      modelConfig: MODEL_CONFIGS["gpt-5.1"],
      systemPrompt: "sys",
      userPrompt: "user",
      searchEnabled: true,
      maxOutputTokens: undefined,
    });
    expect(withSearch.tools).toEqual([{ type: "web_search_preview" }]);
    expect(withSearch.reasoning).toEqual({ effort: "high" });
  });

  test("extractTextOutput combines multiple event styles", () => {
    const responseWithOutputText = {
      output_text: ["First chunk", "Second chunk"],
      output: [],
    };
    expect(extractTextOutput(responseWithOutputText)).toBe("First chunk\nSecond chunk");

    const responseWithMessages = {
      output: [
        {
          type: "message",
          content: [
            { type: "text", text: "Hello" },
            { type: "output_text", text: "World" },
          ],
        },
        {
          type: "output_text",
          text: "!!!",
        },
      ],
    };
    expect(extractTextOutput(responseWithMessages)).toBe("Hello\nWorld\n!!!");
  });

  test("formatting helpers render friendly output", () => {
    expect(formatUSD(12.345)).toBe("$12.3450");
    expect(formatUSD(0.05)).toBe("$0.0500");
    expect(formatUSD(0.000123)).toBe("$0.0001");
    expect(formatUSD(Number.NaN)).toBe("n/a");

    expect(formatNumber(1000)).toBe("1,000");
    expect(formatNumber(4200, { estimated: true })).toBe("4,200 (est.)");
    expect(formatNumber(null)).toBe("n/a");

    expect(formatElapsed(12345)).toBe("12s");
    expect(formatElapsed(125000)).toBe("2m 5s");
  });

  test("getFileTokenStats orders files by tokens and reports totals", () => {
    const files = [
      { path: "/tmp/a.txt", content: "aaa" },
      { path: "/tmp/b.txt", content: "bbbbbb" },
    ];
    const tokenizerInputs: string[] = [];
    const tokenizer = (input: unknown) => {
      const text = String(input);
      tokenizerInputs.push(text);
      return text.length;
    };
    const { stats, totalTokens } = getFileTokenStats(files, {
      cwd: "/tmp",
      tokenizer,
      tokenizerOptions: {},
      inputTokenBudget: 100,
    });
    expect(totalTokens).toBeGreaterThan(0);
    expect(stats[0].displayPath).toBe("b.txt");
    expect(stats[1].displayPath).toBe("a.txt");
    expect(tokenizerInputs).toContain("### File 1: a.txt\nLines: 1-1\n```\n1 | aaa\n```");
    expect(tokenizerInputs).toContain("### File 2: b.txt\nLines: 1-1\n```\n1 | bbbbbb\n```");

    const logs: string[] = [];
    printFileTokenStats(
      { stats, totalTokens },
      { inputTokenBudget: 100, log: (msg: string) => logs.push(msg) },
    );
    expect(logs[0]).toBe("File Token Usage");
    expect(logs.some((line) => line.includes("Total:"))).toBe(true);
  });
});
