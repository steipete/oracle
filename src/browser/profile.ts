// Thin browser-layer wrapper around the v18 shared-profile contract.
//
// This module lives in `src/browser/` so non-v18 code paths (the remote
// client, lease planner, doctor surfaces) can build a redacted public
// view of the active shared browser profile without depending on
// anything else under `src/oracle/v18/` beyond the
// `browser_profile.ts` types.
//
// IMPORTANT: do not import from `src/oracle/v18/contracts.ts` or any
// other pane-owned module here; the entire surface is re-exported from
// `src/oracle/v18/browser_profile.ts`.

import {
  buildSharedProfileView,
  computeProfileIdHash,
  type BuildSharedProfileViewInput,
  type SharedBrowserProfileIdentity,
  type SharedBrowserProfileView,
} from "../oracle/v18/browser_profile.js";

/**
 * Configuration the browser layer actually has when it goes to render
 * the shared profile view. Mirrors the fields the existing remote
 * service config exposes (host env, token env, endpoint id) without
 * making this module depend on `src/remote/` (pane 4 owns that tree).
 */
export interface BrowserProfileConfig {
  /** Stable id for the remote endpoint (e.g. "remote-prod-1"). */
  endpointId?: string;
  /** Name of the env var holding the remote host (defaults to ORACLE_REMOTE_HOST). */
  hostEnv?: string;
  /** Name of the env var holding the remote token (defaults to ORACLE_REMOTE_TOKEN). */
  tokenEnv?: string;
  /** Internal-only: account label / login email if known. NEVER leaves Oracle. */
  accountId?: string;
  /** Internal-only: on-disk Chrome profile path for manual-login. NEVER leaves Oracle. */
  rawProfilePath?: string;
}

const DEFAULT_ENDPOINT_ID = "oracle-shared-remote-browser";
const DEFAULT_HOST_ENV = "ORACLE_REMOTE_HOST";
const DEFAULT_TOKEN_ENV = "ORACLE_REMOTE_TOKEN";

function deriveIdentity(config: BrowserProfileConfig): SharedBrowserProfileIdentity {
  return {
    endpointId: config.endpointId ?? DEFAULT_ENDPOINT_ID,
    hostEnv: config.hostEnv ?? DEFAULT_HOST_ENV,
    tokenEnv: config.tokenEnv ?? DEFAULT_TOKEN_ENV,
    accountId: config.accountId,
    rawProfilePath: config.rawProfilePath,
  };
}

/**
 * Compute the stable `profile_id_hash` for a browser-layer config
 * without materialising the full public view. Useful for matching an
 * inbound provider-result back to the profile that produced it.
 */
export function deriveProfileIdHash(config: BrowserProfileConfig): string {
  return computeProfileIdHash(deriveIdentity(config));
}

/**
 * Build the public, redacted shared-profile view that Oracle hands to
 * APR / `$vibe-planning` / lease planning. All forbidden keys (cookies,
 * DOM, screenshots, raw profile paths, account identifiers) are
 * guaranteed to be absent — the underlying assertion fires if any
 * caller smuggles them through `extras`.
 */
export function describeSharedBrowserProfile(
  config: BrowserProfileConfig,
  options: Omit<BuildSharedProfileViewInput, "identity"> = {},
): SharedBrowserProfileView {
  return buildSharedProfileView({
    identity: deriveIdentity(config),
    providers: options.providers,
  });
}
