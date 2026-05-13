// `oracle robot-docs --json` — emits the typed robot registry as a v18
// `json_envelope.v1` whose `data` field is a `robot_surface.v1` payload.
//
// The bead's "auto-generated from existing command definitions" promise
// is delivered by sourcing the entire command list from
// `src/cli/robotRegistry.ts`; the CLI command, README renderers, and
// tests all read from the same array so README/ROBOTS prose cannot
// drift from the implementation. No live calls, no Chrome, no
// filesystem reads — pure metadata.

import type { Command } from "commander";

import {
  V18_BUNDLE_VERSION,
  createEnvelope,
  type JsonEnvelope,
} from "../../oracle/v18/index.js";
import {
  ROBOT_ERROR_FIELDS_REQUIRED,
  buildRobotSurfacePayload,
  type RobotSurfacePayload,
} from "../robotRegistry.js";

export interface RobotDocsCommandOptions {
  readonly json?: boolean;
}

export interface RobotDocsCommandIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface RobotDocsCommandResult {
  readonly envelope: JsonEnvelope;
  readonly payload: RobotSurfacePayload;
}

/**
 * Build the json_envelope.v1 wrapper around the robot_surface.v1
 * payload. Pure — no I/O. Useful for tests, MCP, and the doctor
 * preflight that prints `oracle robot-docs --json` as a next_command.
 */
export function buildRobotDocsEnvelope(): RobotDocsCommandResult {
  const payload = buildRobotSurfacePayload();
  const envelope = createEnvelope({
    ok: true,
    data: payload as unknown as Record<string, unknown>,
    meta: {
      bundle_version: V18_BUNDLE_VERSION,
      schema_version: payload.schema_version,
      tool: payload.tool,
      command_count: payload.commands.length,
    },
    next_command: "oracle capabilities --json",
    fix_command: null,
    retry_safe: true,
    warnings: [],
    commands: {
      capabilities: "oracle capabilities --json",
      doctor: "oracle doctor --json",
      robot_docs: "oracle robot-docs --json",
    },
  });
  return { envelope, payload };
}

export async function runRobotDocs(
  options: RobotDocsCommandOptions = {},
  io: RobotDocsCommandIo = {},
): Promise<RobotDocsCommandResult> {
  const result = buildRobotDocsEnvelope();
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  if (options.json !== false) {
    write(`${JSON.stringify(result.envelope, null, 2)}\n`);
  } else {
    write(formatHuman(result));
  }
  return result;
}

function formatHuman(result: RobotDocsCommandResult): string {
  const { payload } = result;
  const lines: string[] = [];
  lines.push(`🧿 oracle robot-docs (${payload.bundle_version})`);
  lines.push(
    `tool=${payload.tool}  json_envelope_required=${payload.json_envelope_required}`,
  );
  lines.push(`error_fields_required: ${payload.error_fields_required.join(", ")}`);
  lines.push("");
  for (const cmd of payload.commands) {
    const name = cmd.name as string;
    const command = cmd.command as string;
    const purpose = cmd.purpose as string;
    const paid = cmd.paid_calls as boolean;
    const dryRun = cmd.dry_run as boolean;
    lines.push(`• ${name}`);
    lines.push(`    ${command}`);
    lines.push(`    ${purpose}`);
    lines.push(`    paid_calls=${paid}  dry_run=${dryRun}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function registerRobotDocsCommand(program: Command): Command {
  return program
    .command("robot-docs")
    .description(
      "Emit the Oracle CLI command registry as a robot_surface.v1 envelope (no live calls).",
    )
    .option("--json", "Print machine-readable JSON envelope (default).", true)
    .option("--no-json", "Print a short human summary instead of JSON.")
    .action(async (commandOptions: { json?: boolean }) => {
      try {
        await runRobotDocs({ json: commandOptions.json ?? true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`oracle robot-docs failed: ${message}\n`);
        process.exitCode = 1;
      }
    });
}

/** Ensure callers can introspect what the envelope error contract demands. */
export { ROBOT_ERROR_FIELDS_REQUIRED };
