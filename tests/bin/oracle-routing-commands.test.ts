import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("bin/oracle-cli preview and visibility routing", () => {
  test("oracle --help lists preview and visibility-status", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;

    expect(output).toContain("preview");
    expect(output).toContain("visibility-status");
  });

  test.each([
    ["preview", ["preview", "--help"]],
    ["status", ["status", "--help"]],
    ["visibility-status", ["visibility-status", "--help"]],
  ])("oracle %s --help exits successfully", async (_label, args) => {
    const { stdout, stderr } = await runOracle(args);
    const output = `${stdout}\n${stderr}`;

    expect(output).toContain("Usage:");
  });

  test("oracle preview action emits a json_envelope.v1 without a live call", async () => {
    const { stdout } = await runOracle(["preview", "--json"]);
    const envelope = parseJsonEnvelope(stdout);

    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      data: {
        schema_version: "oracle_preview.v1",
        preview_only: true,
        no_live_calls_made: true,
      },
    });
  });

  test("oracle visibility-status action emits a json_envelope.v1", async () => {
    const { stdout } = await runOracle([
      "visibility-status",
      "--profile",
      "balanced",
      "--slot",
      "chatgpt_pro_first_plan",
      "--json",
    ]);
    const envelope = parseJsonEnvelope(stdout);

    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      data: { schema_version: "oracle_visibility_status.v1" },
    });
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
    },
    timeout: 30_000,
  });
}
