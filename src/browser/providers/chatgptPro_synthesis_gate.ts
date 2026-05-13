import { evaluateApiSubstitution } from "../../oracle/api_substitution_guard.js";
import { sha256OfBytes } from "../../oracle/v18/evidence.js";
import type { V18ErrorCode } from "../../oracle/v18/json_envelope.js";
import {
  errorCodeForFailure,
  isFailureState,
  isProLabel,
  type ChatGptProMachine,
} from "./chatgptProVerification.js";

export const CHATGPT_PRO_SYNTHESIS_GATE_SCHEMA_VERSION = "chatgpt_pro_synthesis_gate.v1" as const;
export const DEFAULT_CHATGPT_PRO_SYNTHESIS_STALE_AFTER_MS = 10 * 60 * 1000;

export type ChatGptProSynthesisSlot = "chatgpt_pro_synthesis";
export type ChatGptProSynthesisStatus = "ready_to_submit" | "blocked";

export interface ChatGptProSynthesisLiveTab {
  readonly targetId?: string | null;
  readonly url?: string | null;
  readonly conversationId?: string | null;
  readonly currentModelLabel?: string | null;
  readonly authenticated?: boolean;
  readonly promptReady?: boolean;
  readonly sendExists?: boolean;
  readonly state?: string | null;
  readonly fingerprint?: string | null;
  readonly observedAt?: string | Date | null;
}

export interface ChatGptProSynthesisCookieState {
  readonly required?: boolean;
  readonly appliedCount?: number | null;
  readonly inlineCount?: number | null;
  readonly manualLogin?: boolean;
  readonly remoteBrowser?: boolean;
  readonly source?: string | null;
}

export interface ChatGptProSynthesisSessionState {
  readonly sessionId?: string | null;
  readonly sessionIdHash?: `sha256:${string}` | string | null;
  readonly liveSessionIdHash?: `sha256:${string}` | string | null;
  readonly verifiedAt?: string | Date | null;
  readonly lastActivityAt?: string | Date | null;
  readonly now?: string | Date | null;
  readonly staleAfterMs?: number | null;
  readonly verifiedTargetId?: string | null;
  readonly liveTargetId?: string | null;
}

export interface ChatGptProSynthesisGateInput {
  readonly slot: ChatGptProSynthesisSlot | string;
  readonly providerFamily: string;
  readonly accessPath: string;
  readonly machine: ChatGptProMachine;
  readonly liveTab?: ChatGptProSynthesisLiveTab | null;
  readonly cookies?: ChatGptProSynthesisCookieState | null;
  readonly session?: ChatGptProSynthesisSessionState | null;
}

export interface ChatGptProSynthesisBlocker {
  readonly field: string;
  readonly code: V18ErrorCode;
  readonly message: string;
  readonly retry_safe: boolean;
  readonly details?: Record<string, unknown>;
}

export interface ChatGptProSynthesisEvidenceProvenance {
  readonly provider_slot: ChatGptProSynthesisSlot;
  readonly provider_family: string;
  readonly access_path: string;
  readonly session_id_hash: `sha256:${string}` | null;
  readonly live_session_id_hash: `sha256:${string}` | null;
  readonly verified_at: string | null;
  readonly last_activity_at: string | null;
  readonly live_tab_target_id_hash: `sha256:${string}` | null;
  readonly live_tab_url_hash: `sha256:${string}` | null;
  readonly conversation_id_hash: `sha256:${string}` | null;
  readonly tab_fingerprint_hash: `sha256:${string}` | null;
  readonly cookie_material_present: boolean;
  readonly cookie_count: number | null;
  readonly cookie_source: string | null;
  readonly observed_model_label: string | null;
  readonly observed_reasoning_effort_label: string | null;
  readonly available_effort_labels_hash: `sha256:${string}` | null;
  readonly selector_manifest_version: string | null;
}

export interface ChatGptProSynthesisGateDecision {
  readonly schema_version: typeof CHATGPT_PRO_SYNTHESIS_GATE_SCHEMA_VERSION;
  readonly ok: boolean;
  readonly status: ChatGptProSynthesisStatus;
  readonly can_submit_prompt: boolean;
  readonly slot: ChatGptProSynthesisSlot;
  readonly requested_mode: "ChatGPT Pro";
  readonly requested_reasoning_effort: "max_browser_available";
  readonly provider_family: string;
  readonly access_path: string;
  readonly verified_before_prompt_submit: boolean;
  readonly mode_verified_same_session: boolean;
  readonly selected_effort_is_highest_visible: boolean;
  readonly live_pro_tab_verified: boolean;
  readonly cookies_present: boolean;
  readonly session_fresh: boolean;
  readonly evidence_provenance: ChatGptProSynthesisEvidenceProvenance;
  readonly blockers: readonly ChatGptProSynthesisBlocker[];
  readonly warnings: readonly string[];
  readonly commands: {
    readonly doctor: string;
    readonly recover_session: string;
    readonly run: string;
  };
}

export class ChatGptProSynthesisGateError extends Error {
  constructor(readonly decision: ChatGptProSynthesisGateDecision) {
    super(decision.blockers[0]?.message ?? "ChatGPT Pro synthesis pre-submit gate is blocked.");
    this.name = "ChatGptProSynthesisGateError";
  }
}

export function planChatGptProSynthesisSubmission(
  input: ChatGptProSynthesisGateInput,
): ChatGptProSynthesisGateDecision {
  const blockers: ChatGptProSynthesisBlocker[] = [];
  const warnings: string[] = [];
  const machine = input.machine;
  const context = machine.context;
  const liveTab = input.liveTab ?? null;
  const cookies = input.cookies ?? null;
  const session = input.session ?? null;

  if (input.slot !== "chatgpt_pro_synthesis") {
    blockers.push(
      blocker(
        "provider_slot",
        "chatgpt_pro_unverified",
        `Unsupported ChatGPT Pro synthesis slot: ${input.slot}`,
        false,
      ),
    );
  }

  const accessVerdict = evaluateApiSubstitution({
    slot: input.slot,
    providerFamily: input.providerFamily,
    accessPath: input.accessPath,
  });
  for (const reason of accessVerdict.reasons) {
    blockers.push(
      blocker(reason.field, reason.code ?? "chatgpt_pro_unverified", reason.message, false),
    );
  }

  if (isFailureState(machine.state)) {
    blockers.push(
      blocker(
        "chatgpt_pro.state",
        errorCodeForFailure(machine.state),
        context.failureReason ?? `ChatGPT Pro verification failed in state ${machine.state}.`,
        isRetrySafeFailure(machine.state),
        { state: machine.state },
      ),
    );
  }

  const effort = context.effort;
  const modeVerifiedSameSession =
    machine.state === "mode_verified_same_session" &&
    isProLabel(context.modelLabel ?? "") &&
    effort?.status === "verified" &&
    effort.selectedIsHighestVisible === true &&
    isSha256(context.sessionIdHash);

  if (!isProLabel(context.modelLabel ?? "")) {
    blockers.push(
      blocker(
        "chatgpt_pro.model_label",
        "chatgpt_pro_unverified",
        "ChatGPT Pro synthesis requires a verified Pro model label before prompt submission.",
        false,
        { model_label_present: Boolean(context.modelLabel) },
      ),
    );
  }

  if (effort?.status !== "verified") {
    blockers.push(
      blocker(
        "chatgpt_pro.effort",
        effort?.errorCode ?? "chatgpt_extended_reasoning_unverified",
        effort?.reason ?? "Highest-visible ChatGPT reasoning effort has not been verified.",
        false,
      ),
    );
  } else if (effort.selectedIsHighestVisible !== true) {
    blockers.push(
      blocker(
        "chatgpt_pro.effort.selected_is_highest_visible",
        "chatgpt_extended_reasoning_unverified",
        "Selected ChatGPT reasoning effort is not the highest visible option.",
        false,
        { selected: effort.selected, rank: effort.rank },
      ),
    );
  }

  if (!modeVerifiedSameSession) {
    blockers.push(
      blocker(
        "chatgpt_pro.same_session_verification",
        "prompt_submitted_before_verification",
        "Synthesis prompt submission is blocked until Pro mode and highest-visible effort are verified in the same session.",
        false,
        { state: machine.state, session_id_hash_present: Boolean(context.sessionIdHash) },
      ),
    );
  }

  const liveProTabVerified = evaluateLiveTab(liveTab, blockers);
  const cookiesPresent = evaluateCookies(cookies, liveTab, blockers);
  const sessionFresh = evaluateSessionFreshness(session, machine, liveTab, blockers, warnings);
  const uniqueBlockers = dedupeBlockers(blockers);
  const ok = uniqueBlockers.length === 0;

  return {
    schema_version: CHATGPT_PRO_SYNTHESIS_GATE_SCHEMA_VERSION,
    ok,
    status: ok ? "ready_to_submit" : "blocked",
    can_submit_prompt: ok,
    slot: "chatgpt_pro_synthesis",
    requested_mode: "ChatGPT Pro",
    requested_reasoning_effort: "max_browser_available",
    provider_family: input.providerFamily,
    access_path: input.accessPath,
    verified_before_prompt_submit: ok,
    mode_verified_same_session: modeVerifiedSameSession,
    selected_effort_is_highest_visible: effort?.selectedIsHighestVisible === true,
    live_pro_tab_verified: liveProTabVerified,
    cookies_present: cookiesPresent,
    session_fresh: sessionFresh,
    evidence_provenance: buildEvidenceProvenance(input, {
      cookieMaterialPresent: cookiesPresent,
    }),
    blockers: uniqueBlockers,
    warnings,
    commands: {
      doctor: "oracle doctor chatgpt --pro --extended-reasoning --json",
      recover_session: "oracle status --hours 24 && oracle session <id> --render",
      run: "oracle --engine browser --model gpt-5.5-pro --browser-thinking-time heavy --json",
    },
  };
}

export function assertChatGptProSynthesisReady(
  input: ChatGptProSynthesisGateInput,
): ChatGptProSynthesisGateDecision {
  const decision = planChatGptProSynthesisSubmission(input);
  if (!decision.ok) {
    throw new ChatGptProSynthesisGateError(decision);
  }
  return decision;
}

function evaluateLiveTab(
  liveTab: ChatGptProSynthesisLiveTab | null,
  blockers: ChatGptProSynthesisBlocker[],
): boolean {
  if (!liveTab) {
    blockers.push(
      blocker(
        "browser.live_tab",
        "remote_browser_unavailable",
        "No live ChatGPT tab is attached for the protected synthesis route.",
        true,
      ),
    );
    return false;
  }

  let ok = true;
  if (liveTab.authenticated !== true) {
    ok = false;
    blockers.push(
      blocker(
        "browser.live_tab.authenticated",
        "provider_login_required",
        "ChatGPT tab is not authenticated; refresh cookies or sign in before submitting synthesis.",
        true,
      ),
    );
  }
  if (!isProLabel(liveTab.currentModelLabel ?? "")) {
    ok = false;
    blockers.push(
      blocker(
        "browser.live_tab.current_model_label",
        "chatgpt_pro_unverified",
        "No live ChatGPT Pro tab is verified for synthesis submission.",
        false,
        { model_label_present: Boolean(liveTab.currentModelLabel) },
      ),
    );
  }
  if (liveTab.state === "detached" || liveTab.state === "stalled") {
    ok = false;
    blockers.push(
      blocker(
        "browser.live_tab.state",
        "remote_browser_unavailable",
        `ChatGPT tab is ${liveTab.state}; synthesis requires an attached live tab.`,
        true,
        { state: liveTab.state },
      ),
    );
  }
  if (liveTab.promptReady !== true && liveTab.sendExists !== true) {
    ok = false;
    blockers.push(
      blocker(
        "browser.live_tab.prompt_composer",
        "ui_drift_suspected",
        "ChatGPT prompt composer is not ready; refusing to submit synthesis prompt.",
        true,
      ),
    );
  }
  return ok;
}

function evaluateCookies(
  cookies: ChatGptProSynthesisCookieState | null,
  liveTab: ChatGptProSynthesisLiveTab | null,
  blockers: ChatGptProSynthesisBlocker[],
): boolean {
  const required = cookies?.required !== false;
  const count = normalizedCookieCount(cookies);
  const present =
    count > 0 ||
    cookies?.manualLogin === true ||
    cookies?.remoteBrowser === true ||
    liveTab?.authenticated === true;

  if (required && !present) {
    blockers.push(
      blocker(
        "browser.cookies",
        "provider_login_required",
        "No ChatGPT cookies or authenticated browser session are available for synthesis submission.",
        true,
        { cookie_source: safeCookieSource(cookies?.source) },
      ),
    );
  }
  return present;
}

function evaluateSessionFreshness(
  session: ChatGptProSynthesisSessionState | null,
  machine: ChatGptProMachine,
  liveTab: ChatGptProSynthesisLiveTab | null,
  blockers: ChatGptProSynthesisBlocker[],
  warnings: string[],
): boolean {
  if (!session) {
    warnings.push(
      "No session freshness metadata was supplied; same-session FSM verification is still required.",
    );
    return true;
  }

  let fresh = true;
  const machineHash = machine.context.sessionIdHash;
  const sessionHash = normalizeSha256(session.sessionIdHash);
  const liveSessionHash = normalizeSha256(session.liveSessionIdHash);
  if (machineHash && sessionHash && machineHash !== sessionHash) {
    fresh = false;
    blockers.push(
      blocker(
        "browser.session.session_id_hash",
        "prompt_submitted_before_verification",
        "ChatGPT Pro synthesis session hash does not match the verification machine.",
        false,
      ),
    );
  }
  if (machineHash && liveSessionHash && machineHash !== liveSessionHash) {
    fresh = false;
    blockers.push(
      blocker(
        "browser.session.live_session_id_hash",
        "prompt_submitted_before_verification",
        "Live ChatGPT tab no longer matches the same-session Pro verification.",
        false,
      ),
    );
  }

  const liveTargetId = session.liveTargetId ?? liveTab?.targetId ?? null;
  if (session.verifiedTargetId && liveTargetId && session.verifiedTargetId !== liveTargetId) {
    fresh = false;
    blockers.push(
      blocker(
        "browser.session.live_target_id",
        "prompt_submitted_before_verification",
        "Live ChatGPT target changed after Pro verification; refusing to submit synthesis.",
        false,
      ),
    );
  }

  const staleAfterMs =
    typeof session.staleAfterMs === "number" && session.staleAfterMs > 0
      ? session.staleAfterMs
      : DEFAULT_CHATGPT_PRO_SYNTHESIS_STALE_AFTER_MS;
  const now = parseTime(session.now) ?? new Date();
  const anchor = parseTime(session.lastActivityAt) ?? parseTime(session.verifiedAt);
  if (anchor && now.getTime() - anchor.getTime() > staleAfterMs) {
    fresh = false;
    blockers.push(
      blocker(
        "browser.session.freshness",
        "prompt_submitted_before_verification",
        "ChatGPT Pro synthesis verification is stale; re-verify Pro mode before submitting.",
        true,
        { stale_after_ms: staleAfterMs },
      ),
    );
  }
  return fresh;
}

function buildEvidenceProvenance(
  input: ChatGptProSynthesisGateInput,
  computed: { cookieMaterialPresent: boolean },
): ChatGptProSynthesisEvidenceProvenance {
  const liveTab = input.liveTab ?? null;
  const session = input.session ?? null;
  const effort = input.machine.context.effort;
  return {
    provider_slot: "chatgpt_pro_synthesis",
    provider_family: input.providerFamily,
    access_path: input.accessPath,
    session_id_hash:
      normalizeSha256(session?.sessionIdHash) ??
      normalizeSha256(input.machine.context.sessionIdHash),
    live_session_id_hash: normalizeSha256(session?.liveSessionIdHash),
    verified_at: formatTime(session?.verifiedAt),
    last_activity_at: formatTime(session?.lastActivityAt),
    live_tab_target_id_hash: hashString(liveTab?.targetId),
    live_tab_url_hash: hashString(liveTab?.url),
    conversation_id_hash: hashString(liveTab?.conversationId),
    tab_fingerprint_hash: hashString(liveTab?.fingerprint),
    cookie_material_present: computed.cookieMaterialPresent,
    cookie_count: normalizedCookieCount(input.cookies ?? null) || null,
    cookie_source: safeCookieSource(input.cookies?.source),
    observed_model_label: input.machine.context.modelLabel,
    observed_reasoning_effort_label: effort?.status === "verified" ? effort.selected : null,
    available_effort_labels_hash: effort?.availableEffortLabelsHash ?? null,
    selector_manifest_version:
      effort?.selectorManifestVersion ?? input.machine.context.selectorManifestVersion ?? null,
  };
}

function blocker(
  field: string,
  code: V18ErrorCode,
  message: string,
  retrySafe: boolean,
  details?: Record<string, unknown>,
): ChatGptProSynthesisBlocker {
  return {
    field,
    code,
    message,
    retry_safe: retrySafe,
    ...(details ? { details } : {}),
  };
}

function dedupeBlockers(
  blockers: readonly ChatGptProSynthesisBlocker[],
): ChatGptProSynthesisBlocker[] {
  const seen = new Set<string>();
  const out: ChatGptProSynthesisBlocker[] = [];
  for (const entry of blockers) {
    const key = `${entry.field}:${entry.code}:${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function isRetrySafeFailure(state: string): boolean {
  return (
    state === "remote_browser_unavailable" ||
    state === "usage_limit" ||
    state === "login_required" ||
    state === "ui_drift_suspected"
  );
}

function normalizedCookieCount(cookies: ChatGptProSynthesisCookieState | null): number {
  return Math.max(0, toCount(cookies?.appliedCount) + toCount(cookies?.inlineCount));
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function hashString(value: string | null | undefined): `sha256:${string}` | null {
  const normalized = String(value ?? "").trim();
  return normalized ? sha256OfBytes(normalized) : null;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value);
}

function normalizeSha256(value: unknown): `sha256:${string}` | null {
  return isSha256(value) ? (value.toLowerCase() as `sha256:${string}`) : null;
}

function parseTime(value: string | Date | null | undefined): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatTime(value: string | Date | null | undefined): string | null {
  const parsed = parseTime(value);
  return parsed ? parsed.toISOString() : null;
}

function safeCookieSource(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "chrome-profile" ||
    normalized === "inline" ||
    normalized === "manual-login" ||
    normalized === "remote-browser" ||
    normalized === "disabled" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return "[redacted]";
}
