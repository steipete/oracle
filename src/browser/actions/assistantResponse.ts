import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  COPY_BUTTON_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTORS,
} from "../constants.js";
import { buildConversationTurnListExpression } from "../conversationTurns.js";
import { buildThinkingActivePredicateJs, readThinkingActivity } from "./thinkingStatus.js";
import { delay } from "../utils.js";
import {
  logDomFailure,
  logConversationSnapshot,
  buildConversationDebugExpression,
} from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

const ASSISTANT_POLL_TIMEOUT_ERROR = "assistant-response-watchdog-timeout";
const STOP_CONTROL_SELECTOR = STOP_BUTTON_SELECTORS.join(", ");
// Still used by the in-page settle heuristic's length buckets (see buildResponseObserverExpression).
const MIN_CONFIDENT_ANSWER_LENGTH = 16;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// Terminal-completion gate. A turn is finalized only on POSITIVE proof it is done — never on
// the mere "stop control absent + text stable" inference, which a settled GPT-5.5 Pro preamble
// satisfies during the brief gap before it enters its thinking/tool phase.
//   proofA: the finished-action bar is present for barConfirmCycles consecutive quiet cycles
//           (debounces the transient mid-thinking action-bar flash). A debounced bar is the
//           strongest positive signal, so it is NOT vetoed by thinking activity.
//   proofB: a generous continuous-quiet window with no strong activity or changing weak sidecar
//           evidence — the fallback that recovers an answer whose action-bar selector drifted.
// Any text growth, a visible stop control, or active thinking resets the quiet clock, so a
// preamble cannot reach the terminal state: it is held until the reasoning phase ends and the
// real answer streams (then proofA/proofB fire on the real answer). Tunable via env for live
// calibration without a rebuild.
export interface TerminalGateConfig {
  barConfirmCycles: number;
  quietMs: number;
  minStableMs: number;
  // Below this length, the quiet fallback (proofB) is NOT trusted: an implausibly short
  // capture must be proven by the action bar (proofA), else it is refused (fail fast). This
  // preserves the #293 guard against finalizing a 1-2 token mid-stream stub.
  minAnswerLen: number;
}

const TERMINAL_GATE_CONFIG: TerminalGateConfig = {
  barConfirmCycles: readPositiveIntEnv("ORACLE_BAR_CONFIRM_CYCLES", 3),
  quietMs: readPositiveIntEnv("ORACLE_TERMINAL_QUIET_MS", 12_000),
  minStableMs: readPositiveIntEnv("ORACLE_TERMINAL_MIN_STABLE_MS", 1_200),
  minAnswerLen: MIN_CONFIDENT_ANSWER_LENGTH,
};

export interface TerminalGateState {
  lastKey: string;
  lastChangeAt: number;
  lastDisturbanceAt: number;
  barStableCycles: number;
  lastWeakKey: string;
  lastWeakChangeAt: number;
  seen: boolean;
}

export interface TerminalSample {
  now: number;
  len: number;
  // A fingerprint of the current answer (its text, ideally plus turn/message identity). ANY
  // change (not just a length increase) is treated as the turn still moving: an equal-length
  // or shorter rewrite, or a preamble replaced by the answer, resets the stability clocks.
  contentKey: string;
  stopVisible: boolean;
  barVisible: boolean;
  thinkingActive: boolean;
  // Strong signals prove live work (stop/shimmer/aria-busy/status/progress). Weak activity is
  // limited to a heuristic sidecar match that can linger after completion.
  strongThinkingActive: boolean;
  thinkingKey?: string;
}

export function createTerminalGateState(now: number): TerminalGateState {
  return {
    lastKey: "",
    lastChangeAt: now,
    lastDisturbanceAt: now,
    barStableCycles: 0,
    lastWeakKey: "",
    lastWeakChangeAt: now,
    seen: false,
  };
}

// Pure, unit-testable per-cycle classifier. Feed it one sample every poll; when it returns
// terminal:true the capture is proven complete and safe to finalize.
export function classifyTurnTerminal(
  state: TerminalGateState,
  sample: TerminalSample,
  config: TerminalGateConfig,
): { state: TerminalGateState; terminal: boolean } {
  const changed = !state.seen || sample.contentKey !== state.lastKey;
  const lastChangeAt = changed ? sample.now : state.lastChangeAt;
  const weakActive = sample.thinkingActive && !sample.strongThinkingActive;
  const weakKey = weakActive ? (sample.thinkingKey ?? "unknown-weak-activity") : "";
  const weakChanged = weakActive && weakKey !== state.lastWeakKey;
  const lastWeakChangeAt = weakChanged ? sample.now : state.lastWeakChangeAt;
  const disturbed = changed || sample.stopVisible || sample.strongThinkingActive || weakChanged;
  const lastDisturbanceAt = disturbed ? sample.now : state.lastDisturbanceAt;
  // proofA debounce: weak/stale sidecar evidence may be overridden, but strong live activity
  // must reset the debounce. It also resets on ANY content change so a bar that appears while
  // the answer is still rendering (the transient-bar / first-tokens race) cannot finalize.
  const barStableCycles =
    sample.barVisible && !sample.stopVisible && !sample.strongThinkingActive && !changed
      ? state.barStableCycles + 1
      : 0;
  const next: TerminalGateState = {
    lastKey: sample.contentKey,
    lastChangeAt,
    lastDisturbanceAt,
    barStableCycles,
    lastWeakKey: weakKey,
    lastWeakChangeAt,
    seen: true,
  };

  let terminal = false;
  if (!sample.stopVisible && sample.len > 0) {
    const quietMs = sample.now - lastDisturbanceAt;
    const stableMs = sample.now - lastChangeAt;
    // proofA — debounced action bar AND content stable for a minimum time. The time-stability
    // requirement guards the documented race where finished-action controls surface while only
    // the first tokens have rendered. Weak sidecar evidence cannot hang a finished turn, but
    // strong live activity vetoes this proof and restarts its debounce.
    const barProof =
      sample.barVisible &&
      !sample.strongThinkingActive &&
      barStableCycles >= config.barConfirmCycles &&
      stableMs >= config.minStableMs;
    // proofB — generous quiet with no strong activity. Changing weak sidecar evidence keeps
    // resetting the window; static weak evidence must age for at least a minute so a stale
    // mounted panel cannot veto selector-drift recovery forever. Implausibly short captures
    // remain action-bar-only.
    const weakEvidenceAged =
      !weakActive || sample.now - lastWeakChangeAt >= Math.max(config.quietMs * 5, 60_000);
    const quietProof =
      !sample.strongThinkingActive &&
      weakEvidenceAged &&
      sample.len >= config.minAnswerLen &&
      stableMs >= config.minStableMs &&
      quietMs >= config.quietMs;
    terminal = barProof || quietProof;
  }
  return { state: next, terminal };
}
const THINKING_STATUS_LABELS = [
  "thinking",
  "pro thinking",
  "thinking longer for a better answer",
  "reasoning",
  "finalizing answer",
  "finalizing",
  "analyzing",
  "researching",
  "working on it",
  "working",
  "planning",
  "searching the web",
  "searching",
  "reading",
];

function matchesThinkingStatusLabel(trimmed: string): boolean {
  if (!trimmed) return false;
  if (THINKING_STATUS_LABELS.includes(trimmed)) return true;
  // includes, not startsWith: the completed summary can carry a heading prefix
  // ("Reasoning Thought for 12s"); the length cap keeps real answers out.
  if (trimmed.includes("thought for ") && trimmed.length <= 40) return true;
  return trimmed.startsWith("pro thinking") && trimmed.length <= 40;
}

export function isAnswerNowPlaceholderText(value: string): boolean {
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  // Learned: "Pro thinking" shows a placeholder turn that contains "Answer now".
  // That is not the final answer and must be ignored in browser automation.
  if (text === "chatgpt said:" || text === "chatgpt said") return true;
  if (
    text.includes("file upload request") &&
    (text.includes("pro thinking") || text.includes("chatgpt said"))
  ) {
    return true;
  }
  return (
    text.includes("answer now") && (text.includes("pro thinking") || text.includes("chatgpt said"))
  );
}

function buildActiveThinkingStatusPredicateJs(fnName: string): string {
  const labelsLiteral = JSON.stringify(THINKING_STATUS_LABELS);
  return `${buildStopButtonVisibilityPredicateJs("isStopControlVisible")}
  const ${fnName} = (snapshot) => {
    const normalized = String(snapshot?.text ?? '').toLowerCase().replace(/\\s+/g, ' ').trim();
    if (!normalized) return false;
    const labels = ${labelsLiteral};
    const matches =
      labels.includes(normalized) ||
      (normalized.includes('thought for ') && normalized.length <= 40) ||
      (normalized.startsWith('pro thinking') && normalized.length <= 40);
    return matches && isStopControlVisible();
  };`;
}

export function matchesThinkingStatusLabelForTest(text: string): boolean {
  return matchesThinkingStatusLabel(text.toLowerCase().replace(/\s+/g, " ").trim());
}

export function buildActiveThinkingStatusPredicateJsForTest(fnName: string): string {
  return buildActiveThinkingStatusPredicateJs(fnName);
}

export async function waitForAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const start = Date.now();
  logger("Waiting for ChatGPT response");
  // Learned: two paths are needed:
  // 1) DOM observer (fast when mutations fire),
  // 2) snapshot poller (fallback when observers miss or JS stalls).
  const expression = buildResponseObserverExpression(
    timeoutMs,
    minTurnIndex,
    expectedConversationId,
  );
  const evaluationPromise = Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const raceReadyEvaluation = evaluationPromise.then(
    (value) => ({ kind: "evaluation" as const, value }),
    (error) => {
      throw { source: "evaluation" as const, error };
    },
  );
  // Use AbortController to stop the poller when the evaluation wins the race,
  // preventing abandoned polling loops from consuming resources.
  const pollerAbort = new AbortController();
  const pollerPromise = pollAssistantCompletion(
    Runtime,
    timeoutMs,
    minTurnIndex,
    expectedConversationId,
    pollerAbort.signal,
  ).then(
    (value) => ({ kind: "poll" as const, value }),
    (error) => {
      throw { source: "poll" as const, error };
    },
  );

  let evaluation: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>> | null = null;
  try {
    const winner = await Promise.race([raceReadyEvaluation, pollerPromise]);
    if (winner.kind === "poll") {
      if (!winner.value) {
        throw { source: "poll" as const, error: new Error(ASSISTANT_POLL_TIMEOUT_ERROR) };
      }
      logger("Captured assistant response via snapshot watchdog");
      evaluationPromise.catch(() => undefined);
      await terminateRuntimeExecution(Runtime);
      return winner.value;
    }
    // Evaluation won - abort the poller to prevent it from running until timeout
    pollerAbort.abort();
    evaluation = winner.value;
  } catch (wrappedError) {
    if (
      wrappedError &&
      typeof wrappedError === "object" &&
      "source" in wrappedError &&
      "error" in wrappedError
    ) {
      const { source, error } = wrappedError as { source: string; error: unknown };
      if (
        source === "poll" &&
        error instanceof Error &&
        error.message === ASSISTANT_POLL_TIMEOUT_ERROR
      ) {
        evaluationPromise.catch(() => undefined);
        await terminateRuntimeExecution(Runtime);
        throw error;
      } else if (source === "poll") {
        throw error;
      } else if (source === "evaluation") {
        const recovered = await recoverAssistantResponse(
          Runtime,
          timeoutMs,
          logger,
          minTurnIndex,
          expectedConversationId,
        );
        if (recovered) {
          return recovered;
        }
        await logDomFailure(Runtime, logger, "assistant-response");
        throw error ?? new Error("Failed to capture assistant response");
      }
    } else {
      throw wrappedError;
    }
  }

  if (!evaluation) {
    await logDomFailure(Runtime, logger, "assistant-response");
    throw new Error("Failed to capture assistant response");
  }

  const parsed = await parseAssistantEvaluationResult(Runtime, evaluation, logger);
  if (!parsed) {
    let remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    if (remainingMs > 0) {
      const recovered = await recoverAssistantResponse(
        Runtime,
        remainingMs,
        logger,
        minTurnIndex,
        expectedConversationId,
      );
      if (recovered) {
        return recovered;
      }
      remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
      if (remainingMs > 0) {
        const polled = await Promise.race([
          pollerPromise.catch(() => null),
          delay(remainingMs).then(() => null),
        ]);
        if (polled && polled.kind === "poll" && polled.value) {
          return polled.value;
        }
      }
    }
    await logDomFailure(Runtime, logger, "assistant-response");
    throw new Error("Unable to capture assistant response");
  }

  const refreshed = await refreshAssistantSnapshot(
    Runtime,
    parsed,
    logger,
    minTurnIndex,
    expectedConversationId,
  );
  const candidate = refreshed ?? parsed;
  if (isGeneratedImageAssistantAnswer(candidate)) {
    logger("Captured assistant generated image response");
    return candidate;
  }
  // The observer/refresh path can race ahead of true completion: a settled GPT-5.5 Pro
  // preamble (or any mid-stream capture) looks done for a moment before the reasoning/tool
  // phase begins. Re-confirm EVERY captured text through the terminal-only poller, which
  // finalizes only on positive proof (a debounced action bar, or a quiet window with no
  // active thinking). We deliberately drop the old ">= candidate length" acceptance: the
  // poller is turn-scoped (minTurnIndex), so whatever it proves terminal is the right turn,
  // even when the real answer is shorter than a verbose preamble.
  const elapsedMs = Date.now() - start;
  const remainingMs = Math.max(0, timeoutMs - elapsedMs);
  if (remainingMs > 0) {
    logger("Confirming the capture is terminal (not a mid-stream/preamble capture)");
    const completed = await pollAssistantCompletion(
      Runtime,
      remainingMs,
      minTurnIndex,
      expectedConversationId,
    );
    if (completed) {
      return completed;
    }
    // Could not prove completion within the budget: refuse rather than finalize a possibly
    // incomplete capture. A clean, fast failure is recoverable (retry/salvage) and never
    // ships a preamble as if it were the answer.
    await logDomFailure(Runtime, logger, "assistant-response-unconfirmed");
    throw new Error(
      "assistant-response could not be confirmed complete before timeout; refusing to finalize a possibly-incomplete capture",
    );
  }

  // Budget already exhausted before we could confirm: refuse rather than fall through and ship
  // an unconfirmed capture. A settled preamble that arrived near the deadline must not be
  // finalized just because there was no time left to prove it terminal.
  await logDomFailure(Runtime, logger, "assistant-response-unconfirmed");
  throw new Error(
    "assistant-response could not be confirmed complete before the deadline; refusing to finalize a possibly-incomplete capture",
  );
}

export async function readAssistantSnapshot(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<AssistantSnapshot | null> {
  const { result } = await Runtime.evaluate({
    expression: buildAssistantSnapshotExpression(minTurnIndex, expectedConversationId),
    returnByValue: true,
  });
  const value = result?.value;
  if (value && typeof value === "object") {
    const snapshot = value as AssistantSnapshot;
    if (typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
      const turnIndex = typeof snapshot.turnIndex === "number" ? snapshot.turnIndex : null;
      if (turnIndex === null) {
        return snapshot;
      }
      if (turnIndex < minTurnIndex) {
        return null;
      }
    }
    return snapshot;
  }
  return null;
}

export async function captureAssistantMarkdown(
  Runtime: ChromeClient["Runtime"],
  meta: { messageId?: string | null; turnId?: string | null },
  logger: BrowserLogger,
): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: buildCopyExpression(meta),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value?.success && typeof result.value.markdown === "string") {
    return result.value.markdown;
  }
  const status = result?.value?.status;
  if (status && status !== "missing-button") {
    logger(`Copy button fallback status: ${status}`);
    await logDomFailure(Runtime, logger, "copy-markdown");
  }
  if (!status) {
    await logDomFailure(Runtime, logger, "copy-markdown");
  }
  return null;
}

export function buildAssistantExtractorForTest(name: string): string {
  return buildAssistantExtractor(name);
}

export function buildAssistantSnapshotExpressionForTest(
  minTurnIndex?: number,
  expectedConversationId?: string,
): string {
  return buildAssistantSnapshotExpression(minTurnIndex, expectedConversationId);
}

export function buildConversationDebugExpressionForTest(): string {
  return buildConversationDebugExpression();
}

export function buildMarkdownFallbackExtractorForTest(minTurnLiteral = "0"): string {
  return buildMarkdownFallbackExtractor(minTurnLiteral);
}

export function buildCopyExpressionForTest(
  meta: { messageId?: string | null; turnId?: string | null } = {},
): string {
  return buildCopyExpression(meta);
}

async function recoverAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const recoveryTimeoutMs = Math.max(0, timeoutMs);
  if (recoveryTimeoutMs === 0) {
    return null;
  }
  const recoveryStartedAt = Date.now();
  const recovered = await waitForCondition(
    async () => {
      const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, expectedConversationId);
      return normalizeAssistantSnapshot(snapshot);
    },
    recoveryTimeoutMs,
    400,
  );
  if (recovered) {
    // Route EVERY recovered snapshot through the terminal-only poller (not just short ones):
    // a recovered long preamble is exactly the raw-return bug this gate exists to prevent.
    logger("Recovered a candidate response; confirming it is terminal before finalizing");
    const remainingMs = Math.max(0, recoveryTimeoutMs - (Date.now() - recoveryStartedAt));
    if (remainingMs > 0) {
      const confirmed = await pollAssistantCompletion(
        Runtime,
        remainingMs,
        minTurnIndex,
        expectedConversationId,
      );
      if (confirmed) {
        logger("Recovered and confirmed assistant response via polling fallback");
        return confirmed;
      }
      // Unconfirmable within budget: refuse (return null) so the caller fails fast instead
      // of finalizing a possibly-incomplete recovered capture.
      await logConversationSnapshot(Runtime, logger).catch(() => undefined);
      return null;
    }
    // No confirmation time left: refuse rather than return the unconfirmed recovered snapshot
    // (returning it raw would reopen the recovered-long-preamble leak this gate closes).
    await logConversationSnapshot(Runtime, logger).catch(() => undefined);
    return null;
  }
  await logConversationSnapshot(Runtime, logger).catch(() => undefined);
  return null;
}

async function parseAssistantEvaluationResult(
  _Runtime: ChromeClient["Runtime"],
  evaluation: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>>,
  _logger: BrowserLogger,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const { result } = evaluation;
  if (
    result.type === "object" &&
    result.value &&
    typeof result.value === "object" &&
    "text" in result.value
  ) {
    const html =
      typeof (result.value as { html?: unknown }).html === "string"
        ? ((result.value as { html?: string }).html ?? undefined)
        : undefined;
    const turnId =
      typeof (result.value as { turnId?: unknown }).turnId === "string"
        ? ((result.value as { turnId?: string }).turnId ?? undefined)
        : undefined;
    const messageId =
      typeof (result.value as { messageId?: unknown }).messageId === "string"
        ? ((result.value as { messageId?: string }).messageId ?? undefined)
        : undefined;
    const text = cleanAssistantText(String((result.value as { text: unknown }).text ?? ""));
    const normalized = text.toLowerCase();
    if (isAnswerNowPlaceholderText(normalized)) {
      return null;
    }
    return { text, html, meta: { turnId, messageId } };
  }
  const fallbackText =
    typeof result.value === "string" ? cleanAssistantText(result.value as string) : "";
  if (!fallbackText) {
    return null;
  }
  if (isAnswerNowPlaceholderText(fallbackText.toLowerCase())) {
    return null;
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function refreshAssistantSnapshot(
  Runtime: ChromeClient["Runtime"],
  current: {
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  },
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const deadline = Date.now() + 5_000;
  let best: {
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  } | null = null;
  let stableCycles = 0;
  const stableTarget = 3;
  while (Date.now() < deadline) {
    // Learned: short/fast answers can race; poll a few extra cycles to pick up messageId + full text.
    const latestSnapshot = await readAssistantSnapshot(
      Runtime,
      minTurnIndex,
      expectedConversationId,
    ).catch(() => null);
    const latest = normalizeAssistantSnapshot(latestSnapshot);
    if (latest) {
      if (
        !best ||
        latest.text.length > best.text.length ||
        (!best.meta.messageId && latest.meta.messageId)
      ) {
        best = latest;
        stableCycles = 0;
      } else if (latest.text.trim() === best.text.trim()) {
        stableCycles += 1;
      }
    }
    if (best && stableCycles >= stableTarget) {
      break;
    }
    await delay(300);
  }
  if (!best) {
    return null;
  }
  const currentLength = cleanAssistantText(current.text).trim().length;
  const latestLength = best.text.length;
  const hasBetterId = !current.meta?.messageId && Boolean(best.meta.messageId);
  const isLonger = latestLength > currentLength;
  const hasDifferentText = best.text.trim() !== current.text.trim();
  if (isLonger || hasBetterId || hasDifferentText) {
    logger("Refreshed assistant response via latest snapshot");
    return best;
  }
  return null;
}

async function terminateRuntimeExecution(Runtime: ChromeClient["Runtime"]): Promise<void> {
  if (typeof Runtime.terminateExecution !== "function") {
    return;
  }
  try {
    await Runtime.terminateExecution();
  } catch {
    // ignore termination failures
  }
}

async function pollAssistantCompletion(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
  abortSignal?: AbortSignal,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const watchdogDeadline = Date.now() + timeoutMs;
  let gate = createTerminalGateState(Date.now());
  while (Date.now() < watchdogDeadline) {
    // Check abort signal to stop polling when another path won the race
    if (abortSignal?.aborted) {
      return null;
    }
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, expectedConversationId);
    const normalized = normalizeAssistantSnapshot(snapshot);
    if (normalized) {
      // Generated-image answers stream no text and mount no action bar; accept immediately
      // (kept BEFORE the terminal gate so they never wait out the quiet window).
      if (isGeneratedImageAssistantAnswer(normalized)) {
        return normalized;
      }
      const [stopVisible, barVisible, thinkingActivity] = await Promise.all([
        isStopButtonVisible(Runtime),
        isCompletionVisible(Runtime, normalized.meta, minTurnIndex),
        readThinkingActivity(Runtime),
      ]);
      const decision = classifyTurnTerminal(
        gate,
        {
          now: Date.now(),
          len: normalized.text.length,
          // Fingerprint = turn/message identity + the full text, so a same-length rewrite, a
          // shorter final answer replacing a longer preamble, or a new turn all count as change.
          contentKey: `${normalized.meta.messageId ?? normalized.meta.turnId ?? ""}::${normalized.text}`,
          stopVisible,
          barVisible,
          thinkingActive: thinkingActivity.active,
          strongThinkingActive: thinkingActivity.strong,
          thinkingKey: thinkingActivity.key,
        },
        TERMINAL_GATE_CONFIG,
      );
      gate = decision.state;
      if (decision.terminal) {
        return normalized;
      }
    } else {
      // The turn disappeared/reset (navigation, re-render): restart the gate so a stale
      // quiet streak cannot carry over onto a fresh turn.
      gate = createTerminalGateState(Date.now());
    }
    await delay(400);
  }
  return null;
}

async function isStopButtonVisible(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: buildStopButtonVisibilityExpression(),
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

function buildStopButtonVisibilityExpression(): string {
  return `(() => {
    ${buildStopButtonVisibilityPredicateJs("isStopControlVisible")}
    return isStopControlVisible();
  })()`;
}

function buildStopButtonVisibilityPredicateJs(fnName: string): string {
  const selectorLiteral = JSON.stringify(STOP_CONTROL_SELECTOR);
  return `const ${fnName} = () => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return !(
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity !== '' && Number(style.opacity) === 0)
      );
    };
    return Array.from(document.querySelectorAll(${selectorLiteral})).some((node) => isVisible(node));
  };`;
}

export const buildStopButtonVisibilityExpressionForTest = buildStopButtonVisibilityExpression;

function buildCompletionVisibilityExpression(
  meta: { turnId?: string | null; messageId?: string | null },
  minTurnIndex?: number,
): string {
  const expectedMessageId = meta.messageId ? JSON.stringify(meta.messageId) : "null";
  const expectedTurnId = meta.turnId ? JSON.stringify(meta.turnId) : "null";
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    const EXPECTED_MESSAGE_ID = ${expectedMessageId};
    const EXPECTED_TURN_ID = ${expectedTurnId};
    const MIN_TURN_INDEX = ${minTurnLiteral};
    // Find the LAST assistant turn to check completion status. Must match the same logic as
    // buildAssistantExtractor, then correlate the controls to the sampled response.
    const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const turns = ${buildConversationTurnListExpression()};
    let lastAssistantTurn = null;
    let lastAssistantIndex = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (isAssistantTurn(turns[i])) {
        lastAssistantTurn = turns[i];
        lastAssistantIndex = i;
        break;
      }
    }
    if (!lastAssistantTurn) return false;

    const hasExpectedIdentity = Boolean(EXPECTED_MESSAGE_ID || EXPECTED_TURN_ID);
    if (hasExpectedIdentity) {
      const identityNodes = [
        lastAssistantTurn,
        ...Array.from(lastAssistantTurn.querySelectorAll('[data-message-id], [data-testid]')),
      ];
      const identityMatches = identityNodes.some((node) =>
        (EXPECTED_MESSAGE_ID && node.getAttribute?.('data-message-id') === EXPECTED_MESSAGE_ID) ||
        (EXPECTED_TURN_ID && node.getAttribute?.('data-testid') === EXPECTED_TURN_ID),
      );
      if (!identityMatches) return false;
    } else if (MIN_TURN_INDEX < 0 || lastAssistantIndex < MIN_TURN_INDEX) {
      // Fallback/project snapshots without an identity may use the new-turn baseline, but an
      // uncorrelated persistent action bar from an older turn must never prove completion.
      return false;
    }

    if (lastAssistantTurn.querySelector('${FINISHED_ACTIONS_SELECTOR}')) return true;
    const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
    return Array.from(markdowns).some((node) => (node.textContent || '').trim() === 'Done');
  })()`;
}

async function isCompletionVisible(
  Runtime: ChromeClient["Runtime"],
  meta: { turnId?: string | null; messageId?: string | null },
  minTurnIndex?: number,
): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: buildCompletionVisibilityExpression(meta, minTurnIndex),
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

export const buildCompletionVisibilityExpressionForTest = buildCompletionVisibilityExpression;

function normalizeAssistantSnapshot(snapshot: AssistantSnapshot | null): {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null {
  const text = snapshot?.text ? cleanAssistantText(snapshot.text) : "";
  if (!text.trim()) {
    return null;
  }
  const normalized = text.toLowerCase();
  // "Pro thinking" often renders a placeholder turn containing an "Answer now" gate.
  // Treat it as incomplete so browser mode keeps waiting for the real assistant text.
  if (isAnswerNowPlaceholderText(normalized)) {
    return null;
  }
  // Ignore user echo turns that can show up in project view fallbacks.
  if (normalized.startsWith("you said")) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
  };
}

function isGeneratedImageAssistantAnswer(answer: { html?: string } | null): boolean {
  return Boolean(answer?.html?.includes("/backend-api/estuary/content?id=file_"));
}

async function waitForCondition<T>(
  getter: () => Promise<T | null>,
  timeoutMs: number,
  pollIntervalMs = 400,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) {
      return value;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

function buildAssistantSnapshotExpression(
  minTurnIndex?: number,
  expectedConversationId?: string,
): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const expectedConversationLiteral =
    typeof expectedConversationId === "string" && expectedConversationId.trim().length > 0
      ? JSON.stringify(expectedConversationId.trim())
      : "null";
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const EXPECTED_CONVERSATION_ID = ${expectedConversationLiteral};
    const currentHref = typeof location === 'object' && location.href ? location.href : '';
    const currentConversationId = currentHref.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
    if (
      EXPECTED_CONVERSATION_ID &&
      currentConversationId &&
      currentConversationId !== EXPECTED_CONVERSATION_ID
    ) {
      return null;
    }
    // Learned: the default turn DOM misses project view; keep a fallback extractor.
    ${buildAssistantExtractor("extractAssistantTurn")}
    const extracted = extractAssistantTurn();
    const isPlaceholder = (snapshot) => {
      const normalized = String(snapshot?.text ?? '').toLowerCase().trim();
      if (normalized === 'chatgpt said:' || normalized === 'chatgpt said') return true;
      if (normalized.includes('file upload request') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
        return true;
      }
      return normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'));
    };
    ${buildActiveThinkingStatusPredicateJs("isActiveThinkingStatus")}
    if (
      extracted &&
      extracted.text &&
      !isPlaceholder(extracted) &&
      !isActiveThinkingStatus(extracted)
    ) {
      return extracted;
    }
    // Fallback for ChatGPT project view: answers can live outside conversation turns.
    const extractFallback = ${buildMarkdownFallbackExtractor("MIN_TURN_INDEX")};
    const fallback = extractFallback();
    if (fallback && !isPlaceholder(fallback) && !isActiveThinkingStatus(fallback)) {
      return fallback;
    }
    return null;
  })()`;
}

function buildResponseObserverExpression(
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const expectedConversationLiteral =
    typeof expectedConversationId === "string" && expectedConversationId.trim().length > 0
      ? JSON.stringify(expectedConversationId.trim())
      : "null";
  return `(() => {
    ${buildClickDispatcher()}
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = ${JSON.stringify(STOP_CONTROL_SELECTOR)};
    const FINISHED_SELECTOR = '${FINISHED_ACTIONS_SELECTOR}';
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const EXPECTED_CONVERSATION_ID = ${expectedConversationLiteral};
    // Learned: settling avoids capturing mid-stream HTML; keep short.
    const settleDelayMs = 800;
    const currentConversationId = () => {
      const href = typeof location === 'object' && location.href ? location.href : '';
      return href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
    };
    const matchesExpectedConversation = () => {
      if (!EXPECTED_CONVERSATION_ID) return true;
      const currentId = currentConversationId();
      return !currentId || currentId === EXPECTED_CONVERSATION_ID;
    };
    const isAnswerNowPlaceholder = (snapshot) => {
      const normalized = String(snapshot?.text ?? '').toLowerCase().trim();
      if (normalized === 'chatgpt said:' || normalized === 'chatgpt said') return true;
      if (normalized.includes('file upload request') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
        return true;
      }
      return normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'));
    };
    ${buildActiveThinkingStatusPredicateJs("isActiveThinkingStatus")}
    ${buildThinkingActivePredicateJs("isThinkingActiveNow")}

    // Helper to detect assistant turns - must match buildAssistantExtractor logic for consistency.
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const MIN_TURN_INDEX = ${minTurnLiteral};
    ${buildAssistantExtractor("extractFromTurns")}
    // Learned: some layouts (project view) render markdown without assistant turn wrappers.
    const extractFromMarkdownFallback = ${buildMarkdownFallbackExtractor("MIN_TURN_INDEX")};

    const acceptSnapshot = (snapshot) => {
      if (!snapshot) return null;
      if (!matchesExpectedConversation()) return null;
      const index = typeof snapshot.turnIndex === 'number' ? snapshot.turnIndex : -1;
      if (MIN_TURN_INDEX >= 0) {
        if (index < 0 || index < MIN_TURN_INDEX) {
          return null;
        }
      }
      return snapshot;
    };

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        let timeoutId = null;
        let cleanedUp = false;
        let observer = null;

        // Centralized cleanup to prevent resource leaks
        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          if (observer) {
            try {
              observer.disconnect();
            } catch {
              // ignore disconnect errors
            }
            observer = null;
          }
        };

        const observerCallback = () => {
          if (cleanedUp) return;
          try {
            const extractedRaw = extractFromTurns();
            const extractedCandidate =
              extractedRaw &&
              !isAnswerNowPlaceholder(extractedRaw) &&
              !isActiveThinkingStatus(extractedRaw)
                ? extractedRaw
                : null;
            let extracted = acceptSnapshot(extractedCandidate);
            if (!extracted) {
              const fallbackRaw = extractFromMarkdownFallback();
              const fallbackCandidate =
                fallbackRaw &&
                !isAnswerNowPlaceholder(fallbackRaw) &&
                !isActiveThinkingStatus(fallbackRaw)
                  ? fallbackRaw
                  : null;
              extracted = acceptSnapshot(fallbackCandidate);
            }
            if (extracted) {
              cleanup();
              resolve(extracted);
            } else if (Date.now() > deadline) {
              cleanup();
              reject(new Error('Response timeout'));
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        };

        observer = new MutationObserver(observerCallback);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    // Check if the last assistant turn has finished (scoped to avoid detecting old turns).
    const isLastAssistantTurnFinished = () => {
      const turns = ${buildConversationTurnListExpression()};
      let lastAssistantTurn = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isAssistantTurn(turns[i])) {
          lastAssistantTurn = turns[i];
          break;
        }
      }
      if (!lastAssistantTurn) return false;
      // Check for action buttons in this specific turn
      if (lastAssistantTurn.querySelector(FINISHED_SELECTOR)) return true;
      // Check for "Done" text in this turn's markdown
      const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
      return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
    };

    const waitForSettle = async (snapshot) => {
      if (String(snapshot?.html ?? '').includes('/backend-api/estuary/content?id=file_')) {
        return snapshot;
      }
      // Learned: short answers can be 1-2 tokens; enforce longer settle windows to avoid truncation.
      // Learned: long streaming responses (esp. thinking models) can pause mid-stream;
      // use progressively longer windows to avoid truncation (#71).
      const initialLength = snapshot?.text?.length ?? 0;
      const shortAnswer = initialLength > 0 && initialLength < ${MIN_CONFIDENT_ANSWER_LENGTH};
      const mediumAnswer = initialLength >= ${MIN_CONFIDENT_ANSWER_LENGTH} && initialLength < 40;
      const longAnswer = initialLength >= 40 && initialLength < 500;
      const settleWindowMs = shortAnswer ? 12_000 : mediumAnswer ? 5_000 : longAnswer ? 8_000 : 10_000;
      const settleIntervalMs = 400;
      const deadline = Date.now() + settleWindowMs;
      let latest = snapshot;
      let lastLength = snapshot?.text?.length ?? 0;
      let stableCycles = 0;
      const stableTarget = shortAnswer ? 6 : mediumAnswer ? 3 : longAnswer ? 5 : 6;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, settleIntervalMs));
        const refreshedRaw = extractFromTurns();
        const refreshedCandidate =
          refreshedRaw &&
          !isAnswerNowPlaceholder(refreshedRaw) &&
          !isActiveThinkingStatus(refreshedRaw)
            ? refreshedRaw
            : null;
        let refreshed = acceptSnapshot(refreshedCandidate);
        if (!refreshed) {
          const fallbackRaw = extractFromMarkdownFallback();
          const fallbackCandidate =
            fallbackRaw &&
            !isAnswerNowPlaceholder(fallbackRaw) &&
            !isActiveThinkingStatus(fallbackRaw)
              ? fallbackRaw
              : null;
          refreshed = acceptSnapshot(fallbackCandidate);
        }
        const nextLength = refreshed?.text?.length ?? lastLength;
        if (refreshed && nextLength >= lastLength) {
          latest = refreshed;
        }
        if (nextLength > lastLength) {
          lastLength = nextLength;
          stableCycles = 0;
        } else {
          stableCycles += 1;
        }
        const stopVisible = Boolean(document.querySelector(STOP_SELECTOR));
        const finishedVisible = isLastAssistantTurnFinished();
        // Defense in depth (the node side re-confirms every capture): never settle on a
        // stable-but-quiet candidate while the model is actively thinking/generating, so the
        // observer does not hand a settled preamble to the node path during the reasoning gap.
        const thinkingActiveNow = isThinkingActiveNow();

        if (
          finishedVisible ||
          (!stopVisible && !thinkingActiveNow && stableCycles >= stableTarget)
        ) {
          break;
        }
      }
      return latest ?? snapshot;
    };

    const extractedRaw = extractFromTurns();
    const extractedCandidate =
      extractedRaw &&
      !isAnswerNowPlaceholder(extractedRaw) &&
      !isActiveThinkingStatus(extractedRaw)
        ? extractedRaw
        : null;
    let extracted = acceptSnapshot(extractedCandidate);
    if (!extracted) {
      const fallbackRaw = extractFromMarkdownFallback();
      const fallbackCandidate =
        fallbackRaw &&
        !isAnswerNowPlaceholder(fallbackRaw) &&
        !isActiveThinkingStatus(fallbackRaw)
          ? fallbackRaw
          : null;
      extracted = acceptSnapshot(fallbackCandidate);
    }
    if (extracted) {
      return waitForSettle(extracted);
    }
    return captureViaObserver().then((payload) => waitForSettle(payload));
  })()`;
}

function buildAssistantExtractor(functionName: string): string {
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const ${functionName} = () => {
    ${buildClickDispatcher()}
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') {
        return true;
      }
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const expandCollapsibles = (root) => {
      const buttons = Array.from(root.querySelectorAll('button'));
      for (const button of buttons) {
        const label = (button.textContent || '').toLowerCase();
        const testid = (button.getAttribute('data-testid') || '').toLowerCase();
        if (
          label.includes('more') ||
          label.includes('expand') ||
          label.includes('show') ||
          testid.includes('markdown') ||
          testid.includes('toggle')
        ) {
          dispatchClickSequence(button);
        }
      }
    };

    const turns = ${buildConversationTurnListExpression()};
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) {
        continue;
      }
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) ?? turn;
      expandCollapsibles(messageRoot);
      const preferred =
        (messageRoot.matches?.('.markdown') || messageRoot.matches?.('[data-message-content]') ? messageRoot : null) ||
        messageRoot.querySelector('.markdown') ||
        messageRoot.querySelector('[data-message-content]') ||
        messageRoot.querySelector('[data-testid*="message"]') ||
        messageRoot.querySelector('[data-testid*="assistant"]') ||
        messageRoot.querySelector('.prose') ||
        messageRoot.querySelector('[class*="markdown"]');
      const contentRoot = preferred ?? messageRoot;
      if (!contentRoot) {
        continue;
      }
      const innerText = contentRoot?.innerText ?? '';
      const textContent = contentRoot?.textContent ?? '';
      const text = innerText.trim().length > 0 ? innerText : textContent;
      const html = contentRoot?.innerHTML ?? '';
      const messageId = messageRoot.getAttribute('data-message-id');
      const turnId = messageRoot.getAttribute('data-testid');
      const generatedImages = Array.from(messageRoot.querySelectorAll('img')).filter((img) =>
        String(img?.src || '').includes('/backend-api/estuary/content?id=file_')
      );
      const normalizedText = String(text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const imageOnlyChrome =
        !normalizedText ||
        normalizedText === 'edit' ||
        normalizedText === 'stopped thinking' ||
        normalizedText === 'stopped thinking edit' ||
        /^(?:reasoning\\s+|pro thinking\\s+)?thought for \\d+(?:\\.\\d+)?\\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\\s+edit$/.test(normalizedText);
      if (generatedImages.length > 0 && imageOnlyChrome) {
        const label = generatedImages.length === 1 ? 'Generated image.' : \`Generated \${generatedImages.length} images.\`;
        return { text: label, html: messageRoot?.innerHTML ?? html, messageId, turnId, turnIndex: index };
      }
      if (text.trim()) {
        return { text, html, messageId, turnId, turnIndex: index };
      }
    }
    return null;
  };`;
}

function buildMarkdownFallbackExtractor(minTurnLiteral?: string): string {
  const turnIndexValue = minTurnLiteral
    ? `(${minTurnLiteral} >= 0 ? ${minTurnLiteral} : null)`
    : "null";
  return `(() => {
    const __minTurn = ${turnIndexValue};
    const roots = [
      document.querySelector('section[data-testid="screen-threadFlyOut"]'),
      document.querySelector('[data-testid="chat-thread"]'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
    ].filter(Boolean);
    if (roots.length === 0) return null;
    const markdownSelector = '.markdown,[data-message-content],[data-testid*="message"],.prose,[class*="markdown"]';
    const isExcluded = (node) =>
      Boolean(
        node?.closest?.(
          'nav, aside, [data-testid*="sidebar"], [data-testid*="chat-history"], [data-testid*="composer"], form',
        ),
      );
    const scoreRoot = (node) => {
      const actions = node.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}').length;
      const assistants = node.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]').length;
      const markdowns = node.querySelectorAll(markdownSelector).length;
      return actions * 10 + assistants * 5 + markdowns;
    };
    let root = roots[0];
    let bestScore = scoreRoot(root);
    for (let i = 1; i < roots.length; i += 1) {
      const candidate = roots[i];
      const score = scoreRoot(candidate);
      if (score > bestScore) {
        bestScore = score;
        root = candidate;
      }
    }
    if (!root) return null;
    const turnNodes = ${buildConversationTurnListExpression()};
    const hasTurns = turnNodes.length > 0;
    const resolveTurnIndex = (node) => {
      const idx = turnNodes.findIndex((turn) => turn === node || turn.contains?.(node));
      return idx >= 0 ? idx : null;
    };
    const isAfterMinTurn = (node) => {
      if (__minTurn === null) return true;
      if (!hasTurns) return true;
      const idx = resolveTurnIndex(node);
      return idx !== null && idx >= __minTurn;
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const collectUserText = (scope) => {
      if (!scope?.querySelectorAll) return '';
      const userTurns = Array.from(scope.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'));
      const lastUser = userTurns[userTurns.length - 1];
      return lastUser ? normalize(lastUser.innerText || lastUser.textContent || '') : '';
    };
    const userText = collectUserText(root) || collectUserText(document);
    const isUserEcho = (text) => {
      if (!userText) return false;
      const normalized = normalize(text);
      if (!normalized) return false;
      return normalized === userText || normalized.startsWith(userText);
    };
    const markdowns = Array.from(root.querySelectorAll(markdownSelector))
      .filter((node) => !isExcluded(node))
      .filter((node) => {
        const container = node.closest('[data-message-author-role], [data-turn]');
        if (!container) return true;
        const role =
          (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
        return role !== 'user';
      });
    if (markdowns.length === 0) return null;
    const actionButtons = Array.from(root.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}'));
    const actionMarkdowns = [];
    for (const button of actionButtons) {
      const container =
        button.closest('${CONVERSATION_TURN_SELECTOR}') ||
        button.closest('[data-message-author-role="assistant"], [data-turn="assistant"]') ||
        button.closest('[data-message-author-role], [data-turn]') ||
        button.closest('[data-testid*="assistant"]');
      if (!container || container === root || container === document.body) continue;
      const scoped = Array.from(container.querySelectorAll(markdownSelector))
        .filter((node) => !isExcluded(node))
        .filter((node) => {
          const roleNode = node.closest('[data-message-author-role], [data-turn]');
          if (!roleNode) return true;
          const role =
            (roleNode.getAttribute('data-message-author-role') || roleNode.getAttribute('data-turn') || '').toLowerCase();
          return role !== 'user';
        });
      if (scoped.length === 0) continue;
      for (const node of scoped) {
        actionMarkdowns.push(node);
      }
    }
    const assistantMarkdowns = markdowns.filter((node) => {
      const container = node.closest('[data-message-author-role], [data-turn], [data-testid*="assistant"]');
      if (!container) return false;
      const role =
        (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (container.getAttribute('data-testid') || '').toLowerCase();
      return testId.includes('assistant');
    });
    const hasAssistantIndicators = Boolean(
      root.querySelector('${FINISHED_ACTIONS_SELECTOR}') ||
        root.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'),
    );
    const allowMarkdownFallback = hasAssistantIndicators || hasTurns || Boolean(userText);
    const candidates =
      actionMarkdowns.length > 0
        ? actionMarkdowns
        : assistantMarkdowns.length > 0
          ? assistantMarkdowns
          : allowMarkdownFallback
            ? markdowns
            : [];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const node = candidates[i];
      if (!node) continue;
      if (!isAfterMinTurn(node)) continue;
      const text = (node.innerText || node.textContent || '').trim();
      if (!text) continue;
      if (isUserEcho(text)) continue;
      const html = node.innerHTML ?? '';
      const turnIndex = resolveTurnIndex(node);
      return { text, html, messageId: null, turnId: null, turnIndex };
    }
    return null;
  })`;
}

function buildCopyExpression(meta: { messageId?: string | null; turnId?: string | null }): string {
  return `(() => {
    ${buildClickDispatcher()}
    const BUTTON_SELECTOR = '${COPY_BUTTON_SELECTOR}';
    const TIMEOUT_MS = 10000;

    const locateButton = () => {
      const hint = ${JSON.stringify(meta ?? {})};
      if (hint?.messageId) {
        const node = document.querySelector('[data-message-id="' + hint.messageId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      if (hint?.turnId) {
        const node = document.querySelector('[data-testid="' + hint.turnId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
      const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
      const isAssistantTurn = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        if (turnAttr === 'assistant') return true;
        const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
        if (role === 'assistant') return true;
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        if (testId.includes('assistant')) return true;
        return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
      };
      const turns = ${buildConversationTurnListExpression()};
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (!isAssistantTurn(turn)) continue;
        const button = turn.querySelector(BUTTON_SELECTOR);
        if (button) {
          return button;
        }
      }
      const all = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const button = all[i];
        const turn = button?.closest?.(CONVERSATION_SELECTOR);
        if (turn && isAssistantTurn(turn)) {
          return button;
        }
      }
      return null;
    };

    const interceptClipboard = () => {
      const clipboard = navigator.clipboard;
      const state = { text: '', updatedAt: 0 };
      if (!clipboard) {
        return { state, restore: () => {} };
      }
      const originalWriteText = clipboard.writeText;
      const originalWrite = clipboard.write;
      clipboard.writeText = (value) => {
        state.text = typeof value === 'string' ? value : '';
        state.updatedAt = Date.now();
        return Promise.resolve();
      };
      clipboard.write = async (items) => {
        try {
          const list = Array.isArray(items) ? items : items ? [items] : [];
          for (const item of list) {
            if (!item) continue;
            const types = Array.isArray(item.types) ? item.types : [];
            if (types.includes('text/plain') && typeof item.getType === 'function') {
              const blob = await item.getType('text/plain');
              const text = await blob.text();
              state.text = text ?? '';
              state.updatedAt = Date.now();
              break;
            }
          }
        } catch {
          state.text = '';
          state.updatedAt = Date.now();
        }
        return Promise.resolve();
      };
      return {
        state,
        restore: () => {
          clipboard.writeText = originalWriteText;
          clipboard.write = originalWrite;
        },
      };
    };

    return new Promise((resolve) => {
      const deadline = Date.now() + TIMEOUT_MS;
      const waitForButton = () => {
        const button = locateButton();
        if (button) {
          const interception = interceptClipboard();
          let settled = false;
          let pollId = null;
          let timeoutId = null;
          const finish = (payload) => {
            if (settled) {
              return;
            }
            settled = true;
            if (pollId) {
              clearInterval(pollId);
            }
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            button.removeEventListener('copy', handleCopy, true);
            interception.restore?.();
            resolve(payload);
          };

          const readIntercepted = () => {
            const markdown = interception.state.text ?? '';
            const updatedAt = interception.state.updatedAt ?? 0;
            return { success: Boolean(markdown.trim()), markdown, updatedAt };
          };

          let lastText = '';
          let stableTicks = 0;
          const requiredStableTicks = 3;
          const requiredStableMs = 250;
          const maybeFinish = () => {
            const payload = readIntercepted();
            if (!payload.success) return;
            if (payload.markdown !== lastText) {
              lastText = payload.markdown;
              stableTicks = 0;
              return;
            }
            stableTicks += 1;
            const ageMs = Date.now() - (payload.updatedAt || 0);
            if (stableTicks >= requiredStableTicks && ageMs >= requiredStableMs) {
              finish(payload);
            }
          };

          const handleCopy = () => {
            maybeFinish();
          };

          button.addEventListener('copy', handleCopy, true);
          button.scrollIntoView({ block: 'center', behavior: 'instant' });
          dispatchClickSequence(button);
          pollId = setInterval(maybeFinish, 120);
          timeoutId = setTimeout(() => {
            button.removeEventListener('copy', handleCopy, true);
            finish({ success: false, status: 'timeout' });
          }, TIMEOUT_MS);
          return;
        }
        if (Date.now() > deadline) {
          resolve({ success: false, status: 'missing-button' });
          return;
        }
        setTimeout(waitForButton, 120);
      };

      waitForButton();
    });
  })()`;
}

interface AssistantSnapshot {
  text?: string;
  html?: string;
  messageId?: string | null;
  turnId?: string | null;
  turnIndex?: number | null;
}

const LANGUAGE_TAGS = new Set(
  [
    "copy code",
    "markdown",
    "bash",
    "sh",
    "shell",
    "javascript",
    "typescript",
    "ts",
    "js",
    "yaml",
    "json",
    "python",
    "py",
    "go",
    "java",
    "c",
    "c++",
    "cpp",
    "c#",
    "php",
    "ruby",
    "rust",
    "swift",
    "kotlin",
    "html",
    "css",
    "sql",
    "text",
  ].map((token) => token.toLowerCase()),
);

function cleanAssistantText(text: string): string {
  const normalized = text.replace(/\u00a0/g, " ");
  const lines = normalized.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim().toLowerCase();
    if (LANGUAGE_TAGS.has(trimmed)) return false;
    return true;
  });
  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
