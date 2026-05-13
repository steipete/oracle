import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("bin/oracle-cli top-level --json error envelope", () => {
  test("unknown subcommand emits json_envelope.v1 failure without a stack trace", async () => {
    const { code, stdout, stderr } = await runOracleFailure([
      "evidence",
      "definitely-not-a-command",
      "--json",
    ]);
    const envelope = JSON.parse(stdout.trim()) as Record<string, unknown>;

    expect(code).toBe(1);
    expect(stderr).not.toContain("error: unknown command");
    expect(`${stdout}\n${stderr}`).not.toMatch(/\n\s+at\s+\S+/u);
    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: false,
      status: "error",
      data: null,
      blocked_reason: "commander.unknownCommand",
      retry_safe: false,
      next_command: "oracle --help",
      error: {
        code: "commander.unknownCommand",
        message: "error: unknown command 'definitely-not-a-command'",
        help: "Run `oracle --help` for usage.",
      },
      errors: [
        {
          error_code: "commander.unknownCommand",
          message: "error: unknown command 'definitely-not-a-command'",
        },
      ],
    });
  });
});

interface ExecFailure extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number | string | null;
}

async function runOracleFailure(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI_ENTRYPOINT, ...args],
      {
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          ORACLE_DISABLE_KEYTAR: "1",
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
