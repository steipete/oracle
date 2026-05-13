import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("Gemini Deep Think canonical CLI flags", () => {
  test("oracle run accepts --provider gemini-deep-think as the protected Gemini route", async () => {
    const { stdout, stderr } = await runOracle([
      "run",
      "--provider",
      "gemini-deep-think",
      "--prompt",
      "SENTINEL_PRIVATE_PROMPT",
      "--json",
    ]);

    expect(`${stdout}\n${stderr}`).not.toMatch(/unknown option|too many arguments/i);
    const envelope = parseJsonEnvelope(stdout);
    expect(envelope).toMatchObject({
      ok: true,
      meta: { command: "oracle gemini run" },
      data: {
        provider: "gemini",
        engine: "browser",
        deep_think: true,
        prompt_source: { kind: "inline", redacted: true },
      },
    });
    expect(String(envelope.next_command)).toContain("--gemini-deep-think");
    expect(stdout).not.toContain("SENTINEL_PRIVATE_PROMPT");
  });

  test("root production command accepts generated Gemini protected-run flags", async () => {
    const { stdout, stderr } = await runOracle([
      "--engine",
      "browser",
      "--provider",
      "gemini",
      "--model",
      "gemini-3-pro-deep-think",
      "--gemini-deep-think",
      "--gemini-deep-think-fallback",
      "fail",
      "--remote-browser",
      "preferred",
      "--evidence",
      "redacted",
      "--prompt",
      "test",
      "--dry-run",
      "summary",
      "--json",
    ]);

    const output = `${stdout}\n${stderr}`;
    expect(output).not.toMatch(/unknown option '--provider'|unknown option '--gemini-deep-think'/i);
    expect(output).toContain("[preview] Oracle");
    expect(output).toContain("gemini-3-pro-deep-think");
  });
});

function parseJsonEnvelope(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

async function runOracle(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", CLI_ENTRYPOINT, ...args], {
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ORACLE_DISABLE_KEYTAR: "1",
      ORACLE_NO_DETACH: "1",
    },
    timeout: 30_000,
  });
}
