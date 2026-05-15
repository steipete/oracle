import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { describe, expect, test } from "vitest";

import {
  checkDocsFlags,
  collectCommanderFlags,
  extractMarkdownFlags,
} from "../../src/cli/docsCheck.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const CLI_TIMEOUT = 15_000;

describe("docs check", () => {
  test("extracts documented flags without prefix fragments", () => {
    expect(
      extractMarkdownFlags(
        "Use `--no-azure`, `--http-timeout <ms>`, --browser-inline-cookies[(-file)], --remote-host/--remote-token, --browser-auto-reattach-delay/-interval/-timeout, and --browser-auto-reattach-*",
      ),
    ).toEqual([
      "--browser-auto-reattach-delay",
      "--browser-auto-reattach-interval",
      "--browser-auto-reattach-timeout",
      "--browser-inline-cookies",
      "--http-timeout",
      "--no-azure",
      "--remote-host",
      "--remote-token",
    ]);
  });

  test("collects root and subcommand flags from Commander", () => {
    const program = new Command();
    program.option("--no-azure");
    program.option("--[no-]background");
    program.command("session").option("--render");

    expect(collectCommanderFlags(program)).toEqual(
      new Set(["--help", "--version", "--no-azure", "--background", "--no-background", "--render"]),
    );
  });

  test("reports documented flags missing from CLI metadata", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-docs-check-"));
    await writeFile(
      path.join(tmp, "flags.md"),
      "Documented: `--known` and `--stale-flag`.",
      "utf8",
    );
    const program = new Command();
    program.option("--known");

    const result = await checkDocsFlags({
      command: program,
      cwd: tmp,
      paths: ["flags.md"],
    });

    expect(result.issues).toEqual([{ file: "flags.md", flag: "--stale-flag" }]);
  });

  test("checks Core consult flags against root options, not unrelated subcommands", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-docs-check-"));
    await writeFile(path.join(tmp, "flags.md"), "## Core consult flags\n`--json`\n", "utf8");
    const program = new Command();
    program.command("doctor").option("--json");

    const result = await checkDocsFlags({
      command: program,
      cwd: tmp,
      paths: ["flags.md"],
    });

    expect(result.issues).toEqual([
      { file: "flags.md", flag: "--json", section: "Core consult flags" },
    ]);
  });

  test("checks command examples against that command's options", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-docs-check-"));
    await writeFile(path.join(tmp, "flags.md"), "```bash\noracle status --json\n```\n", "utf8");
    const program = new Command();
    program.command("doctor").option("--json");
    program.command("status").option("--hours <hours>");

    const result = await checkDocsFlags({
      command: program,
      cwd: tmp,
      paths: ["flags.md"],
    });

    expect(result.issues).toEqual([{ file: "flags.md", flag: "--json", command: "oracle status" }]);
  });

  test(
    "honors custom docs path from the CLI",
    async () => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "oracle-docs-check-"));
      const missing = path.join(tmp, "missing.md");

      await expect(
        execFileAsync(
          process.execPath,
          [
            "--no-deprecation",
            "--import",
            "tsx",
            CLI_ENTRY,
            "docs",
            "check",
            "--docs-path",
            missing,
          ],
          { timeout: CLI_TIMEOUT },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`Docs check path not found: ${missing}`),
      });

      await rm(tmp, { recursive: true, force: true });
    },
    CLI_TIMEOUT,
  );
});
