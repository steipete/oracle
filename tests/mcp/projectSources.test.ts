import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const loadUserConfig = vi.fn(async () => ({
  config: {
    browser: {
      chatgptUrl: "https://chatgpt.com/g/g-p-test/project",
    },
  },
  path: "/tmp/oracle-config.json",
  loaded: true,
}));
const resolveRemoteServiceConfig = vi.fn(() => ({}));
const runBrowserProjectSources = vi.fn(async () => ({
  status: "dry-run",
  operation: "add",
  projectUrl: "https://chatgpt.com/g/g-p-test/project?tab=sources",
  dryRun: true,
  plannedUploads: [],
  warnings: [],
  tookMs: 1,
}));

vi.mock("../../src/config.js", () => ({ loadUserConfig }));
vi.mock("../../src/remote/remoteServiceConfig.js", () => ({ resolveRemoteServiceConfig }));
vi.mock("../../src/browser/projectSourcesRunner.js", () => ({ runBrowserProjectSources }));

const { registerProjectSourcesTool } = await import("../../src/mcp/tools/projectSources.ts");

describe("project_sources MCP tool", () => {
  let handler: ((input: unknown) => Promise<unknown>) | null = null;
  const sendLoggingMessage = vi.fn(async () => undefined);

  beforeEach(() => {
    handler = null;
    loadUserConfig.mockClear();
    resolveRemoteServiceConfig.mockClear();
    runBrowserProjectSources.mockClear();
    sendLoggingMessage.mockClear();
    registerProjectSourcesTool({
      registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
        handler = fn;
      },
      server: { sendLoggingMessage },
    } as unknown as Parameters<typeof registerProjectSourcesTool>[0]);
    if (!handler) throw new Error("handler not registered");
  });

  test("requires explicit confirmation for persistent source mutations", async () => {
    const result = (await handler?.({
      operation: "add",
      files: ["/tmp/context.md"],
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirmMutation/i);
    expect(runBrowserProjectSources).not.toHaveBeenCalled();
  });

  test("allows dry-run add without confirmation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-mcp-"));
    try {
      const filePath = path.join(dir, "architecture.md");
      await writeFile(filePath, "shared project context\n", "utf8");

      const result = (await handler?.({
        operation: "add",
        files: [filePath],
        dryRun: true,
      })) as { structuredContent: { status: string; dryRun: boolean } };

      expect(runBrowserProjectSources).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "add",
          dryRun: true,
          files: [expect.objectContaining({ path: filePath })],
        }),
      );
      expect(result.structuredContent).toMatchObject({ status: "dry-run", dryRun: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
