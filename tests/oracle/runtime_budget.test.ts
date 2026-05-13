import { describe, expect, test } from "vitest";

import {
  RUNTIME_BUDGET_SCHEMA_VERSION,
  budgetVerdict,
  consumeBudget,
  createBudgetTracker,
  estimateSlotRuntime,
  humanApprovalRequired,
  isApprovalSatisfied,
  listKnownSlotEstimates,
  runtimeBudgetSchema,
} from "@src/oracle/runtime_budget.ts";

const NOW = new Date("2026-05-12T00:00:00.000Z");

function buildBudget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundle_version: "v18.0.0",
    max_cost_usd: 50,
    max_wall_minutes: 180,
    profile: "balanced",
    required_approvals: ["live_fanout"],
    retry_policy: { required_browser_modes: "fail_closed" },
    schema_version: RUNTIME_BUDGET_SCHEMA_VERSION,
    ...overrides,
  };
}

describe("runtimeBudgetSchema — strict-core acceptance", () => {
  test("accepts the canonical v18 fixture shape", () => {
    expect(() => runtimeBudgetSchema.parse(buildBudget())).not.toThrow();
  });

  test("rejects wrong schema_version", () => {
    expect(() =>
      runtimeBudgetSchema.parse(buildBudget({ schema_version: "runtime_budget.v0" })),
    ).toThrow();
  });

  test("rejects negative max_cost_usd / non-positive max_wall_minutes", () => {
    expect(() => runtimeBudgetSchema.parse(buildBudget({ max_cost_usd: -1 }))).toThrow();
    expect(() => runtimeBudgetSchema.parse(buildBudget({ max_wall_minutes: 0 }))).toThrow();
  });

  test("passthrough preserves api_provider_budgets + search_budget extensions", () => {
    const budget = runtimeBudgetSchema.parse(
      buildBudget({
        api_provider_budgets: { xai_grok_reasoning: { max_cost_usd: 10 } },
        search_budget: { deepseek: { max_queries: 5 } },
        no_effort_downgrade_without_waiver: true,
      }),
    );
    expect((budget as Record<string, unknown>).api_provider_budgets).toBeTruthy();
    expect((budget as Record<string, unknown>).no_effort_downgrade_without_waiver).toBe(true);
  });
});

describe("estimateSlotRuntime — static catalogue", () => {
  test("known protected browser slots emphasize time risk", () => {
    for (const slot of ["chatgpt_pro_first_plan", "chatgpt_pro_synthesis", "gemini_deep_think"]) {
      const e = estimateSlotRuntime(slot);
      expect(e).not.toBeNull();
      expect(e!.primary_risk).toBe("time");
      expect(e!.browser_required).toBe(true);
      expect(e!.evidence_required).toBe(true);
      expect(e!.paid_call).toBe(true);
      // Pro thinking ranges from 10m to 1h — typical 5-10m, max 30-60m.
      expect(e!.typical_wall_seconds).toBeGreaterThanOrEqual(300);
      expect(e!.max_wall_seconds).toBeGreaterThanOrEqual(1800);
    }
  });

  test("API-allowed slots emphasize token risk and are paid", () => {
    for (const slot of ["xai_grok_reasoning", "deepseek_v4_pro_reasoning_search"]) {
      const e = estimateSlotRuntime(slot)!;
      expect(e.primary_risk).toBe("tokens");
      expect(e.browser_required).toBe(false);
      expect(e.paid_call).toBe(true);
    }
  });

  test("subscription-CLI slots are not paid per-call (subscription_quota)", () => {
    for (const slot of ["claude_code_opus", "codex_intake", "codex_thinking_fast_draft"]) {
      const e = estimateSlotRuntime(slot)!;
      expect(e.primary_risk).toBe("subscription_quota");
      expect(e.paid_call).toBe(false);
    }
  });

  test("unknown slot returns null", () => {
    expect(estimateSlotRuntime("does_not_exist")).toBeNull();
  });

  test("listKnownSlotEstimates is alphabetized and stable", () => {
    const slots = listKnownSlotEstimates().map((e) => e.slot);
    expect(slots).toEqual([...slots].sort());
  });
});

describe("BudgetTracker — consume + verdict", () => {
  test("fresh tracker is healthy at 0% wall + cost", () => {
    const tracker = createBudgetTracker({ budget: buildBudget(), now: NOW });
    const verdict = budgetVerdict(tracker);
    expect(verdict.status).toBe("healthy");
    expect(verdict.wall_percent).toBe(0);
    expect(verdict.cost_percent).toBe(0);
    expect(verdict.wall_ms_remaining).toBe(180 * 60 * 1000);
    expect(verdict.cost_usd_remaining).toBe(50);
  });

  test("consumption is immutable and additive", () => {
    const tracker = createBudgetTracker({ budget: buildBudget(), now: NOW });
    const a = consumeBudget(tracker, { wallMs: 1_000, costUsd: 1, tokens: 100 });
    const b = consumeBudget(a, { wallMs: 2_000, costUsd: 2 });
    expect(tracker.consumedWallMs).toBe(0);
    expect(a.consumedWallMs).toBe(1_000);
    expect(b.consumedWallMs).toBe(3_000);
    expect(b.consumedCostUsd).toBe(3);
    expect(b.consumedTokens).toBe(100);
  });

  test("near_exhaustion fires at >=80% consumed", () => {
    const tracker = createBudgetTracker({
      budget: buildBudget({ max_wall_minutes: 10, max_cost_usd: 1 }),
      now: NOW,
    });
    const at80 = consumeBudget(tracker, { wallMs: 8 * 60 * 1000 });
    const verdict = budgetVerdict(at80);
    expect(verdict.status).toBe("near_exhaustion");
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  test("exhausted fires when wall or cost reaches max", () => {
    const tracker = createBudgetTracker({
      budget: buildBudget({ max_wall_minutes: 10, max_cost_usd: 5 }),
      now: NOW,
    });
    const wallDone = consumeBudget(tracker, { wallMs: 10 * 60 * 1000 });
    expect(budgetVerdict(wallDone).status).toBe("exhausted");
    const costDone = consumeBudget(tracker, { costUsd: 5 });
    expect(budgetVerdict(costDone).status).toBe("exhausted");
  });

  test("malformed budget input throws at tracker creation", () => {
    expect(() =>
      createBudgetTracker({
        budget: { schema_version: "wrong.v1" },
        now: NOW,
      }),
    ).toThrow();
  });
});

describe("approval helpers", () => {
  test("humanApprovalRequired echoes the budget's required_approvals", () => {
    expect(humanApprovalRequired(buildBudget())).toEqual(["live_fanout"]);
  });

  test("humanApprovalRequired returns [] for malformed budget", () => {
    expect(humanApprovalRequired({ schema_version: "bogus" })).toEqual([]);
  });

  test("isApprovalSatisfied returns true when all required approvals are present", () => {
    const result = isApprovalSatisfied(buildBudget(), ["live_fanout"]);
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("isApprovalSatisfied reports missing approvals", () => {
    const result = isApprovalSatisfied(buildBudget(), []);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["live_fanout"]);
  });

  test("isApprovalSatisfied returns satisfied=true when budget declares no approvals", () => {
    const result = isApprovalSatisfied(
      buildBudget({ required_approvals: undefined }),
      [],
    );
    expect(result.satisfied).toBe(true);
  });
});
