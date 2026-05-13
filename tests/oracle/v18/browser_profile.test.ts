// Unit tests for the v18 shared browser profile + provider lock model
// (oracle-stu).
//
// Acceptance criteria (verbatim from the bead):
//
//   Tests prove endpoint/profile metadata is stable and redacted, and
//   that ChatGPT/Gemini locks are visible as
//   `browser:shared-profile:chatgpt` and `browser:shared-profile:gemini`
//   or documented equivalents.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  describeSharedBrowserProfile,
  deriveProfileIdHash,
} from "../../../src/browser/profile.js";
import {
  BROWSER_SHARED_PROFILE_LOCKS,
  BROWSER_SHARED_PROFILE_PROVIDERS,
  FORBIDDEN_PUBLIC_PROFILE_KEYS,
  SHARED_BROWSER_PROFILE_SCHEMA_VERSION,
  SHARED_PROFILE_POLICY,
  SHARED_PROFILE_SCOPE,
  assertNoSecretsInPublicView,
  browserSessionExposesAllProviderLocks,
  buildSharedProfileView,
  computeProfileIdHash,
  isSharedProfileLockName,
  isSharedProfileProvider,
  lockNameForProvider,
  providerForLockName,
} from "../../../src/oracle/v18/browser_profile.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_BUNDLE = path.resolve(
  moduleDir,
  "../../../PLAN/oracle-vnext-plan-bundle-v18.0.0",
);

async function loadFixture<T = unknown>(rel: string): Promise<T> {
  return JSON.parse(await readFile(path.join(PLAN_BUNDLE, rel), "utf8")) as T;
}

// ─── Lock taxonomy ───────────────────────────────────────────────────────────

describe("shared profile lock taxonomy", () => {
  test("lock names match the documented spec strings", () => {
    expect(BROWSER_SHARED_PROFILE_LOCKS.chatgpt).toBe("browser:shared-profile:chatgpt");
    expect(BROWSER_SHARED_PROFILE_LOCKS.gemini).toBe("browser:shared-profile:gemini");
  });

  test("BROWSER_SHARED_PROFILE_PROVIDERS contains both documented providers", () => {
    expect([...BROWSER_SHARED_PROFILE_PROVIDERS].sort()).toEqual(["chatgpt", "gemini"]);
  });

  test("lockNameForProvider round-trips with providerForLockName", () => {
    for (const provider of BROWSER_SHARED_PROFILE_PROVIDERS) {
      const lock = lockNameForProvider(provider);
      expect(providerForLockName(lock)).toBe(provider);
    }
  });

  test("providerForLockName returns null for unknown / malformed locks", () => {
    expect(providerForLockName("browser:shared-profile:claude")).toBeNull();
    expect(providerForLockName("not-a-lock")).toBeNull();
    expect(providerForLockName("")).toBeNull();
  });

  test("isSharedProfileLockName accepts only documented locks", () => {
    expect(isSharedProfileLockName("browser:shared-profile:chatgpt")).toBe(true);
    expect(isSharedProfileLockName("browser:shared-profile:gemini")).toBe(true);
    expect(isSharedProfileLockName("browser:shared-profile:other")).toBe(false);
    expect(isSharedProfileLockName(null)).toBe(false);
    expect(isSharedProfileLockName(42)).toBe(false);
  });

  test("isSharedProfileProvider accepts the v18 browser-provider enum", () => {
    expect(isSharedProfileProvider("chatgpt")).toBe(true);
    expect(isSharedProfileProvider("gemini")).toBe(true);
    expect(isSharedProfileProvider("claude")).toBe(false);
    expect(isSharedProfileProvider("openai")).toBe(false);
  });

  test("SHARED_PROFILE_POLICY matches the canonical lease fixture phrase", async () => {
    const lease = await loadFixture<Record<string, unknown>>("fixtures/browser-lease.json");
    expect(lease.shared_profile_policy).toBe(SHARED_PROFILE_POLICY);
    expect(lease.profile_scope).toBe(SHARED_PROFILE_SCOPE);
  });
});

// ─── Identity hash ───────────────────────────────────────────────────────────

describe("computeProfileIdHash", () => {
  test("returns a sha256:<hex64> string", () => {
    const hash = computeProfileIdHash({
      endpointId: "ep-1",
      hostEnv: "ORACLE_REMOTE_HOST",
      tokenEnv: "ORACLE_REMOTE_TOKEN",
    });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("is deterministic across calls with identical identity", () => {
    const identity = {
      endpointId: "ep-1",
      hostEnv: "ORACLE_REMOTE_HOST",
      tokenEnv: "ORACLE_REMOTE_TOKEN",
      accountId: "user@example.com",
    };
    expect(computeProfileIdHash(identity)).toBe(computeProfileIdHash({ ...identity }));
  });

  test("is insensitive to property-insertion order", () => {
    const a = computeProfileIdHash({
      endpointId: "ep-1",
      hostEnv: "H",
      tokenEnv: "T",
      accountId: "u@x",
    });
    const b = computeProfileIdHash({
      accountId: "u@x",
      tokenEnv: "T",
      hostEnv: "H",
      endpointId: "ep-1",
    });
    expect(a).toBe(b);
  });

  test("changes when any identity field changes", () => {
    const base = {
      endpointId: "ep-1",
      hostEnv: "H",
      tokenEnv: "T",
    };
    const baseHash = computeProfileIdHash(base);
    expect(computeProfileIdHash({ ...base, endpointId: "ep-2" })).not.toBe(baseHash);
    expect(computeProfileIdHash({ ...base, hostEnv: "OTHER_HOST" })).not.toBe(baseHash);
    expect(computeProfileIdHash({ ...base, tokenEnv: "OTHER_TOKEN" })).not.toBe(baseHash);
    expect(computeProfileIdHash({ ...base, accountId: "u@x" })).not.toBe(baseHash);
    expect(computeProfileIdHash({ ...base, rawProfilePath: "/var/Oracle/profile" })).not.toBe(
      baseHash,
    );
  });

  test("omitting an optional field equals leaving it undefined", () => {
    const a = computeProfileIdHash({
      endpointId: "ep-1",
      hostEnv: "H",
      tokenEnv: "T",
    });
    const b = computeProfileIdHash({
      endpointId: "ep-1",
      hostEnv: "H",
      tokenEnv: "T",
      accountId: undefined,
      rawProfilePath: undefined,
    });
    expect(a).toBe(b);
  });
});

// ─── Public view: redaction guarantees ──────────────────────────────────────

describe("buildSharedProfileView", () => {
  const identity = {
    endpointId: "ep-1",
    hostEnv: "ORACLE_REMOTE_HOST",
    tokenEnv: "ORACLE_REMOTE_TOKEN",
    accountId: "user@example.com",
    rawProfilePath: "/home/ubuntu/.oracle/profiles/manual-login",
  };

  test("emits the documented schema_version and policy strings", () => {
    const view = buildSharedProfileView({ identity });
    expect(view.schema_version).toBe(SHARED_BROWSER_PROFILE_SCHEMA_VERSION);
    expect(view.shared_profile_policy).toBe(SHARED_PROFILE_POLICY);
    expect(view.profile_scope).toBe(SHARED_PROFILE_SCOPE);
  });

  test("profile_id_hash equals auth_profile_id_hash", () => {
    // The v18 model uses a single logical profile identity boundary; the
    // two hash slots exist for compatibility with the remote-browser
    // endpoint contract but must always point to the same identity.
    const view = buildSharedProfileView({ identity });
    expect(view.auth_profile_id_hash).toBe(view.profile_id_hash);
  });

  test("provider_locks lists both documented locks by default", () => {
    const view = buildSharedProfileView({ identity });
    expect(view.provider_locks).toHaveLength(2);
    const locks = view.provider_locks.map((entry) => entry.lock);
    expect(locks).toContain("browser:shared-profile:chatgpt");
    expect(locks).toContain("browser:shared-profile:gemini");
  });

  test("provider_locks can be narrowed to a single provider", () => {
    const view = buildSharedProfileView({ identity, providers: ["chatgpt"] });
    expect(view.provider_locks).toHaveLength(1);
    expect(view.provider_locks[0].provider).toBe("chatgpt");
    expect(view.provider_locks[0].lock).toBe("browser:shared-profile:chatgpt");
  });

  test("public view never leaks internal identity fields", () => {
    const view = buildSharedProfileView({ identity });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("user@example.com");
    expect(serialised).not.toContain("manual-login");
    expect(serialised).not.toContain("/home/ubuntu");
  });

  test("public view never contains any forbidden key", () => {
    const view = buildSharedProfileView({ identity }) as unknown as Record<string, unknown>;
    for (const key of FORBIDDEN_PUBLIC_PROFILE_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(view, key)).toBe(false);
    }
    expect(() => assertNoSecretsInPublicView(view)).not.toThrow();
  });

  test("public view is deeply frozen", () => {
    const view = buildSharedProfileView({ identity });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.remote_browser)).toBe(true);
    expect(Object.isFrozen(view.provider_locks)).toBe(true);
    expect(Object.isFrozen(view.provider_locks[0])).toBe(true);
  });

  test("public view declares no_plaintext_secrets=true", () => {
    const view = buildSharedProfileView({ identity });
    expect(view.remote_browser.no_plaintext_secrets).toBe(true);
    expect(view.remote_browser.host_env).toBe("ORACLE_REMOTE_HOST");
    expect(view.remote_browser.token_env).toBe("ORACLE_REMOTE_TOKEN");
    // The endpoint id is the public identifier, not the raw host.
    expect(view.remote_browser.endpoint_id).toBe("ep-1");
  });
});

// ─── Redaction guard ─────────────────────────────────────────────────────────

describe("assertNoSecretsInPublicView", () => {
  test("flags cookies at the top level", () => {
    expect(() =>
      assertNoSecretsInPublicView({ cookies: [{ name: "session" }] }),
    ).toThrow(/forbidden keys/i);
  });

  test("flags a nested raw_profile_path", () => {
    expect(() =>
      assertNoSecretsInPublicView({
        remote_browser: { raw_profile_path: "/x" },
      }),
    ).toThrow(/forbidden keys/i);
  });

  test("flags a nested account_email inside an array", () => {
    expect(() =>
      assertNoSecretsInPublicView({
        provider_locks: [{ lock: "browser:shared-profile:chatgpt", account_email: "u@x" }],
      }),
    ).toThrow(/forbidden keys/i);
  });

  test("passes for a fully-redacted view", () => {
    expect(() =>
      assertNoSecretsInPublicView({
        schema_version: "shared_browser_profile.v1",
        provider_locks: [
          { provider: "chatgpt", lock: "browser:shared-profile:chatgpt" },
          { provider: "gemini", lock: "browser:shared-profile:gemini" },
        ],
      }),
    ).not.toThrow();
  });
});

// ─── Plan-bundle fixtures cross-check ────────────────────────────────────────

describe("plan-bundle fixtures expose the documented locks", () => {
  test("browser-session.json exposes both shared-profile locks", async () => {
    const session = await loadFixture<Record<string, unknown>>("fixtures/browser-session.json");
    expect(browserSessionExposesAllProviderLocks(session.provider_locks)).toBe(true);
  });

  test("browser-lease.json uses the chatgpt shared-profile lock name", async () => {
    const lease = await loadFixture<Record<string, unknown>>("fixtures/browser-lease.json");
    expect(lease.lock_name).toBe("browser:shared-profile:chatgpt");
    expect(lease.profile_scope).toBe(SHARED_PROFILE_SCOPE);
    expect(lease.shared_profile_policy).toBe(SHARED_PROFILE_POLICY);
  });

  test("browserSessionExposesAllProviderLocks rejects partial coverage", () => {
    expect(
      browserSessionExposesAllProviderLocks([
        { provider: "chatgpt", lock: "browser:shared-profile:chatgpt" },
      ]),
    ).toBe(false);
    expect(browserSessionExposesAllProviderLocks([])).toBe(false);
    expect(browserSessionExposesAllProviderLocks(null)).toBe(false);
    expect(browserSessionExposesAllProviderLocks("not-an-array")).toBe(false);
  });

  test("browserSessionExposesAllProviderLocks accepts the string-array shape", () => {
    expect(
      browserSessionExposesAllProviderLocks([
        "browser:shared-profile:chatgpt",
        "browser:shared-profile:gemini",
      ]),
    ).toBe(true);
  });
});

// ─── src/browser/profile.ts wiring ───────────────────────────────────────────

describe("browser-layer wiring", () => {
  test("describeSharedBrowserProfile defaults to ORACLE_REMOTE_* env vars", () => {
    const view = describeSharedBrowserProfile({});
    expect(view.remote_browser.host_env).toBe("ORACLE_REMOTE_HOST");
    expect(view.remote_browser.token_env).toBe("ORACLE_REMOTE_TOKEN");
    expect(view.remote_browser.endpoint_id).toBe("oracle-shared-remote-browser");
  });

  test("describeSharedBrowserProfile redacts internal account info", () => {
    const view = describeSharedBrowserProfile({
      accountId: "user@example.com",
      rawProfilePath: "/var/profile",
    });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("user@example.com");
    expect(serialised).not.toContain("/var/profile");
  });

  test("deriveProfileIdHash matches buildSharedProfileView's hash", () => {
    const config = {
      endpointId: "ep-2",
      hostEnv: "OR_HOST",
      tokenEnv: "OR_TOKEN",
      accountId: "u@x",
    };
    const view = describeSharedBrowserProfile(config);
    expect(deriveProfileIdHash(config)).toBe(view.profile_id_hash);
  });

  test("deriveProfileIdHash hides account/raw-profile from the hash domain", () => {
    // Different accountId / rawProfilePath must still produce *some*
    // sha256 string; the public view must not let the raw values
    // escape.
    const view = describeSharedBrowserProfile({
      accountId: "leaky@example.com",
      rawProfilePath: "/leaky/path",
    });
    expect(view.profile_id_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(view)).not.toContain("leaky");
  });
});
