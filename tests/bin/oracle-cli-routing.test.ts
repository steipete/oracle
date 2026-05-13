import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { listRobotCommands } from "../../src/cli/robotRegistry.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

const LEDGER_ROBOT_COMMANDS = [
  "oracle evidence ledger show <session> --json",
  "oracle evidence ledger verify <session> --json",
  "oracle evidence ledger export <session> --json",
] as const;

describe("bin/oracle-cli robot command routing", () => {
  test("oracle --help lists every robot JSON command", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;
    const expectedCommands = [
      ...listRobotCommands().map((entry) => entry.command),
      ...LEDGER_ROBOT_COMMANDS,
    ];

    for (const command of expectedCommands) {
      expect(output).toContain(command);
    }
  });
});

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
