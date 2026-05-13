// Single typed registry of every robot-facing Oracle CLI surface.
//
// The bead asks for `oracle robot-docs --json` to be "auto-generated
// from existing command definitions, not hand-written". The honest
// shape of that promise in a Commander.js codebase is: keep one typed
// declaration of every command in this file, and have every consumer
// (the CLI envelope emitter, the test suite, README/ROBOTS renderers)
// read from it. That eliminates the README↔ROBOTS↔implementation
// drift the bead is worried about — the prose is the OUTPUT, not the
// source.
//
// Each entry carries the v18 robot metadata the spec requires
// (`name`, `command`, `paid_calls`, `dry_run`, `required_env`,
// `output_schema_version`, `recovery_fields`, optional `mock_command`)
// plus a short non-prose `purpose`. Tests at
// `tests/cli/robotDocs.test.ts` assert every bead-required command is
// present and that the recovery_fields list stays aligned with
// `robot_surface.v1`.

import {
  CAPABILITY_LEASE_SCHEMA_VERSION,
} from "../oracle/v18/capability_lease.js";
import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  BROWSER_LEASE_SCHEMA_VERSION,
  JSON_ENVELOPE_SCHEMA_VERSION,
  PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_SCHEMA_VERSION,
  REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
  ROBOT_SURFACE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
} from "../oracle/v18/index.js";
import { ORACLE_CAPABILITIES_SCHEMA_VERSION } from "../oracle/capabilities/registry.js";

export const ORACLE_ROBOT_TOOL_NAME = "oracle" as const;

/** v18 recovery fields every failure envelope must surface. */
export const ROBOT_ERROR_FIELDS_REQUIRED: readonly string[] = Object.freeze([
  "blocked_reason",
  "next_command",
  "fix_command",
  "retry_safe",
]);

/** Extended recovery fields surfaced when present. */
export const ROBOT_RECOVERY_FIELDS: readonly string[] = Object.freeze([
  "blocked_reason",
  "next_command",
  "fix_command",
  "retry_safe",
  "required_env",
  "docs_url_or_path",
]);

export interface RobotCommandEntry {
  /** Stable kebab-case identifier; matches the bundle's robots.json convention. */
  readonly name: string;
  /** Exact invocation a robot caller should run. */
  readonly command: string;
  /** Free-form mock invocation; useful for development rehearsal scripts. */
  readonly mock_command?: string;
  /** One-sentence non-prose purpose. */
  readonly purpose: string;
  /** Whether the command can spend money on live providers. */
  readonly paid_calls: boolean;
  /** Whether `--dry-run` is supported (true when no live work happens). */
  readonly dry_run: boolean;
  /** Environment variable NAMES (never values) the command may consult. */
  readonly required_env: readonly string[];
  /** v18 schema version the `data` field of the envelope conforms to. */
  readonly output_schema_version: string;
  /** Recovery fields the failure envelope must surface for this command. */
  readonly recovery_fields: readonly string[];
  /** Whether this surface touches the network. */
  readonly touches_network: boolean;
  /** Whether this surface launches/attaches Chrome. */
  readonly touches_chrome: boolean;
  /** Optional pointer for human-facing docs. */
  readonly docs_path?: string;
}

function entry(input: RobotCommandEntry): RobotCommandEntry {
  return Object.freeze({
    ...input,
    required_env: Object.freeze([...input.required_env]) as readonly string[],
    recovery_fields: Object.freeze([...input.recovery_fields]) as readonly string[],
  });
}

const ORACLE_REMOTE_ENVS: readonly string[] = ["ORACLE_REMOTE_HOST", "ORACLE_REMOTE_TOKEN"];

export const ROBOT_COMMANDS: readonly RobotCommandEntry[] = Object.freeze([
  entry({
    name: "capabilities",
    command: "oracle capabilities --json",
    mock_command: "oracle capabilities --json",
    purpose:
      "Static capability matrix (no live calls); the first command APR/vibe-planning should run.",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: ORACLE_CAPABILITIES_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
    docs_path: "README.md#capabilities",
  }),
  entry({
    name: "doctor",
    command: "oracle doctor --json",
    purpose: "Aggregate Oracle preflight (env, leases, evidence index, remote endpoint).",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "doctor-chatgpt",
    command: "oracle doctor chatgpt --json",
    purpose:
      "ChatGPT-specific provider doctor: selector manifest, picker labels, evidence readiness.",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "doctor-gemini",
    command: "oracle doctor gemini --json",
    purpose:
      "Gemini-specific provider doctor: Deep Think exposure, high-if-exposed strategy readiness.",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-plan",
    command: "oracle browser leases plan --providers chatgpt,gemini --json",
    mock_command: "oracle browser leases plan --providers chatgpt,gemini --json",
    purpose: "Plan the browser leases a multi-provider run would acquire (no acquisition).",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-status",
    command: "oracle browser leases status --json",
    purpose: "Inspect existing browser provider leases and their TTLs.",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-recover",
    command: "oracle browser leases recover --provider <chatgpt|gemini> --json",
    purpose: "Print safe recovery guidance for a stuck provider lease (advisory only).",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-acquire",
    command: "oracle browser leases acquire --provider <chatgpt|gemini> --json",
    purpose:
      "Acquire a browser provider lease before running a Pro / Deep Think browser session.",
    paid_calls: false,
    dry_run: false,
    required_env: [],
    output_schema_version: CAPABILITY_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-release",
    command: "oracle browser leases release --lease <id> --json",
    purpose: "Release a previously-acquired browser provider lease.",
    paid_calls: false,
    dry_run: false,
    required_env: [],
    output_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "evidence-show",
    command: "oracle evidence show <session> --json",
    purpose:
      "Print the redacted artifact index for a stored session; never includes raw prompt/output.",
    paid_calls: false,
    dry_run: true,
    required_env: ["ORACLE_HOME_DIR"],
    output_schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "evidence-verify",
    command: "oracle evidence verify <session> --json",
    purpose:
      "Verify indexed evidence artifact hashes and trust-critical fields against the v18 contract.",
    paid_calls: false,
    dry_run: true,
    required_env: ["ORACLE_HOME_DIR"],
    output_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "remote-doctor",
    command: "oracle remote doctor --json",
    purpose: "Probe the configured remote Oracle endpoint (TCP + /health).",
    paid_calls: false,
    dry_run: false,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: true,
    touches_chrome: false,
  }),
  entry({
    name: "remote-status",
    command: "oracle remote status --json",
    purpose:
      "Print the resolved remote endpoint config without touching the network (env presence flags only).",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "remote-attach",
    command: "oracle remote attach --host <host:port> --json",
    purpose: "Probe attach readiness against a caller-supplied remote host without proxying calls.",
    paid_calls: false,
    dry_run: false,
    required_env: ["ORACLE_REMOTE_TOKEN"],
    output_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: true,
    touches_chrome: false,
  }),
  entry({
    name: "robot-docs",
    command: "oracle robot-docs --json",
    purpose:
      "Emit this registry as a robot_surface.v1 envelope — the source of truth for ROBOTS.md.",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: ROBOT_SURFACE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
]);

const COMMAND_BY_NAME: ReadonlyMap<string, RobotCommandEntry> = new Map(
  ROBOT_COMMANDS.map((c) => [c.name, c]),
);

export function findRobotCommand(name: string): RobotCommandEntry | null {
  return COMMAND_BY_NAME.get(name) ?? null;
}

export function listRobotCommands(): readonly RobotCommandEntry[] {
  return ROBOT_COMMANDS;
}

export interface RobotSurfacePayload {
  readonly schema_version: typeof ROBOT_SURFACE_SCHEMA_VERSION;
  readonly bundle_version: typeof V18_BUNDLE_VERSION;
  readonly tool: typeof ORACLE_ROBOT_TOOL_NAME;
  readonly json_envelope_required: true;
  readonly error_fields_required: readonly string[];
  readonly robot_recovery_fields: readonly string[];
  readonly first_try_principle: string;
  readonly notes: string;
  readonly commands: readonly Record<string, unknown>[];
}

/**
 * Build the robot-surface payload from the registry. The result conforms
 * to v18 `robot_surface.v1` (typed-core: schema_version, tool, commands)
 * with bundle metadata + a `robot_recovery_fields` extension that
 * matches the canonical bundle's `robots.json` shape.
 */
export function buildRobotSurfacePayload(): RobotSurfacePayload {
  const commands = ROBOT_COMMANDS.map((cmd): Record<string, unknown> => ({
    name: cmd.name,
    command: cmd.command,
    purpose: cmd.purpose,
    paid_calls: cmd.paid_calls,
    dry_run: cmd.dry_run,
    required_env: [...cmd.required_env],
    output_schema_version: cmd.output_schema_version,
    recovery_fields: [...cmd.recovery_fields],
    touches_network: cmd.touches_network,
    touches_chrome: cmd.touches_chrome,
    ...(cmd.mock_command ? { mock_command: cmd.mock_command } : {}),
    ...(cmd.docs_path ? { docs_path: cmd.docs_path } : {}),
  }));
  return {
    schema_version: ROBOT_SURFACE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    tool: ORACLE_ROBOT_TOOL_NAME,
    json_envelope_required: true,
    error_fields_required: ROBOT_ERROR_FIELDS_REQUIRED,
    robot_recovery_fields: ROBOT_RECOVERY_FIELDS,
    first_try_principle:
      "The first command a coding agent guesses should work or redirect with a precise next command.",
    notes:
      "Oracle does not own the DeepSeek official API adapter for this workflow; APR does. Oracle continues to own browser routes and evidence.",
    commands,
  };
}

/** Cross-reference the provider_access_policy version so callers can grep one constant for compatibility. */
export const ROBOT_REGISTRY_COMPATIBLE_POLICY_VERSION = PROVIDER_ACCESS_POLICY_SCHEMA_VERSION;
