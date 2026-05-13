// Runtime budget tracking + per-slot runtime estimates.
//
// Oracle is NOT APR's budget authority. APR owns max_cost_usd /
// max_wall_minutes / required_approvals for the whole route; Oracle
// only:
//
//   1. Materializes a typed `runtime_budget.v1` shape so APR-supplied
//      JSON parses cleanly before any other code touches it (kept out
//      of `src/oracle/v18/` per the bead's domain rules — local zod
//      that mirrors the v18 fixture).
//   2. Tracks per-session consumption (wall ms, optional token count)
//      so the preview/doctor surfaces can report exhaustion BEFORE a
//      live call is dispatched.
//   3. Carries static per-slot runtime estimates (time/cost risk
//      class) so the `oracle preview` command can describe what a
//      live call WOULD do without making it.
//
// For browser-routed slots, the estimates emphasize wall-time +
// lease/session implications because exact provider cost is not
// knowable in advance — AGENTS.md says Pro thinking can take 10m–1h.

import { z } from "zod";

export const RUNTIME_BUDGET_SCHEMA_VERSION = "runtime_budget.v1" as const;

// ─── Schema ──────────────────────────────────────────────────────────────────

export const runtimeBudgetSchema = z
  .object({
    schema_version: z.literal(RUNTIME_BUDGET_SCHEMA_VERSION),
    profile: z.string(),
    max_cost_usd: z.number().nonnegative(),
    max_wall_minutes: z.number().positive(),
    required_approvals: z.array(z.string()).optional(),
    retry_policy: z.record(z.string(), z.unknown()).optional(),
    bundle_version: z.string().optional(),
  })
  .passthrough();
export type RuntimeBudget = z.infer<typeof runtimeBudgetSchema>;

// ─── Per-slot runtime estimates (static) ─────────────────────────────────────

export type SlotPrimaryRisk =
  | "time"
  | "tokens"
  | "subscription_quota"
  | "human_action"
  | "none";

export interface SlotRuntimeEstimate {
  readonly slot: string;
  readonly family: string;
  readonly typical_wall_seconds: number;
  readonly max_wall_seconds: number;
  readonly primary_risk: SlotPrimaryRisk;
  /** True when the slot can spend money (per-request) directly. */
  readonly paid_call: boolean;
  /** True when the slot requires the Oracle browser path. */
  readonly browser_required: boolean;
  /** True when the slot requires remote browser endpoint to be reachable. */
  readonly remote_browser_preferred: boolean;
  /** True when the slot requires a same-session evidence check. */
  readonly evidence_required: boolean;
}

const SLOT_RUNTIME_ESTIMATES: ReadonlyMap<string, SlotRuntimeEstimate> = new Map([
  [
    "chatgpt_pro_first_plan",
    {
      slot: "chatgpt_pro_first_plan",
      family: "chatgpt",
      typical_wall_seconds: 600,
      max_wall_seconds: 3600,
      primary_risk: "time",
      paid_call: true,
      browser_required: true,
      remote_browser_preferred: true,
      evidence_required: true,
    },
  ],
  [
    "chatgpt_pro_synthesis",
    {
      slot: "chatgpt_pro_synthesis",
      family: "chatgpt",
      typical_wall_seconds: 600,
      max_wall_seconds: 3600,
      primary_risk: "time",
      paid_call: true,
      browser_required: true,
      remote_browser_preferred: true,
      evidence_required: true,
    },
  ],
  [
    "gemini_deep_think",
    {
      slot: "gemini_deep_think",
      family: "gemini",
      typical_wall_seconds: 300,
      max_wall_seconds: 1800,
      primary_risk: "time",
      paid_call: true,
      browser_required: true,
      remote_browser_preferred: true,
      evidence_required: true,
    },
  ],
  [
    "xai_grok_reasoning",
    {
      slot: "xai_grok_reasoning",
      family: "xai",
      typical_wall_seconds: 60,
      max_wall_seconds: 600,
      primary_risk: "tokens",
      paid_call: true,
      browser_required: false,
      remote_browser_preferred: false,
      evidence_required: false,
    },
  ],
  [
    "deepseek_v4_pro_reasoning_search",
    {
      slot: "deepseek_v4_pro_reasoning_search",
      family: "deepseek",
      typical_wall_seconds: 120,
      max_wall_seconds: 1800,
      primary_risk: "tokens",
      paid_call: true,
      browser_required: false,
      remote_browser_preferred: false,
      evidence_required: false,
    },
  ],
  [
    "claude_code_opus",
    {
      slot: "claude_code_opus",
      family: "claude",
      typical_wall_seconds: 60,
      max_wall_seconds: 600,
      primary_risk: "subscription_quota",
      paid_call: false,
      browser_required: false,
      remote_browser_preferred: false,
      evidence_required: false,
    },
  ],
  [
    "codex_intake",
    {
      slot: "codex_intake",
      family: "codex",
      typical_wall_seconds: 30,
      max_wall_seconds: 120,
      primary_risk: "subscription_quota",
      paid_call: false,
      browser_required: false,
      remote_browser_preferred: false,
      evidence_required: false,
    },
  ],
  [
    "codex_thinking_fast_draft",
    {
      slot: "codex_thinking_fast_draft",
      family: "codex",
      typical_wall_seconds: 30,
      max_wall_seconds: 300,
      primary_risk: "subscription_quota",
      paid_call: false,
      browser_required: false,
      remote_browser_preferred: false,
      evidence_required: false,
    },
  ],
]);

/** Lookup the static runtime estimate for a slot; null when unknown. */
export function estimateSlotRuntime(slot: string): SlotRuntimeEstimate | null {
  return SLOT_RUNTIME_ESTIMATES.get(slot) ?? null;
}

/** All slots Oracle currently has estimates for, alphabetized. */
export function listKnownSlotEstimates(): readonly SlotRuntimeEstimate[] {
  return [...SLOT_RUNTIME_ESTIMATES.values()].sort((a, b) => a.slot.localeCompare(b.slot));
}

// ─── Budget tracker (per-session) ────────────────────────────────────────────

export interface BudgetTrackerState {
  readonly budget: RuntimeBudget;
  readonly startedAtMs: number;
  readonly consumedWallMs: number;
  readonly consumedCostUsd: number;
  readonly consumedTokens: number;
}

export function createBudgetTracker(input: {
  budget: unknown;
  now: Date;
}): BudgetTrackerState {
  const budget = runtimeBudgetSchema.parse(input.budget);
  return {
    budget,
    startedAtMs: input.now.getTime(),
    consumedWallMs: 0,
    consumedCostUsd: 0,
    consumedTokens: 0,
  };
}

export interface BudgetConsumeInput {
  readonly wallMs?: number;
  readonly costUsd?: number;
  readonly tokens?: number;
}

/** Immutable accumulator — returns a new state with the increments applied. */
export function consumeBudget(
  state: BudgetTrackerState,
  input: BudgetConsumeInput,
): BudgetTrackerState {
  return {
    ...state,
    consumedWallMs: state.consumedWallMs + Math.max(0, input.wallMs ?? 0),
    consumedCostUsd: state.consumedCostUsd + Math.max(0, input.costUsd ?? 0),
    consumedTokens: state.consumedTokens + Math.max(0, input.tokens ?? 0),
  };
}

export type BudgetVerdictStatus = "healthy" | "near_exhaustion" | "exhausted";

export interface BudgetVerdict {
  readonly status: BudgetVerdictStatus;
  readonly wall_percent: number;
  readonly cost_percent: number;
  readonly wall_ms_remaining: number;
  readonly cost_usd_remaining: number;
  readonly reasons: readonly string[];
}

const NEAR_EXHAUSTION_PERCENT = 80;

/** Compute the current verdict against `state` at `now`. */
export function budgetVerdict(state: BudgetTrackerState): BudgetVerdict {
  const maxWallMs = Math.round(state.budget.max_wall_minutes * 60 * 1000);
  const maxCost = state.budget.max_cost_usd;
  const wallRemaining = Math.max(0, maxWallMs - state.consumedWallMs);
  const costRemaining = Math.max(0, maxCost - state.consumedCostUsd);
  const wallPercent = maxWallMs > 0 ? Math.min(100, (state.consumedWallMs / maxWallMs) * 100) : 0;
  const costPercent = maxCost > 0 ? Math.min(100, (state.consumedCostUsd / maxCost) * 100) : 0;
  const reasons: string[] = [];
  let status: BudgetVerdictStatus = "healthy";
  if (state.consumedWallMs >= maxWallMs) {
    status = "exhausted";
    reasons.push(
      `wall budget exhausted: consumed ${Math.round(state.consumedWallMs / 1000)}s ≥ max ${Math.round(maxWallMs / 1000)}s`,
    );
  }
  if (state.consumedCostUsd >= maxCost) {
    status = "exhausted";
    reasons.push(
      `cost budget exhausted: consumed $${state.consumedCostUsd.toFixed(2)} ≥ max $${maxCost.toFixed(2)}`,
    );
  }
  if (status !== "exhausted") {
    if (wallPercent >= NEAR_EXHAUSTION_PERCENT) {
      status = "near_exhaustion";
      reasons.push(
        `wall budget ${Math.round(wallPercent)}% consumed; ${Math.round(wallRemaining / 1000)}s remaining`,
      );
    }
    if (costPercent >= NEAR_EXHAUSTION_PERCENT) {
      status = "near_exhaustion";
      reasons.push(
        `cost budget ${Math.round(costPercent)}% consumed; $${costRemaining.toFixed(2)} remaining`,
      );
    }
  }
  return {
    status,
    wall_percent: wallPercent,
    cost_percent: costPercent,
    wall_ms_remaining: wallRemaining,
    cost_usd_remaining: costRemaining,
    reasons,
  };
}

// ─── Human approval helpers ──────────────────────────────────────────────────

export function humanApprovalRequired(budget: unknown): readonly string[] {
  const parsed = runtimeBudgetSchema.safeParse(budget);
  if (!parsed.success) return [];
  return parsed.data.required_approvals ?? [];
}

export function isApprovalSatisfied(
  budget: unknown,
  approvalsPresent: readonly string[],
): { satisfied: boolean; missing: readonly string[] } {
  const required = humanApprovalRequired(budget);
  const have = new Set(approvalsPresent);
  const missing = required.filter((name) => !have.has(name));
  return { satisfied: missing.length === 0, missing };
}
