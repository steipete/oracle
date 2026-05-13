import type { Command } from "commander";
import {
  registerProtectedRunCommand,
  type ProtectedRunCommandDeps,
} from "./commands/run/protected.js";

export interface CliCommandDeps {
  protectedRun?: ProtectedRunCommandDeps;
}

export function registerCliCommands(program: Command, deps: CliCommandDeps = {}): Command {
  registerProtectedRunCommand(program, deps.protectedRun);
  return program;
}

export { registerProtectedRunCommand } from "./commands/run/protected.js";
