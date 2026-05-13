import fs from "node:fs/promises";
import path from "node:path";

import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  type ArtifactIndex,
  type ArtifactIndexEntry,
} from "../oracle/v18/contracts.js";
import {
  canonicalJSON,
  quarantineFilePath,
  quarantineIndexPath,
  readArtifactIndex,
  redactEvidencePayload,
  sha256OfBytes,
  writeArtifactIndex,
} from "../oracle/v18/evidence.js";
import { getOracleHomeDir } from "../oracleHome.js";

const INVALID_EVIDENCE_KIND = "invalid_browser_evidence";
const QUARANTINE_SCHEMA_VERSION = "evidence_quarantine.v1";

export interface QuarantineInvalidEvidenceArtifactOptions {
  readonly sessionId: string;
  readonly evidenceId?: string;
  readonly payload: unknown;
  readonly validationError: unknown;
  readonly homeDir?: string;
  readonly runId?: string;
  readonly now?: () => string;
}

export interface QuarantinedEvidenceArtifact {
  readonly artifactId: string;
  readonly path: string;
  readonly indexPath: string;
  readonly sha256: `sha256:${string}`;
  readonly removedPaths: readonly string[];
  readonly validationError: string;
}

function sanitizeEvidenceId(value: string | undefined): string {
  const sanitized = (value ?? "invalid-browser-evidence")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/[._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return sanitized || "invalid-browser-evidence";
}

function describeValidationError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown validation error");
}

function emptyQuarantineIndex(runId?: string): ArtifactIndex {
  return {
    schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
    artifacts: [],
    bundle_version: V18_BUNDLE_VERSION,
    ...(runId ? { run_id: runId } : {}),
  };
}

function upsertEntry(index: ArtifactIndex, entry: ArtifactIndexEntry): ArtifactIndex {
  const artifacts = index.artifacts.filter(
    (existing) =>
      !(entry.artifact_id && existing.artifact_id === entry.artifact_id) &&
      existing.path !== entry.path,
  );
  return { ...index, artifacts: [...artifacts, entry] };
}

export async function quarantineInvalidEvidenceArtifact(
  options: QuarantineInvalidEvidenceArtifactOptions,
): Promise<QuarantinedEvidenceArtifact> {
  const homeDir = options.homeDir ?? getOracleHomeDir();
  const baseId = sanitizeEvidenceId(options.evidenceId);
  const artifactId = `${baseId}.invalid`;
  const validationError = describeValidationError(options.validationError);
  const envelope = {
    schema_version: QUARANTINE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    artifact_id: artifactId,
    evidence_id: options.evidenceId ?? null,
    kind: INVALID_EVIDENCE_KIND,
    quarantined_at: options.now?.() ?? new Date().toISOString(),
    validation_error: validationError,
    payload: options.payload,
  };
  const redaction = redactEvidencePayload(envelope);
  const bytes = canonicalJSON(redaction.redacted);
  const sha256 = sha256OfBytes(bytes);
  const filePath = quarantineFilePath(options.sessionId, artifactId, homeDir);
  const indexPath = quarantineIndexPath(options.sessionId, homeDir);

  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${bytes}\n`, "utf8");
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  }

  const entry: ArtifactIndexEntry = {
    artifact_id: artifactId,
    kind: INVALID_EVIDENCE_KIND,
    path: path.relative(path.dirname(indexPath), filePath) || path.basename(filePath),
    sha256,
  };
  const existing = (await readArtifactIndex(indexPath)) ?? emptyQuarantineIndex(options.runId);
  const updated = upsertEntry(existing, entry);
  if (options.runId && !updated.run_id) {
    (updated as Record<string, unknown>).run_id = options.runId;
  }
  await writeArtifactIndex(indexPath, updated);

  return {
    artifactId,
    path: filePath,
    indexPath,
    sha256,
    removedPaths: redaction.removedPaths,
    validationError,
  };
}

export const __test__ = {
  INVALID_EVIDENCE_KIND,
  QUARANTINE_SCHEMA_VERSION,
  sanitizeEvidenceId,
};
