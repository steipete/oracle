import { Command } from "commander";
import { describe, expect, test, afterEach } from "vitest";
import { registerCliCommands } from "../../../src/cli/index.js";

const FROZEN_TIME = "2026-05-13T00:00:00.000Z";

afterEach(() => {
  process.exitCode = undefined;
});

describe("protected browser run command dispatch", () => {
  test("registers oracle run through the central CLI registrar", () => {
    const program = createProgram();
    registerCliCommands(program);

    expect(program.commands.map((command) => command.name())).toContain("run");
  });

  test("routes ChatGPT Pro protected run plans through oracle run", async () => {
    const { output, program } = createRegisteredProgram();

    await program.parseAsync(
      [
        "run",
        "--provider",
        "chatgpt",
        "--engine",
        "browser",
        "--model",
        "chatgpt-pro-latest",
        "--chatgpt-pro",
        "--extended-reasoning",
        "--remote-browser",
        "preferred",
        "--evidence",
        "redacted",
        "--prompt",
        "private prompt text",
        "--dry-run",
        "json",
        "--json",
      ],
      { from: "user" },
    );

    const envelope = JSON.parse(output.join(""));
    expect(envelope).toMatchObject({
      ok: true,
      meta: { command: "oracle chatgpt run", generated_at: FROZEN_TIME },
      data: {
        provider: "chatgpt",
        engine: "browser",
        protected_route: {
          run_command:
            "oracle run --engine browser --provider chatgpt --model chatgpt-pro-latest --chatgpt-pro --extended-reasoning --remote-browser preferred --evidence redacted --prompt <redacted> --json",
        },
      },
      commands: {
        run: "oracle run --engine browser --provider chatgpt --model chatgpt-pro-latest --chatgpt-pro --extended-reasoning --remote-browser preferred --evidence redacted --prompt <redacted> --json",
      },
    });
    expect(envelope.next_command).toBe(envelope.commands.run);
    expect(output.join("")).not.toContain("private prompt text");
  });

  test("routes Gemini Deep Think protected run plans through oracle run", async () => {
    const { output, program } = createRegisteredProgram();

    await program.parseAsync(
      [
        "run",
        "--provider",
        "gemini",
        "--engine",
        "browser",
        "--model",
        "gemini-3.1-pro-deep-think",
        "--gemini-deep-think",
        "--gemini-deep-think-fallback",
        "fail",
        "--remote-browser",
        "required",
        "--evidence",
        "redacted",
        "--prompt-file",
        "PROMPT.md",
        "--dry-run",
        "json",
        "--json",
      ],
      { from: "user" },
    );

    const envelope = JSON.parse(output.join(""));
    expect(envelope).toMatchObject({
      ok: true,
      meta: { command: "oracle gemini run", generated_at: FROZEN_TIME },
      data: {
        provider: "gemini",
        engine: "browser",
        protected_route: {
          run_command:
            "oracle run --engine browser --provider gemini --model gemini-3.1-pro-deep-think --gemini-deep-think --gemini-deep-think-fallback fail --remote-browser required --evidence redacted --prompt-file PROMPT.md --json",
        },
      },
      commands: {
        run: "oracle run --engine browser --provider gemini --model gemini-3.1-pro-deep-think --gemini-deep-think --gemini-deep-think-fallback fail --remote-browser required --evidence redacted --prompt-file PROMPT.md --json",
      },
    });
    expect(envelope.next_command).toBe(envelope.commands.run);
  });

  test("unsupported providers produce a structured dispatch blocker", async () => {
    const { output, program } = createRegisteredProgram();

    await program.parseAsync(
      ["run", "--provider", "claude", "--prompt", "private prompt text", "--json"],
      { from: "user" },
    );

    const envelope = JSON.parse(output.join(""));
    expect(envelope).toMatchObject({
      ok: false,
      blocked_reason: "protected_provider_required",
      retry_safe: false,
      errors: [
        {
          error_code: "protected_provider_required",
        },
      ],
    });
    expect(process.exitCode).toBe(1);
    expect(output.join("")).not.toContain("private prompt text");
  });

  test("provider route reaches typed protected-route blockers instead of commander errors", async () => {
    const { output, program } = createRegisteredProgram();

    await program.parseAsync(
      ["run", "--provider", "chatgpt", "--prompt", "private prompt text", "--json"],
      { from: "user" },
    );

    const envelope = JSON.parse(output.join(""));
    expect(envelope).toMatchObject({
      ok: false,
      blocked_reason: "chatgpt_pro_flag_required",
      retry_safe: false,
      meta: { command: "oracle chatgpt run" },
    });
    expect(process.exitCode).toBe(1);
    expect(output.join("")).not.toContain("private prompt text");
  });
});

function createRegisteredProgram(): { output: string[]; program: Command } {
  const output: string[] = [];
  const program = createProgram();
  registerCliCommands(program, {
    protectedRun: {
      now: () => new Date(FROZEN_TIME),
      stdout: (text) => output.push(text),
    },
  }).configureOutput({
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
  });
  const run = program.commands.find((command) => command.name() === "run");
  expect(run).toBeDefined();
  run!.configureOutput({
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
  });
  return { output, program };
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  return program;
}
