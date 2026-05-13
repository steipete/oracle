import type { BrowserEvidence } from "./contracts.js";

export type BrowserEvidenceEffortStatus = "verified" | "unverified" | "ui_drift_suspected";

export interface BrowserEvidenceEffortVerdict {
  readonly status: BrowserEvidenceEffortStatus;
  readonly availableEffortLabelsHash: `sha256:${string}`;
  readonly tier: string | null;
  readonly selected: string | null;
  readonly selectorManifestVersion: string;
  readonly selectedIsHighestVisible: boolean;
  readonly errorCode?: string | null;
  readonly reason?: string;
}

export type BrowserEvidenceEffortFields = Pick<
  BrowserEvidence,
  | "available_effort_labels_hash"
  | "effort_rank"
  | "failure_code"
  | "fix_command"
  | "next_command"
  | "observed_reasoning_effort_label"
  | "reasoning_effort_verified"
  | "selected_effort_is_highest_visible"
  | "selector_manifest_version"
>;

const CHATGPT_EFFORT_DOCTOR_COMMAND = "oracle doctor chatgpt --json";

function failureCodeForEffort(effort: BrowserEvidenceEffortVerdict): string | null {
  if (effort.status === "verified" && effort.selectedIsHighestVisible) {
    return null;
  }
  if (effort.errorCode) {
    return effort.errorCode;
  }
  if (effort.status === "ui_drift_suspected") {
    return "ui_drift_suspected";
  }
  return "chatgpt_extended_reasoning_unverified";
}

function fixCommandForEffort(effort: BrowserEvidenceEffortVerdict): string | null {
  const failureCode = failureCodeForEffort(effort);
  if (!failureCode) {
    return null;
  }
  if (failureCode === "ui_drift_suspected") {
    return "Refresh ChatGPT selectors, then rerun the protected browser route.";
  }
  return "Rerun after the same-session browser verification sees and selects the highest visible reasoning effort.";
}

export function deriveBrowserEvidenceEffortFields(
  effort: BrowserEvidenceEffortVerdict,
): BrowserEvidenceEffortFields {
  const verified = effort.status === "verified" && effort.selectedIsHighestVisible;
  const failureCode = failureCodeForEffort(effort);

  return {
    available_effort_labels_hash: effort.availableEffortLabelsHash,
    effort_rank: verified ? (effort.tier ?? "highest_visible") : effort.status,
    failure_code: failureCode,
    fix_command: fixCommandForEffort(effort),
    next_command: failureCode ? CHATGPT_EFFORT_DOCTOR_COMMAND : null,
    observed_reasoning_effort_label: verified ? (effort.selected ?? "") : "",
    reasoning_effort_verified: verified,
    selected_effort_is_highest_visible: verified,
    selector_manifest_version: effort.selectorManifestVersion,
  };
}
