import type { BrowserModelSelectionEvidence, SessionMetadata } from "../sessionStore.js";
import type { BrowserModelStrategy } from "./types.js";

interface BrowserModelDisplayInput {
  model?: string | null;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  evidence?: BrowserModelSelectionEvidence;
}

function cleanLabel(value?: string | null): string | null {
  const label = value?.trim();
  return label ? label : null;
}

function sameLabel(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

/**
 * Describe what a browser run will try to select without presenting the target as observed fact.
 */
export function formatBrowserModelTarget({
  model,
  desiredModel,
  modelStrategy,
}: BrowserModelDisplayInput): string {
  const requested = cleanLabel(model) ?? "n/a";
  if (modelStrategy === "current" || modelStrategy === "ignore") {
    return `picker=${modelStrategy}; requested=${requested}`;
  }
  const target = cleanLabel(desiredModel);
  if (!target) {
    return requested;
  }
  return `target=${target}; requested=${requested}`;
}

/**
 * Prefer picker evidence only when Oracle verified it. Otherwise retain the requested CLI key.
 * In particular, a bare `Pro` picker label must not be expanded to a server-side model version.
 */
export function resolveBrowserModelDisplayName({
  model,
  evidence,
}: BrowserModelDisplayInput): string {
  const verifiedLabel = evidence?.verified ? cleanLabel(evidence.resolvedLabel) : null;
  return verifiedLabel ?? cleanLabel(model) ?? "n/a";
}

export function formatBrowserModelWithRequestedKey(input: BrowserModelDisplayInput): string {
  const displayName = resolveBrowserModelDisplayName(input);
  const requested = cleanLabel(input.model);
  if (!requested || sameLabel(displayName, requested)) {
    return displayName;
  }
  return `${displayName} (requested ${requested})`;
}

export function resolveSessionBrowserModelDisplayName(
  metadata: SessionMetadata,
  model = metadata.model,
): string {
  const sessionModel = cleanLabel(metadata.model);
  const requestedModel = cleanLabel(model);
  const evidenceApplies =
    requestedModel === null
      ? sessionModel === null
      : sessionModel !== null && sameLabel(requestedModel, sessionModel);
  return resolveBrowserModelDisplayName({
    model,
    evidence: evidenceApplies ? metadata.browser?.modelSelection : undefined,
  });
}

export function formatSessionBrowserModelWithRequestedKey(
  metadata: SessionMetadata,
  model = metadata.model,
): string {
  const sessionModel = cleanLabel(metadata.model);
  const requestedModel = cleanLabel(model);
  const evidenceApplies =
    requestedModel === null
      ? sessionModel === null
      : sessionModel !== null && sameLabel(requestedModel, sessionModel);
  return formatBrowserModelWithRequestedKey({
    model,
    evidence: evidenceApplies ? metadata.browser?.modelSelection : undefined,
  });
}

export function formatBrowserModelSelectionEvidence(
  evidence: BrowserModelSelectionEvidence,
  model?: string | null,
): string {
  const requestedKey = cleanLabel(model) ?? "(none)";
  const target = cleanLabel(evidence.requestedModel) ?? "(none)";
  const resolvedLabel = cleanLabel(evidence.resolvedLabel) ?? "(unavailable)";
  const strategy = evidence.strategy ?? "(default)";
  const verified = evidence.verified ? "yes" : "no";
  return `requestedKey=${requestedKey}; target=${target}; resolvedLabel=${resolvedLabel}; status=${evidence.status}; strategy=${strategy}; verified=${verified}; source=${evidence.source}; capturedAt=${evidence.capturedAt}`;
}
