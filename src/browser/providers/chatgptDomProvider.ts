import type { BrowserLogger, ChromeClient } from "../types.js";
import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { ensurePromptReady } from "../actions/navigation.js";
import { submitPrompt } from "../actions/promptComposer.js";
import { waitForAssistantResponse } from "../actions/assistantResponse.js";
import { sha256OfBytes } from "../../oracle/v18/evidence.js";
import { chatgptSelectorList } from "../selectors/chatgpt/index.js";
import {
  createChatGptProMachine,
  isFailureState,
  machineVerdict,
  type ChatGptProEvent,
  type ChatGptProMachine,
  type ChatGptProState,
  type ChatGptProVerdict,
} from "./chatgptProVerification.js";
import {
  assertChatGptProSynthesisReady,
  type ChatGptProSynthesisCookieState,
  type ChatGptProSynthesisGateDecision,
  type ChatGptProSynthesisLiveTab,
  type ChatGptProSynthesisSessionState,
} from "./chatgptPro_synthesis_gate.js";

// Re-export the v18 selector manifest + effort strategy so downstream
// callers (state machine, doctor surface, evidence builder) can resolve
// every ChatGPT browser dependency from a single module path.
export {
  CHATGPT_EFFORT_TIERS,
  CHATGPT_SELECTOR_MANIFEST,
  SELECTOR_MANIFEST_LAST_VERIFIED,
  SELECTOR_MANIFEST_VERSION,
  availableEffortLabelsHash,
  chatgptManifestFingerprint,
  chatgptSelector,
  chatgptSelectorFingerprint,
  chatgptSelectorList,
  highestKnownLabel,
  pickHighestVisibleEffort,
  tierForLabel,
  type ChatGptEffortTier,
  type ChatGptEffortTierEntry,
  type ChatGptSelectorEntry,
  type ChatGptSelectorPurpose,
  type EffortStatus,
  type EffortStrategyResult,
  type PickHighestVisibleEffortInput,
  type SelectorConfidence,
} from "../selectors/chatgpt/index.js";

interface ChatgptDomProviderState {
  runtime: ChromeClient["Runtime"];
  input: ChromeClient["Input"];
  logger: BrowserLogger;
  timeoutMs: number;
  inputTimeoutMs?: number;
  attachmentTimeoutMs?: number;
  baselineTurns?: number | null;
  attachmentNames?: string[];
  committedTurns?: number | null;
  onPromptSubmitted?: () => Promise<void> | void;
}

interface ChatGptProDomVerificationOverrides {
  enabled?: boolean;
  mode?: "remote" | "local";
  accessPath?: "oracle_browser_remote" | "oracle_browser_local" | "oracle_browser_remote_or_local";
  sessionIdHash?: `sha256:${string}`;
  modelLabel?: string;
  observedEffortLabels?: readonly string[];
  liveTab?: Partial<ChatGptProSynthesisLiveTab>;
  cookies?: ChatGptProSynthesisCookieState | null;
  session?: Partial<ChatGptProSynthesisSessionState>;
}

interface ChatGptProDomProbe {
  modelLabel: string;
  effortLabels: readonly string[];
  selectedEffortLabel: string | null;
  authenticated: boolean;
  promptReady: boolean;
  sendExists: boolean;
  targetId: string | null;
  url: string | null;
  conversationId: string | null;
  fingerprint: string | null;
}

function requireState(ctx: ProviderDomFlowContext): ChatgptDomProviderState {
  const state = ctx.state as ChatgptDomProviderState | undefined;
  if (!state?.runtime || !state?.input || !state?.logger) {
    throw new Error("chatgptDomProvider requires runtime/input/logger in context.state.");
  }
  return state;
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  await ensurePromptReady(state.runtime, state.inputTimeoutMs ?? 30_000, state.logger);
}

async function typePrompt(_ctx: ProviderDomFlowContext): Promise<void> {
  // submitPrompt() handles typing + send for ChatGPT.
}

async function submitPromptViaAdapter(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  const committedTurns = await submitPrompt(
    {
      runtime: state.runtime,
      input: state.input,
      attachmentNames: state.attachmentNames ?? [],
      baselineTurns: state.baselineTurns ?? undefined,
      inputTimeoutMs: state.inputTimeoutMs ?? undefined,
      attachmentTimeoutMs: state.attachmentTimeoutMs ?? undefined,
      onPromptSubmitted: state.onPromptSubmitted,
    },
    ctx.prompt,
    state.logger,
  );
  state.committedTurns =
    typeof committedTurns === "number" && Number.isFinite(committedTurns) ? committedTurns : null;
  if (
    state.committedTurns != null &&
    (state.baselineTurns == null || state.committedTurns > state.baselineTurns)
  ) {
    state.baselineTurns = Math.max(0, state.committedTurns - 1);
  }
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{
  text: string;
  html?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
}> {
  const state = requireState(ctx);
  const answer = await waitForAssistantResponse(
    state.runtime,
    state.timeoutMs,
    state.logger,
    state.baselineTurns ?? undefined,
  );
  return {
    text: answer.text,
    html: answer.html,
    meta: answer.meta,
  };
}

const chatgptDomProviderBase: ProviderDomAdapter = {
  providerName: "chatgpt-web",
  waitForUi,
  typePrompt,
  submitPrompt: submitPromptViaAdapter,
  waitForResponse,
};

// ─── ChatGPT Pro FSM wiring (oracle-byl) ───────────────────────────────────
//
// Production ChatGPT DOM submission previously consumed the bare
// adapter above, so the v18 ChatGPT Pro FSM could exist without ever
// gating the live send click. The wrapper below mirrors the Gemini
// Deep Think wiring: submitPrompt first proves the machine reached
// `mode_verified_same_session`, then consults the synthesis gate, and
// only then delegates to the underlying adapter.

export class ChatGptProFsmError extends Error {
  readonly verdict: ChatGptProVerdict;
  constructor(verdict: ChatGptProVerdict, cause?: unknown) {
    super(
      `ChatGPT Pro FSM rejected operation (state="${verdict.state}", errorCode=${
        verdict.errorCode ?? "n/a"
      }): ${verdict.failureReason ?? "no reason recorded"}`,
    );
    this.name = "ChatGptProFsmError";
    this.verdict = verdict;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface WiredChatGptProAdapter extends ProviderDomAdapter {
  readonly getMachine: () => ChatGptProMachine;
  readonly getVerdict: () => ChatGptProVerdict;
  readonly getLastSynthesisGateDecision: () => ChatGptProSynthesisGateDecision | null;
}

export interface WireChatGptProFsmOptions {
  readonly mode?: "remote" | "local";
  readonly accessPath?:
    | "oracle_browser_remote"
    | "oracle_browser_local"
    | "oracle_browser_remote_or_local";
  readonly sessionIdHash?: `sha256:${string}`;
  readonly promptSha256?: (prompt: string) => `sha256:${string}`;
  readonly outputSha256?: (text: string) => `sha256:${string}`;
  readonly now?: () => Date;
  readonly onTransition?: (machine: ChatGptProMachine) => void;
}

function classifyChatGptAdapterError(err: unknown): "login_required" | "ui_drift" {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("sign in") || msg.includes("sign-in") || msg.includes("login")) {
    return "login_required";
  }
  return "ui_drift";
}

function chatGptProOverrides(
  ctx: ProviderDomFlowContext,
): ChatGptProDomVerificationOverrides | null {
  const raw = ctx.state?.chatgptProVerification;
  return raw && typeof raw === "object" ? (raw as ChatGptProDomVerificationOverrides) : null;
}

function chatGptProVerificationEnabled(ctx: ProviderDomFlowContext): boolean {
  return chatGptProOverrides(ctx)?.enabled !== false;
}

function throwIfChatGptProFailure(machine: ChatGptProMachine): void {
  if (isFailureState(machine.state)) {
    throw new ChatGptProFsmError(machineVerdict(machine));
  }
}

function resolveSessionIdHash(
  ctx: ProviderDomFlowContext,
  adapter: ProviderDomAdapter,
  options: WireChatGptProFsmOptions,
): `sha256:${string}` {
  const override = chatGptProOverrides(ctx)?.sessionIdHash;
  return override ?? options.sessionIdHash ?? sha256OfBytes(`chatgpt-pro:${adapter.providerName}`);
}

function resolveMode(
  ctx: ProviderDomFlowContext,
  options: WireChatGptProFsmOptions,
): "remote" | "local" {
  return chatGptProOverrides(ctx)?.mode ?? options.mode ?? "local";
}

function resolveAccessPath(
  ctx: ProviderDomFlowContext,
  options: WireChatGptProFsmOptions,
): "oracle_browser_remote" | "oracle_browser_local" | "oracle_browser_remote_or_local" {
  const override = chatGptProOverrides(ctx)?.accessPath ?? options.accessPath;
  if (override) return override;
  return resolveMode(ctx, options) === "remote" ? "oracle_browser_remote" : "oracle_browser_local";
}

async function resolveChatGptProProbe(ctx: ProviderDomFlowContext): Promise<ChatGptProDomProbe> {
  const overrides = chatGptProOverrides(ctx);
  const state = requireState(ctx);
  const domProbe = await readChatGptProDomProbe(state.runtime).catch(() => null);
  const modelLabel = overrides?.modelLabel ?? domProbe?.modelLabel ?? "";
  const effortLabels = overrides?.observedEffortLabels ?? domProbe?.effortLabels ?? [];
  return {
    modelLabel,
    effortLabels,
    selectedEffortLabel: domProbe?.selectedEffortLabel ?? null,
    authenticated: domProbe?.authenticated ?? true,
    promptReady: domProbe?.promptReady ?? true,
    sendExists: domProbe?.sendExists ?? true,
    targetId: domProbe?.targetId ?? null,
    url: domProbe?.url ?? null,
    conversationId: domProbe?.conversationId ?? null,
    fingerprint: domProbe?.fingerprint ?? null,
  };
}

async function readChatGptProDomProbe(
  runtime: ChromeClient["Runtime"],
): Promise<ChatGptProDomProbe | null> {
  const result = await runtime.evaluate({
    expression: buildChatGptProDomProbeExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.result?.value;
  if (!value || typeof value !== "object") return null;
  const probe = value as Partial<ChatGptProDomProbe>;
  return {
    modelLabel: typeof probe.modelLabel === "string" ? probe.modelLabel : "",
    effortLabels: Array.isArray(probe.effortLabels)
      ? probe.effortLabels.filter((label): label is string => typeof label === "string")
      : [],
    selectedEffortLabel:
      typeof probe.selectedEffortLabel === "string" ? probe.selectedEffortLabel : null,
    authenticated: probe.authenticated !== false,
    promptReady: probe.promptReady === true,
    sendExists: probe.sendExists === true,
    targetId: typeof probe.targetId === "string" ? probe.targetId : null,
    url: typeof probe.url === "string" ? probe.url : null,
    conversationId: typeof probe.conversationId === "string" ? probe.conversationId : null,
    fingerprint: typeof probe.fingerprint === "string" ? probe.fingerprint : null,
  };
}

function buildChatGptProDomProbeExpression(): string {
  const modelPickerButtons = JSON.stringify(chatgptSelectorList("model_picker_button"));
  const modelRows = JSON.stringify(chatgptSelectorList("model_row"));
  const effortButtons = JSON.stringify(chatgptSelectorList("effort_picker_button"));
  const effortRows = JSON.stringify(chatgptSelectorList("effort_row"));
  const composerInputs = JSON.stringify(chatgptSelectorList("composer_textarea"));
  const sendButtons = JSON.stringify(chatgptSelectorList("send_button"));

  return `(() => {
    const MODEL_PICKER_BUTTONS = ${modelPickerButtons};
    const MODEL_ROWS = ${modelRows};
    const EFFORT_BUTTONS = ${effortButtons};
    const EFFORT_ROWS = ${effortRows};
    const COMPOSER_INPUTS = ${composerInputs};
    const SEND_BUTTONS = ${sendButtons};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const text = (node) => normalize(node?.textContent || node?.getAttribute?.('aria-label') || '');
    const selected = (node) => {
      if (!node) return false;
      const values = [
        node.getAttribute?.('aria-selected'),
        node.getAttribute?.('aria-checked'),
        node.getAttribute?.('aria-pressed'),
        node.getAttribute?.('data-selected'),
        node.getAttribute?.('data-state'),
      ].map((v) => String(v || '').toLowerCase());
      return values.some((v) => v === 'true' || v === 'checked' || v === 'selected' || v === 'on');
    };
    const firstText = (selectors) => {
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          const value = text(node);
          if (value) return value;
        }
      }
      return '';
    };
    const selectedText = (selectors) => {
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          if (!selected(node)) continue;
          const value = text(node);
          if (value) return value;
        }
      }
      return '';
    };
    const collectTexts = (selectors) => {
      const out = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          const value = text(node);
          if (!value || seen.has(value)) continue;
          seen.add(value);
          out.push(value);
        }
      }
      return out;
    };
    const byOracleRole = (role) =>
      Array.from(document.querySelectorAll('[data-oracle-role="' + role + '"]'));
    const fixtureModel =
      byOracleRole('chatgpt-model-option').find(selected)?.textContent?.trim?.() || '';
    const fixtureEfforts = byOracleRole('chatgpt-effort-option')
      .map((node) => text(node))
      .filter(Boolean);
    const fixtureSelectedEffort =
      text(byOracleRole('chatgpt-effort-option').find(selected)) || null;
    const composerModel =
      normalize(document.querySelector('[data-testid="composer-model-label"], [data-testid="model-label"]')?.textContent || '');
    const buttonModel = firstText(MODEL_PICKER_BUTTONS);
    const selectedModel = selectedText(MODEL_ROWS);
    const hasProPill = Boolean(
      document.querySelector('button.__composer-pill[aria-label*="Pro" i], button[aria-label="Pro, click to remove"]')
    );
    const baseModel = fixtureModel || selectedModel || composerModel || buttonModel;
    const modelLabel =
      baseModel && hasProPill && !/\\bpro\\b/i.test(baseModel) ? baseModel + ' + Pro' : baseModel;
    const selectedEffort = fixtureSelectedEffort || selectedText(EFFORT_ROWS) || firstText(EFFORT_BUTTONS) || null;
    const effortLabels = fixtureEfforts.length > 0 ? fixtureEfforts : collectTexts(EFFORT_ROWS);
    if (effortLabels.length === 0 && selectedEffort) {
      effortLabels.push(selectedEffort);
    }
    const promptReady = COMPOSER_INPUTS.some((selector) => Boolean(document.querySelector(selector)));
    const sendExists = SEND_BUTTONS.some((selector) => Boolean(document.querySelector(selector)));
    const url = window.location?.href || null;
    const conversationId = url?.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
    return {
      modelLabel,
      effortLabels,
      selectedEffortLabel: selectedEffort,
      authenticated: !/\\/auth\\/login|\\/login/i.test(url || ''),
      promptReady,
      sendExists,
      targetId: null,
      url,
      conversationId,
      fingerprint: [modelLabel, selectedEffort, effortLabels.join('|')].join('::'),
    };
  })()`;
}

function buildSynthesisGateInput(
  ctx: ProviderDomFlowContext,
  machine: ChatGptProMachine,
  probe: ChatGptProDomProbe | null,
  options: WireChatGptProFsmOptions,
) {
  const overrides = chatGptProOverrides(ctx);
  const now = (options.now?.() ?? new Date()).toISOString();
  const sessionIdHash = machine.context.sessionIdHash;
  const liveTab: ChatGptProSynthesisLiveTab = {
    targetId: probe?.targetId ?? null,
    url: probe?.url ?? null,
    conversationId: probe?.conversationId ?? null,
    currentModelLabel: machine.context.modelLabel ?? probe?.modelLabel ?? null,
    authenticated: probe?.authenticated ?? true,
    promptReady: probe?.promptReady ?? true,
    sendExists: probe?.sendExists ?? true,
    state: "completed",
    fingerprint: probe?.fingerprint ?? null,
    observedAt: now,
    ...(overrides?.liveTab ?? {}),
  };
  const session: ChatGptProSynthesisSessionState = {
    sessionIdHash,
    liveSessionIdHash: sessionIdHash,
    verifiedAt: now,
    lastActivityAt: now,
    now,
    verifiedTargetId: liveTab.targetId ?? null,
    liveTargetId: liveTab.targetId ?? null,
    ...(overrides?.session ?? {}),
  };
  return {
    slot: "chatgpt_pro_synthesis",
    providerFamily: "chatgpt",
    accessPath: resolveAccessPath(ctx, options),
    machine,
    liveTab,
    cookies: overrides?.cookies ?? {
      required: false,
      remoteBrowser: resolveMode(ctx, options) === "remote",
      appliedCount: liveTab.authenticated ? 1 : 0,
      source: "browser-session",
    },
    session,
  } as const;
}

export function wireChatGptProFsm(
  adapter: ProviderDomAdapter,
  options: WireChatGptProFsmOptions = {},
): WiredChatGptProAdapter {
  let machine: ChatGptProMachine = createChatGptProMachine();
  let lastProbe: ChatGptProDomProbe | null = null;
  let lastGateDecision: ChatGptProSynthesisGateDecision | null = null;
  const promptHash = options.promptSha256 ?? ((text: string) => sha256OfBytes(text));
  const outputHash = options.outputSha256 ?? ((text: string) => sha256OfBytes(text));

  const send = (event: ChatGptProEvent): void => {
    machine = machine.send(event);
    options.onTransition?.(machine);
  };

  return {
    providerName: adapter.providerName,

    async waitForUi(ctx: ProviderDomFlowContext) {
      if (!chatGptProVerificationEnabled(ctx)) {
        await adapter.waitForUi(ctx);
        return;
      }
      machine = createChatGptProMachine();
      lastProbe = null;
      lastGateDecision = null;
      send({ type: "browser_connected", mode: resolveMode(ctx, options) });
      try {
        await adapter.waitForUi(ctx);
      } catch (err) {
        const kind = classifyChatGptAdapterError(err);
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
      if (!chatGptProVerificationEnabled(ctx)) {
        if (adapter.selectMode) await adapter.selectMode(ctx);
        return;
      }
      send({ type: "model_menu_opened" });
      try {
        if (adapter.selectMode) await adapter.selectMode(ctx);
        lastProbe = await resolveChatGptProProbe(ctx);
      } catch (err) {
        send({
          type: "ui_drift_observed",
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      send({ type: "pro_candidate_selected", modelLabel: lastProbe.modelLabel });
      throwIfChatGptProFailure(machine);
      send({ type: "effort_candidate_selected", observedEffortLabels: lastProbe.effortLabels });
      throwIfChatGptProFailure(machine);
      send({
        type: "mode_verified_same_session",
        sessionIdHash: resolveSessionIdHash(ctx, adapter, options),
      });
      throwIfChatGptProFailure(machine);
    },

    typePrompt: (ctx: ProviderDomFlowContext) => adapter.typePrompt(ctx),

    async submitPrompt(ctx: ProviderDomFlowContext) {
      if (!chatGptProVerificationEnabled(ctx)) {
        await adapter.submitPrompt(ctx);
        return;
      }
      if (machine.state !== "mode_verified_same_session") {
        send({ type: "submit_prompt", promptSha256: promptHash(ctx.prompt) });
        throw new ChatGptProFsmError(machineVerdict(machine));
      }
      lastGateDecision = assertChatGptProSynthesisReady(
        buildSynthesisGateInput(ctx, machine, lastProbe, options),
      );
      send({ type: "submit_prompt", promptSha256: promptHash(ctx.prompt) });
      throwIfChatGptProFailure(machine);
      await adapter.submitPrompt(ctx);
    },

    async waitForResponse(ctx: ProviderDomFlowContext) {
      if (!chatGptProVerificationEnabled(ctx)) {
        return await adapter.waitForResponse(ctx);
      }
      const response = await adapter.waitForResponse(ctx);
      send({
        type: "response_arrived",
        outputTextSha256: outputHash(response.text),
        bytesLength: Buffer.byteLength(response.text, "utf8"),
      });
      throwIfChatGptProFailure(machine);
      return response;
    },

    extractThoughts: adapter.extractThoughts
      ? (ctx: ProviderDomFlowContext) => adapter.extractThoughts!(ctx)
      : undefined,

    getMachine: () => machine,
    getVerdict: () => machineVerdict(machine),
    getLastSynthesisGateDecision: () => lastGateDecision,
  };
}

export const chatgptDomProvider: WiredChatGptProAdapter = wireChatGptProFsm(chatgptDomProviderBase);

export function chatgptDomProviderWithFsm(): WiredChatGptProAdapter {
  return wireChatGptProFsm(chatgptDomProviderBase);
}

export type { ChatGptProState };
