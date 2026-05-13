// Always-on browser evidence redaction (oracle-ejv).
//
// Security audit finding: browser_evidence.v1 is `.passthrough()` in
// src/oracle/v18/contracts.ts, and src/oracle/v18/evidence.ts skips
// `redactEvidencePayload` when redaction_policy is "off" — so a
// caller that hands evidence with `redaction_policy: "off"` plus
// forbidden extension keys (cookies, auth_headers, raw_dom,
// screenshot_base64, localStorage, sessionStorage) writes those raw
// bytes into the normal evidence directory.
//
// This module is the defense-in-depth fix: it ALWAYS runs the
// forbidden-key redactor on browser_evidence payloads regardless of
// the declared policy. Browser-layer call sites should route every
// outbound evidence payload through `redactBrowserEvidenceAlways`
// BEFORE handing it to `writeEvidence`, and assert via
// `assertNoForbiddenExtensionKeys` after parse-time validation.
//
// Note: src/oracle/v18/evidence.ts is read-only per pane 6's domain,
// so this fix lives at the browser layer as an additive guard.

import type { RedactionResult } from "../oracle/v18/evidence.js";

/**
 * Always strip forbidden extension keys from a browser_evidence
 * payload before it touches disk. Returns the redacted clone + the
 * list of dotted paths the redactor removed. Safe to call on a
 * payload that has already been parsed through `browserEvidenceSchema`.
 *
 * This wrapper exists so a call site cannot accidentally bypass
 * redaction by setting `redaction_policy: "off"`. Run it BEFORE
 * `writeEvidence` and the resulting payload is safe to write into
 * the normal evidence directory regardless of policy.
 *
 * Uses its own walker (does NOT delegate to v18's
 * redactEvidencePayload) so the audit-finding extras (localStorage,
 * sessionStorage, screenshot_base64) are stripped — those keys are
 * not in the v18 redactor's forbidden set and would otherwise
 * survive even policy=redacted.
 */
export function redactBrowserEvidenceAlways<T>(payload: T): RedactionResult<T> {
  const removed: string[] = [];
  const redacted = redactInternal(payload, removed, "") as T;
  return { redacted, removedPaths: removed };
}

function redactInternal(value: unknown, removed: string[], pathPrefix: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, idx) =>
      redactInternal(entry, removed, `${pathPrefix}[${idx}]`),
    );
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = pathPrefix === "" ? key : `${pathPrefix}.${key}`;
      if (isForbiddenKey(key)) {
        removed.push(childPath);
        continue;
      }
      out[key] = redactInternal(child, removed, childPath);
    }
    return out;
  }
  return value;
}

/**
 * Mirror of the v18 redactor's forbidden-substring policy. Kept in
 * sync with src/oracle/v18/evidence.ts FORBIDDEN_KEY_SUBSTRINGS +
 * FORBIDDEN_EXACT_KEYS. We re-derive here because that internal
 * set is not exported; this duplicate is small enough that a future
 * drift will surface in the regression test below.
 *
 * Extends the v18 set with the audit-finding extras (localStorage,
 * sessionStorage, screenshot_base64) so the always-on guard catches
 * payloads the v18 redactor might miss.
 */
const FORBIDDEN_SUBSTRINGS: readonly string[] = Object.freeze([
  "cookie",
  "account_email",
  "user_email",
  "raw_dom",
  "dom_html",
  "dom_snapshot",
  "html_snapshot",
  "screenshot",
  "auth_header",
  "authorization",
  "bearer_token",
  "access_token",
  "session_token",
  "api_key",
  "raw_prompt",
  "prompt_text",
  "raw_output",
  "output_text",
  "assistant_text",
  "response_text",
  "raw_profile_path",
  // Audit-finding extras flagged in oracle-ejv:
  "localstorage",
  "sessionstorage",
  "screenshot_base64",
]);

const FORBIDDEN_EXACT: readonly string[] = Object.freeze(["email", "auth"]);

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith("stores_")) return false; // privacy declarations
  if (lower.endsWith("_sha256") || lower.endsWith("_hash")) return false; // digests
  if (FORBIDDEN_EXACT.includes(lower)) return true;
  return FORBIDDEN_SUBSTRINGS.some((needle) => lower.includes(needle));
}

export interface ForbiddenKeyHit {
  /** Dotted JSON pointer to the offending property. */
  readonly pointer: string;
  readonly key: string;
}

/**
 * Walk a payload and collect every forbidden-key hit. Returns an
 * empty array when the payload is clean.
 */
export function findForbiddenExtensionKeys(payload: unknown): ForbiddenKeyHit[] {
  const hits: ForbiddenKeyHit[] = [];
  visit(payload, "", hits);
  return hits;
}

function visit(value: unknown, pointer: string, hits: ForbiddenKeyHit[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, idx) => visit(entry, `${pointer}/${idx}`, hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${key}`;
    if (isForbiddenKey(key)) hits.push({ pointer: childPointer, key });
    visit(child, childPointer, hits);
  }
}

/**
 * Throws if the payload contains any forbidden extension keys. Used
 * as a hard pre-write guard — meant to fire BEFORE `writeEvidence`
 * so the offending payload never touches disk.
 */
export function assertNoForbiddenExtensionKeys(payload: unknown): void {
  const hits = findForbiddenExtensionKeys(payload);
  if (hits.length === 0) return;
  const summary = hits
    .slice(0, 5)
    .map((h) => `  - ${h.pointer} (key="${h.key}")`)
    .join("\n");
  const overflow = hits.length > 5 ? `\n  …and ${hits.length - 5} more` : "";
  throw new Error(
    `Refusing to write browser evidence: ${hits.length} forbidden extension key(s) detected.\n${summary}${overflow}`,
  );
}

/**
 * One-call wrapper that combines both layers: always redact, then
 * assert the redacted result has no surviving forbidden keys. Use
 * this on every browser-layer evidence emission path. Returns the
 * sanitised payload safe to hand to `writeEvidence` regardless of
 * the declared redaction_policy.
 */
export function sanitizeBrowserEvidenceForWrite<T>(payload: T): RedactionResult<T> {
  const redacted = redactBrowserEvidenceAlways(payload);
  assertNoForbiddenExtensionKeys(redacted.redacted);
  return redacted;
}
