// v18 hash & ID consistency verification (oracle-hbn).
//
// Provider results, browser evidence ledgers, prompt manifests, source
// baselines, and artifact-index entries are independent artifacts. Each
// records a small set of cross-references — evidence_id, provider_slot,
// provider/family, prompt/output sha256, on-disk artifact hashes — and
// a polished provider result can drift away from its proof artifacts
// when any of those references stop matching.
//
// `verifyHashConsistency` is the cross-artifact check that catches:
//
//   - tampered or stale `provider_result.evidence_id` / `provider_slot`
//     / `provider_family`
//   - prompt or output hashes that disagree between the result and its
//     evidence ledger
//   - protected-slot results that ship without verified evidence
//   - API-allowed slots that improperly carry browser evidence
//   - artifact_index entries whose on-disk bytes hash differently than
//     the recorded sha256 (partial write, tampering, sync drift)
//
// The verifier never short-circuits on the first mismatch — it returns
// every inconsistency at once so a downstream CLI surface can render a
// complete recovery hint for the operator.

import { createHash } from "node:crypto";

import {
  artifactIndexSchema,
  browserEvidenceSchema,
  providerResultSchema,
  type ArtifactIndex,
  type BrowserEvidence,
  type ProviderResult,
} from "./contracts.js";
import type { V18ErrorCode } from "./json_envelope.js";
import {
  ORACLE_BROWSER_ACCESS_PATHS,
  PROTECTED_SLOTS,
  PROTECTED_SLOT_FAMILY,
  PROTECTED_SLOT_UNVERIFIED_CODE,
  isApiAllowedSlot,
  isOracleBrowserAccessPath,
  isProtectedSlot,
  type ProtectedSlot,
} from "./provider_access_policy.js";

// ─── Result shape ────────────────────────────────────────────────────────────

export interface ConsistencyMismatch {
  /** v18 error code (when one applies); else `null`. */
  code: V18ErrorCode | null;
  /** Dotted field path (e.g. `provider_result.evidence_id`). */
  field: string;
  message: string;
}

export interface ConsistencyVerdict {
  readonly consistent: boolean;
  readonly mismatches: readonly ConsistencyMismatch[];
}

const OK: ConsistencyVerdict = Object.freeze({ consistent: true, mismatches: [] });

function fail(mismatches: ConsistencyMismatch[]): ConsistencyVerdict {
  return { consistent: false, mismatches };
}

function mismatch(
  field: string,
  message: string,
  code: V18ErrorCode | null = null,
): ConsistencyMismatch {
  return { code, field, message };
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface VerifyHashConsistencyInput {
  /** Parsed or raw provider_result.v1. */
  readonly result: unknown;
  /** Optional evidence ledger; required for protected slots. */
  readonly evidence?: unknown;
  /** Optional artifact index for cross-checking on-disk hashes. */
  readonly artifactIndex?: unknown;
  /**
   * Optional on-disk bytes keyed by artifact path. When provided, the
   * verifier confirms each `artifact_index.artifacts[*].sha256` matches
   * the actual digest of the bytes — catches partial writes / tampering.
   */
  readonly artifactBytes?: Readonly<Record<string, Uint8Array | string>>;
}

// ─── Parse helpers (collect schema errors instead of throwing) ───────────────

function parseProviderResult(
  value: unknown,
  out: ConsistencyMismatch[],
): ProviderResult | null {
  const parsed = providerResultSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = ["provider_result", ...issue.path.map(String)].join(".");
      out.push(mismatch(path, issue.message));
    }
    return null;
  }
  return parsed.data as ProviderResult;
}

function parseEvidence(value: unknown, out: ConsistencyMismatch[]): BrowserEvidence | null {
  const parsed = browserEvidenceSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = ["browser_evidence", ...issue.path.map(String)].join(".");
      out.push(mismatch(path, issue.message));
    }
    return null;
  }
  return parsed.data as BrowserEvidence;
}

function parseArtifactIndex(
  value: unknown,
  out: ConsistencyMismatch[],
): ArtifactIndex | null {
  const parsed = artifactIndexSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = ["artifact_index", ...issue.path.map(String)].join(".");
      out.push(mismatch(path, issue.message));
    }
    return null;
  }
  return parsed.data as ArtifactIndex;
}

// ─── Per-rule checkers ───────────────────────────────────────────────────────

function familyMatchesProvider(family: string, provider: "chatgpt" | "gemini"): boolean {
  // provider_result.provider_family may be the same name as the browser
  // provider (`chatgpt`, `gemini`), or a more specific identifier that
  // starts with the provider name (e.g. `chatgpt_pro_synthesis`). Either
  // is accepted; everything else is a family mismatch.
  return family === provider || family.startsWith(`${provider}_`) || family.startsWith(`${provider}-`);
}

function pickErrorCodeForSlot(slot: string | null): V18ErrorCode | null {
  if (slot && isProtectedSlot(slot)) return PROTECTED_SLOT_UNVERIFIED_CODE[slot];
  return null;
}

function checkResultEvidencePair(
  result: ProviderResult,
  evidence: BrowserEvidence | null,
  out: ConsistencyMismatch[],
): void {
  const slot = result.provider_slot;
  const code = pickErrorCodeForSlot(slot);
  const slotIsProtected = isProtectedSlot(slot);
  const slotIsApiAllowed = isApiAllowedSlot(slot);

  if (!evidence) {
    if (slotIsProtected) {
      out.push(
        mismatch(
          "provider_result.evidence",
          `slot ${slot} is protected and requires a verified browser evidence ledger`,
          code,
        ),
      );
      if (!result.evidence_id) {
        out.push(
          mismatch(
            "provider_result.evidence_id",
            `slot ${slot} must record evidence_id even when the evidence object is summarised`,
            code,
          ),
        );
      }
    }
    return;
  }

  // Both sides exist. Cross-check IDs.
  if (result.evidence_id !== evidence.evidence_id) {
    out.push(
      mismatch(
        "provider_result.evidence_id",
        `evidence_id mismatch: result=${String(result.evidence_id)} evidence=${evidence.evidence_id}`,
        code,
      ),
    );
  }
  if (result.provider_slot !== evidence.provider_slot) {
    out.push(
      mismatch(
        "provider_result.provider_slot",
        `provider_slot mismatch: result=${result.provider_slot} evidence=${evidence.provider_slot}`,
        code,
      ),
    );
  }

  // provider family ↔ browser provider.
  if (!familyMatchesProvider(result.provider_family, evidence.provider)) {
    out.push(
      mismatch(
        "provider_result.provider_family",
        `provider family "${result.provider_family}" does not match evidence.provider "${evidence.provider}"`,
        code,
      ),
    );
  }

  // provider_result_id is recorded on BOTH artifacts — the bead's
  // primary "must match across artifacts" rule. Evidence carries it as
  // a typed field; result carries it as its own identifier. Mismatch
  // here is the highest-signal drift indicator.
  if (
    typeof evidence.provider_result_id === "string" &&
    result.provider_result_id !== evidence.provider_result_id
  ) {
    out.push(
      mismatch(
        "provider_result.provider_result_id",
        `provider_result_id mismatch: result=${result.provider_result_id} evidence=${evidence.provider_result_id}`,
        code,
      ),
    );
  }

  // Result output hash should match evidence's recorded output hash. The
  // result text hash is a `sha256:<64-hex>` string; same shape on the
  // evidence side. We compare string equality.
  if (result.result_text_sha256 !== evidence.output_text_sha256) {
    out.push(
      mismatch(
        "provider_result.result_text_sha256",
        `result text hash does not match evidence.output_text_sha256`,
        "output_capture_unverified",
      ),
    );
  }

  // NB: provider_result.prompt_manifest_sha256 is a hash of the prompt
  // MANIFEST document (JSON with metadata), while evidence.prompt_sha256
  // is a hash of the prompt TEXT bytes that were submitted. They are
  // related but not byte-identical, so we do NOT require equality here.
  // Drift detection for the prompt text lives in oracle-s7p (prompt
  // hash recording), not in this cross-artifact checker.

  // Evidence must be verified before prompt submit AND mode_verified for
  // a protected slot — synthesis_eligible cannot be true otherwise.
  if (slotIsProtected) {
    if (!evidence.mode_verified) {
      out.push(
        mismatch(
          "browser_evidence.mode_verified",
          `must be true for protected slot ${slot}`,
          code,
        ),
      );
    }
    if (!evidence.verified_before_prompt_submit) {
      out.push(
        mismatch(
          "browser_evidence.verified_before_prompt_submit",
          `must be true for protected slot ${slot}`,
          "prompt_submitted_before_verification",
        ),
      );
    }
    if (result.synthesis_eligible && (!evidence.mode_verified || !evidence.verified_before_prompt_submit)) {
      out.push(
        mismatch(
          "provider_result.synthesis_eligible",
          `cannot be true for protected slot ${slot} without verified evidence`,
          code,
        ),
      );
    }
    // Protected-slot family ↔ access_path. Even with valid evidence,
    // an API access path here is a substitution attack.
    const expectedFamily = PROTECTED_SLOT_FAMILY[slot as ProtectedSlot];
    if (!familyMatchesProvider(result.provider_family, expectedFamily)) {
      out.push(
        mismatch(
          "provider_result.provider_family",
          `protected slot ${slot} requires provider_family aligned with "${expectedFamily}"`,
          code,
        ),
      );
    }
    if (!isOracleBrowserAccessPath(result.access_path)) {
      out.push(
        mismatch(
          "provider_result.access_path",
          `protected slot ${slot} forbids API access path "${result.access_path}"; must be one of ${ORACLE_BROWSER_ACCESS_PATHS.join(", ")}`,
          code,
        ),
      );
    }
  }

  if (slotIsApiAllowed) {
    // API-allowed slots should NOT ship browser evidence. The verifier
    // raises this as a warning-level mismatch so callers can decide
    // whether to reject or just log.
    out.push(
      mismatch(
        "provider_result.evidence_id",
        `API-allowed slot ${slot} should not carry browser evidence`,
        null,
      ),
    );
  }
}

function checkArtifactIndex(
  index: ArtifactIndex,
  bytes: Readonly<Record<string, Uint8Array | string>> | undefined,
  result: ProviderResult,
  out: ConsistencyMismatch[],
): void {
  // If the result ships an evidence_id, the index should reference it.
  if (result.evidence_id) {
    const referenced = index.artifacts.find(
      (entry) => entry.artifact_id === result.evidence_id,
    );
    if (!referenced) {
      out.push(
        mismatch(
          "artifact_index.artifacts",
          `no entry references evidence_id=${result.evidence_id}`,
          pickErrorCodeForSlot(result.provider_slot),
        ),
      );
    }
  }

  if (!bytes) return;

  for (const entry of index.artifacts) {
    const raw = bytes[entry.path];
    if (raw === undefined) {
      out.push(
        mismatch(
          `artifact_index.${entry.path}`,
          `index entry references missing bytes for path "${entry.path}"`,
          null,
        ),
      );
      continue;
    }
    const actual = hashBytes(raw);
    if (actual !== entry.sha256) {
      out.push(
        mismatch(
          `artifact_index.${entry.path}.sha256`,
          `on-disk bytes hash ${actual} but index recorded ${entry.sha256} — partial write or tampering`,
          null,
        ),
      );
    }
  }
}

function hashBytes(value: Uint8Array | string): `sha256:${string}` {
  const buf = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

// ─── Public surface ──────────────────────────────────────────────────────────

/**
 * Cross-check a provider_result.v1 against its evidence ledger and
 * artifact index. Returns every mismatch, never the first one.
 */
export function verifyHashConsistency(input: VerifyHashConsistencyInput): ConsistencyVerdict {
  const mismatches: ConsistencyMismatch[] = [];

  const result = parseProviderResult(input.result, mismatches);
  if (!result) return fail(mismatches);

  const evidence =
    input.evidence === undefined ? null : parseEvidence(input.evidence, mismatches);
  // Schema-parse failures on evidence are already recorded; continue so
  // the index check can still run.

  checkResultEvidencePair(result, evidence, mismatches);

  if (input.artifactIndex !== undefined) {
    const index = parseArtifactIndex(input.artifactIndex, mismatches);
    if (index) checkArtifactIndex(index, input.artifactBytes, result, mismatches);
  }

  return mismatches.length === 0 ? OK : fail(mismatches);
}

/**
 * Convenience: returns the list of mismatch codes (deduped) so a caller
 * can map them onto a json_envelope.v1 `errors[]` array directly.
 */
export function consistencyCodes(verdict: ConsistencyVerdict): V18ErrorCode[] {
  const seen = new Set<V18ErrorCode>();
  for (const m of verdict.mismatches) {
    if (m.code) seen.add(m.code);
  }
  return [...seen];
}

/**
 * Throw on inconsistency. Useful in tests and dev-only assertions; CLI
 * code paths should prefer the verdict object so they can surface every
 * mismatch in one envelope.
 */
export function assertHashConsistency(input: VerifyHashConsistencyInput): void {
  const verdict = verifyHashConsistency(input);
  if (verdict.consistent) return;
  const summary = verdict.mismatches
    .slice(0, 5)
    .map((m) => `  - [${m.code ?? "no-code"}] ${m.field}: ${m.message}`)
    .join("\n");
  const overflow =
    verdict.mismatches.length > 5 ? `\n  …and ${verdict.mismatches.length - 5} more` : "";
  throw new Error(`Hash consistency failed (${verdict.mismatches.length}):\n${summary}${overflow}`);
}

/**
 * Compute a `sha256:<64-hex>` digest from raw bytes; exported so test
 * scaffolding can build matching hashes without re-importing
 * src/oracle/v18/evidence.ts. The implementation mirrors `sha256OfBytes`.
 */
export function computeSha256(bytes: Uint8Array | string): `sha256:${string}` {
  return hashBytes(bytes);
}

// Slot taxonomy re-exports kept here so downstream consumers can import
// the whole consistency surface from one module.
export { PROTECTED_SLOTS, ORACLE_BROWSER_ACCESS_PATHS };
