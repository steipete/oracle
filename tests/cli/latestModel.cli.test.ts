import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
test("CLI engine discovery preserves the browser Pro alias but rejects API dispatch", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-latest-cli-"));
  const env = {
    ...process.env,
    ORACLE_HOME_DIR: home,
    ORACLE_NO_DETACH: "1",
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    AZURE_OPENAI_ENDPOINT: "",
    ORACLE_ENGINE: "",
  };
  const command = [
    "--import",
    "tsx",
    "bin/oracle-cli.ts",
    "--model",
    "gpt-6-pro",
    "--prompt",
    "CLI alias regression proof",
    "--dry-run",
    "summary",
  ];
  try {
    const browser = await exec(process.execPath, [...command, "--engine", "browser"], { env });
    expect(browser.stdout).toContain("Latest");
    await expect(
      exec(process.execPath, [...command, "--engine", "api"], { env }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("not a model slug") });
    await expect(
      exec(
        process.execPath,
        [
          ...command.map((value) => (value === "--model" ? "--models" : value)),
          "--engine",
          "browser",
        ],
        { env },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("not a model slug") });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}, 30_000);
