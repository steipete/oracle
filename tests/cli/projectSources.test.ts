import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildProjectSourcesBrowserConfig,
  resolveProjectSourceFiles,
} from "../../src/cli/projectSources.js";

describe("project sources CLI helpers", () => {
  const originalProfileDir = process.env.ORACLE_BROWSER_PROFILE_DIR;

  afterEach(() => {
    if (originalProfileDir === undefined) {
      delete process.env.ORACLE_BROWSER_PROFILE_DIR;
    } else {
      process.env.ORACLE_BROWSER_PROFILE_DIR = originalProfileDir;
    }
  });

  test("resolves files without reading their contents into memory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-test-"));
    try {
      await writeFile(path.join(dir, "context.md"), "PROJECT_SOURCE_OK\n", "utf8");
      const files = await resolveProjectSourceFiles(["context.md"], {
        cwd: dir,
        maxFileSizeBytes: 1_000_000,
      });
      expect(files).toEqual([
        expect.objectContaining({
          path: path.join(dir, "context.md"),
          displayPath: "context.md",
          sizeBytes: 18,
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("builds browser config without a model picker target", async () => {
    const config = await buildProjectSourcesBrowserConfig({
      options: {
        browserKeepBrowser: true,
        browserManualLogin: true,
        browserManualLoginProfileDir: "/tmp/oracle-profile",
      },
      projectUrl: "https://chatgpt.com/g/g-p-123/project?tab=sources",
      configuredBrowser: {
        desiredModel: "GPT-5.5 Pro",
        modelStrategy: "select",
      },
    });
    expect(config).toMatchObject({
      url: "https://chatgpt.com/g/g-p-123/project?tab=sources",
      chatgptUrl: "https://chatgpt.com/g/g-p-123/project?tab=sources",
      keepBrowser: true,
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
      desiredModel: null,
      modelStrategy: "ignore",
      researchMode: "off",
    });
  });

  test("uses ORACLE_BROWSER_PROFILE_DIR as the local signed-in profile for MCP-style calls", async () => {
    process.env.ORACLE_BROWSER_PROFILE_DIR = "/tmp/env-oracle-profile";
    const config = await buildProjectSourcesBrowserConfig({
      options: {},
      projectUrl: "https://chatgpt.com/g/g-p-123/project?tab=sources",
      configuredBrowser: {},
    });
    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginProfileDir: "/tmp/env-oracle-profile",
      cookieSync: false,
      desiredModel: null,
      modelStrategy: "ignore",
    });
  });
});
