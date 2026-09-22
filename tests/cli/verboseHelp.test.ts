import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
let oracleHome: string;

beforeAll(async () => {
  oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-help-"));
});
afterAll(async () => {
  await rm(oracleHome, { recursive: true, force: true });
});

async function help(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "bin/oracle-cli.ts"), ...args],
    {
      env: { ...process.env, ORACLE_HOME_DIR: oracleHome, ORACLE_FORCE_TUI: "0", NO_COLOR: "1" },
      timeout: 15_000,
    },
  );
  expect(await readdir(oracleHome)).toEqual([]);
  return stdout;
}

test.each([
  ["--help", "--verbose"],
  ["--verbose", "--help"],
  ["-h", "--verbose"],
])(
  "shows advanced help for %j",
  async (...args) => {
    const output = await help(args);
    expect(output).toContain("Usage:");
    expect(output).toContain("Advanced Options");
    expect(output).toContain("Browser Options");
    expect(output).toContain("--browser-cookie-path");
  },
  20_000,
);

test("keeps plain and subcommand help concise", async () => {
  expect(await help(["--help"])).not.toContain("Advanced Options");
  const subcommand = await help(["status", "--help", "--verbose"]);
  expect(subcommand).toContain("Usage:");
  expect(subcommand).not.toContain("Advanced Options");
}, 20_000);

test("keeps the explicit debug-help entrypoint", async () => {
  expect(await help(["--debug-help"])).toContain("Advanced Options");
}, 20_000);
