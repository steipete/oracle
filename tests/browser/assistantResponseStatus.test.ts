import { createContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildActiveThinkingStatusPredicateJsForTest,
  buildAssistantSnapshotExpressionForTest,
  buildStopButtonVisibilityExpressionForTest,
  classifyTurnTerminal,
  createTerminalGateState,
  matchesThinkingStatusLabelForTest,
  type TerminalGateConfig,
  type TerminalSample,
} from "../../src/browser/actions/assistantResponse.js";
import {
  buildThinkingActivePredicateJsForTest,
  buildThinkingActivityDetailsPredicateJsForTest,
} from "../../src/browser/actions/thinkingStatus.js";
import { STOP_BUTTON_SELECTORS } from "../../src/browser/constants.js";

// Completed-summary shapes the veto must treat as NOT active: bare, heading-prefixed
// (the GPT-5.6 DOM renders "Reasoning Thought for 12s"), worded non-numeric durations,
// and heading fragments that concatenate without whitespace (CSS-spaced siblings).
const COMPLETED_SUMMARY_LABELS = [
  "Thought for 12s",
  "Reasoning Thought for 12s",
  "Thought for a few seconds",
  "Reasoning Thought for a moment",
  "ReasoningThought for 12s",
  "Thought for 1m 5s",
];

function evaluatePredicate(text: string, generating: boolean): boolean {
  const predicate = buildActiveThinkingStatusPredicateJsForTest("isActiveThinkingStatus");
  class FakeHtmlElement {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    }
  }
  const context = createContext({
    Array,
    Number,
    String,
    HTMLElement: FakeHtmlElement,
    document: {
      querySelectorAll: () => (generating ? [new FakeHtmlElement()] : []),
    },
    window: {
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
  });
  return new Script(
    `${predicate}\nisActiveThinkingStatus({ text: ${JSON.stringify(text)} });`,
  ).runInContext(context) as boolean;
}

describe("assistant thinking-status capture", () => {
  const statusLabels = [
    "Pro thinking",
    "Finalizing answer",
    "Thinking",
    "Reading",
    "Thought for 12s",
    "Pro thinking - planning",
  ];

  test.each(statusLabels)("suppresses active status label %j", (label) => {
    expect(matchesThinkingStatusLabelForTest(label)).toBe(true);
    expect(evaluatePredicate(label, true)).toBe(true);
  });

  test.each(statusLabels)("preserves completed exact answer %j", (label) => {
    expect(evaluatePredicate(label, false)).toBe(false);
  });

  test("does not suppress normal text while generation is active", () => {
    expect(evaluatePredicate("Thinking about the design, use Postgres.", true)).toBe(false);
  });

  test.each(["Reasoning Thought for 12s", "Thought for a few seconds"])(
    "recognizes prefixed/worded completed summary %s as status chrome, not an answer",
    (label) => {
      expect(matchesThinkingStatusLabelForTest(label)).toBe(true);
      expect(evaluatePredicate(label, true)).toBe(true);
    },
  );

  test("does not treat a real answer mentioning 'thought for' as status chrome", () => {
    // Longer than the 40-char status cap: must never be held back as a placeholder.
    const answer = "I thought for a while about this tradeoff and Postgres still wins.";
    expect(matchesThinkingStatusLabelForTest(answer)).toBe(false);
    expect(evaluatePredicate(answer, true)).toBe(false);
  });

  test("uses the active-status predicate in snapshot capture", () => {
    const expression = buildAssistantSnapshotExpressionForTest();
    expect(expression).toContain("isActiveThinkingStatus");
    expect(expression).toContain('data-testid=\\"stop-button\\"');
    expect(expression).toContain("const fallback = extractFallback();");
  });

  test("shares all stop-control selectors with completion capture", () => {
    let observedSelector = "";
    new Script(buildStopButtonVisibilityExpressionForTest()).runInContext(
      createContext({
        Array,
        Number,
        HTMLElement: class {},
        document: {
          querySelectorAll: (selector: string) => {
            observedSelector = selector;
            return [];
          },
        },
        window: { getComputedStyle: () => ({}) },
      }),
    );
    expect(observedSelector).toBe(STOP_BUTTON_SELECTORS.join(", "));
  });

  test.each([
    {
      width: 120,
      height: 40,
      display: "block",
      visibility: "visible",
      opacity: "1",
      expected: true,
    },
    {
      width: 0,
      height: 40,
      display: "block",
      visibility: "visible",
      opacity: "1",
      expected: false,
    },
    {
      width: 120,
      height: 40,
      display: "none",
      visibility: "visible",
      opacity: "1",
      expected: false,
    },
  ])("requires a visible stop control before blocking completion: %o", (fixture) => {
    class FakeHtmlElement {
      getBoundingClientRect() {
        return { width: fixture.width, height: fixture.height };
      }
    }
    const result = new Script(buildStopButtonVisibilityExpressionForTest()).runInContext(
      createContext({
        Array,
        Number,
        HTMLElement: FakeHtmlElement,
        document: { querySelectorAll: () => [new FakeHtmlElement()] },
        window: {
          getComputedStyle: () => ({
            display: fixture.display,
            visibility: fixture.visibility,
            opacity: fixture.opacity,
          }),
        },
      }),
    );
    expect(result).toBe(fixture.expected);
  });
});

describe("classifyTurnTerminal", () => {
  const config: TerminalGateConfig = {
    barConfirmCycles: 3,
    quietMs: 1_000,
    minStableMs: 200,
    minAnswerLen: 16,
  };

  // Drive the pure classifier over a sequence of samples (each 400ms apart by default),
  // returning the per-sample terminal decisions.
  function runGate(
    samples: Array<Partial<TerminalSample> & { len: number }>,
    cfg: TerminalGateConfig = config,
    stepMs = 400,
  ): boolean[] {
    let now = 0;
    let state = createTerminalGateState(now);
    const out: boolean[] = [];
    for (const partial of samples) {
      const sample: TerminalSample = {
        now,
        len: partial.len,
        // Default fingerprint = the length, so a changing length reads as "still moving"; tests
        // that need an equal-length rewrite pass an explicit contentKey.
        contentKey: partial.contentKey ?? String(partial.len),
        stopVisible: partial.stopVisible ?? false,
        barVisible: partial.barVisible ?? false,
        thinkingActive: partial.thinkingActive ?? false,
        strongThinkingActive: partial.strongThinkingActive ?? false,
      };
      const result = classifyTurnTerminal(state, sample, cfg);
      state = result.state;
      out.push(result.terminal);
      now += stepMs;
    }
    return out;
  }

  test("never finalizes while the stop control is visible", () => {
    const out = runGate(Array.from({ length: 20 }, () => ({ len: 400, stopVisible: true })));
    expect(out.some(Boolean)).toBe(false);
  });

  test("holds a settled long preamble until the reasoning phase resolves", () => {
    // A 150-char preamble settles (stop gone, no bar), then thinking mounts for ~4s, then the
    // real answer streams and its action bar appears. It must NOT finalize the preamble.
    const samples: Array<Partial<TerminalSample> & { len: number }> = [];
    // preamble streaming
    for (let i = 0; i < 3; i++) samples.push({ len: 50 * (i + 1), stopVisible: true });
    // settle gap: stop gone, no bar, no thinking yet (the exact window the bug exploited)
    for (let i = 0; i < 2; i++) samples.push({ len: 150 });
    // thinking phase mounts (connector/reasoning)
    for (let i = 0; i < 10; i++) samples.push({ len: 150, thinkingActive: true });
    // real answer streams after thinking, bar appears and debounces
    samples.push({ len: 600, stopVisible: true });
    samples.push({ len: 900, stopVisible: true });
    for (let i = 0; i < 5; i++) samples.push({ len: 900, barVisible: true });
    const out = runGate(samples);
    // No terminal:true may occur before the real answer streamed (index of first len>150).
    const firstAnswerIdx = samples.findIndex((s) => s.len > 150);
    const finalizedEarly = out.slice(0, firstAnswerIdx).some(Boolean);
    expect(finalizedEarly).toBe(false);
    // It DOES finalize once the real answer's bar debounces.
    expect(out.some(Boolean)).toBe(true);
  });

  test("proofA: a debounced action bar finalizes (and bypasses the thinking veto)", () => {
    const out = runGate([
      { len: 800, stopVisible: true }, // streaming
      { len: 800, barVisible: true }, // grew stopped; bar appears (cycle 1)
      { len: 800, barVisible: true }, // cycle 2
      { len: 800, barVisible: true }, // cycle 3 -> barStableCycles reaches 3
      { len: 800, barVisible: true },
    ]);
    // First three post-stream cycles build the debounce; terminal by the time cycles>=3.
    expect(out.at(-1)).toBe(true);
  });

  test("proofA fires even if weak stale-sidecar evidence lingers", () => {
    const out = runGate([
      { len: 800, stopVisible: true },
      { len: 800, barVisible: true, thinkingActive: true },
      { len: 800, barVisible: true, thinkingActive: true },
      { len: 800, barVisible: true, thinkingActive: true },
      { len: 800, barVisible: true, thinkingActive: true },
    ]);
    // Weak activity can be a stale mounted sidecar; the debounced bar may override it.
    expect(out.at(-1)).toBe(true);
  });

  test("proofA cannot override strong live activity and rebuilds its debounce afterward", () => {
    const samples: Array<Partial<TerminalSample> & { len: number }> = [
      { len: 800, stopVisible: true },
    ];
    for (let i = 0; i < 5; i++) {
      samples.push({
        len: 800,
        barVisible: true,
        thinkingActive: true,
        strongThinkingActive: true,
      });
    }
    samples.push({ len: 800, barVisible: true });
    samples.push({ len: 800, barVisible: true });
    samples.push({ len: 800, barVisible: true });
    const out = runGate(samples);
    expect(out.slice(0, 6).some(Boolean)).toBe(false);
    expect(out.at(-1)).toBe(true);
  });

  test("proofA does NOT finalize a transient bar while the answer is still rendering", () => {
    // Repo history: finished-action controls can surface while only the first tokens exist.
    // The bar is present the whole time, but the text keeps changing, so proofA must not fire.
    const out = runGate([
      { len: 4, barVisible: true },
      { len: 8, barVisible: true },
      { len: 12, barVisible: true },
      { len: 40, barVisible: true },
      { len: 90, barVisible: true },
    ]);
    expect(out.some(Boolean)).toBe(false);
  });

  test("any content change (even equal length) resets the stability clocks", () => {
    // An equal-length rewrite (preamble replaced by an answer of the same length) must reset:
    // length-only tracking would have treated it as stable and could finalize mid-rewrite.
    const out = runGate([
      { len: 200, barVisible: true, contentKey: "preamble-aaaaaaaaaaaaaaaaaaaa" },
      { len: 200, barVisible: true, contentKey: "answer-bbbbbbbbbbbbbbbbbbbbbb" }, // same len, new text
      { len: 200, barVisible: true, contentKey: "answer-bbbbbbbbbbbbbbbbbbbbbb" },
    ]);
    // The rewrite at sample 1 resets the debounce; only ~1 stable cycle follows -> not terminal.
    expect(out.some(Boolean)).toBe(false);
  });

  test("proofB: a bar-drifted answer finalizes after the quiet window with no thinking", () => {
    const samples: Array<Partial<TerminalSample> & { len: number }> = [
      { len: 800, stopVisible: true },
    ];
    // stop gone, no bar (selector drift), no thinking: quiet accrues at 400ms/cycle.
    for (let i = 0; i < 8; i++) samples.push({ len: 800 });
    const out = runGate(samples);
    // quietMs must reach 1000ms (config) -> terminal by ~cycle 3 after streaming stopped.
    expect(out.some(Boolean)).toBe(true);
  });

  test("proofB is withheld for an implausibly short capture (must be proven by the bar)", () => {
    const samples: Array<Partial<TerminalSample> & { len: number }> = [{ len: 1 }];
    for (let i = 0; i < 20; i++) samples.push({ len: 1 }); // stable "I", quiet, no bar/thinking
    const out = runGate(samples);
    expect(out.some(Boolean)).toBe(false);
  });

  test("a short answer still finalizes once its action bar debounces", () => {
    const out = runGate([
      { len: 4 },
      { len: 4, barVisible: true },
      { len: 4, barVisible: true },
      { len: 4, barVisible: true },
    ]);
    expect(out.at(-1)).toBe(true);
  });

  test("proofB does not fire while thinking stays active", () => {
    const samples: Array<Partial<TerminalSample> & { len: number }> = [
      { len: 800, stopVisible: true },
    ];
    for (let i = 0; i < 20; i++) samples.push({ len: 800, thinkingActive: true });
    const out = runGate(samples);
    expect(out.some(Boolean)).toBe(false);
  });

  test("text growth resets the quiet clock (no premature finalize mid-stream)", () => {
    // A mid-stream pause shorter than the quiet window, then more text -> not terminal at the pause.
    const out = runGate([
      { len: 100, stopVisible: false },
      { len: 100 }, // 400ms quiet
      { len: 100 }, // 800ms quiet (< 1000ms)
      { len: 200 }, // grew -> resets quiet
      { len: 200 },
    ]);
    expect(out.slice(0, 4).some(Boolean)).toBe(false);
  });
});

describe("thinking-active completion veto", () => {
  class FakeEl {
    public rect = { left: 0, top: 0, width: 120, height: 40 };
    constructor(
      public textContent = "",
      private attrs: Record<string, string> = {},
    ) {}
    getBoundingClientRect() {
      return this.rect;
    }
    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }
    querySelectorAll(selector: string) {
      const matches: FakeEl[] = [];
      if (selector.includes("progress"))
        matches.push(
          ...this.children.filter((child) => child.getAttribute("role") === "progressbar"),
        );
      if (selector.includes("loading-shimmer"))
        matches.push(
          ...this.children.filter((child) => child.getAttribute("data-kind") === "shimmer"),
        );
      if (selector.includes("aria-busy"))
        matches.push(
          ...this.children.filter((child) => child.getAttribute("aria-busy") === "true"),
        );
      return [...new Set(matches)];
    }
    public children: FakeEl[] = [];
  }

  interface ThinkingFixtureOptions {
    stop?: boolean;
    shimmer?: boolean;
    ariaBusy?: boolean;
    statusText?: string;
    statusTestId?: string;
    progress?: boolean;
    progressNow?: number;
    progressMax?: number;
    unrelatedProgress?: boolean;
    unrelatedBusy?: boolean;
    panel?: FakeEl;
  }

  function createThinkingContext(opts: ThinkingFixtureOptions) {
    const statusNodes =
      opts.statusText != null
        ? [
            new FakeEl(
              opts.statusText,
              opts.statusTestId ? { "data-testid": opts.statusTestId } : {},
            ),
          ]
        : [];
    const progressAttrs: Record<string, string> =
      opts.progressNow != null
        ? {
            "aria-valuenow": String(opts.progressNow),
            "aria-valuemax": String(opts.progressMax ?? 100),
            role: "progressbar",
          }
        : { "aria-valuenow": "40", role: "progressbar" };
    const progressNodes =
      opts.progress || opts.progressNow != null ? [new FakeEl("", progressAttrs)] : [];
    // Progress is scoped to the CURRENT assistant turn (review P1): the harness models the
    // turn container; unrelatedProgress mounts a live bar OUTSIDE any turn, which must not veto.
    const turn = new FakeEl("turn");
    turn.children = [
      ...progressNodes,
      ...(opts.shimmer ? [new FakeEl("", { "data-kind": "shimmer" })] : []),
      ...(opts.ariaBusy ? [new FakeEl("", { "aria-busy": "true" })] : []),
    ];
    const turnNodes = [turn];
    const panelNodes = opts.panel ? [opts.panel] : [];
    return createContext({
      Array,
      Number,
      String,
      HTMLElement: FakeEl,
      HTMLProgressElement: class {},
      document: {
        querySelectorAll: (selector: string) => {
          if (selector.includes("stop") || selector.includes('aria-label*="stop"')) {
            return opts.stop ? [new FakeEl()] : [];
          }
          if (selector.includes("loading-shimmer")) return opts.unrelatedBusy ? [new FakeEl()] : [];
          if (selector.includes("aria-busy")) return opts.unrelatedBusy ? [new FakeEl()] : [];
          if (selector.includes("progressbar") || selector.includes("aria-valuenow")) {
            // Only an UNRELATED page-wide bar is ever visible at document level now; the
            // turn-scoped bars are reached through the turn node's own querySelectorAll.
            return opts.unrelatedProgress ? [new FakeEl("", progressAttrs)] : [];
          }
          if (selector.includes("conversation-turn") || selector.includes("data-turn")) {
            return turnNodes;
          }
          // The panel selector carries "aside"/"complementary"/"sidecar"; the status selector
          // does not, so match panels first to disambiguate (both mention thinking/reasoning).
          if (
            selector.includes("aside") ||
            selector.includes("complementary") ||
            selector.includes("sidecar") ||
            selector.includes("sidebar")
          ) {
            return panelNodes;
          }
          if (
            selector.includes("thinking") ||
            selector.includes("reasoning") ||
            selector.includes("status") ||
            selector.includes("aria-live")
          ) {
            return statusNodes;
          }
          return [];
        },
      },
      window: {
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        innerHeight: 900,
        innerWidth: 1440,
      },
    });
  }

  function evalThinkingActive(opts: ThinkingFixtureOptions): boolean {
    const predicate = buildThinkingActivePredicateJsForTest("isThinkingActive");
    return new Script(`${predicate}\nisThinkingActive();`).runInContext(
      createThinkingContext(opts),
    ) as boolean;
  }

  function evalThinkingActivityDetails(opts: ThinkingFixtureOptions): {
    active: boolean;
    strong: boolean;
  } {
    const predicate = buildThinkingActivityDetailsPredicateJsForTest("readThinkingActivity");
    return new Script(`${predicate}\nreadThinkingActivity();`).runInContext(
      createThinkingContext(opts),
    ) as { active: boolean; strong: boolean };
  }

  test("fires on a visible stop control", () => {
    expect(evalThinkingActive({ stop: true })).toBe(true);
  });

  test("fires on a visible loading-shimmer skeleton", () => {
    expect(evalThinkingActive({ shimmer: true })).toBe(true);
  });

  test("fires on aria-busy", () => {
    expect(evalThinkingActive({ ariaBusy: true })).toBe(true);
  });

  test.each(["Thinking", "Pro thinking", "Searching the web", "Reading", "Finalizing answer"])(
    "fires on active status label %j",
    (label) => {
      expect(evalThinkingActive({ statusText: label })).toBe(true);
    },
  );

  test("does NOT treat ordinary live-region answer prose as active thinking", () => {
    expect(
      evalThinkingActivityDetails({ statusText: "Thinking clearly requires practice." }),
    ).toEqual({
      active: false,
      strong: false,
    });
  });

  test("allows prefix matching only in verified thinking chrome", () => {
    expect(
      evalThinkingActivityDetails({
        statusText: "Thinking through the remaining cases",
        statusTestId: "reasoning-status",
      }),
    ).toEqual({ active: true, strong: true });
  });

  test.each(COMPLETED_SUMMARY_LABELS)(
    "does NOT fire on the persistent completed reasoning summary %s",
    (statusText) => {
      // The headline hang the design must avoid: this summary lingers in the DOM on every
      // finished Pro turn and on reattach. A presence-based veto would hang forever here.
      expect(evalThinkingActive({ statusText })).toBe(false);
    },
  );

  test("fires on a live progress bar inside the current assistant turn", () => {
    expect(evalThinkingActive({ progress: true })).toBe(true);
    expect(evalThinkingActivityDetails({ progress: true })).toEqual({ active: true, strong: true });
  });

  test("does NOT fire on a completed progress bar (value at max)", () => {
    // A finished connector bar must not veto completion forever.
    expect(evalThinkingActive({ progressNow: 100, progressMax: 100 })).toBe(false);
  });

  test("does NOT fire on an unrelated progress bar outside the assistant turn", () => {
    // Review P1: unrelated page UI can keep a visible progress bar mounted indefinitely; a
    // document-wide veto would then hold a completed response until the watchdog timeout.
    expect(evalThinkingActive({ unrelatedProgress: true })).toBe(false);
  });

  test("does NOT fire on unrelated page-wide busy indicators", () => {
    expect(evalThinkingActivityDetails({ unrelatedBusy: true })).toEqual({
      active: false,
      strong: false,
    });
  });

  test("fires on a right-side reasoning sidecar panel with no inline label", () => {
    const panel = new FakeEl("Reasoning");
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 }; // right side, large
    expect(evalThinkingActive({ panel })).toBe(true);
    expect(evalThinkingActivityDetails({ panel })).toEqual({ active: true, strong: false });
  });

  test("does NOT treat progress in a generic panel as model activity", () => {
    const panel = new FakeEl("Upload");
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    panel.children = [new FakeEl("", { "aria-valuenow": "40", role: "progressbar" })];
    expect(evalThinkingActivityDetails({ panel })).toEqual({ active: false, strong: false });
  });

  test("treats progress in verified reasoning chrome as strong activity", () => {
    const panel = new FakeEl("", { "data-testid": "reasoning-panel" });
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    panel.children = [new FakeEl("", { "aria-valuenow": "40", role: "progressbar" })];
    expect(evalThinkingActivityDetails({ panel })).toEqual({ active: true, strong: true });
  });

  test.each(COMPLETED_SUMMARY_LABELS)("does NOT fire on completed sidecar summary %s", (text) => {
    const panel = new FakeEl(text);
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    expect(evalThinkingActive({ panel })).toBe(false);
  });

  test("still fires on a live sidecar trace that embeds a completed sub-step summary", () => {
    // A running trace accumulates sub-step summaries ("Thought for 2s") alongside live
    // reasoning text. Only a SHORT summary-only panel means the turn is done; a long trace
    // must keep vetoing completion even though it contains the completed phrase.
    const panel = new FakeEl(
      "Thought for 2s: Searching the web. Reasoning about the diff and enumerating candidate hunks to inspect next.",
    );
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    expect(evalThinkingActive({ panel })).toBe(true);
  });

  test("fires on a short live trace that begins with a completed sub-step", () => {
    const panel = new FakeEl("Thought for 2s: Searching the web");
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    expect(evalThinkingActive({ panel })).toBe(true);
  });

  test("does NOT fire on an idle DOM (finished, no controls)", () => {
    expect(evalThinkingActive({})).toBe(false);
  });
});
