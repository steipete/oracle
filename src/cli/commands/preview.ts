// `oracle preview` — describe what a live call WOULD do, without making
// it. Pure static analysis backed by the v18 slot taxonomy + the static
// runtime estimates in `src/oracle/runtime_budget.ts`. Per oracle-6wd:
// no paid call during preview, ever; the surface emphasizes time /
// lease / session implications because exact provider cost is not
// knowable in advance.

import type { Command } from "commander";

import {
  V18_BUNDLE_VERSION,
  createEnvelope,
  type JsonEnvelope,
} from "../../oracle/v18/index.js";
import {
  estimateSlotRuntime,
  isApprovalSatisfied,
  type SlotRuntimeEstimate,
} from "../../oracle/runtime_budget.js";

export const ORACLE_PREVIEW_SCHEMA_VERSION = "oracle_preview.v1" as const;

export interface PreviewSlotInput {
  /** Workflow slot the caller is considering invoking. */
  readonly slot: string;
  /** Whether this is an optional reviewer slot. */
  readonly optional?: boolean;
  /** Whether the run's review quorum is already satisfied
   *  (optional reviewers can be skipped after quorum). */
  readonly quorum_satisfied?: boolean;
}

export interface PreviewCommandOptions {
  readonly profile: string;
  readonly slots: readonly PreviewSlotInput[];
  /** APR-supplied runtime budget for the call. Validated locally. */
  readonly budget?: unknown;
  /** Approval names the user has actively granted (`live_fanout`, …). */
  readonly approvalsPresent?: readonly string[];
  /** Whether a remote browser endpoint is currently configured. */
  readonly remote_browser_available?: boolean;
  /** Optional clock override for deterministic snapshots. */
  readonly now?: Date;
  /** When `false`, suppress the `--json` envelope (used by --no-json). */
  readonly json?: boolean;
}

export interface PreviewCommandIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface PreviewSlotEntry {
  readonly slot: string;
  readonly known: boolean;
  readonly family: string | null;
  readonly primary_risk: string;
  readonly paid_call: boolean;
  readonly typical_wall_seconds: number;
  readonly max_wall_seconds: number;
  readonly browser_required: boolean;
  readonly remote_browser_preferred: boolean;
  readonly evidence_required: boolean;
  readonly optional: boolean;
  readonly skippable_now: boolean;
  readonly blocked: boolean;
  readonly blockers: readonly string[];
  readonly next_command: string | null;
}

export interface PreviewTotals {
  readonly slot_count: number;
  readonly skippable_slot_count: number;
  readonly active_slot_count: number;
  readonly paid_call_count: number;
  readonly blocked_slot_count: number;
  readonly typical_wall_seconds: number;
  readonly max_wall_seconds: number;
}

export interface PreviewPayload {
  readonly schema_version: typeof ORACLE_PREVIEW_SCHEMA_VERSION;
  readonly bundle_version: typeof V18_BUNDLE_VERSION;
  readonly generated_at: string;
  readonly profile: string;
  readonly preview_only: true;
  readonly no_live_calls_made: true;
  readonly slots: readonly PreviewSlotEntry[];
  readonly totals: PreviewTotals;
  readonly approval_status: {
    readonly required: readonly string[];
    readonly missing: readonly string[];
    readonly satisfied: boolean;
  };
}

export interface PreviewResult {
  readonly envelope: JsonEnvelope;
  readonly payload: PreviewPayload;
}

function previewSlotEntry(
  input: PreviewSlotInput,
  estimate: SlotRuntimeEstimate | null,
  options: PreviewCommandOptions,
): PreviewSlotEntry {
  const blockers: string[] = [];
  let nextCommand: string | null = null;
  const optional = input.optional === true;
  const skippable =
    optional && input.quorum_satisfied === true; // optional reviewer after quorum can be skipped
  if (!estimate) {
    return {
      slot: input.slot,
      known: false,
      family: null,
      primary_risk: "none",
      paid_call: false,
      typical_wall_seconds: 0,
      max_wall_seconds: 0,
      browser_required: false,
      remote_browser_preferred: false,
      evidence_required: false,
      optional,
      skippable_now: skippable,
      blocked: !optional,
      blockers: optional ? [] : [`unknown slot "${input.slot}" — Oracle has no runtime estimate`],
      next_command: optional ? null : "oracle robot-docs --json",
    };
  }
  // Approvals (required for any paid_call slot under live_fanout policy).
  if (estimate.paid_call && !skippable) {
    const { satisfied, missing } = isApprovalSatisfied(options.budget, options.approvalsPresent ?? []);
    if (!satisfied && missing.includes("live_fanout")) {
      blockers.push("live_fanout approval is required but not present");
      nextCommand = "oracle capabilities --json  # confirm the run requires live_fanout";
    } else if (!satisfied) {
      blockers.push(`required approvals missing: ${missing.join(", ")}`);
    }
  }
  // Remote browser requirement.
  if (estimate.browser_required && estimate.remote_browser_preferred && !skippable) {
    if (options.remote_browser_available === false) {
      blockers.push(
        "remote browser endpoint not configured (set ORACLE_REMOTE_HOST + ORACLE_REMOTE_TOKEN)",
      );
      nextCommand = nextCommand ?? "oracle remote doctor --json";
    } else if (options.remote_browser_available === undefined) {
      blockers.push(
        "remote browser availability unknown; run `oracle remote doctor --json` to confirm",
      );
      nextCommand = nextCommand ?? "oracle remote doctor --json";
    }
  }
  return {
    slot: input.slot,
    known: true,
    family: estimate.family,
    primary_risk: estimate.primary_risk,
    paid_call: estimate.paid_call,
    typical_wall_seconds: estimate.typical_wall_seconds,
    max_wall_seconds: estimate.max_wall_seconds,
    browser_required: estimate.browser_required,
    remote_browser_preferred: estimate.remote_browser_preferred,
    evidence_required: estimate.evidence_required,
    optional,
    skippable_now: skippable,
    blocked: !skippable && blockers.length > 0,
    blockers,
    next_command: skippable ? null : nextCommand,
  };
}

function summarize(entries: readonly PreviewSlotEntry[]): PreviewTotals {
  let typical = 0;
  let max = 0;
  let paidCount = 0;
  let blockedCount = 0;
  let skippable = 0;
  let active = 0;
  for (const entry of entries) {
    if (entry.skippable_now) {
      skippable += 1;
      continue;
    }
    active += 1;
    typical += entry.typical_wall_seconds;
    if (entry.max_wall_seconds > max) max = entry.max_wall_seconds;
    if (entry.paid_call) paidCount += 1;
    if (entry.blocked) blockedCount += 1;
  }
  return {
    slot_count: entries.length,
    skippable_slot_count: skippable,
    active_slot_count: active,
    paid_call_count: paidCount,
    blocked_slot_count: blockedCount,
    typical_wall_seconds: typical,
    max_wall_seconds: max,
  };
}

export function buildPreviewPayload(options: PreviewCommandOptions): PreviewPayload {
  const now = options.now ?? new Date();
  const entries = options.slots.map((slotInput) =>
    previewSlotEntry(slotInput, estimateSlotRuntime(slotInput.slot), options),
  );
  const totals = summarize(entries);
  const { satisfied, missing } = isApprovalSatisfied(
    options.budget,
    options.approvalsPresent ?? [],
  );
  const required = (options.budget &&
    typeof options.budget === "object" &&
    Array.isArray((options.budget as Record<string, unknown>).required_approvals)
      ? ((options.budget as Record<string, unknown>).required_approvals as string[])
      : []) as readonly string[];
  return {
    schema_version: ORACLE_PREVIEW_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    generated_at: now.toISOString(),
    profile: options.profile,
    preview_only: true,
    no_live_calls_made: true,
    slots: entries,
    totals,
    approval_status: { required, missing, satisfied },
  };
}

export function buildPreviewEnvelope(options: PreviewCommandOptions): PreviewResult {
  const payload = buildPreviewPayload(options);
  // Headline blockers: pick the first blocked slot's next_command so
  // the robot caller has a single recovery hint at the envelope level.
  const headline = payload.slots.find((entry) => entry.blocked);
  const envelope = createEnvelope({
    ok: true,
    data: payload as unknown as Record<string, unknown>,
    meta: {
      bundle_version: V18_BUNDLE_VERSION,
      schema_version: ORACLE_PREVIEW_SCHEMA_VERSION,
      profile: payload.profile,
      preview_only: true,
      no_live_calls_made: true,
      generated_at: payload.generated_at,
    },
    next_command: headline?.next_command ?? null,
    fix_command: headline?.next_command ?? null,
    retry_safe: true,
    commands: {
      capabilities: "oracle capabilities --json",
      remote_doctor: "oracle remote doctor --json",
      robot_docs: "oracle robot-docs --json",
    },
  });
  return { envelope, payload };
}

export async function runPreview(
  options: PreviewCommandOptions,
  io: PreviewCommandIo = {},
): Promise<PreviewResult> {
  const result = buildPreviewEnvelope(options);
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  if (options.json !== false) {
    write(`${JSON.stringify(result.envelope, null, 2)}\n`);
  } else {
    write(formatHuman(result));
  }
  return result;
}

function formatHuman(result: PreviewResult): string {
  const { payload } = result;
  const lines: string[] = [];
  lines.push(`🧿 oracle preview (${payload.bundle_version}) profile=${payload.profile}`);
  lines.push(
    `slots=${payload.totals.slot_count} active=${payload.totals.active_slot_count} skippable=${payload.totals.skippable_slot_count} blocked=${payload.totals.blocked_slot_count} paid=${payload.totals.paid_call_count}`,
  );
  lines.push(
    `wall: typical~${payload.totals.typical_wall_seconds}s  max~${payload.totals.max_wall_seconds}s (single slot worst case)`,
  );
  lines.push(
    `approvals required: ${payload.approval_status.required.length ? payload.approval_status.required.join(", ") : "none"}; missing: ${payload.approval_status.missing.length ? payload.approval_status.missing.join(", ") : "none"}`,
  );
  lines.push("");
  for (const entry of payload.slots) {
    const tag = entry.skippable_now
      ? "SKIP"
      : entry.blocked
        ? "BLOCKED"
        : entry.paid_call
          ? "PAID"
          : "FREE";
    lines.push(`[${tag}] ${entry.slot}  risk=${entry.primary_risk}  ~${entry.typical_wall_seconds}s/max ${entry.max_wall_seconds}s`);
    for (const blocker of entry.blockers) {
      lines.push(`    blocker: ${blocker}`);
    }
    if (entry.next_command) {
      lines.push(`    next: ${entry.next_command}`);
    }
  }
  lines.push("");
  lines.push("preview_only=true  no_live_calls_made=true");
  return `${lines.join("\n")}\n`;
}

export function registerPreviewCommand(program: Command): Command {
  return program
    .command("preview")
    .description(
      "Preview what a live oracle run would do (no provider calls). Reads slot list + budget from --slots and --budget files or stdin.",
    )
    .option("--json", "Print machine-readable JSON envelope (default).", true)
    .option("--no-json", "Print a short human summary instead of JSON.")
    .action(async (commandOptions: { json?: boolean }) => {
      try {
        // Production wiring (file/stdin parsing for --slots/--budget)
        // lives in the CLI bootstrap layer; this registration ensures
        // the command exists in the registry and human help text.
        await runPreview(
          {
            profile: "balanced",
            slots: [],
            json: commandOptions.json ?? true,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`oracle preview failed: ${message}\n`);
        process.exitCode = 1;
      }
    });
}
