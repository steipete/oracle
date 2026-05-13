// Wire emitV18BrowserArtifacts into the live browser executor path
// (oracle-2f0; fixes oracle-x2t's deferred wiring).
//
// `emitV18BrowserArtifacts` from src/browser/runLive_v18.ts is a
// pure orchestrator — it produces v18 evidence + provider_result +
// ledger from BrowserRunResult-shaped inputs but never runs on the
// actual live path. Reality-check audit confirmed zero callers in
// sessionRunner.ts / mcp/tools/consult.ts.
//
// This module is the missing call-site wrapper: it composes with the
// existing `wrapBrowserExecutorWithLease` / `wrapWithLeaseOrPassthrough`
// helpers from runLive.ts so a caller can swap in one wrapped
// executor and get lease acquire/release + v18 artifact emission
// automatically.
//
// Design notes:
//
//   * The wrapper only emits v18 artifacts when the run targets a
//     v18 protected slot (chatgpt_pro_first_plan,
//     chatgpt_pro_synthesis, or — when the Gemini equivalent ships —
//     gemini_deep_think). Non-v18 routes pass through unchanged so
//     ordinary Oracle browser usage is unaffected.
//
//   * The emit step uses the orchestrator from oracle-x2t as the
//     SINGLE ledger-emission authority for the live path. Per the
//     oracle-2f0 design constraint, the chatgptProLedgerDriver from
//     oracle-6qi is the OTHER possible authority but must not be
//     composed with this wrapper — otherwise duplicate
//     evidence_written + run_completed entries land in the ledger.
//     Callers that drive the FSM directly should use the driver
//     instead; this wrapper is for the live executor path where the
//     FSM is observed externally.
//
//   * Errors thrown by emitV18BrowserArtifacts are reported via the
//     run logger but do NOT propagate. A live browser run that
//     succeeded must not be re-classified as a failure just because
//     evidence emission tripped — the captured answer is still
//     valuable to the user even when the v18 artifact pipeline has
//     a transient hiccup.

import { createHash } from "node:crypto";

import type { BrowserLogger } from "./types.js";
import type { BrowserExecutor, LeasedBrowserExecutor } from "./leaseIntegration.js";
import type { BrowserRunOptions, BrowserRunResult } from "./types.js";
import type { OracleBrowserAccessPath } from "../oracle/v18/provider_access_policy.js";
import type { ChatGptProSlot } from "../oracle/v18/chatgpt_provider_result.js";
import type { EmitV18BrowserArtifactsResult, LiveBrowserRunCapture } from "./runLive_v18.js";
import { emitV18BrowserArtifacts } from "./runLive_v18.js";
import { urlHostnameMatchesAllowedHost } from "./url_constraint.js";

const CHATGPT_HOSTS = ["chatgpt.com", "chat.openai.com"] as const;

export interface WrapBrowserExecutorWithV18EmitOptions {
  /**
   * Explicit slot override. When omitted the wrapper detects the slot
   * from the run's `chatgptUrl`/`url` host. Pass `null` to skip emit
   * even for ChatGPT URLs — useful for tests or for runs that the
   * caller is producing artifacts for via a different path.
   */
  readonly providerSlot?: ChatGptProSlot | null;
  /**
   * access_path attached to the emitted provider_result. Defaults to
   * `oracle_browser_remote`; pass `oracle_browser_local` for runs that
   * launched a local Chrome.
   */
  readonly accessPath?: OracleBrowserAccessPath;
  /** Override Oracle home dir for evidence writes; defaults to ~/.oracle. */
  readonly homeDir?: string;
  /**
   * Caller-side prompt-manifest sha256. The caller computed this when
   * assembling the prompt; we forward it unchanged so the consistency
   * cross-check against the evidence prompt_sha256 stays meaningful.
   */
  readonly promptManifestSha256: `sha256:${string}`;
  /** Caller-side source-baseline sha256. */
  readonly sourceBaselineSha256: `sha256:${string}`;
  /**
   * How to derive the evidence id + provider_result id from the run
   * options. The wrapper provides a default that uses the run's
   * `sessionId` + provider slot; callers can override (e.g. APR may
   * already assign these ids upstream).
   */
  readonly artifactIdFor?: (
    options: BrowserRunOptions,
    slot: ChatGptProSlot,
  ) => { evidenceId: string; providerResultId: string };
  /**
   * Hook the live executor uses to surface observed effort labels +
   * verification booleans. When omitted, the wrapper builds a
   * conservative capture summary from the BrowserRunOptions +
   * BrowserRunResult only. Missing observations are treated as
   * unverified, never as a successful same-session mode check.
   */
  readonly captureFor?: (
    options: BrowserRunOptions,
    result: BrowserRunResult,
  ) => LiveBrowserRunCapture;
}

export interface V18EmitOutcome {
  readonly attempted: boolean;
  readonly skippedReason: string | null;
  readonly artifacts: EmitV18BrowserArtifactsResult | null;
  readonly emitError: Error | null;
}

export interface V18EmittedBrowserRunResult extends BrowserRunResult {
  /** Outcome of the v18 emit attempt — present even when skipped. */
  v18Emit?: V18EmitOutcome;
}

interface BrowserRunResultWithV18Capture extends BrowserRunResult {
  readonly v18Capture?: Partial<LiveBrowserRunCapture>;
}

export interface ProductionV18BrowserEmitOptionsInput {
  /** Final prompt text submitted to the browser composer. */
  readonly promptText: string;
  /** Optional source-baseline seed; hashed before persistence. */
  readonly sourceBaselineSeed?: string;
  /** Override Oracle home dir for tests; production defaults to ~/.oracle. */
  readonly homeDir?: string;
}

function detectProviderSlotFromOptions(options: BrowserRunOptions): ChatGptProSlot | null {
  const url = options.config?.chatgptUrl ?? options.config?.url ?? null;
  if (typeof url !== "string" || url.length === 0) return null;
  if (!urlHostnameMatchesAllowedHost(url, CHATGPT_HOSTS)) return null;
  // Conservative default: treat every ChatGPT browser run as
  // chatgpt_pro_first_plan unless the caller passes an explicit slot
  // override. The synthesis slot is only invoked through the explicit
  // override path; the conservative default keeps the eligibility gate
  // tight (synthesis_eligible=true requires the right slot match).
  return "chatgpt_pro_first_plan";
}

function defaultArtifactIds(
  options: BrowserRunOptions,
  slot: ChatGptProSlot,
): { evidenceId: string; providerResultId: string } {
  const sessionId = options.sessionId ?? "live-run";
  return {
    evidenceId: `evidence-${sessionId}-${slot}`,
    providerResultId: `provider-result-${sessionId}-${slot}`,
  };
}

function sha256Text(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function captureConfidence(value: unknown): LiveBrowserRunCapture["captureConfidence"] | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined;
}

export function captureLiveBrowserRunForV18(
  options: BrowserRunOptions,
  result: BrowserRunResult,
): LiveBrowserRunCapture {
  const observed = (result as BrowserRunResultWithV18Capture).v18Capture;
  const answerText = result.answerMarkdown || result.answerText || "";
  const baselineTurns = nonNegativeInteger(observed?.baselineTurns) ?? 0;
  const observedTurnIndex = nonNegativeInteger(observed?.observedTurnIndex) ?? baselineTurns;
  const modeVerified = observed?.modeVerified === true;
  const verifiedBeforePromptSubmit =
    modeVerified === true && observed?.verifiedBeforePromptSubmit === true;
  return {
    promptText: typeof observed?.promptText === "string" ? observed.promptText : options.prompt,
    answerText,
    observedEffortLabels: stringArray(observed?.observedEffortLabels) ?? [],
    observedTurnIndex,
    baselineTurns,
    modeVerified,
    verifiedBeforePromptSubmit,
    captureConfidence:
      captureConfidence(observed?.captureConfidence) ?? (modeVerified ? "medium" : "low"),
  };
}

function safeDefaultCapture(
  options: BrowserRunOptions,
  result: BrowserRunResult,
): LiveBrowserRunCapture {
  return captureLiveBrowserRunForV18(options, result);
}

export function buildProductionV18BrowserEmitOptions(
  input: ProductionV18BrowserEmitOptionsInput,
): WrapBrowserExecutorWithV18EmitOptions {
  return {
    homeDir: input.homeDir,
    promptManifestSha256: sha256Text(input.promptText),
    sourceBaselineSha256: sha256Text(
      input.sourceBaselineSeed ?? "oracle-browser-live-source-baseline:v1",
    ),
    captureFor: captureLiveBrowserRunForV18,
  };
}

async function maybeEmit(
  options: BrowserRunOptions,
  result: BrowserRunResult,
  emitOptions: WrapBrowserExecutorWithV18EmitOptions,
  logger: BrowserLogger | undefined,
): Promise<V18EmitOutcome> {
  if (emitOptions.providerSlot === null) {
    return {
      attempted: false,
      skippedReason: "providerSlot explicitly set to null by caller",
      artifacts: null,
      emitError: null,
    };
  }
  const slot = emitOptions.providerSlot ?? detectProviderSlotFromOptions(options);
  if (!slot) {
    return {
      attempted: false,
      skippedReason: "non-v18 route (no ChatGPT host detected)",
      artifacts: null,
      emitError: null,
    };
  }
  if (!options.sessionId) {
    return {
      attempted: false,
      skippedReason: "missing sessionId — cannot anchor evidence to a session",
      artifacts: null,
      emitError: null,
    };
  }

  const idGen = emitOptions.artifactIdFor ?? defaultArtifactIds;
  const captureGen = emitOptions.captureFor ?? safeDefaultCapture;
  const ids = idGen(options, slot);
  const capture = captureGen(options, result);

  try {
    const artifacts = await emitV18BrowserArtifacts({
      sessionId: options.sessionId,
      homeDir: emitOptions.homeDir,
      providerSlot: slot,
      providerResultId: ids.providerResultId,
      evidenceId: ids.evidenceId,
      accessPath: emitOptions.accessPath ?? "oracle_browser_remote",
      capture,
      promptManifestSha256: emitOptions.promptManifestSha256,
      sourceBaselineSha256: emitOptions.sourceBaselineSha256,
      runId: options.sessionId,
    });
    if (logger) {
      const codes = artifacts.blockedErrorCodes.length
        ? ` (blocked: ${artifacts.blockedErrorCodes.join(", ")})`
        : "";
      logger(
        `[browser] v18 artifacts: ${artifacts.synthesisEligible ? "eligible" : "blocked"}${codes}; evidence=${ids.evidenceId}`,
      );
    }
    return { attempted: true, skippedReason: null, artifacts, emitError: null };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (logger) {
      logger(`[browser] v18 artifact emission failed: ${wrapped.message}`);
    }
    return { attempted: true, skippedReason: null, artifacts: null, emitError: wrapped };
  }
}

/**
 * Wrap a BrowserExecutor so successful runs emit v18 evidence +
 * provider_result + ledger artifacts before returning. The wrapped
 * executor returns a `V18EmittedBrowserRunResult` carrying both the
 * original BrowserRunResult fields and a `v18Emit` outcome record so
 * downstream callers can audit whether emission ran, skipped, or
 * errored.
 *
 * Composable with `wrapBrowserExecutorWithLease` from runLive.ts —
 * compose lease-wrapping first (closer to the executor), then v18
 * emit (outer) so the lease is held while artifacts write to disk.
 */
export function wrapBrowserExecutorWithV18Emit(
  executor: BrowserExecutor | LeasedBrowserExecutor,
  emitOptions: WrapBrowserExecutorWithV18EmitOptions,
): (options: BrowserRunOptions) => Promise<V18EmittedBrowserRunResult> {
  return async (options) => {
    const startedAt = Date.now();
    try {
      const result = await executor(options);
      const outcome = await maybeEmit(options, result, emitOptions, options.log);
      return { ...result, v18Emit: outcome };
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const failureResult: BrowserRunResultWithV18Capture = {
        answerText: "",
        answerMarkdown: "",
        tookMs: elapsedMs,
        answerTokens: 0,
        answerChars: 0,
        tabUrl: options.config?.chatgptUrl ?? options.config?.url,
        v18Capture: {
          promptText: options.prompt,
          answerText: "",
          observedEffortLabels: [],
          observedTurnIndex: 0,
          baselineTurns: 0,
          modeVerified: false,
          verifiedBeforePromptSubmit: false,
          captureConfidence: "low",
        },
      };
      await maybeEmit(options, failureResult, emitOptions, options.log);
      throw error;
    }
  };
}
