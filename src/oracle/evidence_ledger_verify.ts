import fs from "node:fs/promises";
import path from "node:path";

import {
  evidenceDir,
  evidenceFilePath,
  evidenceIndexPath,
  readArtifactIndex,
  sha256OfBytes,
} from "./v18/evidence.js";
import type { ArtifactIndex, ArtifactIndexEntry } from "./v18/contracts.js";
import {
  summarizeEvidenceLedger,
  type EvidenceLedgerEntry,
  type EvidenceLedgerSummary,
} from "./evidence_ledger.js";

export const EVIDENCE_LEDGER_VERIFY_SCHEMA_VERSION = "evidence_ledger_verify.v1" as const;

export type EvidenceLedgerVerifyIssueCode =
  | "evidence_ledger_chain_invalid"
  | "evidence_id_missing"
  | "evidence_id_invalid"
  | "evidence_file_missing"
  | "evidence_file_json_invalid"
  | "evidence_file_id_mismatch"
  | "artifact_index_missing"
  | "artifact_index_entry_missing"
  | "artifact_index_path_escape"
  | "artifact_index_path_mismatch"
  | "evidence_file_hash_mismatch";

export interface EvidenceLedgerVerifyIssue {
  readonly code: EvidenceLedgerVerifyIssueCode;
  readonly field: string;
  readonly message: string;
  readonly sequence?: number;
  readonly evidence_id?: string;
  readonly path?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface EvidenceLedgerFileCheck {
  readonly sequence: number;
  readonly evidence_id: string;
  readonly path: string;
  readonly artifact_index_path: string | null;
  readonly file_sha256: `sha256:${string}` | null;
  readonly index_sha256: `sha256:${string}` | null;
  readonly ok: boolean;
}

export interface EvidenceLedgerVerifyResult {
  readonly schema_version: typeof EVIDENCE_LEDGER_VERIFY_SCHEMA_VERSION;
  readonly session_id: string;
  readonly ok: boolean;
  readonly chain_valid: boolean;
  readonly chain_failure: string | null;
  readonly entry_count: number;
  readonly evidence_written_count: number;
  readonly files_checked: number;
  readonly artifact_index_present: boolean;
  readonly ledger_tail_hash: `sha256:${string}`;
  readonly issues: readonly EvidenceLedgerVerifyIssue[];
  readonly file_checks: readonly EvidenceLedgerFileCheck[];
}

export interface VerifyEvidenceLedgerOptions {
  readonly homeDir?: string;
}

export async function verifyEvidenceLedger(
  sessionId: string,
  options: VerifyEvidenceLedgerOptions = {},
): Promise<EvidenceLedgerVerifyResult> {
  const summary = await summarizeEvidenceLedger(sessionId, {
    homeDir: options.homeDir,
    verifyChain: true,
  });
  const issues: EvidenceLedgerVerifyIssue[] = [];
  const checks: EvidenceLedgerFileCheck[] = [];
  const written = summary.events.filter((entry) => entry.event.type === "evidence_written");

  if (!summary.chain_valid) {
    issues.push({
      code: "evidence_ledger_chain_invalid",
      field: "evidence_ledger.chain",
      message: summary.chain_failure ?? "ledger chain verification failed",
    });
    return buildResult(sessionId, summary, written.length, false, issues, checks);
  }

  const indexPath = evidenceIndexPath(sessionId, options.homeDir);
  const index = written.length > 0 ? await readArtifactIndex(indexPath) : null;
  if (written.length > 0 && !index) {
    issues.push({
      code: "artifact_index_missing",
      field: "artifact_index",
      message: `evidence ledger references ${written.length} evidence file(s), but ${indexPath} is missing`,
      path: indexPath,
    });
  }

  const root = evidenceDir(sessionId, options.homeDir);
  for (const entry of written) {
    const check = await verifyEvidenceWrittenEntry({
      sessionId,
      homeDir: options.homeDir,
      evidenceRoot: root,
      index,
      entry,
      issues,
    });
    if (check) checks.push(check);
  }

  return buildResult(sessionId, summary, written.length, index !== null, issues, checks);
}

interface VerifyEvidenceWrittenEntryInput {
  readonly sessionId: string;
  readonly homeDir?: string;
  readonly evidenceRoot: string;
  readonly index: ArtifactIndex | null;
  readonly entry: EvidenceLedgerEntry;
  readonly issues: EvidenceLedgerVerifyIssue[];
}

async function verifyEvidenceWrittenEntry({
  sessionId,
  homeDir,
  evidenceRoot,
  index,
  entry,
  issues,
}: VerifyEvidenceWrittenEntryInput): Promise<EvidenceLedgerFileCheck | null> {
  const evidenceId = entry.event.evidence_id;
  if (!evidenceId) {
    issues.push({
      code: "evidence_id_missing",
      field: `evidence_ledger.events[${entry.sequence}].event.evidence_id`,
      message: "evidence_written ledger entries must include event.evidence_id",
      sequence: entry.sequence,
    });
    return null;
  }

  let expectedFilePath: string;
  try {
    expectedFilePath = evidenceFilePath(sessionId, evidenceId, homeDir);
  } catch (error) {
    issues.push({
      code: "evidence_id_invalid",
      field: `evidence_ledger.events[${entry.sequence}].event.evidence_id`,
      message: (error as Error).message,
      sequence: entry.sequence,
      evidence_id: evidenceId,
    });
    return null;
  }
  let raw: string;
  let fileSha: `sha256:${string}` | null = null;
  try {
    raw = await fs.readFile(expectedFilePath, "utf8");
    fileSha = sha256OfBytes(stripSingleJsonNewline(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push({
        code: "evidence_file_missing",
        field: `evidence.${evidenceId}.path`,
        message: `evidence_written references ${evidenceId}, but ${expectedFilePath} does not exist`,
        sequence: entry.sequence,
        evidence_id: evidenceId,
        path: expectedFilePath,
      });
      return makeFileCheck(entry.sequence, evidenceId, expectedFilePath, null, null, null, false);
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.evidence_id !== evidenceId) {
      issues.push({
        code: "evidence_file_id_mismatch",
        field: `evidence.${evidenceId}.evidence_id`,
        message: `evidence file evidence_id ${String(parsed.evidence_id)} does not match ledger id ${evidenceId}`,
        sequence: entry.sequence,
        evidence_id: evidenceId,
        path: expectedFilePath,
        expected: evidenceId,
        actual: String(parsed.evidence_id),
      });
    }
  } catch (error) {
    issues.push({
      code: "evidence_file_json_invalid",
      field: `evidence.${evidenceId}.json`,
      message: `evidence file is not valid JSON: ${(error as Error).message}`,
      sequence: entry.sequence,
      evidence_id: evidenceId,
      path: expectedFilePath,
    });
  }

  const indexEntry = index?.artifacts.find((artifact) => artifact.artifact_id === evidenceId);
  if (!indexEntry) {
    issues.push({
      code: "artifact_index_entry_missing",
      field: `artifact_index.artifacts[artifact_id=${evidenceId}]`,
      message: `artifact_index.v1 has no entry for evidence_id ${evidenceId}`,
      sequence: entry.sequence,
      evidence_id: evidenceId,
    });
    return makeFileCheck(entry.sequence, evidenceId, expectedFilePath, null, fileSha, null, false);
  }

  const resolvedIndexPath = resolveIndexEntryPath(evidenceRoot, indexEntry);
  if (!resolvedIndexPath.insideRoot) {
    issues.push({
      code: "artifact_index_path_escape",
      field: `artifact_index.${indexEntry.path}.path`,
      message: `artifact index path escapes the evidence directory: ${indexEntry.path}`,
      sequence: entry.sequence,
      evidence_id: evidenceId,
      path: indexEntry.path,
    });
  } else if (resolvedIndexPath.path !== path.resolve(expectedFilePath)) {
    issues.push({
      code: "artifact_index_path_mismatch",
      field: `artifact_index.${indexEntry.path}.path`,
      message: `artifact index path ${indexEntry.path} does not point at ${path.basename(expectedFilePath)}`,
      sequence: entry.sequence,
      evidence_id: evidenceId,
      path: indexEntry.path,
      expected: expectedFilePath,
      actual: resolvedIndexPath.path,
    });
  }

  if (fileSha !== indexEntry.sha256) {
    issues.push({
      code: "evidence_file_hash_mismatch",
      field: `artifact_index.${indexEntry.path}.sha256`,
      message: `evidence file hash ${fileSha} does not match artifact index hash ${indexEntry.sha256}`,
      sequence: entry.sequence,
      evidence_id: evidenceId,
      path: expectedFilePath,
      expected: indexEntry.sha256,
      actual: fileSha,
    });
  }

  const ok =
    fileSha === indexEntry.sha256 &&
    resolvedIndexPath.insideRoot &&
    resolvedIndexPath.path === path.resolve(expectedFilePath);
  return makeFileCheck(
    entry.sequence,
    evidenceId,
    expectedFilePath,
    indexEntry.path,
    fileSha,
    indexEntry.sha256,
    ok,
  );
}

function buildResult(
  sessionId: string,
  summary: EvidenceLedgerSummary,
  evidenceWrittenCount: number,
  artifactIndexPresent: boolean,
  issues: readonly EvidenceLedgerVerifyIssue[],
  checks: readonly EvidenceLedgerFileCheck[],
): EvidenceLedgerVerifyResult {
  return {
    schema_version: EVIDENCE_LEDGER_VERIFY_SCHEMA_VERSION,
    session_id: sessionId,
    ok: issues.length === 0,
    chain_valid: summary.chain_valid,
    chain_failure: summary.chain_failure,
    entry_count: summary.entry_count,
    evidence_written_count: evidenceWrittenCount,
    files_checked: checks.length,
    artifact_index_present: artifactIndexPresent,
    ledger_tail_hash: summary.tail_hash,
    issues,
    file_checks: checks,
  };
}

function makeFileCheck(
  sequence: number,
  evidenceId: string,
  filePath: string,
  artifactIndexPath: string | null,
  fileSha: `sha256:${string}` | null,
  indexSha: `sha256:${string}` | null,
  ok: boolean,
): EvidenceLedgerFileCheck {
  return {
    sequence,
    evidence_id: evidenceId,
    path: filePath,
    artifact_index_path: artifactIndexPath,
    file_sha256: fileSha,
    index_sha256: indexSha,
    ok,
  };
}

function stripSingleJsonNewline(raw: string): string {
  if (raw.endsWith("\r\n")) return raw.slice(0, -2);
  if (raw.endsWith("\n")) return raw.slice(0, -1);
  return raw;
}

function resolveIndexEntryPath(
  evidenceRoot: string,
  entry: ArtifactIndexEntry,
): { path: string; insideRoot: boolean } {
  const root = path.resolve(evidenceRoot);
  const resolved = path.resolve(root, entry.path);
  return {
    path: resolved,
    insideRoot: resolved === root || resolved.startsWith(`${root}${path.sep}`),
  };
}
