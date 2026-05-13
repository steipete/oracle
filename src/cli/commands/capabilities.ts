// `oracle capabilities --json` — first-preflight surface for APR /
// vibe-planning. Wraps the static capability registry in a
// `json_envelope.v1` and writes deterministic output to stdout. Strictly
// LOCAL: zero network calls, zero secret values printed (env var NAMES +
// presence flags only).

import type { Command } from "commander";

import {
  V18_BUNDLE_VERSION,
  createEnvelope,
  type JsonEnvelope,
} from "../../oracle/v18/index.js";
import {
  ORACLE_CAPABILITIES_SCHEMA_VERSION,
  buildCapabilityReport,
  type CapabilityReport,
} from "../../oracle/capabilities/registry.js";

export interface CapabilitiesCommandOptions {
  readonly json?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  readonly tty?: boolean;
}

export interface CapabilitiesCommandIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface CapabilitiesCommandResult {
  readonly envelope: JsonEnvelope;
  readonly report: CapabilityReport;
}

const NEXT_COMMAND_HEALTHY = "oracle doctor --json";

/**
 * Build the capability envelope without writing to stdout. Useful for
 * upstream callers (MCP, the aggregate `oracle doctor`) that consume
 * the typed result directly.
 */
export function buildCapabilitiesEnvelope(
  options: CapabilitiesCommandOptions = {},
): CapabilitiesCommandResult {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const report = buildCapabilityReport({ env, now, tty: options.tty });

  // Surface the highest-priority remediation as the envelope's
  // next_command / fix_command. Available-but-not-ready entries are
  // ranked first so the remote_browser env-var hint surfaces over
  // healthy entries.
  const ranked = [...report.capabilities].sort((a, b) => {
    const order: Record<string, number> = {
      blocked: 0,
      available: 1,
      ready: 2,
      unsupported: 3,
    };
    return (order[a.status] ?? 99) - (order[b.status] ?? 99);
  });
  const headline = ranked.find(
    (entry) => entry.fix_command != null || entry.next_command != null,
  );

  const envelope = createEnvelope({
    ok: true,
    data: report as unknown as Record<string, unknown>,
    meta: {
      bundle_version: V18_BUNDLE_VERSION,
      schema_version: ORACLE_CAPABILITIES_SCHEMA_VERSION,
      generated_at: report.generated_at,
      ci: report.ci,
      tty: report.tty,
    },
    next_command:
      headline?.next_command ??
      (report.counts.available > 0 ? "oracle browser doctor --json" : NEXT_COMMAND_HEALTHY),
    fix_command: headline?.fix_command ?? null,
    retry_safe: true,
    commands: {
      capabilities: "oracle capabilities --json",
      doctor: NEXT_COMMAND_HEALTHY,
      remote_doctor: "oracle remote doctor --json",
    },
  });
  return { envelope, report };
}

/**
 * Run `oracle capabilities`. Always returns a healthy envelope (ok=true);
 * individual entries advertise their own readiness. Output is canonical
 * JSON when `options.json` is set (the default for robot callers).
 */
export async function runCapabilities(
  options: CapabilitiesCommandOptions = {},
  io: CapabilitiesCommandIo = {},
): Promise<CapabilitiesCommandResult> {
  const result = buildCapabilitiesEnvelope(options);
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  if (options.json !== false) {
    write(`${JSON.stringify(result.envelope, null, 2)}\n`);
  } else {
    write(formatHuman(result));
  }
  return result;
}

function formatHuman(result: CapabilitiesCommandResult): string {
  const { report } = result;
  const lines: string[] = [];
  lines.push(`🧿 oracle capabilities (${report.bundle_version})`);
  lines.push(
    `generated_at=${report.generated_at}  ci=${report.ci}  tty=${report.tty}`,
  );
  lines.push("");
  for (const entry of report.capabilities) {
    lines.push(`[${entry.status.toUpperCase()}] ${entry.id}`);
    lines.push(`  ${entry.description}`);
    if (entry.next_command) {
      lines.push(`  next: ${entry.next_command}`);
    }
    if (entry.fix_command) {
      lines.push(`  fix : ${entry.fix_command}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function registerCapabilitiesCommand(program: Command): Command {
  return program
    .command("capabilities")
    .description(
      "Print Oracle's capability surface as json_envelope.v1 without any live provider calls.",
    )
    .option("--json", "Print machine-readable JSON envelope (default).", true)
    .option("--no-json", "Print a short human summary instead of JSON.")
    .action(async (commandOptions: { json?: boolean }) => {
      try {
        await runCapabilities({ json: commandOptions.json ?? true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`oracle capabilities failed: ${message}\n`);
        process.exitCode = 1;
      }
    });
}
