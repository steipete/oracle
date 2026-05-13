import { describe, expect, test } from "vitest";

import {
  ORACLE_PREVIEW_SCHEMA_VERSION,
  buildPreviewEnvelope,
  buildPreviewPayload,
  runPreview,
} from "@src/cli/commands/preview.ts";
import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  jsonEnvelopeSchema,
} from "@src/oracle/v18/index.ts";

const FROZEN_TIME = new Date("2026-05-13T00:00:00.000Z");

function buildBudget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundle_version: V18_BUNDLE_VERSION,
    max_cost_usd: 50,
    max_wall_minutes: 180,
    profile: "balanced",
    required_approvals: ["live_fanout"],
    schema_version: "runtime_budget.v1",
    ...overrides,
  };
}

describe("buildPreviewPayload — protected browser route", () => {
  test("ChatGPT pro first plan shows time as primary risk + browser_required + paid_call", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "chatgpt_pro_first_plan" }],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    const entry = payload.slots[0];
    expect(entry.known).toBe(true);
    expect(entry.family).toBe("chatgpt");
    expect(entry.primary_risk).toBe("time");
    expect(entry.paid_call).toBe(true);
    expect(entry.browser_required).toBe(true);
    expect(entry.evidence_required).toBe(true);
    expect(entry.blocked).toBe(false);
    expect(entry.blockers).toEqual([]);
  });

  test("preview_only + no_live_calls_made are pinned constants", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [],
      now: FROZEN_TIME,
    });
    expect(payload.preview_only).toBe(true);
    expect(payload.no_live_calls_made).toBe(true);
    expect(payload.schema_version).toBe(ORACLE_PREVIEW_SCHEMA_VERSION);
    expect(payload.bundle_version).toBe(V18_BUNDLE_VERSION);
  });
});

describe("buildPreviewPayload — remote browser requirement", () => {
  test("remote_browser_available=false blocks a ChatGPT-Pro slot with the remote-doctor hint", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "chatgpt_pro_synthesis" }],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: false,
      now: FROZEN_TIME,
    });
    const entry = payload.slots[0];
    expect(entry.blocked).toBe(true);
    expect(entry.blockers.some((b) => b.includes("remote browser endpoint not configured"))).toBe(
      true,
    );
    expect(entry.next_command).toBe("oracle remote doctor --json");
  });

  test("undefined remote_browser_available also blocks until confirmed", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "gemini_deep_think" }],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: undefined,
      now: FROZEN_TIME,
    });
    const entry = payload.slots[0];
    expect(entry.blocked).toBe(true);
    expect(entry.blockers.some((b) => b.includes("remote browser availability unknown"))).toBe(
      true,
    );
  });

  test("API-allowed slots do NOT require remote browser", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "deepseek_v4_pro_reasoning_search" }],
      budget: buildBudget({ required_approvals: [] }),
      remote_browser_available: false,
      now: FROZEN_TIME,
    });
    const entry = payload.slots[0];
    expect(entry.blocked).toBe(false);
    expect(entry.browser_required).toBe(false);
  });
});

describe("buildPreviewPayload — live approval missing", () => {
  test("paid_call slot blocks when live_fanout approval is missing", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "chatgpt_pro_first_plan" }],
      budget: buildBudget(),
      approvalsPresent: [],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    const entry = payload.slots[0];
    expect(entry.blocked).toBe(true);
    expect(entry.blockers.some((b) => b.includes("live_fanout approval is required"))).toBe(true);
  });

  test("approval_status block reports required + missing", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "chatgpt_pro_first_plan" }],
      budget: buildBudget(),
      approvalsPresent: [],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    expect(payload.approval_status.required).toEqual(["live_fanout"]);
    expect(payload.approval_status.missing).toEqual(["live_fanout"]);
    expect(payload.approval_status.satisfied).toBe(false);
  });
});

describe("buildPreviewPayload — optional reviewer after quorum", () => {
  test("optional + quorum_satisfied marks slot skippable and excludes it from totals", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [
        { slot: "chatgpt_pro_first_plan" },
        { slot: "gemini_deep_think" },
        { slot: "xai_grok_reasoning", optional: true, quorum_satisfied: true },
      ],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    const xai = payload.slots.find((e) => e.slot === "xai_grok_reasoning")!;
    expect(xai.skippable_now).toBe(true);
    expect(xai.blocked).toBe(false);
    expect(payload.totals.skippable_slot_count).toBe(1);
    expect(payload.totals.active_slot_count).toBe(2);
  });

  test("optional WITHOUT quorum_satisfied still runs (active, not skippable)", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [
        { slot: "xai_grok_reasoning", optional: true, quorum_satisfied: false },
      ],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    const xai = payload.slots[0];
    expect(xai.skippable_now).toBe(false);
    expect(payload.totals.skippable_slot_count).toBe(0);
    expect(payload.totals.active_slot_count).toBe(1);
  });
});

describe("buildPreviewPayload — totals", () => {
  test("totals add typical wall seconds for active slots only", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [
        { slot: "chatgpt_pro_first_plan" }, // 600s typical
        { slot: "gemini_deep_think" }, // 300s typical
        { slot: "xai_grok_reasoning", optional: true, quorum_satisfied: true }, // skipped
      ],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    expect(payload.totals.typical_wall_seconds).toBe(900);
    expect(payload.totals.paid_call_count).toBe(2);
    expect(payload.totals.max_wall_seconds).toBe(3600);
  });
});

describe("buildPreviewPayload — unknown slot handling", () => {
  test("unknown required slot is reported as blocked with a robot-docs hint", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "does_not_exist" }],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    const entry = payload.slots[0];
    expect(entry.known).toBe(false);
    expect(entry.blocked).toBe(true);
    expect(entry.next_command).toBe("oracle robot-docs --json");
  });

  test("unknown OPTIONAL slot is non-blocking", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "future_reviewer", optional: true }],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    expect(payload.slots[0].blocked).toBe(false);
  });
});

describe("buildPreviewEnvelope — v18 json_envelope conformance", () => {
  test("envelope passes jsonEnvelopeSchema and carries meta flags", () => {
    const { envelope, payload } = buildPreviewEnvelope({
      profile: "balanced",
      slots: [{ slot: "chatgpt_pro_first_plan" }],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.preview_only).toBe(true);
    expect(envelope.meta.no_live_calls_made).toBe(true);
    expect(envelope.meta.profile).toBe("balanced");
    expect(envelope.data).toEqual(payload);
  });

  test("envelope's next_command surfaces the first blocker's hint", () => {
    const { envelope } = buildPreviewEnvelope({
      profile: "balanced",
      slots: [{ slot: "chatgpt_pro_first_plan" }],
      budget: buildBudget(),
      approvalsPresent: [],
      remote_browser_available: false,
      now: FROZEN_TIME,
    });
    expect(typeof envelope.next_command).toBe("string");
    expect(envelope.next_command).not.toBe(null);
  });
});

describe("runPreview — CLI surface (no live calls)", () => {
  test("--json invocation produces JSON envelope on stdout", async () => {
    const chunks: string[] = [];
    await runPreview(
      {
        profile: "balanced",
        slots: [{ slot: "chatgpt_pro_first_plan" }],
        budget: buildBudget(),
        approvalsPresent: ["live_fanout"],
        remote_browser_available: true,
        now: FROZEN_TIME,
        json: true,
      },
      { stdout: (text) => chunks.push(text) },
    );
    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.preview_only).toBe(true);
    expect(parsed.data.no_live_calls_made).toBe(true);
  });

  test("--no-json emits a deterministic human summary including 'preview_only=true'", async () => {
    const chunks: string[] = [];
    await runPreview(
      {
        profile: "balanced",
        slots: [
          { slot: "chatgpt_pro_first_plan" },
          { slot: "gemini_deep_think" },
        ],
        budget: buildBudget(),
        approvalsPresent: ["live_fanout"],
        remote_browser_available: true,
        now: FROZEN_TIME,
        json: false,
      },
      { stdout: (text) => chunks.push(text) },
    );
    const text = chunks.join("");
    expect(text).toContain("preview_only=true");
    expect(text).toContain("no_live_calls_made=true");
    expect(text).toContain("chatgpt_pro_first_plan");
    expect(text).toContain("gemini_deep_think");
  });

  test("two runs with the same inputs produce byte-identical JSON", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const opts = {
      profile: "balanced",
      slots: [{ slot: "chatgpt_pro_first_plan" }],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
      json: true,
    } as const;
    await runPreview(opts, { stdout: (text) => a.push(text) });
    await runPreview(opts, { stdout: (text) => b.push(text) });
    expect(a.join("")).toBe(b.join(""));
  });
});

describe("preview never invokes anything paid (pure static)", () => {
  test("payload is produced synchronously without any Promise/HTTP refs in the result", () => {
    const payload = buildPreviewPayload({
      profile: "balanced",
      slots: [{ slot: "chatgpt_pro_first_plan" }, { slot: "gemini_deep_think" }],
      budget: buildBudget(),
      approvalsPresent: ["live_fanout"],
      remote_browser_available: true,
      now: FROZEN_TIME,
    });
    expect(typeof (payload as unknown as Record<string, unknown>).then).toBe("undefined");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/Promise|http\.IncomingMessage/);
    // Headline guards stay pinned: never lies about preview_only.
    expect(serialized).toContain('"preview_only":true');
    expect(serialized).toContain('"no_live_calls_made":true');
  });
});
