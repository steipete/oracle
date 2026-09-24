import { Command, Option } from "commander";
import { expect, test } from "vitest";
import { scopeSessionPathOption } from "../../src/cli/sessionPathParsing.js";

function cli() {
  const program = new Command()
    .option("--prompt <text>")
    .option("--model <name>")
    .addOption(new Option("--path <paths...>").default([]));
  program.command("session");
  program.command("status");
  return program;
}

test.each([
  ["--", "session"],
  ["--prompt", "session", "--path", "source.ts"],
  ["--path", "session", "source.ts"],
  ["status", "session", "--path"],
])("leaves non-session syntax unchanged: %j", (...args) => {
  const program = cli();
  expect(scopeSessionPathOption(program, args)).toEqual(args);
  expect(program.options.some((option) => option.long === "--path")).toBe(true);
});

test("preserves parsed root values and sources before scoping the boolean flag", () => {
  const program = cli();
  const args = ["--path", "source.ts", "--model", "chosen", "session", "id", "--path"];
  expect(scopeSessionPathOption(program, args)).toEqual(["session", "id", "--path"]);
  expect(program.opts()).toMatchObject({ path: ["source.ts"], model: "chosen" });
  expect(program.getOptionValueSource("model")).toBe("cli");
  expect(program.options.find((option) => option.long === "--path")?.required).toBe(false);
});

test("an option value containing the delimiter does not hide a real session command", () => {
  const program = cli();
  expect(scopeSessionPathOption(program, ["--prompt", "--", "session", "id", "--path"])).toEqual([
    "session",
    "id",
    "--path",
  ]);
  expect(program.opts().prompt).toBe("--");
});
