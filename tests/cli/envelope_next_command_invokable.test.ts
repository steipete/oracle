import { Command } from "commander";
import { describe, expect, test } from "vitest";

import { registerCliCommands } from "../../src/cli/index.js";
import {
  runProtectedRunCommand,
  type ProtectedRunEnvelope,
} from "../../src/cli/commands/run/protected.js";

const FROZEN_TIME = "2026-05-13T00:00:00.000Z";

describe("protected run envelope command pointers", () => {
  test("emits registered lease commands for ChatGPT Pro and Gemini Deep Think", async () => {
    const chatgpt = await protectedEnvelope({
      provider: "chatgpt",
      engine: "browser",
      model: "chatgpt-pro-latest",
      chatgptPro: true,
      extendedReasoning: true,
      remoteBrowser: "preferred",
      evidence: "redacted",
      promptFile: "PROMPT.md",
      json: true,
    });
    const gemini = await protectedEnvelope({
      provider: "gemini",
      engine: "browser",
      model: "gemini-3.1-pro-deep-think",
      geminiDeepThink: true,
      geminiDeepThinkFallback: "fail",
      remoteBrowser: "required",
      evidence: "redacted",
      promptFile: "PROMPT.md",
      json: true,
    });

    expect(chatgpt.commands.lease).toBe(
      "oracle browser leases acquire --providers chatgpt --require pro --remote-browser preferred --ttl-seconds 1800 --json",
    );
    expect(gemini.commands.lease).toBe(
      "oracle browser leases acquire --providers gemini --require deep_think --remote-browser required --ttl-seconds 1800 --json",
    );

    const commands = [...commandPointers(chatgpt), ...commandPointers(gemini)];
    expect(commands.some((command) => command.startsWith("oracle chatgpt lease"))).toBe(false);
    expect(commands.some((command) => command.startsWith("oracle gemini lease"))).toBe(false);

    for (const command of commands) {
      await expectOracleCommandHelpValid(command);
    }
  });
});

async function protectedEnvelope(
  options: Parameters<typeof runProtectedRunCommand>[0],
): Promise<ProtectedRunEnvelope> {
  return runProtectedRunCommand(
    options,
    { now: () => new Date(FROZEN_TIME) },
    { stdout: () => undefined },
  );
}

function commandPointers(envelope: ProtectedRunEnvelope): Set<string> {
  const commands = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("oracle ")) {
      commands.add(value);
    }
  };

  add(envelope.next_command);
  add(envelope.fix_command);
  for (const value of Object.values(envelope.commands)) {
    add(value);
  }
  if (envelope.ok && envelope.data) {
    for (const value of Object.values(envelope.data.protected_route)) {
      add(value);
    }
  }
  return commands;
}

async function expectOracleCommandHelpValid(command: string): Promise<void> {
  const argv = splitCommand(command);
  expect(argv[0]).toBe("oracle");

  const program = new Command();
  program.name("oracle");
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerCliCommands(program);

  try {
    await program.parseAsync([...argv.slice(1), "--help"], { from: "user" });
  } catch (error) {
    if (isHelpDisplayed(error)) {
      return;
    }
    throw error;
  }
}

function splitCommand(command: string): string[] {
  return (command.match(/"([^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((token) => {
    if (token.startsWith('"') && token.endsWith('"')) {
      return JSON.parse(token) as string;
    }
    if (token.startsWith("'") && token.endsWith("'")) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function isHelpDisplayed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "commander.helpDisplayed"
  );
}
