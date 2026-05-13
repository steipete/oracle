// v18 shared browser profile + provider locks (oracle-stu).
//
// Models the "one shared profile" requirement as a shared *logical*
// user-authenticated browser identity boundary (see
// PLAN/oracle-vnext-plan-bundle-v18.0.0/docs/remote-browser-profile-policy.md).
// The contract-visible surface is:
//
//   - one logical `profile_id_hash` (sha256 of identity-bearing fields)
//   - one remote-browser endpoint descriptor
//   - per-provider locks named `browser:shared-profile:<provider>`
//
// Anything else — cookies, DOM, screenshots, raw profile paths, account
// identifiers — must stay inside Oracle and never appear in objects this
// module emits.

import { createHash } from "node:crypto";

import { browserProviderSchema, sha256HashSchema } from "./contracts.js";
import type { V18ErrorCode } from "./json_envelope.js";

// ─── Lock taxonomy ───────────────────────────────────────────────────────────

/**
 * Documented provider-lock names from oracle-stu acceptance criteria and
 * the canonical fixtures (`fixtures/browser-session.json`,
 * `fixtures/browser-lease.json`).
 */
export const BROWSER_SHARED_PROFILE_LOCKS = {
  chatgpt: "browser:shared-profile:chatgpt",
  gemini: "browser:shared-profile:gemini",
} as const;

export type SharedProfileProvider = keyof typeof BROWSER_SHARED_PROFILE_LOCKS;
export type SharedProfileLockName =
  (typeof BROWSER_SHARED_PROFILE_LOCKS)[SharedProfileProvider];

const LOCK_NAME_TO_PROVIDER: ReadonlyMap<string, SharedProfileProvider> = new Map(
  (Object.entries(BROWSER_SHARED_PROFILE_LOCKS) as [SharedProfileProvider, SharedProfileLockName][]).map(
    ([provider, lock]) => [lock, provider],
  ),
);

export const BROWSER_SHARED_PROFILE_PROVIDERS: readonly SharedProfileProvider[] = Object.freeze(
  Object.keys(BROWSER_SHARED_PROFILE_LOCKS) as SharedProfileProvider[],
);

/** Returns the documented lock string for a known shared-profile provider. */
export function lockNameForProvider(provider: SharedProfileProvider): SharedProfileLockName {
  return BROWSER_SHARED_PROFILE_LOCKS[provider];
}

/**
 * Inverse lookup: given a lock string, returns its provider or `null` if
 * the string is not one of the documented shared-profile locks.
 */
export function providerForLockName(name: string): SharedProfileProvider | null {
  return LOCK_NAME_TO_PROVIDER.get(name) ?? null;
}

export function isSharedProfileLockName(value: unknown): value is SharedProfileLockName {
  return typeof value === "string" && LOCK_NAME_TO_PROVIDER.has(value);
}

export function isSharedProfileProvider(value: unknown): value is SharedProfileProvider {
  return browserProviderSchema.safeParse(value).success;
}

/**
 * The single phrase that goes into the `shared_profile_policy` /
 * `profile_scope` field of every lease emitted under this contract. See
 * `fixtures/browser-lease.json`.
 */
export const SHARED_PROFILE_POLICY =
  "one_user_auth_context_per_remote_browser_host; provider-specific technical profiles are allowed only if Oracle requires them internally";

export const SHARED_PROFILE_SCOPE = "shared_logical_remote_browser_profile_with_provider_locks";

// ─── Profile views: public vs private ────────────────────────────────────────

/**
 * Identity inputs Oracle's internal browser layer knows about. None of
 * these may appear in the public view; the redactor hashes them into the
 * single `profile_id_hash`.
 */
export interface SharedBrowserProfileIdentity {
  /** Stable name for the remote endpoint (e.g. "remote-prod-1"). */
  endpointId: string;
  /** Env-var name holding the remote host. */
  hostEnv: string;
  /** Env-var name holding the remote token. */
  tokenEnv: string;
  /**
   * The user-visible account label or login email — NEVER allowed to
   * escape Oracle. Optional because some Oracle internal callers omit
   * it; when present it is folded into the identity hash.
   */
  accountId?: string;
  /** Raw on-disk path for the manual-login Chrome profile, if any. */
  rawProfilePath?: string;
}

/**
 * The public view APR / `$vibe-planning` consume. Only identity-bearing
 * material in pre-hashed form, the lock list, and a tiny endpoint
 * descriptor.
 */
export interface SharedBrowserProfileView {
  schema_version: "shared_browser_profile.v1";
  profile_id_hash: string;
  auth_profile_id_hash: string;
  shared_profile_policy: typeof SHARED_PROFILE_POLICY;
  profile_scope: typeof SHARED_PROFILE_SCOPE;
  remote_browser: {
    endpoint_id: string;
    host_env: string;
    token_env: string;
    no_plaintext_secrets: true;
  };
  provider_locks: ReadonlyArray<{
    provider: SharedProfileProvider;
    lock: SharedProfileLockName;
  }>;
}

export const SHARED_BROWSER_PROFILE_SCHEMA_VERSION = "shared_browser_profile.v1" as const;

/**
 * Keys that MUST never appear in a public view object. The redactor
 * asserts this; the assertion is also exposed publicly for downstream
 * pre-commit / pre-emit checks.
 */
export const FORBIDDEN_PUBLIC_PROFILE_KEYS: readonly string[] = Object.freeze([
  "cookies",
  "cookie",
  "raw_dom",
  "dom",
  "screenshots",
  "screenshot",
  "raw_profile_path",
  "profile_path",
  "user_data_dir",
  "account_id",
  "account_email",
  "account_label",
  "remote_host",
  "remote_token",
  "host",
  "token",
]);

const FORBIDDEN_PUBLIC_PROFILE_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_PUBLIC_PROFILE_KEYS);

export const SHARED_PROFILE_REDACTION_ERROR_CODE: V18ErrorCode = "remote_browser_unavailable";

// ─── Hash + redaction ────────────────────────────────────────────────────────

/**
 * Stable sha256 over identity-bearing fields, formatted as
 * `sha256:<64-hex>` so it matches `sha256HashSchema` and the other v18
 * hash fields.
 *
 * The hash is intentionally tolerant to property-order differences in
 * the input (it canonicalises before hashing) and ignores any extension
 * keys not listed in {@link SharedBrowserProfileIdentity}.
 */
export function computeProfileIdHash(identity: SharedBrowserProfileIdentity): string {
  const canonical = canonicaliseIdentity(identity);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  const hash = `sha256:${digest}`;
  // Sanity check against the in-repo regex for sha256: hashes.
  if (!sha256HashSchema.safeParse(hash).success) {
    throw new Error(`computeProfileIdHash produced a malformed digest: ${hash}`);
  }
  return hash;
}

function canonicaliseIdentity(identity: SharedBrowserProfileIdentity): string {
  // We sort keys so caller-side property-insertion order never affects
  // the hash, and we omit `undefined` so an optional field that wasn't
  // configured produces the same hash as one explicitly set to absent.
  const stable: Record<string, string> = {};
  if (identity.endpointId !== undefined) stable.endpointId = identity.endpointId;
  if (identity.hostEnv !== undefined) stable.hostEnv = identity.hostEnv;
  if (identity.tokenEnv !== undefined) stable.tokenEnv = identity.tokenEnv;
  if (identity.accountId !== undefined) stable.accountId = identity.accountId;
  if (identity.rawProfilePath !== undefined) stable.rawProfilePath = identity.rawProfilePath;
  return JSON.stringify(stable, Object.keys(stable).sort());
}

export interface BuildSharedProfileViewInput {
  identity: SharedBrowserProfileIdentity;
  /**
   * Which providers can take leases on this profile. Defaults to both
   * documented shared-profile providers; pass a narrower list when a
   * deployment only wires one.
   */
  providers?: readonly SharedProfileProvider[];
}

/**
 * Build the redacted public view APR / `$vibe-planning` can consume.
 * The returned object is deeply frozen so callers cannot mutate it back
 * into a leaky one.
 */
export function buildSharedProfileView(
  input: BuildSharedProfileViewInput,
): SharedBrowserProfileView {
  const providers = input.providers ?? BROWSER_SHARED_PROFILE_PROVIDERS;
  const profileIdHash = computeProfileIdHash(input.identity);

  const provider_locks = providers.map((provider) =>
    Object.freeze({
      provider,
      lock: lockNameForProvider(provider),
    }),
  );

  const view: SharedBrowserProfileView = {
    schema_version: SHARED_BROWSER_PROFILE_SCHEMA_VERSION,
    profile_id_hash: profileIdHash,
    auth_profile_id_hash: profileIdHash,
    shared_profile_policy: SHARED_PROFILE_POLICY,
    profile_scope: SHARED_PROFILE_SCOPE,
    remote_browser: Object.freeze({
      endpoint_id: input.identity.endpointId,
      host_env: input.identity.hostEnv,
      token_env: input.identity.tokenEnv,
      no_plaintext_secrets: true as const,
    }),
    provider_locks: Object.freeze(provider_locks),
  };

  assertNoSecretsInPublicView(view);
  return Object.freeze(view);
}

/**
 * Throws when a public view contains any forbidden key (cookies, raw
 * DOM, profile paths, account identifiers, ...). Used as the gate
 * between Oracle's internal browser layer and anything user-visible.
 */
export function assertNoSecretsInPublicView(view: unknown): void {
  const failures = collectForbiddenKeys(view, "");
  if (failures.length > 0) {
    throw new Error(
      `Shared browser profile public view leaks forbidden keys: ${failures.join(", ")}. ` +
        "Cookies, DOM, screenshots, raw profile paths, and account identifiers must stay inside Oracle.",
    );
  }
}

function collectForbiddenKeys(value: unknown, pointer: string): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectForbiddenKeys(entry, `${pointer}/${index}`));
  }
  const failures: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${key}`;
    if (FORBIDDEN_PUBLIC_PROFILE_KEY_SET.has(key)) {
      failures.push(childPointer);
    }
    failures.push(...collectForbiddenKeys(child, childPointer));
  }
  return failures;
}

// ─── Cross-check helpers ─────────────────────────────────────────────────────

/**
 * Given the `provider_locks` array of a `browser_session.v1` payload,
 * returns whether every documented shared-profile lock is present.
 * Accepts the array-of-objects shape from the canonical fixture and
 * the array-of-strings shape used by `remote_browser_endpoint.v1`.
 */
export function browserSessionExposesAllProviderLocks(value: unknown): boolean {
  const observed = new Set<string>();
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (typeof entry === "string") {
      observed.add(entry);
    } else if (entry !== null && typeof entry === "object") {
      const lock = (entry as Record<string, unknown>).lock;
      if (typeof lock === "string") {
        observed.add(lock);
      }
    }
  }
  for (const expected of Object.values(BROWSER_SHARED_PROFILE_LOCKS)) {
    if (!observed.has(expected)) return false;
  }
  return true;
}
