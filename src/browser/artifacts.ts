import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";
import type { SessionArtifact } from "../sessionStore.js";
import { isDeepResearchIncompleteText } from "./deepResearchResult.js";
import type { BrowserLogger } from "./types.js";

const ARTIFACTS_DIRNAME = "artifacts";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_EMPTY_ARCHIVE_LENGTH = 22;
const ZIP_MAX_EOCD_COMMENT_BYTES = 65_535;
type ArtifactValidation = NonNullable<SessionArtifact["validation"]>;

function sanitizePathSegment(value: string, fallback: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

export function sanitizeArtifactFilename(value: string, fallback = "artifact.bin"): string {
  const normalized = String(value ?? "")
    .replace(/\0/g, "")
    .replace(/\\/g, "/");
  const basename = path.basename(normalized).replace(/\.crdownload$/i, "");
  const fallbackName = path.basename(fallback.replace(/\\/g, "/")) || "artifact.bin";
  const sanitized = sanitizePathSegment(
    basename,
    sanitizePathSegment(fallbackName, "artifact.bin"),
  );
  return sanitized === "." || sanitized === ".."
    ? sanitizePathSegment(fallbackName, "artifact.bin")
    : sanitized;
}

export function sanitizeArtifactMimeType(value?: string): string | undefined {
  const mime = String(value ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    !mime ||
    mime.length > 127 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)
  ) {
    return undefined;
  }
  return mime;
}

function normalizeSessionId(sessionId: string): string {
  return sanitizePathSegment(path.basename(sessionId), "session");
}

export function resolveSessionArtifactsDir(sessionId: string): string {
  return path.join(
    getOracleHomeDir(),
    "sessions",
    normalizeSessionId(sessionId),
    ARTIFACTS_DIRNAME,
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveUniqueArtifactPath(basePath: string): Promise<string> {
  const ext = path.extname(basePath);
  const stem = ext ? path.basename(basePath, ext) : path.basename(basePath);
  const dir = path.dirname(basePath);
  let candidate = basePath;
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(dir, `${stem}-${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

async function readSizeBytes(targetPath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(targetPath)).size;
  } catch {
    return undefined;
  }
}

export function computeBufferSha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function computeFileSha256(targetPath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(targetPath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export function isZipArtifact(filename?: string, mimeType?: string): boolean {
  const ext = path.extname(String(filename ?? "")).toLowerCase();
  const mime = String(mimeType ?? "").toLowerCase();
  return (
    ext === ".zip" ||
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime.endsWith("+zip")
  );
}

export function validateZipBuffer(contents: Buffer): ArtifactValidation {
  if (contents.length < ZIP_EMPTY_ARCHIVE_LENGTH) {
    return { type: "zip", ok: false, error: "zip-too-small" };
  }

  const firstSignature = contents.readUInt32LE(0);
  if (firstSignature !== ZIP_LOCAL_FILE_HEADER_SIGNATURE && firstSignature !== ZIP_EOCD_SIGNATURE) {
    return { type: "zip", ok: false, error: "zip-magic-mismatch" };
  }

  const searchStart = Math.max(
    0,
    contents.length - ZIP_EMPTY_ARCHIVE_LENGTH - ZIP_MAX_EOCD_COMMENT_BYTES,
  );
  let eocdOffset = -1;
  for (
    let offset = contents.length - ZIP_EMPTY_ARCHIVE_LENGTH;
    offset >= searchStart;
    offset -= 1
  ) {
    if (contents.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    return { type: "zip", ok: false, error: "zip-central-directory-missing" };
  }

  const commentLength = contents.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + ZIP_EMPTY_ARCHIVE_LENGTH + commentLength !== contents.length) {
    return { type: "zip", ok: false, error: "zip-eocd-size-mismatch" };
  }

  const centralDirectorySize = contents.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = contents.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    return { type: "zip", ok: false, error: "zip-central-directory-out-of-range" };
  }

  return { type: "zip", ok: true };
}

export async function validateZipFile(targetPath: string): Promise<ArtifactValidation> {
  const contents = await fs.readFile(targetPath);
  return validateZipBuffer(contents);
}

export function validateArtifactBuffer(params: {
  filename?: string;
  mimeType?: string;
  contents: Buffer;
}): ArtifactValidation {
  if (isZipArtifact(params.filename, params.mimeType)) {
    return validateZipBuffer(params.contents);
  }
  return {
    type: "generic",
    ok: params.contents.length > 0,
    error: params.contents.length > 0 ? undefined : "empty-file",
  };
}

export async function validateArtifactFile(params: {
  filename?: string;
  mimeType?: string;
  path: string;
}): Promise<ArtifactValidation> {
  if (isZipArtifact(params.filename ?? path.basename(params.path), params.mimeType)) {
    return validateZipFile(params.path);
  }
  const size = await readSizeBytes(params.path);
  return {
    type: "generic",
    ok: Boolean(size && size > 0),
    error: size && size > 0 ? undefined : "empty-file",
  };
}

export async function writeTextBrowserArtifact(params: {
  sessionId?: string;
  kind: SessionArtifact["kind"];
  filename: string;
  contents: string;
  label?: string;
  mimeType?: string;
  sourceUrl?: string;
  logger?: BrowserLogger;
}): Promise<SessionArtifact | null> {
  const text = params.contents.trim();
  if (!params.sessionId || text.length === 0) {
    return null;
  }
  const dir = resolveSessionArtifactsDir(params.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const filename = sanitizeArtifactFilename(params.filename, "artifact.md");
  const targetPath = await resolveUniqueArtifactPath(path.join(dir, filename));
  await fs.writeFile(targetPath, `${text}\n`, "utf8");
  params.logger?.(`[browser] Saved ${params.kind} artifact to ${targetPath}`);
  return {
    kind: params.kind,
    path: targetPath,
    label: params.label,
    mimeType: params.mimeType ?? "text/markdown",
    sizeBytes: await readSizeBytes(targetPath),
    sourceUrl: params.sourceUrl,
    sha256: computeBufferSha256(Buffer.from(`${text}\n`, "utf8")),
    validation: { type: "generic", ok: true },
    transfer: { status: "not-needed" },
    origin: { mode: "local" },
  };
}

export async function writeBinaryBrowserArtifact(params: {
  sessionId?: string;
  kind: SessionArtifact["kind"];
  filename: string;
  contents: Buffer;
  label?: string;
  mimeType?: string;
  sourceUrl?: string;
  logger?: BrowserLogger;
}): Promise<SessionArtifact | null> {
  if (!params.sessionId || params.contents.length === 0) {
    return null;
  }
  const dir = resolveSessionArtifactsDir(params.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const filename = sanitizeArtifactFilename(params.filename, "artifact.bin");
  const targetPath = await resolveUniqueArtifactPath(path.join(dir, filename));
  await fs.writeFile(targetPath, params.contents);
  const validation = validateArtifactBuffer({
    filename,
    mimeType: params.mimeType,
    contents: params.contents,
  });
  params.logger?.(`[browser] Saved ${params.kind} artifact to ${targetPath}`);
  if (validation.type === "zip" && !validation.ok) {
    params.logger?.(
      `[browser] ZIP validation failed for ${filename}: ${validation.error ?? "invalid"}`,
    );
  }
  return {
    kind: params.kind,
    path: targetPath,
    label: params.label,
    mimeType: params.mimeType,
    sizeBytes: params.contents.length,
    sourceUrl: params.sourceUrl,
    sha256: computeBufferSha256(params.contents),
    validation,
    transfer: { status: "not-needed" },
    origin: { mode: "local" },
  };
}

export async function saveDeepResearchReportArtifact(params: {
  sessionId?: string;
  reportMarkdown: string;
  conversationUrl?: string;
  logger?: BrowserLogger;
}): Promise<SessionArtifact | null> {
  const report = params.reportMarkdown.trim();
  if (report.length < 40 || isDeepResearchIncompleteText(report)) {
    return null;
  }
  return writeTextBrowserArtifact({
    sessionId: params.sessionId,
    kind: "deep-research-report",
    filename: "deep-research-report.md",
    contents: report,
    label: "Deep Research report",
    mimeType: "text/markdown",
    sourceUrl: params.conversationUrl,
    logger: params.logger,
  });
}

export async function saveBrowserTranscriptArtifact(params: {
  sessionId?: string;
  prompt: string;
  answerMarkdown: string;
  conversationUrl?: string;
  artifacts?: SessionArtifact[];
  logger?: BrowserLogger;
}): Promise<SessionArtifact | null> {
  const answer = params.answerMarkdown.trim();
  if (!answer) {
    return null;
  }
  const artifactLines =
    params.artifacts && params.artifacts.length > 0
      ? [
          "",
          "## Artifacts",
          "",
          ...params.artifacts.map((artifact) => {
            const label = artifact.label ?? artifact.kind;
            const hash = artifact.sha256 ? ` sha256=${artifact.sha256}` : "";
            const transfer = artifact.transfer?.status
              ? ` transfer=${artifact.transfer.status}`
              : "";
            const validation = artifact.validation
              ? ` validation=${artifact.validation.ok ? "ok" : (artifact.validation.error ?? "failed")}`
              : "";
            return `- ${label}: ${artifact.path}${hash}${transfer}${validation}`;
          }),
        ]
      : [];
  const conversationLines = params.conversationUrl
    ? ["", `Conversation: ${params.conversationUrl}`, ""]
    : ["", ""];
  const body = [
    "# Oracle Browser Transcript",
    ...conversationLines,
    "## Prompt",
    "",
    params.prompt.trim(),
    "",
    "## Answer",
    "",
    answer,
    ...artifactLines,
  ].join("\n");
  return writeTextBrowserArtifact({
    sessionId: params.sessionId,
    kind: "transcript",
    filename: "transcript.md",
    contents: body,
    label: "Browser transcript",
    mimeType: "text/markdown",
    sourceUrl: params.conversationUrl,
    logger: params.logger,
  });
}

export function appendArtifacts(
  existing: SessionArtifact[] | undefined,
  additions: Array<SessionArtifact | null | undefined>,
): SessionArtifact[] | undefined {
  const merged = new Map<string, SessionArtifact>();
  for (const artifact of existing ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  for (const artifact of additions) {
    if (artifact) {
      merged.set(`${artifact.kind}:${artifact.path}`, artifact);
    }
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

export const __test__ = {
  normalizeSessionId,
  sanitizeArtifactFilename,
  sanitizePathSegment,
};
