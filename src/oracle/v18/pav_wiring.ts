// PAV wiring — attach pane 7's provider-boundary PAV snapshots to the
// concrete provider_result + session metadata surfaces without
// rewriting either. The PAV (provider-prompt + access-policy + context-
// serialization) snapshot is the typed boundary record; this module
// answers the question "where does it actually go in the data we
// persist?" Three rules govern wiring:
//
//   1. Raw prompt text NEVER enters metadata. We carry
//      `prompt_sha256`, `prompt_bytes`, and `prompt_semantics:
//      "unchanged"` — not the bytes.
//   2. Wiring is a no-op for ordinary (non-workflow) Oracle runs. The
//      `ordinary_oracle` ownership tag means general-purpose `oracle`
//      CLI use stays unchanged: same provider_result shape, no PAV
//      block on the session record.
//   3. Wiring is additive. Existing fields on the provider_result /
//      session metadata are preserved verbatim; we only add a typed
//      `pav_boundary` namespace.

import type { ProviderBoundaryPavSnapshot } from "../provider_boundaries_pav.js";

/**
 * The session/provider-result-level typed projection of a PAV snapshot.
 * Identical to `snapshot.metadata` minus the `boundary_roles` block
 * (which is informational policy text, not run-specific data).
 */
export type PavBoundaryMetadata = Omit<
  ProviderBoundaryPavSnapshot["metadata"],
  "boundary_roles"
>;

/** Returns the persistable metadata projection of a PAV snapshot. */
export function projectPavMetadata(snapshot: ProviderBoundaryPavSnapshot): PavBoundaryMetadata {
  // Strip boundary_roles; everything else round-trips.
  const { boundary_roles: _omit, ...rest } = snapshot.metadata;
  void _omit;
  return rest;
}

/**
 * `true` when the snapshot describes an ordinary (non-workflow) Oracle
 * run that wiring must NOT modify. Callers should bail out early when
 * this returns true so general-purpose Oracle behavior stays unchanged.
 */
export function isOrdinaryOracleUsage(snapshot: ProviderBoundaryPavSnapshot): boolean {
  return snapshot.metadata.ownership === "ordinary_oracle";
}

/**
 * Hard invariant: raw prompt text must NEVER appear in metadata
 * round-tripped to the wire. Throws if a wiring helper accidentally
 * carried `providerPrompt` (or any extension key that mirrors it) into
 * the metadata it returns.
 */
export function assertNoRawPromptInMetadata(payload: unknown): void {
  if (payload == null) return;
  const serialized = JSON.stringify(payload);
  // The boundary record advertises prompt_semantics:"unchanged" and
  // raw_prompt_in_metadata:false; we look for the actual bytes by
  // checking for fields that would only exist if a caller leaked the
  // prompt body.
  const banned = ["providerPrompt", "raw_prompt", "prompt_text", "prompt_body", "prompt_bytes_text"];
  for (const key of banned) {
    if (serialized.includes(`"${key}":`)) {
      throw new Error(
        `PAV wiring leak detected: metadata contains "${key}" — only prompt_sha256/prompt_bytes/prompt_semantics are allowed`,
      );
    }
  }
}

/**
 * Attach a PAV snapshot to a provider_result-shaped object. The
 * returned object is a NEW value — the input is not mutated. For
 * ordinary Oracle runs (`ownership === "ordinary_oracle"`) the input
 * is returned verbatim so general-purpose Oracle calls keep their
 * existing shape.
 */
export interface ProviderResultLike {
  readonly schema_version?: string;
  readonly provider_slot?: string;
  readonly provider_family?: string;
  readonly access_path?: string;
  readonly prompt_manifest_sha256?: string;
  readonly [key: string]: unknown;
}

export interface ProviderResultWithPav extends ProviderResultLike {
  readonly pav_boundary: PavBoundaryMetadata;
}

export function attachPavToProviderResult<T extends ProviderResultLike>(
  result: T,
  snapshot: ProviderBoundaryPavSnapshot,
): T | ProviderResultWithPav {
  if (isOrdinaryOracleUsage(snapshot)) {
    return result;
  }
  const metadata = projectPavMetadata(snapshot);
  const out: ProviderResultWithPav = { ...result, pav_boundary: metadata };
  assertNoRawPromptInMetadata(out);
  return out;
}

/**
 * Session-level PAV metadata namespace. Stored as a sibling key on
 * the session record, never inside `options` or anywhere prompt text
 * could be reconstructed.
 */
export interface SessionPavMetadata {
  readonly schema_version: typeof PAV_SESSION_NAMESPACE_SCHEMA_VERSION;
  readonly boundaries: readonly PavBoundaryMetadata[];
}

export const PAV_SESSION_NAMESPACE_SCHEMA_VERSION = "oracle.session_pav.v1" as const;

export interface SessionRecordLike {
  readonly id?: string;
  readonly options?: Record<string, unknown>;
  readonly pav?: SessionPavMetadata;
  readonly [key: string]: unknown;
}

export interface SessionRecordWithPav extends SessionRecordLike {
  readonly pav: SessionPavMetadata;
}

/**
 * Append a PAV boundary to a session record. If the session already
 * carries a `pav` block, append to its `boundaries` array (in stable
 * order). For ordinary Oracle usage the session is returned verbatim.
 *
 * The function is pure and immutable; suitable for use inside the
 * session-store update path.
 */
export function attachPavToSessionRecord<T extends SessionRecordLike>(
  session: T,
  snapshot: ProviderBoundaryPavSnapshot,
): T | SessionRecordWithPav {
  if (isOrdinaryOracleUsage(snapshot)) {
    return session;
  }
  const metadata = projectPavMetadata(snapshot);
  const existing = session.pav?.boundaries ?? [];
  const boundaries = [...existing, metadata];
  const block: SessionPavMetadata = {
    schema_version: PAV_SESSION_NAMESPACE_SCHEMA_VERSION,
    boundaries,
  };
  const out: SessionRecordWithPav = { ...session, pav: block };
  assertNoRawPromptInMetadata(out);
  return out;
}

/**
 * Convenience: pull a typed list of PAV boundaries off a session
 * record. Returns an empty array when none have been attached.
 */
export function readPavBoundaries(session: SessionRecordLike): readonly PavBoundaryMetadata[] {
  return session.pav?.boundaries ?? [];
}
