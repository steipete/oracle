import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { joinSelectors } from "../providerDomFlow.js";
import {
  GEMINI_DEEP_THINK_MANIFEST,
  getManifestSelectorLiteral,
} from "../../gemini-web/selectors/geminiDeepThinkManifest.js";
import { sha256OfBytes } from "../../oracle/v18/evidence.js";
import {
  createGeminiDeepThinkMachine,
  geminiDeepThinkMachineVerdict,
  isGeminiDeepThinkFailureState,
  type GeminiDeepThinkEvent,
  type GeminiDeepThinkMachine,
  type GeminiDeepThinkVerdict,
} from "./geminiDeepThink_verification.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;

interface GeminiDomProviderState {
  inputTimeoutMs?: number;
  timeoutMs?: number;
}

export const GEMINI_DEEP_THINK_SELECTORS = {
  input: [
    "rich-textarea .ql-editor",
    '[role="textbox"][aria-label*="prompt" i]',
    'div[contenteditable="true"]',
  ],
  sendButton: ["button.send-button", 'button[aria-label="Send message"]'],
  toolsButton: ["button.toolbox-drawer-button", 'button[aria-label="Tools"]'],
  toolsMenuItem: ['[role="menuitemcheckbox"]', ".toolbox-drawer-item-list-button"],
  deepThinkActive: [
    ".toolbox-drawer-item-deselect-button",
    'button[aria-label*="Deselect Deep Think"]',
  ],
  uploadButton: ['button[aria-label="Open upload file menu"]', ".upload-card-button"],
  uploadMenuItem: ['[role="menuitem"]'],
  uploadTrigger: [".hidden-local-file-upload-button", ".hidden-local-upload-button"],
  uploaderContainer: [".uploader-button-container", ".file-uploader"],
  uploaderElement: ["uploader.upload-button"],
  userTurnAttachment: [".file-preview-container"],
  responseTurn: ["model-response"],
  responseText: ["message-content", ".model-response-text message-content"],
  responseComplete: [".response-footer.complete"],
  userQuery: ["user-query"],
  userQueryText: ["user-query-content", ".query-text"],
  spinner: ['[role="progressbar"]'],
  thoughtsToggle: [".thoughts-header-button", '[data-test-id="thoughts-header-button"]'],
  thoughtsContent: ["model-thoughts", '[data-test-id="model-thoughts"]'],
  hasThoughts: [".has-thoughts"],
} as const;

function asSelectorLiteral(selectors: readonly string[]): string {
  return JSON.stringify(joinSelectors(selectors));
}

function readTimeouts(ctx: ProviderDomFlowContext): {
  uiTimeoutMs: number;
  responseTimeoutMs: number;
} {
  const state = ctx.state as GeminiDomProviderState | undefined;
  const uiTimeoutMs =
    typeof state?.inputTimeoutMs === "number" && Number.isFinite(state.inputTimeoutMs)
      ? Math.max(1_000, state.inputTimeoutMs)
      : UI_TIMEOUT_MS;
  const responseTimeoutMs =
    typeof state?.timeoutMs === "number" && Number.isFinite(state.timeoutMs)
      ? Math.max(1_000, state.timeoutMs)
      : RESPONSE_TIMEOUT_MS;
  return { uiTimeoutMs, responseTimeoutMs };
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Waiting for Gemini UI to load...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const { uiTimeoutMs } = readTimeouts(ctx);
  const uiDeadline = Date.now() + uiTimeoutMs;
  let uiReady = false;
  let sawLoginRedirect = false;

  while (Date.now() < uiDeadline) {
    const state = await ctx.evaluate<{ ready?: boolean; requiresLogin?: boolean }>(
      `(() => {
        const editor = document.querySelector(${inputSelector});
        const href = location.href || '';
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const requiresLogin =
          href.includes('accounts.google.com') ||
          (bodyText.includes('sign in') && bodyText.includes('google'));
        return { ready: Boolean(editor), requiresLogin };
      })()`,
    );
    if (state?.ready) {
      uiReady = true;
      break;
    }
    if (state?.requiresLogin) {
      sawLoginRedirect = true;
    }
    await ctx.delay(1_000);
  }

  if (!uiReady) {
    if (sawLoginRedirect) {
      throw new Error("Gemini is showing a sign-in flow. Please sign in in Chrome and retry.");
    }
    throw new Error("Timed out waiting for Gemini UI prompt input to become ready.");
  }
}

async function selectMode(ctx: ProviderDomFlowContext): Promise<void> {
  const toolsButtonSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.toolsButton);

  let toolsClickResult = "not-found";
  for (let i = 0; i < 10; i++) {
    toolsClickResult =
      (await ctx.evaluate<string>(
        `(() => {
        const btn = document.querySelector(${toolsButtonSelectors});
        if (btn instanceof HTMLElement) {
          btn.click();
          return 'clicked';
        }
        return 'not-found';
      })()`,
      )) ?? "not-found";
    if (toolsClickResult === "clicked") break;
    await ctx.delay(500);
  }

  if (toolsClickResult !== "clicked") {
    throw new Error("Unable to open Gemini tools menu; Deep Think toggle is not accessible.");
  }
  await ctx.delay(1_000);

  const deepThinkItemSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.toolsMenuItem);
  let deepThinkClickResult = "not-found";
  for (let i = 0; i < 10; i++) {
    deepThinkClickResult =
      (await ctx.evaluate<string>(
        `(() => {
        const items = Array.from(document.querySelectorAll(${deepThinkItemSelectors}));
        for (const item of items) {
          const text = item.textContent?.trim().toLowerCase() ?? '';
          if (!text.includes('deep think')) continue;
          if (item instanceof HTMLElement) item.click();
          return 'clicked';
        }
        return 'not-found';
      })()`,
      )) ?? "not-found";
    if (deepThinkClickResult === "clicked") break;
    await ctx.delay(500);
  }

  if (deepThinkClickResult !== "clicked") {
    throw new Error('Unable to select "Deep Think" from Gemini tools menu.');
  }
  await ctx.delay(1_500);

  const deepThinkActiveSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.deepThinkActive);
  const deepThinkActive = await ctx.evaluate<boolean>(
    `(() => {
      const active = document.querySelector(${deepThinkActiveSelectors});
      if (!(active instanceof HTMLElement)) return false;
      const label = active.getAttribute('aria-label')?.toLowerCase() ?? '';
      const text = active.textContent?.toLowerCase() ?? '';
      return label.includes('deep think') || text.includes('deep think');
    })()`,
  );
  if (!deepThinkActive) {
    throw new Error("Deep Think did not appear selected after clicking the tools menu item.");
  }
}

async function typePrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Typing prompt...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  let typeResult = "no-editor";

  for (let i = 0; i < 10; i++) {
    typeResult =
      (await ctx.evaluate<string>(
        `(() => {
        const editor = document.querySelector(${inputSelector});
        if (!(editor instanceof HTMLElement)) return 'no-editor';
        editor.focus();
        editor.textContent = '';
        if (typeof document.execCommand === 'function') {
          document.execCommand('insertText', false, ${JSON.stringify(ctx.prompt)});
        } else {
          editor.textContent = ${JSON.stringify(ctx.prompt)};
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(ctx.prompt)} }));
        }
        const typed = (editor.textContent || '').trim().length > 0;
        return typed ? 'typed' : 'empty';
      })()`,
      )) ?? "no-editor";

    if (typeResult === "typed") break;
    await ctx.delay(500);
  }

  if (typeResult !== "typed") {
    throw new Error(`Failed to type Gemini prompt (status=${typeResult ?? "unknown"}).`);
  }
  await ctx.delay(500);
}

async function submitPrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[gemini-web] Sending prompt...");
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const sendButtonSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.sendButton);

  let sendResult = "not-found";
  for (let i = 0; i < 10; i++) {
    sendResult =
      (await ctx.evaluate<string>(
        `(() => {
        const btn = document.querySelector(${sendButtonSelectors});
        if (btn instanceof HTMLElement && !btn.hasAttribute('disabled')) {
          btn.click();
          return 'clicked';
        }
        const editor = document.querySelector(${inputSelector});
        if (editor instanceof HTMLElement) {
          editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
          return 'enter';
        }
        return 'not-found';
      })()`,
      )) ?? "not-found";

    if (sendResult === "clicked" || sendResult === "enter") break;
    await ctx.delay(500);
  }

  if (sendResult !== "clicked" && sendResult !== "enter") {
    throw new Error("Failed to submit prompt in Gemini Deep Think mode (send control not found).");
  }
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{ text: string }> {
  ctx.log?.("[gemini-web] Waiting for Deep Think response (this may take a while)...");
  const responseTurnSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const responseTextSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseText);
  const responseCompleteSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseComplete);
  const spinnerSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.spinner);
  const { responseTimeoutMs } = readTimeouts(ctx);
  const responseDeadline = Date.now() + responseTimeoutMs;
  let lastLog = 0;
  let responseText = "";

  while (Date.now() < responseDeadline) {
    const payload = await ctx.evaluate<string>(
      `(() => {
        const turns = document.querySelectorAll(${responseTurnSel});
        if (turns.length === 0) return JSON.stringify({ status: 'waiting' });
        const lastTurn = turns[turns.length - 1];
        const footer = lastTurn.querySelector(${responseCompleteSel});
        const content = lastTurn.querySelector(${responseTextSel});
        const text = content?.textContent?.trim() ?? '';
        const lower = text.toLowerCase();
        if (lower.includes('generating your response') || lower.includes('check back later') || lower.includes("i'm on it")) {
          return JSON.stringify({ status: 'generating' });
        }
        if (footer && text.length > 0) {
          return JSON.stringify({ status: 'done', text });
        }
        const spinners = lastTurn.querySelectorAll(${spinnerSel});
        const visibleSpinners = Array.from(spinners).filter((s) => s instanceof HTMLElement && s.offsetParent !== null);
        if (text.length > 0 && visibleSpinners.length === 0 && !footer) {
          return JSON.stringify({ status: 'streaming' });
        }
        return JSON.stringify({ status: 'generating' });
      })()`,
    );

    try {
      const parsed = JSON.parse(payload ?? "{}") as { status?: string; text?: string };
      if (parsed.status === "done" && typeof parsed.text === "string" && parsed.text.length > 0) {
        responseText = parsed.text;
        break;
      }
      const now = Date.now();
      if (now - lastLog > 10_000) {
        ctx.log?.(`[gemini-web] Deep Think still generating... (${parsed.status ?? "unknown"})`);
        lastLog = now;
      }
    } catch {
      // ignore parse errors while polling
    }
    await ctx.delay(3_000);
  }

  if (!responseText) {
    throw new Error(
      `Deep Think timed out waiting for response (${Math.ceil(responseTimeoutMs / 1000)} seconds).`,
    );
  }
  return { text: responseText };
}

async function extractThoughts(ctx: ProviderDomFlowContext): Promise<string | null> {
  const thoughtsToggleSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsToggle);
  const thoughtsContentSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsContent);

  let thinkResult = "no-toggle";
  for (let i = 0; i < 10; i++) {
    thinkResult =
      (await ctx.evaluate<string>(
        `(() => {
        const toggle = document.querySelector(${thoughtsToggleSel});
        if (!(toggle instanceof HTMLElement)) return 'no-toggle';
        toggle.click();
        return 'clicked';
      })()`,
      )) ?? "no-toggle";
    if (thinkResult === "clicked") break;
    await ctx.delay(500);
  }

  if (thinkResult !== "clicked") {
    return null;
  }

  await ctx.delay(1_500);
  const extractedThoughts = await ctx.evaluate<string>(
    `(() => {
      const el = document.querySelector(${thoughtsContentSel});
      if (!el) return '';
      const full = el.textContent?.trim() ?? '';
      const btn = el.querySelector('.thoughts-header-button, [data-test-id="thoughts-header-button"]');
      const btnText = btn?.textContent?.trim() ?? '';
      if (btnText && full.startsWith(btnText)) {
        return full.slice(btnText.length).trim();
      }
      return full;
    })()`,
  );
  return typeof extractedThoughts === "string" && extractedThoughts.length > 0
    ? extractedThoughts
    : null;
}

async function applyHighIfExposedStrategy(
  ctx: ProviderDomFlowContext,
): Promise<{ verified: boolean; effort?: string }> {
  const manifest = GEMINI_DEEP_THINK_MANIFEST;
  if (!manifest.thinkingLevelControl) {
    return { verified: false };
  }

  const controlSelector = getManifestSelectorLiteral(manifest.thinkingLevelControl.selector);
  const highOption = manifest.thinkingLevelControl.options["high"];

  const result = await ctx.evaluate<{ clicked: boolean; label?: string }>(
    `(() => {
      const controls = Array.from(document.querySelectorAll(${controlSelector}));
      for (const control of controls) {
        if (!(control instanceof HTMLElement)) continue;
        const text = control.textContent?.trim().toLowerCase() ?? '';
        if (text.includes(${JSON.stringify(highOption.toLowerCase())})) {
          control.click();
          return { clicked: true, label: text };
        }
      }
      return { clicked: false };
    })()`,
  );

  if (result?.clicked) {
    ctx.log?.(`[gemini-web] Selected high thinking level: ${result.label}`);
    return { verified: true, effort: "high" };
  }

  return { verified: false };
}

export const geminiDeepThinkDomProvider: ProviderDomAdapter = {
  providerName: "gemini-web",
  waitForUi,
  selectMode,
  typePrompt,
  submitPrompt,
  waitForResponse,
  extractThoughts,
};

/**
 * Gemini Deep Think provider with high-if-exposed strategy enabled.
 */
export const geminiDeepThinkWithStrategyDomProvider: ProviderDomAdapter = {
  ...geminiDeepThinkDomProvider,
  selectMode: async (ctx) => {
    await selectMode(ctx);
    await applyHighIfExposedStrategy(ctx);
  },
};

// ─── FSM wiring (oracle-svt) ────────────────────────────────────────────────
//
// Production gemini-web/executor.ts previously consumed the bare
// geminiDeepThinkDomProvider, bypassing the verification FSM defined
// in src/browser/state/geminiDeepThink.ts. A live Deep Think run could
// therefore call submitPrompt after a best-effort tools-menu click
// without recording or proving the FSM's same-session verification
// sequence — so a UI drift could ship a result that looked like a
// verified Deep Think turn but wasn't.
//
// `wireGeminiDeepThinkFsm` returns an adapter that owns a fresh FSM
// machine and drives it through every adapter phase. The critical
// invariant: submitPrompt sends `submit_prompt` to the FSM BEFORE
// touching the underlying adapter, so if the machine is not in
// `deep_think_verified_same_session` it transitions to
// `prompt_submitted_before_verification` and we throw — the underlying
// click never fires. Regression tests pin this in
// tests/browser/providers/geminiDeepThink_fsm_wiring.test.ts.

export class GeminiDeepThinkFsmError extends Error {
  readonly verdict: GeminiDeepThinkVerdict;
  constructor(verdict: GeminiDeepThinkVerdict, cause?: unknown) {
    super(
      `Gemini Deep Think FSM rejected operation (state="${verdict.state}", errorCode=${
        verdict.errorCode ?? "n/a"
      }): ${verdict.failureReason ?? "no reason recorded"}`,
    );
    this.name = "GeminiDeepThinkFsmError";
    this.verdict = verdict;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface WiredGeminiDeepThinkAdapter extends ProviderDomAdapter {
  readonly getMachine: () => GeminiDeepThinkMachine;
  readonly getVerdict: () => GeminiDeepThinkVerdict;
}

export interface WireGeminiDeepThinkFsmOptions {
  /**
   * Session identity hash for `deep_think_verified_same_session`.
   * Defaults to a hash derived from the underlying provider name —
   * suitable for the production path where each browser session uses
   * a fresh adapter instance. Pass an explicit value when the caller
   * has a real session id to thread through the FSM.
   */
  readonly sessionIdHash?: `sha256:${string}`;
  /** Override the prompt → sha256 transform for tests. */
  readonly promptSha256?: (prompt: string) => `sha256:${string}`;
  /** Override the response text → sha256 transform for tests. */
  readonly outputSha256?: (text: string) => `sha256:${string}`;
  /** Observer hook fired after every FSM transition. */
  readonly onTransition?: (machine: GeminiDeepThinkMachine) => void;
}

function classifyAdapterError(err: unknown): "login_required" | "ui_drift" {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("sign in") || msg.includes("sign-in") || msg.includes("login")) {
    return "login_required";
  }
  return "ui_drift";
}

export function wireGeminiDeepThinkFsm(
  adapter: ProviderDomAdapter,
  options: WireGeminiDeepThinkFsmOptions = {},
): WiredGeminiDeepThinkAdapter {
  let machine: GeminiDeepThinkMachine = createGeminiDeepThinkMachine();
  const sessionIdHash: `sha256:${string}` =
    options.sessionIdHash ?? sha256OfBytes(`gemini-deep-think:${adapter.providerName}`);
  const promptHash = options.promptSha256 ?? ((text: string) => sha256OfBytes(text));
  const outputHash = options.outputSha256 ?? ((text: string) => sha256OfBytes(text));

  const send = (event: GeminiDeepThinkEvent): void => {
    machine = machine.send(event);
    options.onTransition?.(machine);
  };

  const wired: WiredGeminiDeepThinkAdapter = {
    providerName: adapter.providerName,

    async waitForUi(ctx: ProviderDomFlowContext) {
      send({ type: "browser_connected", mode: "local" });
      try {
        await adapter.waitForUi(ctx);
      } catch (err) {
        const kind = classifyAdapterError(err);
        if (kind === "login_required") {
          send({ type: "login_required" });
        } else {
          send({
            type: "ui_drift_observed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
      send({ type: "login_verified" });
    },

    async selectMode(ctx: ProviderDomFlowContext) {
      send({ type: "gemini_model_candidate_selected", modelLabel: "gemini" });
      send({ type: "deep_think_menu_opened" });
      try {
        if (adapter.selectMode) await adapter.selectMode(ctx);
      } catch (err) {
        send({
          type: "ui_drift_observed",
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      send({ type: "deep_think_candidate_selected", deepThinkLabel: "deep think" });
      send({
        type: "deep_think_verified_same_session",
        sessionIdHash,
        verifiedAt: new Date().toISOString(),
      });
    },

    typePrompt: (ctx: ProviderDomFlowContext) => adapter.typePrompt(ctx),

    async submitPrompt(ctx: ProviderDomFlowContext) {
      // The gate: send `submit_prompt` to the FSM BEFORE the click.
      // If the machine has not reached `deep_think_verified_same_session`
      // it transitions to `prompt_submitted_before_verification` (a
      // failure state) and we throw — adapter.submitPrompt is NOT called.
      send({
        type: "submit_prompt",
        promptSha256: promptHash(ctx.prompt),
        submittedAt: new Date().toISOString(),
      });
      if (isGeminiDeepThinkFailureState(machine.state)) {
        throw new GeminiDeepThinkFsmError(geminiDeepThinkMachineVerdict(machine));
      }
      await adapter.submitPrompt(ctx);
    },

    async waitForResponse(ctx: ProviderDomFlowContext) {
      send({ type: "response_stream_started" });
      const response = await adapter.waitForResponse(ctx);
      send({
        type: "response_arrived",
        outputTextSha256: outputHash(response.text),
        bytesLength: response.text.length,
        capturedAt: new Date().toISOString(),
      });
      if (isGeminiDeepThinkFailureState(machine.state)) {
        throw new GeminiDeepThinkFsmError(geminiDeepThinkMachineVerdict(machine));
      }
      return response;
    },

    extractThoughts: adapter.extractThoughts
      ? (ctx: ProviderDomFlowContext) => adapter.extractThoughts!(ctx)
      : undefined,

    getMachine: () => machine,
    getVerdict: () => geminiDeepThinkMachineVerdict(machine),
  };

  return wired;
}

/**
 * Production-ready Gemini Deep Think provider wired through the v18
 * verification FSM. Use this from gemini-web/executor.ts instead of
 * the bare `geminiDeepThinkDomProvider` so live DOM runs cannot
 * submit a prompt without same-session Deep Think verification.
 */
export const geminiDeepThinkDomProviderWithFsm = (): WiredGeminiDeepThinkAdapter =>
  wireGeminiDeepThinkFsm(geminiDeepThinkDomProvider);

/**
 * Pre-wired adapter for the high-if-exposed strategy variant.
 */
export const geminiDeepThinkWithStrategyDomProviderWithFsm = (): WiredGeminiDeepThinkAdapter =>
  wireGeminiDeepThinkFsm(geminiDeepThinkWithStrategyDomProvider);

// ─── v18 artifact emission (oracle-scb) ────────────────────────────────────
//
// Live Gemini Deep Think runs previously produced NO v18 evidence,
// NO provider_result.v1, and NO evidence_ledger entries — every
// browser_evidence record came from the ChatGPT pipeline only. The
// audit-trail therefore contained zero Gemini runs even though the
// Gemini normalizer / FSM / stream-capture summaries all existed.
//
// `emitGeminiDeepThinkV18ArtifactsForRun` packages the
// orchestrator from src/browser/runLive_v18.ts into a single call the
// live executor (src/gemini-web/executor.ts) makes AFTER the wired
// adapter's runProviderDomFlow returns. It pulls the FSM's
// verification verdict, builds the LiveGeminiBrowserRunCapture from
// the stream summary the executor already maintains, and emits.

import {
  emitV18GeminiBrowserArtifacts,
  type EmitV18GeminiBrowserArtifactsResult,
  type LiveGeminiBrowserRunCapture,
} from "../runLive_v18.js";
import { verifyGeminiDeepThinkCandidate } from "../state/geminiDeepThink.js";
import type { GeminiStreamCaptureSummary } from "../../gemini-web/streamSafeguards.js";
import type { OracleBrowserAccessPath } from "../../oracle/v18/provider_access_policy.js";

export interface EmitGeminiDeepThinkArtifactsInput {
  /** Wired adapter that drove the run — used to read the FSM verdict. */
  readonly wired: WiredGeminiDeepThinkAdapter;
  /** Session id for evidence/ledger anchoring. */
  readonly sessionId: string;
  /** Verbatim prompt submitted to Gemini. */
  readonly promptText: string;
  /** Captured assistant response text (markdown if available). */
  readonly answerText: string;
  /** Stream-ownership capture summary from streamSafeguards.ts. */
  readonly stream: GeminiStreamCaptureSummary;
  /** Caller-side prompt-manifest sha256. */
  readonly promptManifestSha256: `sha256:${string}`;
  /** Caller-side source-baseline sha256. */
  readonly sourceBaselineSha256: `sha256:${string}`;
  /** Stable provider_result + evidence ids. */
  readonly providerResultId: string;
  readonly evidenceId: string;
  /** access_path for the result envelope. Defaults to oracle_browser_remote. */
  readonly accessPath?: OracleBrowserAccessPath;
  /** Override Oracle home dir for tests. */
  readonly homeDir?: string;
  /** Optional run id surfaced on the evidence ledger. */
  readonly runId?: string;
  /**
   * Override the Deep Think verification verdict. When omitted the
   * helper derives one from the FSM's recorded labels + selection
   * (typical live-path behaviour); tests pass a known verdict to pin
   * expectations.
   */
  readonly verificationOverride?: Parameters<typeof verifyGeminiDeepThinkCandidate>[0] | null;
}

function deriveVerificationFromFsm(
  wired: WiredGeminiDeepThinkAdapter,
): Parameters<typeof verifyGeminiDeepThinkCandidate>[0] {
  const ctx = wired.getMachine().context;
  const deepThinkLabel = ctx.deepThink?.deepThinkLabel ?? "Deep Think";
  const observedThinkingLevelLabels = ctx.deepThink?.observedLabels ?? [];
  return {
    deepThinkLabel,
    observedThinkingLevelLabels,
    selectedThinkingLevel: ctx.deepThink?.selected ?? null,
    thinkingLevelControlExposed: ctx.deepThink?.thinkingLevelControlExposed ?? false,
  };
}

/**
 * Build the LiveGeminiBrowserRunCapture from a wired adapter + the
 * run's I/O, then drive emitV18GeminiBrowserArtifacts. Exposed as a
 * single entry point so the gemini-web executor can call it on both
 * success and failure paths without re-deriving the verdict shape.
 */
export async function emitGeminiDeepThinkV18ArtifactsForRun(
  input: EmitGeminiDeepThinkArtifactsInput,
): Promise<EmitV18GeminiBrowserArtifactsResult> {
  const deepThink = verifyGeminiDeepThinkCandidate(
    input.verificationOverride ?? deriveVerificationFromFsm(input.wired),
  );
  const machineState = input.wired.getMachine().state;
  // The FSM lands in `deep_think_verified_same_session` (or beyond) on
  // the happy path; before-verify failure states are surfaced via the
  // verdict's errorCode instead. When the caller passes an explicit
  // verificationOverride, trust the override's status as the source of
  // truth — the FSM hasn't necessarily been driven (this is the path
  // tests + post-hoc audits use).
  const verifiedStates: readonly string[] = [
    "deep_think_verified_same_session",
    "prompt_submitted",
    "response_streaming",
    "output_captured_nonempty",
    "evidence_written",
    "success",
  ];
  const verifiedFromFsm = verifiedStates.includes(machineState);
  const verifiedFromOverride =
    input.verificationOverride !== undefined &&
    input.verificationOverride !== null &&
    deepThink.status === "verified";
  const verifiedBeforePromptSubmit = verifiedFromFsm || verifiedFromOverride;
  const modeVerified = verifiedBeforePromptSubmit && deepThink.status !== "ui_drift_suspected";
  const capture: LiveGeminiBrowserRunCapture = {
    promptText: input.promptText,
    answerText: input.answerText,
    stream: input.stream,
    deepThink,
    modeVerified,
    verifiedBeforePromptSubmit,
  };
  return emitV18GeminiBrowserArtifacts({
    sessionId: input.sessionId,
    homeDir: input.homeDir,
    providerSlot: "gemini_deep_think",
    providerResultId: input.providerResultId,
    evidenceId: input.evidenceId,
    accessPath: input.accessPath ?? "oracle_browser_remote",
    capture,
    promptManifestSha256: input.promptManifestSha256,
    sourceBaselineSha256: input.sourceBaselineSha256,
    runId: input.runId,
  });
}
