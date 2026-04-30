import { describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("browser CLI default model", () => {
  test("dry-run targets GPT-5.5 Pro when browser engine has no explicit model", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-default-"));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--dry-run",
          "summary",
          "--engine",
          "browser",
          "--prompt",
          "Browser default check",
        ],
        {
          env: {
            ...process.env,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_HOME_DIR: oracleHome,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_DISABLE_KEYTAR: "1",
          },
        },
      );

      expect(stdout).toContain("browser mode (gpt-5.5-pro)");
    } finally {
      await rm(oracleHome, { recursive: true, force: true });
    }
  }, 15_000);

  test("dry-run normalizes legacy browser Pro aliases to GPT-5.5 Pro", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-alias-"));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--dry-run",
          "summary",
          "--engine",
          "browser",
          "--model",
          "gpt-5.2-pro",
          "--prompt",
          "Browser alias check",
        ],
        {
          env: {
            ...process.env,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_HOME_DIR: oracleHome,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_DISABLE_KEYTAR: "1",
          },
        },
      );

      expect(stdout).toContain("browser mode (gpt-5.5-pro)");
    } finally {
      await rm(oracleHome, { recursive: true, force: true });
    }
  }, 15_000);
});
