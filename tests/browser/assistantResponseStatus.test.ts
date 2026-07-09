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
import { buildThinkingActivePredicateJsForTest } from "../../src/browser/actions/thinkingStatus.js";
import { STOP_BUTTON_SELECTORS } from "../../src/browser/constants.js";

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
        stopVisible: partial.stopVisible ?? false,
        barVisible: partial.barVisible ?? false,
        thinkingActive: partial.thinkingActive ?? false,
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

  test("proofA fires even if a stale thinking panel lingers (bar bypasses the veto)", () => {
    const out = runGate([
      { len: 800, stopVisible: true },
      { len: 800, barVisible: true, thinkingActive: true },
      { len: 800, barVisible: true, thinkingActive: true },
      { len: 800, barVisible: true, thinkingActive: true },
      { len: 800, barVisible: true, thinkingActive: true },
    ]);
    // The debounce increments on barVisible && !stop && !grew (NOT gated on thinking), so a
    // debounced action bar proves completion even if a false-positive or stale thinking signal
    // lingers. This avoids hanging a finished turn whose reasoning panel is still mounted.
    expect(out.at(-1)).toBe(true);
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
    constructor(
      public textContent = "",
      private attrs: Record<string, string> = {},
    ) {}
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    }
    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }
  }

  function evalThinkingActive(opts: {
    stop?: boolean;
    shimmer?: boolean;
    ariaBusy?: boolean;
    statusText?: string;
  }): boolean {
    const predicate = buildThinkingActivePredicateJsForTest("isThinkingActive");
    const statusNodes = opts.statusText != null ? [new FakeEl(opts.statusText)] : [];
    const context = createContext({
      Array,
      Number,
      String,
      HTMLElement: FakeEl,
      document: {
        querySelectorAll: (selector: string) => {
          if (selector.includes("stop") || selector.includes('aria-label*="stop"')) {
            return opts.stop ? [new FakeEl()] : [];
          }
          if (selector.includes("loading-shimmer")) return opts.shimmer ? [new FakeEl()] : [];
          if (selector.includes("aria-busy")) return opts.ariaBusy ? [new FakeEl()] : [];
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
    return new Script(`${predicate}\nisThinkingActive();`).runInContext(context) as boolean;
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

  test("does NOT fire on the persistent completed reasoning summary 'Thought for 12s'", () => {
    // The headline hang the design must avoid: this summary lingers in the DOM on every
    // finished Pro turn and on reattach. A presence-based veto would hang forever here.
    expect(evalThinkingActive({ statusText: "Thought for 12s" })).toBe(false);
  });

  test("does NOT fire on an idle DOM (finished, no controls)", () => {
    expect(evalThinkingActive({})).toBe(false);
  });
});
