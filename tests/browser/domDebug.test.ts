import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureBrowserDiagnostics } from "../../src/browser/domDebug.js";
import type { BrowserLogger } from "../../src/browser/types.js";

const originalOracleHome = process.env.ORACLE_HOME_DIR;

afterEach(() => {
  if (originalOracleHome === undefined) {
    delete process.env.ORACLE_HOME_DIR;
  } else {
    process.env.ORACLE_HOME_DIR = originalOracleHome;
  }
});

describe("captureBrowserDiagnostics", () => {
  test("writes DOM and screenshot diagnostics into the session artifact directory", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-dom-debug-"));
    process.env.ORACLE_HOME_DIR = tmpHome;
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            url: "https://chatgpt.com/c/demo",
            title: "demo",
            turns: [{ role: "assistant", text: "visible answer" }],
          },
        },
      }),
    };
    const page = {
      captureScreenshot: vi
        .fn()
        .mockResolvedValue({ data: Buffer.from("png bytes").toString("base64") }),
    };
    const logger = vi.fn() as BrowserLogger;

    try {
      const result = await captureBrowserDiagnostics(
        runtime as never,
        logger,
        "assistant-timeout",
        {
          Page: page as never,
          sessionId: "debug-session",
        },
      );

      const domRelativePath = path.relative(tmpHome, result.domPath ?? "");
      const screenshotRelativePath = path.relative(tmpHome, result.screenshotPath ?? "");
      expect(domRelativePath.split(path.sep)).toEqual([
        "sessions",
        "debug-session",
        "artifacts",
        expect.stringMatching(/^assistant-timeout-.+\.dom\.json$/),
      ]);
      expect(screenshotRelativePath.split(path.sep)).toEqual([
        "sessions",
        "debug-session",
        "artifacts",
        expect.stringMatching(/^assistant-timeout-.+\.png$/),
      ]);
      await expect(fs.readFile(result.domPath ?? "", "utf8")).resolves.toContain("visible answer");
      await expect(fs.readFile(result.screenshotPath ?? "")).resolves.toEqual(
        Buffer.from("png bytes"),
      );
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
