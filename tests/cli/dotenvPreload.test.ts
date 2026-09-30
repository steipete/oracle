import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const preload = pathToFileURL(require.resolve("dotenv/config")).href;

describe("CLI dotenv preload contract", () => {
  test.each([false, true])(
    "loads quietly and preserves shell values (legacy path override: %s)",
    async (customPath) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "oracle-dotenv-"));
      try {
        const filename = path.join(cwd, customPath ? "custom env" : ".env");
        await writeFile(
          filename,
          'ORACLE_TEST_ENV_FILE="one\\ntwo"\nORACLE_TEST_ENV_KEEP=from-file\n',
        );
        const env: NodeJS.ProcessEnv = { ...process.env, ORACLE_TEST_ENV_KEEP: "from-shell" };
        delete env.ORACLE_TEST_ENV_FILE;
        for (const name of Object.keys(env)) {
          if (name.startsWith("DOTENV_")) delete env[name];
        }
        if (customPath) env.DOTENV_CONFIG_PATH = filename;
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            "--import",
            preload,
            "-e",
            "process.stdout.write(JSON.stringify([process.env.ORACLE_TEST_ENV_FILE, process.env.ORACLE_TEST_ENV_KEEP]))",
          ],
          { cwd, env },
        );
        expect(JSON.parse(stdout)).toEqual(["one\ntwo", "from-shell"]);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
