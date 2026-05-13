// v18 evidence storage layout, redaction defaults, and artifact-index
// management. Lives next to the existing session storage (no replacement
// of `src/browser/artifacts.ts`, which handles transcripts/images).
//
// Layout under `~/.oracle/sessions/<id>/`:
//
//   evidence/
//     index.json                       — artifact_index.v1 (redacted entries only)
//     <evidence_id>.json               — redacted browser_evidence.v1 ledger
//     quarantine/
//       <evidence_id>.json             — unsafe_debug payloads; NEVER indexed
//       index.json                     — separate quarantine ledger
//
// Default redaction is `redacted`. Bytes destined for disk are walked
// recursively and any property whose name matches a forbidden key
// (cookies, account email, raw DOM, screenshots, auth headers, raw
// prompt/output text) is omitted before serialization. Unsafe payloads
// (`redaction_policy === "unsafe_debug"`) are diverted to quarantine and
// excluded from the normal index that downstream APR/handoff readers
// consume.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getOracleHomeDir } from "../../oracleHome.js";
import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  artifactIndexSchema,
  browserEvidenceSchema,
  type ArtifactIndex,
  type ArtifactIndexEntry,
  type BrowserEvidence,
} from "./contracts.js";
import { serializeArtifactIndexUpdate } from "./artifact_index_lock.js";

const SESSIONS_DIRNAME = "sessions";
const EVIDENCE_DIRNAME = "evidence";
const QUARANTINE_DIRNAME = "quarantine";
const INDEX_FILENAME = "index.json";
const EVIDENCE_KIND = "browser_evidence";

/**
 * Forbidden substring families. A property is dropped if its key (after
 * lower-casing) contains any of these substrings, regardless of position
 * — defends against prefix attacks like `debug_session_token` or
 * `legacy_auth_header`. Two carve-outs preserve legitimate typed-core
 * fields:
 *
 *   * keys starting with `stores_` are evidence-privacy DECLARATIONS
 *     (e.g. `stores_cookies: false`), not raw cookie/dom bytes.
 *   * keys ending in `_sha256` or `_hash` are content-addressed
 *     digests — safe by construction.
 */
const FORBIDDEN_KEY_SUBSTRINGS: readonly string[] = [
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
] as const;

const FORBIDDEN_EXACT_KEYS: readonly string[] = ["email", "auth"] as const;

/** Sentinel placeholder inserted when a forbidden array entry is found. */
export const REDACTED_PLACEHOLDER = "[redacted]";

export interface RedactionResult<T> {
  /** The redacted clone (no shared references to the input). */
  readonly redacted: T;
  /** Dotted paths of every property that was removed or replaced. */
  readonly removedPaths: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith("stores_")) return false;
  if (lower.endsWith("_sha256") || lower.endsWith("_hash")) return false;
  if (FORBIDDEN_EXACT_KEYS.includes(lower)) return true;
  return FORBIDDEN_KEY_SUBSTRINGS.some((sub) => lower.includes(sub));
}

function redactInternal(input: unknown, removed: string[], pathPrefix: string): unknown {
  if (Array.isArray(input)) {
    return input.map((entry, index) => redactInternal(entry, removed, `${pathPrefix}[${index}]`));
  }
  if (isPlainObject(input)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const childPath = pathPrefix === "" ? key : `${pathPrefix}.${key}`;
      if (isForbiddenKey(key)) {
        removed.push(childPath);
        continue;
      }
      out[key] = redactInternal(value, removed, childPath);
    }
    return out;
  }
  return input;
}

/**
 * Walk `input` and drop any property whose key matches the forbidden list.
 * Returns a new object; the input is not mutated. The result is suitable
 * for JSON serialization.
 */
export function redactEvidencePayload<T>(input: T): RedactionResult<T> {
  const removed: string[] = [];
  const redacted = redactInternal(input, removed, "") as T;
  return { redacted, removedPaths: removed };
}

// ─── paths ───────────────────────────────────────────────────────────────────

function assertSafeSessionId(id: string): void {
  if (
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error(`Invalid session id: "${id}"`);
  }
}

const EVIDENCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function assertSafeEvidenceId(id: string): void {
  if (!EVIDENCE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid evidence id: "${id}". Must match [a-z0-9][a-z0-9._-]{0,127}.`);
  }
  if (id.includes("..")) {
    throw new Error(`Invalid evidence id: "${id}"`);
  }
}

export function evidenceDir(sessionId: string, homeDir = getOracleHomeDir()): string {
  assertSafeSessionId(sessionId);
  return path.join(homeDir, SESSIONS_DIRNAME, sessionId, EVIDENCE_DIRNAME);
}

export function quarantineDir(sessionId: string, homeDir = getOracleHomeDir()): string {
  return path.join(evidenceDir(sessionId, homeDir), QUARANTINE_DIRNAME);
}

export function evidenceFilePath(
  sessionId: string,
  evidenceId: string,
  homeDir = getOracleHomeDir(),
): string {
  assertSafeEvidenceId(evidenceId);
  return path.join(evidenceDir(sessionId, homeDir), `${evidenceId}.json`);
}

export function quarantineFilePath(
  sessionId: string,
  evidenceId: string,
  homeDir = getOracleHomeDir(),
): string {
  assertSafeEvidenceId(evidenceId);
  return path.join(quarantineDir(sessionId, homeDir), `${evidenceId}.json`);
}

export function evidenceIndexPath(sessionId: string, homeDir = getOracleHomeDir()): string {
  return path.join(evidenceDir(sessionId, homeDir), INDEX_FILENAME);
}

export function quarantineIndexPath(sessionId: string, homeDir = getOracleHomeDir()): string {
  return path.join(quarantineDir(sessionId, homeDir), INDEX_FILENAME);
}

// ─── hashing + index helpers ─────────────────────────────────────────────────

export function sha256OfBytes(bytes: string | Uint8Array): `sha256:${string}` {
  const hash = crypto.createHash("sha256");
  hash.update(bytes);
  return `sha256:${hash.digest("hex")}` as const;
}

/**
 * Recognize obvious placeholder hashes (all-zeros, all-fs, any single-char
 * repeat) that a caller might use as a sentinel before real hashing is
 * wired in. The browser_evidence schema would still pass these via its
 * regex, so the v18 hash-provenance contract relies on this guard.
 */
export function isPlaceholderHash(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const match = /^sha256:([0-9a-f]{64})$/.exec(value);
  if (!match) return true;
  const hex = match[1];
  // Any 64-char repeat of a single hex character is a placeholder.
  if (/^([0-9a-f])\1{63}$/.test(hex)) return true;
  return false;
}

/**
 * Throw with a descriptive error if the value is not a real sha256 hash.
 * Used by the evidence builder when a caller hands in a pre-computed
 * hash instead of bytes.
 */
export function assertRealHash(value: unknown, field: string): `sha256:${string}` {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a sha256 hash string (got ${typeof value}).`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must match sha256:<64 hex>; got "${value}".`);
  }
  if (isPlaceholderHash(value)) {
    throw new Error(`${field} appears to be a placeholder hash: ${value}`);
  }
  return value as `sha256:${string}`;
}

/**
 * Canonical JSON: sorted keys, no trailing newline. Used for evidence bytes
 * so the same logical object always hashes to the same value regardless of
 * input key ordering.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function emptyIndex(runId?: string): ArtifactIndex {
  return {
    schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
    artifacts: [],
    bundle_version: V18_BUNDLE_VERSION,
    ...(runId ? { run_id: runId } : {}),
  };
}

export async function readArtifactIndex(indexFile: string): Promise<ArtifactIndex | null> {
  try {
    const raw = await fs.readFile(indexFile, "utf8");
    const parsed = artifactIndexSchema.parse(JSON.parse(raw));
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export async function writeArtifactIndex(indexFile: string, index: ArtifactIndex): Promise<void> {
  await fs.mkdir(path.dirname(indexFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(indexFile, `${canonicalJSON(index)}\n`, "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(indexFile, 0o600).catch(() => undefined);
  }
}

function upsertEntry(index: ArtifactIndex, entry: ArtifactIndexEntry): ArtifactIndex {
  const others = index.artifacts.filter(
    (existing) =>
      !(entry.artifact_id && existing.artifact_id === entry.artifact_id) &&
      existing.path !== entry.path,
  );
  return { ...index, artifacts: [...others, entry] };
}

// ─── writing evidence ────────────────────────────────────────────────────────

export interface WrittenEvidence {
  readonly evidenceId: string;
  readonly path: string;
  readonly sha256: `sha256:${string}`;
  readonly redactionPolicy: BrowserEvidence["redaction_policy"];
  readonly quarantined: boolean;
  readonly indexed: boolean;
  readonly indexPath: string;
  readonly removedPaths: readonly string[];
}

export interface WriteEvidenceOptions {
  readonly homeDir?: string;
  /**
   * Caller-supplied run identifier; recorded in the artifact index so APR
   * handoff can correlate evidence with the run that produced it.
   */
  readonly runId?: string;
  /**
   * When true, allow `redaction_policy: "unsafe_debug"` to write to the
   * quarantine directory. Defaults to true; if false, unsafe payloads
   * throw rather than landing on disk.
   */
  readonly allowQuarantine?: boolean;
}

/**
 * Write a browser-evidence ledger to disk under the session's evidence
 * directory. Default behavior:
 *
 *   * `redacted` (or implicit) → run through `redactEvidencePayload`,
 *     hash the canonical JSON, write to `<evidence_id>.json`, upsert into
 *     `index.json` as an `artifact_index.v1` entry.
 *   * `off` → same path as `redacted` but skip the recursive redaction
 *     walk. The schema still enforces the typed-core shape, so raw
 *     fields cannot sneak in via the typed surface; only extension keys
 *     are preserved verbatim.
 *   * `unsafe_debug` → quarantine path; never appears in the normal
 *     index. The quarantine has its own separate index.json for audits.
 */
export async function writeEvidence(
  sessionId: string,
  rawEvidence: unknown,
  options: WriteEvidenceOptions = {},
): Promise<WrittenEvidence> {
  const homeDir = options.homeDir ?? getOracleHomeDir();
  const evidence = browserEvidenceSchema.parse(rawEvidence);
  const policy = evidence.redaction_policy;
  const isUnsafe = policy === "unsafe_debug";
  const allowQuarantine = options.allowQuarantine ?? true;
  if (isUnsafe && !allowQuarantine) {
    throw new Error(
      `Refusing to write unsafe_debug evidence (${evidence.evidence_id}); allowQuarantine is disabled.`,
    );
  }

  // Strict redaction is the default; only `off` writes the parsed object
  // unmodified. unsafe_debug deliberately preserves the raw bytes so the
  // quarantine can be audited, but is excluded from the normal index.
  const redaction =
    policy === "redacted" || policy === "unsafe_debug"
      ? redactEvidencePayload(evidence)
      : { redacted: evidence, removedPaths: [] as string[] };
  const bytes = canonicalJSON(redaction.redacted);
  const sha = sha256OfBytes(bytes);

  const filePath = isUnsafe
    ? quarantineFilePath(sessionId, evidence.evidence_id, homeDir)
    : evidenceFilePath(sessionId, evidence.evidence_id, homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${bytes}\n`, "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  }

  // Pick the index that matches the file location. The normal index is
  // never polluted with quarantined entries — that is the v18 promise.
  const indexFile = isUnsafe
    ? quarantineIndexPath(sessionId, homeDir)
    : evidenceIndexPath(sessionId, homeDir);
  const entry: ArtifactIndexEntry = {
    artifact_id: evidence.evidence_id,
    kind: EVIDENCE_KIND,
    path: path.relative(path.dirname(indexFile), filePath) || path.basename(filePath),
    sha256: sha,
  };
  await serializeArtifactIndexUpdate(indexFile, (current) => {
    const updated = upsertEntry(current ?? emptyIndex(options.runId), entry);
    if (options.runId && !updated.run_id) {
      return { ...updated, run_id: options.runId };
    }
    return updated;
  });

  return {
    evidenceId: evidence.evidence_id,
    path: filePath,
    sha256: sha,
    redactionPolicy: policy,
    quarantined: isUnsafe,
    indexed: !isUnsafe,
    indexPath: indexFile,
    removedPaths: redaction.removedPaths,
  };
}

/**
 * Return all entries from the normal (non-quarantined) evidence index.
 * Quarantined entries are never returned here — callers that need to
 * audit unsafe payloads must explicitly read the quarantine index.
 */
export async function listIndexedEvidence(
  sessionId: string,
  homeDir = getOracleHomeDir(),
): Promise<readonly ArtifactIndexEntry[]> {
  const indexFile = evidenceIndexPath(sessionId, homeDir);
  const index = await readArtifactIndex(indexFile);
  return index?.artifacts ?? [];
}

/** Returns quarantine entries; intentionally separate. */
export async function listQuarantinedEvidence(
  sessionId: string,
  homeDir = getOracleHomeDir(),
): Promise<readonly ArtifactIndexEntry[]> {
  const indexFile = quarantineIndexPath(sessionId, homeDir);
  const index = await readArtifactIndex(indexFile);
  return index?.artifacts ?? [];
}

// Constants exported for tests + callers that want to inspect the
// forbidden-key policy from outside.
export const FORBIDDEN_KEY_TEST = (key: string): boolean => isForbiddenKey(key);
export const EVIDENCE_LAYOUT = Object.freeze({
  SESSIONS_DIRNAME,
  EVIDENCE_DIRNAME,
  QUARANTINE_DIRNAME,
  INDEX_FILENAME,
  EVIDENCE_KIND,
});
