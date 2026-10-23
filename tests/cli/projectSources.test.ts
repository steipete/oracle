import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildProjectSourcesBrowserConfig,
  resolveProjectSourceFiles,
  runProjectSourcesCliCommand,
} from "../../src/cli/projectSources.js";
import { navigateToChatGPT } from "../../src/browser/actions/navigation.js";
import type { ChromeClient } from "../../src/browser/types.js";

const projectSourcesRunner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/browser/projectSourcesRunner.js", () => ({
  runBrowserProjectSources: projectSourcesRunner.run,
}));

describe("project sources CLI helpers", () => {
  const originalProfileDir = process.env.ORACLE_BROWSER_PROFILE_DIR;

  afterEach(() => {
    if (originalProfileDir === undefined) {
      delete process.env.ORACLE_BROWSER_PROFILE_DIR;
    } else {
      process.env.ORACLE_BROWSER_PROFILE_DIR = originalProfileDir;
    }
  });

  test("prints the project URL without userinfo, query or fragment in normal output", async () => {
    // The runner's first step is the shared navigation helper; here its navigation fails.
    projectSourcesRunner.run.mockImplementationOnce(
      async ({ chatgptUrl, log }: { chatgptUrl: string; log: (message: string) => void }) => {
        await navigateToChatGPT(
          {
            navigate: async () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }),
          } as unknown as ChromeClient["Page"],
          {} as ChromeClient["Runtime"],
          chatgptUrl,
          log,
        );
      },
    );
    const printed: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      printed.push(String(line));
    });
    try {
      await expect(
        runProjectSourcesCliCommand("list", {
          chatgptUrl:
            "https://user:SECRET_PASS@chatgpt.com/g/p/project?state=STATE_SENTINEL#FRAG_SENTINEL",
          verbose: false,
        }),
      ).rejects.toThrow(/Page did not load/);
    } finally {
      consoleLog.mockRestore();
    }
    const output = printed.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(output).toContain("Navigating to https://chatgpt.com/g/p/project");
    expect(output).not.toMatch(/SENTINEL|SECRET_PASS|tab=sources/);
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

  test("honors explicit cookie sync for a persistent manual-login profile", async () => {
    const config = await buildProjectSourcesBrowserConfig({
      options: {},
      projectUrl: "https://chatgpt.com/g/g-p-123/project?tab=sources",
      configuredBrowser: {
        manualLogin: true,
        manualLoginCookieSync: true,
      },
    });

    expect(config).toMatchObject({
      manualLogin: true,
      manualLoginCookieSync: true,
      cookieSync: true,
    });
  });

  test("honors explicit cookie sync for an ordinary temporary profile", async () => {
    const fromConfig = await buildProjectSourcesBrowserConfig({
      options: {},
      projectUrl: "https://chatgpt.com/g/g-p-123/project?tab=sources",
      configuredBrowser: { cookieSync: true },
    });
    const fromFlag = await buildProjectSourcesBrowserConfig({
      options: { browserCookieSync: true },
      projectUrl: "https://chatgpt.com/g/g-p-123/project?tab=sources",
      configuredBrowser: {},
    });

    expect(fromConfig.cookieSync).toBe(true);
    expect(fromFlag.cookieSync).toBe(true);
  });
});
