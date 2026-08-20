import { describe, expect, it, vi } from "vitest";
import {
  runConversationExport,
  type ConversationObsidianFs,
} from "../../src/cli/conversationCommand.js";
import type { ConversationExport } from "../../src/browser/conversationExport.js";

function buildFakeObsidianExport(): ConversationExport {
  return {
    version: 2,
    engine: "api",
    source: {
      url: "https://chatgpt.com/c/obsidian-fixture-id",
      conversationId: "obsidian-fixture-id",
      targetId: "tab",
      exportedAt: "2026-01-01T00:00:00.000Z",
    },
    conversation: {
      title: "Obsidian CLI fixture",
      createTime: "2025-01-01T00:00:00.000Z",
      updateTime: "2025-01-01T00:05:00.000Z",
      nodeCount: 3,
      branchNodesSkipped: 0,
    },
    records: [
      {
        ordinal: 0,
        turnIndex: 1,
        role: "user",
        turnId: "u1",
        messageIds: ["u1"],
        text: "hi",
        textHash: "hash-u1",
        hiddenNodes: [],
        createTime: "2025-01-01T00:00:00.000Z",
      },
      {
        ordinal: 1,
        turnIndex: 2,
        role: "assistant",
        turnId: "a1",
        messageIds: ["a1"],
        text: "hello",
        markdown: "hello",
        textHash: "hash-a1",
        hiddenNodes: [],
        createTime: "2025-01-01T00:00:05.000Z",
        segments: [{ messageId: "a1", contentType: "text", text: "hello" }],
      },
    ],
    fingerprint: "obsidian-fixture-fingerprint",
    complete: true,
    missingTurnIndices: [],
  };
}

function buildFakeObsidianFs(existingEntries: string[] = []): ConversationObsidianFs & {
  writes: Map<string, string>;
  mkdirs: string[];
} {
  const writes = new Map<string, string>();
  const mkdirs: string[] = [];
  return {
    writes,
    mkdirs,
    async mkdir(dirPath) {
      mkdirs.push(dirPath);
    },
    async writeFile(filePath, content) {
      writes.set(filePath, content);
    },
    async readdir(dirPath) {
      void dirPath;
      if (existingEntries.length === 0) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return existingEntries;
    },
  };
}

describe("runConversationExport stdout purity", () => {
  it("writes only the rendered export to stdout when no --output is given", async () => {
    const fixed: ConversationExport = {
      version: 1,
      source: {
        url: "https://chatgpt.com/c/thread-1",
        conversationId: "thread-1",
        targetId: "tab",
        exportedAt: "2026-01-01T00:00:00.000Z",
      },
      records: [
        { ordinal: 0, role: "user", text: "hi", textHash: "hash-0" },
        { ordinal: 1, role: "assistant", text: "hello", textHash: "hash-1" },
      ],
      fingerprint: "export-hash",
      complete: true,
    };
    const exporter = vi.fn().mockResolvedValue(fixed);
    const chunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(chunk.toString());
      return true;
    });
    try {
      await runConversationExport({ format: "json" }, exporter);
    } finally {
      writeSpy.mockRestore();
    }
    expect(exporter).toHaveBeenCalledOnce();
    const parsed = JSON.parse(chunks.join("")) as ConversationExport;
    expect(parsed).toEqual(fixed);
  });

  it("writes the untouched backend-api body for --format raw", async () => {
    const raw = { title: "raw fixture", mapping: { m1: { id: "m1" } } };
    const fixed: ConversationExport = {
      version: 2,
      engine: "api",
      source: {
        url: "https://chatgpt.com/c/thread-1",
        conversationId: "thread-1",
        targetId: "tab",
        exportedAt: "2026-01-01T00:00:00.000Z",
      },
      records: [],
      fingerprint: "export-hash",
      complete: true,
      missingTurnIndices: [],
      raw,
    };
    const exporter = vi.fn().mockResolvedValue(fixed);
    const chunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(chunk.toString());
      return true;
    });
    try {
      await runConversationExport({ format: "raw" }, exporter);
    } finally {
      writeSpy.mockRestore();
    }
    expect(exporter).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "api", includeRaw: true }),
    );
    expect(JSON.parse(chunks.join(""))).toEqual(raw);
  });

  it("rejects --format raw with --source dom", async () => {
    const exporter = vi.fn();
    await expect(runConversationExport({ format: "raw", engine: "dom" }, exporter)).rejects.toThrow(
      /--source api/,
    );
    expect(exporter).not.toHaveBeenCalled();
  });

  it("routes --source dom through to the exporter", async () => {
    const fixed: ConversationExport = {
      version: 1,
      engine: "dom",
      source: {
        url: "https://chatgpt.com/c/thread-1",
        conversationId: "thread-1",
        targetId: "tab",
        exportedAt: "2026-01-01T00:00:00.000Z",
      },
      records: [{ ordinal: 0, role: "user", text: "hi", textHash: "hash-0" }],
      fingerprint: "export-hash",
      complete: true,
    };
    const exporter = vi.fn().mockResolvedValue(fixed);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runConversationExport({ format: "json", engine: "dom" }, exporter);
    } finally {
      writeSpy.mockRestore();
    }
    expect(exporter).toHaveBeenCalledWith(expect.objectContaining({ engine: "dom" }));
  });
});

describe("runConversationExport obsidian format", () => {
  it("rejects --format obsidian without --out", async () => {
    const exporter = vi.fn();
    await expect(runConversationExport({ format: "obsidian" }, exporter)).rejects.toThrow(/--out/);
    expect(exporter).not.toHaveBeenCalled();
  });

  it("rejects --format obsidian with --source dom", async () => {
    const exporter = vi.fn();
    await expect(
      runConversationExport(
        { format: "obsidian", output: "/vault/00_Inbox", engine: "dom" },
        exporter,
      ),
    ).rejects.toThrow(/--source api/);
    expect(exporter).not.toHaveBeenCalled();
  });

  it("writes the expected relative paths through the injected fs and keeps stdout empty", async () => {
    const exporter = vi.fn().mockResolvedValue(buildFakeObsidianExport());
    const fakeFs = buildFakeObsidianFs();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runConversationExport(
        {
          format: "obsidian",
          output: "/vault/00_Inbox",
          timezone: "UTC",
          captured: "2026-08-20",
          folder: "ChatGPT-cli-fixture",
        },
        exporter,
        fakeFs,
      );
      // Assert spy call history before mockRestore() clears it in the finally block.
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Wrote obsidian vault: 2 files"),
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    expect([...fakeFs.writes.keys()].sort()).toEqual([
      "/vault/00_Inbox/ChatGPT-cli-fixture/001-2025-01-01-turn-001.md",
      "/vault/00_Inbox/ChatGPT-cli-fixture/INDEX.md",
    ]);
    expect(
      fakeFs.writes.get("/vault/00_Inbox/ChatGPT-cli-fixture/001-2025-01-01-turn-001.md"),
    ).toContain("hello");
  });

  it("refuses to write into an existing non-empty folder unless --force", async () => {
    const exporter = vi.fn().mockResolvedValue(buildFakeObsidianExport());
    const fakeFs = buildFakeObsidianFs(["some-existing-file.md"]);
    await expect(
      runConversationExport(
        { format: "obsidian", output: "/vault/00_Inbox", folder: "ChatGPT-cli-fixture" },
        exporter,
        fakeFs,
      ),
    ).rejects.toThrow(/--force/);
    expect(fakeFs.writes.size).toBe(0);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runConversationExport(
        {
          format: "obsidian",
          output: "/vault/00_Inbox",
          folder: "ChatGPT-cli-fixture",
          force: true,
        },
        exporter,
        fakeFs,
      );
    } finally {
      stderrSpy.mockRestore();
    }
    expect(fakeFs.writes.size).toBe(2);
  });

  it("defaults the folder name to ChatGPT-<first 8 chars of conversation id>", async () => {
    const exporter = vi.fn().mockResolvedValue(buildFakeObsidianExport());
    const fakeFs = buildFakeObsidianFs();
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runConversationExport(
        { format: "obsidian", output: "/vault/00_Inbox" },
        exporter,
        fakeFs,
      );
    } finally {
      stderrSpy.mockRestore();
    }
    expect([...fakeFs.writes.keys()]).toEqual(
      expect.arrayContaining([expect.stringContaining("/vault/00_Inbox/ChatGPT-obsidian/")]),
    );
  });
});
