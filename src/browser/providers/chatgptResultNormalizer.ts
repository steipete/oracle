// Browser-layer wrapper around the v18 ChatGPT provider_result
// normalizer (oracle-e8u).
//
// Bridges the FSM context (oracle-php) + capture verdict (oracle-qfl)
// + selector manifest version (oracle-hcs) into a strict v18
// `provider_result.v1`. APR consumers do not need to know anything
// about DOM selectors or browser internals — they get a typed
// ProviderResult plus a list of blocker reasons.

import type { BrowserEvidence } from "../../oracle/v18/contracts.js";
import {
  buildChatGptProviderResult,
  isChatGptProSlot,
  type BlockedReason,
  type BuildChatGptProviderResultInput,
  type ChatGptProSlot,
  type ChatGptProviderResultBuild,
  type NormalizerCaptureSummary,
  type NormalizerEffortSummary,
} from "../../oracle/v18/chatgpt_provider_result.js";
import type { OracleBrowserAccessPath } from "../../oracle/v18/provider_access_policy.js";
import type { CaptureVerdict } from "../output-capture/captureVerdict.js";
import type { EffortStrategyResult } from "../selectors/chatgpt/effortStrategy.js";

export {
  buildChatGptProviderResult,
  isChatGptProSlot,
  type BlockedReason,
  type BuildChatGptProviderResultInput,
  type ChatGptProSlot,
  type ChatGptProviderResultBuild,
  type NormalizerCaptureSummary,
  type NormalizerEffortSummary,
};

/**
 * Convenience: project a captureVerdict into the normalizer summary
 * shape. Used by the higher-level browser driver so the driver does
 * not need to know about the v18 module's exact field names.
 */
export function captureToSummary(verdict: CaptureVerdict): NormalizerCaptureSummary {
  return {
    status: verdict.status,
    outputTextSha256: verdict.outputTextSha256,
    markdownPreserved: verdict.markdownPreserved,
    captureConfidence: verdict.captureConfidence,
  };
}

/**
 * Project an effort strategy result into the normalizer summary shape.
 */
export function effortToSummary(verdict: EffortStrategyResult): NormalizerEffortSummary {
  return {
    status: verdict.status,
    availableEffortLabelsHash: verdict.availableEffortLabelsHash,
    tier: verdict.tier,
    selected: verdict.selected,
    selectorManifestVersion: verdict.selectorManifestVersion,
    selectedIsHighestVisible: verdict.selectedIsHighestVisible,
  };
}

/**
 * Bundled entry point: takes the browser-side artefacts directly
 * (CaptureVerdict + EffortStrategyResult + evidence + hashes) and
 * returns the parsed v18 result + blocker list.
 */
export interface NormalizeChatGptRunInput {
  readonly slot: ChatGptProSlot;
  readonly providerResultId: string;
  readonly accessPath: OracleBrowserAccessPath;
  readonly evidence: BrowserEvidence;
  readonly capture: CaptureVerdict;
  readonly effort: EffortStrategyResult;
  readonly promptManifestSha256: `sha256:${string}`;
  readonly sourceBaselineSha256: `sha256:${string}`;
  readonly resultPath?: string;
  readonly model?: string;
  readonly degradationReason?: string;
  readonly error?: Record<string, unknown>;
}

export function normalizeChatGptRun(
  input: NormalizeChatGptRunInput,
): ChatGptProviderResultBuild {
  return buildChatGptProviderResult({
    slot: input.slot,
    providerResultId: input.providerResultId,
    accessPath: input.accessPath,
    evidence: input.evidence,
    capture: captureToSummary(input.capture),
    effort: effortToSummary(input.effort),
    promptManifestSha256: input.promptManifestSha256,
    sourceBaselineSha256: input.sourceBaselineSha256,
    resultPath: input.resultPath,
    model: input.model,
    degradationReason: input.degradationReason,
    error: input.error,
  });
}
