import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("top-level --json errors dual-emit", () => {
  test("Codex Max rejection keeps human stderr and emits json_envelope stdout", async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-error-dual-"));
    try {
      const { code, stdout, stderr } = await runOracleFailure(
        ["--prompt", "Codex Max integration", "--model", "gpt-5.1-codex-max", "--json"],
        oracleHome,
      );
      const envelope = parseJsonEnvelope(stdout);

      expect(code).toBe(1);
      expect(stderr).toMatch(/codex-max is not available yet/i);
      expect(envelope).toMatchObject({
        schema_version: "json_envelope.v1",
        ok: false,
        status: "error",
        data: null,
        blocked_reason: "commander.invalidArgument",
        retry_safe: false,
        error: {
          code: "commander.invalidArgument",
          message: expect.stringMatching(/codex-max is not available yet/i),
        },
        errors: [
          {
            error_code: "commander.invalidArgument",
            message: expect.stringMatching(/codex-max is not available yet/i),
          },
        ],
      });
    } finally {
      await rm(oracleHome, { recursive: true, force: true });
    }
  });
});

function parseJsonEnvelope(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

interface ExecFailure extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number | string | null;
}

async function runOracleFailure(
  args: string[],
  oracleHome: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      {
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          OPENAI_API_KEY: "sk-integration",
          ORACLE_DISABLE_KEYTAR: "1",
          ORACLE_HOME_DIR: oracleHome,
        },
        timeout: 30_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as ExecFailure;
    const parsedCode =
      typeof failure.code === "number" ? failure.code : Number.parseInt(String(failure.code), 10);
    return {
      code: Number.isFinite(parsedCode) ? parsedCode : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
}
