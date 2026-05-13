import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { getOracleHomeDir } from "../../../oracleHome.js";
import { registerEvidenceLedgerCommands } from "./ledger_register.js";
import {
  createEnvelope,
  createErrorEnvelope,
  type V18ErrorEntry,
} from "../../../oracle/v18/json_envelope.js";

const INDEX_FILENAMES = [
  "artifact-index.json",
  "artifact_index.json",
  path.join("artifacts", "artifact-index.json"),
  path.join("artifacts", "artifact_index.json"),
  path.join("artifacts", "evidence", "artifact-index.json"),
  path.join("artifacts", "evidence", "artifact_index.json"),
  path.join("evidence", "artifact-index.json"),
  path.join("evidence", "artifact_index.json"),
];

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SENSITIVE_DISPLAY_KEY_RE =
  /(^|_)(account|authorization|cookie|cookies|email|password|raw_dom|raw_prompt|raw_output|screenshot|secret|token)(_|$)|api[_-]?key|hidden[_-]?reasoning/i;

export interface EvidenceCommandOptions {
  json?: boolean;
  oracleHomeDir?: string;
  cwd?: string;
}

export interface EvidenceCommandIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface EvidenceArtifactEntry {
  artifact_id?: string;
  kind?: string;
  path?: string;
  sha256?: string;
  [key: string]: unknown;
}

export interface EvidenceArtifactIndex {
  schema_version?: string;
  artifacts?: EvidenceArtifactEntry[];
  [key: string]: unknown;
}

export interface EvidenceShowResult {
  session: string;
  indexPath: string;
  index: EvidenceArtifactIndex;
}

export interface EvidenceVerifyArtifactResult {
  artifactId?: string;
  kind?: string;
  path?: string;
  sha256?: string;
  ok: boolean;
}

export interface EvidenceVerifyError {
  code: string;
  message: string;
  artifactId?: string;
  path?: string;
}

export interface EvidenceVerifyResult {
  ok: boolean;
  session: string;
  indexPath: string;
  artifactCount: number;
  verified: EvidenceVerifyArtifactResult[];
  errors: EvidenceVerifyError[];
}

interface LoadedArtifact {
  entry: EvidenceArtifactEntry;
  absolutePath: string;
  parsed?: Record<string, unknown>;
}

interface LoadedEvidenceIndex {
  session: string;
  sessionDir: string;
  indexPath: string;
  artifactRoots: string[];
  index: EvidenceArtifactIndex;
}

export class EvidenceCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "EvidenceCommandError";
  }
}

export function registerEvidenceCommand(
  program: Command,
  deps: EvidenceCommandOptions = {},
): Command {
  const evidenceCommand = program
    .command("evidence")
    .description("Inspect and verify redacted Oracle evidence artifacts.");

  evidenceCommand
    .command("show <session>")
    .description("Print the evidence artifact index for a stored session.")
    .option("--json", "Print structured JSON.", false)
    .action(async (session: string, commandOptions: EvidenceCommandOptions) => {
      try {
        await runEvidenceShow(session, { ...deps, ...commandOptions });
      } catch (error) {
        printCommandError(error);
        process.exitCode = 1;
      }
    });

  evidenceCommand
    .command("verify <session>")
    .description("Verify indexed evidence artifact hashes and trust-critical fields.")
    .option("--json", "Print structured JSON.", false)
    .action(async (session: string, commandOptions: EvidenceCommandOptions) => {
      try {
        const result = await runEvidenceVerify(session, { ...deps, ...commandOptions });
        if (!result.ok) {
          process.exitCode = 1;
        }
      } catch (error) {
        printCommandError(error);
        process.exitCode = 1;
      }
    });

  registerEvidenceLedgerCommands(evidenceCommand, deps);

  return evidenceCommand;
}

export async function runEvidenceShow(
  session: string,
  options: EvidenceCommandOptions = {},
  io: EvidenceCommandIo = {},
): Promise<EvidenceShowResult> {
  const loaded = await loadEvidenceIndex(session, options);
  const result: EvidenceShowResult = {
    session: loaded.session,
    indexPath: loaded.indexPath,
    index: redactForDisplay(loaded.index) as EvidenceArtifactIndex,
  };
  if (options.json) {
    // robot_surface contract (oracle-eaz): every --json surface must
    // emit json_envelope.v1 so consumers can branch on `ok` and read
    // recovery fields without parsing prose.
    const envelope = createEnvelope({
      ok: true,
      data: result as unknown as Record<string, unknown>,
      meta: { tool: "oracle evidence show", session_id: result.session },
    });
    writeOutput(io, JSON.stringify(envelope, null, 2));
  } else {
    writeOutput(io, formatIndex(result));
  }
  return result;
}

export async function runEvidenceVerify(
  session: string,
  options: EvidenceCommandOptions = {},
  io: EvidenceCommandIo = {},
): Promise<EvidenceVerifyResult> {
  const loaded = await loadEvidenceIndex(session, options);
  const errors: EvidenceVerifyError[] = validateIndexShape(loaded.index);
  const verified: EvidenceVerifyArtifactResult[] = [];
  const loadedArtifacts: LoadedArtifact[] = [];

  for (const entry of loaded.index.artifacts ?? []) {
    const artifact = await verifyArtifactEntry(entry, loaded, errors);
    verified.push({
      artifactId: entry.artifact_id,
      kind: entry.kind,
      path: entry.path,
      sha256: entry.sha256,
      ok: artifact.ok,
    });
    if (artifact.loaded) {
      loadedArtifacts.push(artifact.loaded);
    }
  }

  validateEvidenceArtifacts(loadedArtifacts, errors);
  validateProviderResultLinks(loadedArtifacts, errors);

  const result: EvidenceVerifyResult = {
    ok: errors.length === 0,
    session: loaded.session,
    indexPath: loaded.indexPath,
    artifactCount: loaded.index.artifacts?.length ?? 0,
    verified,
    errors,
  };
  if (options.json) {
    writeOutput(io, JSON.stringify(buildVerifyEnvelope(result), null, 2));
  } else {
    writeOutput(io, formatVerifyResult(result));
  }
  return result;
}

function buildVerifyEnvelope(result: EvidenceVerifyResult): ReturnType<typeof createEnvelope> {
  // oracle-eaz: verify rolls up per-artifact failures under a single
  // v18 taxonomy code (`output_capture_unverified`) so robot callers
  // get a stable error_code; the granular per-artifact codes survive
  // inside details and the typed `data` payload so humans / regression
  // tests still see them.
  if (result.ok) {
    return createEnvelope({
      ok: true,
      data: result as unknown as Record<string, unknown>,
      meta: { tool: "oracle evidence verify", session_id: result.session },
      commands: {
        show: `oracle evidence show ${result.session} --json`,
      },
    });
  }
  const taxonomyEntry: V18ErrorEntry = {
    error_code: "output_capture_unverified",
    message:
      result.errors[0]?.message ?? "evidence verification failed (no detailed reason recorded)",
    details: {
      session_id: result.session,
      index_path: result.indexPath,
      first_issue: result.errors[0] ?? null,
      issue_count: result.errors.length,
      // Surface the raw issue codes so robots can branch on the
      // specific failure mode without trawling messages.
      issue_codes: result.errors.map((entry) => entry.code),
    },
  };
  return createErrorEnvelope({
    errors: [taxonomyEntry],
    meta: { tool: "oracle evidence verify", session_id: result.session },
    next_command: `oracle evidence verify ${result.session} --json`,
    fix_command: `oracle evidence show ${result.session} --json`,
    retry_safe: false,
    data: result as unknown as Record<string, unknown>,
  });
}

async function loadEvidenceIndex(
  session: string,
  options: EvidenceCommandOptions,
): Promise<LoadedEvidenceIndex> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = await resolveIndexPath(session, cwd, options.oracleHomeDir);
  const raw = await fs.readFile(resolved.indexPath, "utf8").catch((error) => {
    throw new EvidenceCommandError(
      `Evidence index not found for "${session}": ${(error as Error).message}`,
      "evidence_index_missing",
    );
  });
  const index = parseJson(raw, resolved.indexPath) as EvidenceArtifactIndex;
  return {
    session,
    sessionDir: resolved.sessionDir,
    indexPath: resolved.indexPath,
    artifactRoots: uniquePaths([path.dirname(resolved.indexPath), resolved.sessionDir]),
    index,
  };
}

async function resolveIndexPath(
  session: string,
  cwd: string,
  oracleHomeDir?: string,
): Promise<{ sessionDir: string; indexPath: string }> {
  const explicitPath = looksLikePath(session);
  if (explicitPath) {
    const resolved = path.resolve(cwd, session);
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat?.isFile()) {
      return { sessionDir: path.dirname(resolved), indexPath: resolved };
    }
    if (stat?.isDirectory()) {
      const indexPath = await findIndexInDir(resolved);
      return { sessionDir: resolved, indexPath };
    }
  }

  const sessionDir = path.join(oracleHomeDir ?? getOracleHomeDir(), "sessions", session);
  const indexPath = await findIndexInDir(sessionDir);
  return { sessionDir, indexPath };
}

async function findIndexInDir(sessionDir: string): Promise<string> {
  for (const filename of INDEX_FILENAMES) {
    const candidate = path.join(sessionDir, filename);
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  throw new EvidenceCommandError(
    `Evidence index not found under ${sessionDir}.`,
    "evidence_index_missing",
  );
}

async function verifyArtifactEntry(
  entry: EvidenceArtifactEntry,
  loaded: LoadedEvidenceIndex,
  errors: EvidenceVerifyError[],
): Promise<{ ok: boolean; loaded?: LoadedArtifact }> {
  const initialErrorCount = errors.length;
  if (!entry.path || typeof entry.path !== "string") {
    errors.push({
      code: "artifact_path_missing",
      message: "Artifact index entry is missing a string path.",
      artifactId: entry.artifact_id,
    });
    return { ok: false };
  }
  if (!entry.sha256 || typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
    errors.push({
      code: "artifact_hash_invalid",
      message: `Artifact ${entry.path} is missing a valid sha256:<hex> digest.`,
      artifactId: entry.artifact_id,
      path: entry.path,
    });
    return { ok: false };
  }

  const artifactPath = await resolveArtifactPath(entry.path, loaded);
  if (!artifactPath) {
    errors.push({
      code: "artifact_path_unsafe",
      message: `Artifact path escapes the evidence root: ${entry.path}`,
      artifactId: entry.artifact_id,
      path: entry.path,
    });
    return { ok: false };
  }

  const bytes = await fs.readFile(artifactPath).catch(() => null);
  if (!bytes) {
    errors.push({
      code: "artifact_missing",
      message: `Artifact file is missing: ${entry.path}`,
      artifactId: entry.artifact_id,
      path: entry.path,
    });
    return { ok: false };
  }

  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== entry.sha256) {
    errors.push({
      code: "artifact_hash_mismatch",
      message: `Artifact hash mismatch for ${entry.path}: expected ${entry.sha256}, got ${actual}.`,
      artifactId: entry.artifact_id,
      path: entry.path,
    });
  }

  let parsed: Record<string, unknown> | undefined;
  if (entry.path.endsWith(".json")) {
    parsed = parseJson(bytes.toString("utf8"), artifactPath) as Record<string, unknown>;
  }

  return {
    ok: errors.length === initialErrorCount,
    loaded: { entry, absolutePath: artifactPath, parsed },
  };
}

function validateIndexShape(index: EvidenceArtifactIndex): EvidenceVerifyError[] {
  const errors: EvidenceVerifyError[] = [];
  if (index.schema_version !== "artifact_index.v1") {
    errors.push({
      code: "index_schema_version_invalid",
      message: "Evidence index schema_version must be artifact_index.v1.",
    });
  }
  if (!Array.isArray(index.artifacts)) {
    errors.push({
      code: "index_artifacts_missing",
      message: "Evidence index must include an artifacts array.",
    });
  }
  return errors;
}

function validateEvidenceArtifacts(
  artifacts: LoadedArtifact[],
  errors: EvidenceVerifyError[],
): void {
  for (const artifact of artifacts) {
    if (artifact.entry.kind !== "browser_evidence" || !artifact.parsed) continue;
    const evidence = artifact.parsed;
    const artifactId = artifact.entry.artifact_id;
    requireString(evidence, "evidence_id", artifact, errors);
    requireString(evidence, "provider_slot", artifact, errors);
    requireString(evidence, "provider_result_id", artifact, errors);
    requireSha(evidence, "prompt_sha256", artifact, errors);
    requireSha(evidence, "output_text_sha256", artifact, errors);
    requireSha(evidence, "session_id_hash", artifact, errors);
    requireSha(evidence, "transition_log_sha256", artifact, errors);
    requireTrue(evidence, "mode_verified", artifact, errors);
    requireTrue(evidence, "verified_before_prompt_submit", artifact, errors);
    requireTrue(evidence, "reasoning_effort_verified", artifact, errors);
    requireTrue(evidence, "selected_effort_is_highest_visible", artifact, errors);
    requireTrue(evidence, "unsafe_artifacts_quarantined", artifact, errors);
    if (evidence.redaction_policy !== "redacted") {
      errors.push({
        code: "evidence_redaction_policy_invalid",
        message: "Browser evidence redaction_policy must be redacted.",
        artifactId,
        path: artifact.entry.path,
      });
    }
    if (artifactId && evidence.evidence_id !== artifactId) {
      errors.push({
        code: "evidence_id_mismatch",
        message: `Evidence id ${String(evidence.evidence_id)} does not match index artifact_id ${artifactId}.`,
        artifactId,
        path: artifact.entry.path,
      });
    }
  }
}

function validateProviderResultLinks(
  artifacts: LoadedArtifact[],
  errors: EvidenceVerifyError[],
): void {
  const evidenceById = new Map<string, Record<string, unknown>>();
  const evidenceByProviderResultId = new Map<string, Record<string, unknown>>();
  const resultById = new Map<string, Record<string, unknown>>();

  for (const artifact of artifacts) {
    if (!artifact.parsed) continue;
    if (artifact.entry.kind === "browser_evidence") {
      const evidenceId = stringField(artifact.parsed, "evidence_id");
      const resultId = stringField(artifact.parsed, "provider_result_id");
      if (evidenceId) evidenceById.set(evidenceId, artifact.parsed);
      if (resultId) evidenceByProviderResultId.set(resultId, artifact.parsed);
    }
    if (artifact.entry.kind === "provider_result") {
      const resultId = stringField(artifact.parsed, "provider_result_id");
      if (resultId) resultById.set(resultId, artifact.parsed);
      requireString(artifact.parsed, "provider_result_id", artifact, errors);
      requireString(artifact.parsed, "evidence_id", artifact, errors);
      requireString(artifact.parsed, "provider_slot", artifact, errors);
      requireSha(artifact.parsed, "result_text_sha256", artifact, errors);
      requireSha(artifact.parsed, "prompt_manifest_sha256", artifact, errors);
      requireSha(artifact.parsed, "source_baseline_sha256", artifact, errors);
    }
  }

  for (const [resultId, evidence] of evidenceByProviderResultId) {
    const result = resultById.get(resultId);
    if (!result) continue;
    const evidenceId = stringField(evidence, "evidence_id");
    const resultEvidenceId = stringField(result, "evidence_id");
    if (evidenceId && resultEvidenceId && evidenceId !== resultEvidenceId) {
      errors.push({
        code: "provider_result_evidence_id_mismatch",
        message: `Provider result ${resultId} links to evidence ${resultEvidenceId}, expected ${evidenceId}.`,
        artifactId: resultId,
      });
    }
    const evidenceSlot = stringField(evidence, "provider_slot");
    const resultSlot = stringField(result, "provider_slot");
    if (evidenceSlot && resultSlot && evidenceSlot !== resultSlot) {
      errors.push({
        code: "provider_result_slot_mismatch",
        message: `Provider result ${resultId} provider_slot ${resultSlot} does not match evidence slot ${evidenceSlot}.`,
        artifactId: resultId,
      });
    }
    const evidenceOutputHash = stringField(evidence, "output_text_sha256");
    const resultTextHash = stringField(result, "result_text_sha256");
    if (evidenceOutputHash && resultTextHash && evidenceOutputHash !== resultTextHash) {
      errors.push({
        code: "provider_result_output_hash_mismatch",
        message: `Provider result ${resultId} result_text_sha256 does not match evidence output_text_sha256.`,
        artifactId: resultId,
      });
    }
  }

  for (const [resultId, result] of resultById) {
    const evidenceId = stringField(result, "evidence_id");
    if (evidenceId && evidenceById.has(evidenceId)) continue;
    if (evidenceId && evidenceByProviderResultId.has(resultId)) continue;
    errors.push({
      code: "provider_result_evidence_missing",
      message: `Provider result ${resultId} references evidence ${evidenceId ?? "<missing>"} that is not present in the index.`,
      artifactId: resultId,
    });
  }
}

function requireString(
  object: Record<string, unknown>,
  field: string,
  artifact: LoadedArtifact,
  errors: EvidenceVerifyError[],
): void {
  if (typeof object[field] === "string" && object[field]) return;
  errors.push({
    code: "field_missing",
    message: `${artifact.entry.kind ?? "artifact"}.${field} must be a non-empty string.`,
    artifactId: artifact.entry.artifact_id,
    path: artifact.entry.path,
  });
}

function requireSha(
  object: Record<string, unknown>,
  field: string,
  artifact: LoadedArtifact,
  errors: EvidenceVerifyError[],
): void {
  if (typeof object[field] === "string" && SHA256_RE.test(object[field])) return;
  errors.push({
    code: "hash_field_invalid",
    message: `${artifact.entry.kind ?? "artifact"}.${field} must be a sha256:<hex> digest.`,
    artifactId: artifact.entry.artifact_id,
    path: artifact.entry.path,
  });
}

function requireTrue(
  object: Record<string, unknown>,
  field: string,
  artifact: LoadedArtifact,
  errors: EvidenceVerifyError[],
): void {
  if (object[field] === true) return;
  errors.push({
    code: "evidence_verification_field_false",
    message: `${artifact.entry.kind ?? "artifact"}.${field} must be true.`,
    artifactId: artifact.entry.artifact_id,
    path: artifact.entry.path,
  });
}

function stringField(object: Record<string, unknown>, field: string): string | undefined {
  return typeof object[field] === "string" ? object[field] : undefined;
}

async function resolveArtifactPath(
  entryPath: string,
  loaded: LoadedEvidenceIndex,
): Promise<string | null> {
  if (path.isAbsolute(entryPath)) return null;
  const normalized = path.normalize(entryPath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  const candidates: string[] = [];
  for (const root of loaded.artifactRoots) {
    const candidate = path.resolve(root, normalized);
    if (isWithin(root, candidate)) {
      candidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? null;
}

function formatIndex(result: EvidenceShowResult): string {
  const artifacts = result.index.artifacts ?? [];
  const lines = [`Evidence index: ${result.indexPath}`, `Artifacts: ${artifacts.length}`];
  for (const artifact of artifacts) {
    const id = artifact.artifact_id ? ` ${artifact.artifact_id}` : "";
    const kind = artifact.kind ?? "artifact";
    const artifactPath = artifact.path ?? "<missing-path>";
    const sha = artifact.sha256 ?? "<missing-sha256>";
    lines.push(`- ${kind}${id}: ${artifactPath} ${sha}`);
  }
  return lines.join("\n");
}

function formatVerifyResult(result: EvidenceVerifyResult): string {
  const lines = [
    `Evidence verify: ${result.ok ? "ok" : "failed"}`,
    `Index: ${result.indexPath}`,
    `Artifacts: ${result.artifactCount}`,
  ];
  for (const artifact of result.verified) {
    lines.push(
      `- ${artifact.ok ? "ok" : "fail"} ${artifact.kind ?? "artifact"} ${artifact.path ?? "<missing-path>"}`,
    );
  }
  for (const error of result.errors) {
    lines.push(`ERROR ${error.code}: ${error.message}`);
  }
  return lines.join("\n");
}

function redactForDisplay(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_DISPLAY_KEY_RE.test(key)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactForDisplay(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactForDisplay(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function parseJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new EvidenceCommandError(
      `Failed to parse evidence JSON at ${filePath}: ${(error as Error).message}`,
      "evidence_json_invalid",
    );
  }
}

async function isFile(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() === true;
}

function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.endsWith(".json") ||
    value === "." ||
    value === ".."
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((entry) => path.resolve(entry))));
}

function writeOutput(io: EvidenceCommandIo, text: string): void {
  const writer = io.stdout ?? ((message: string) => console.log(message));
  writer(text);
}

function printCommandError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
}
