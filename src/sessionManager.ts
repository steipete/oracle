import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import type { TransportFailureReason } from './oracle.js';

export type SessionMode = 'api' | 'browser';

export interface BrowserSessionConfig {
  chromeProfile?: string | null;
  chromePath?: string | null;
  url?: string;
  timeoutMs?: number;
  inputTimeoutMs?: number;
  cookieSync?: boolean;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  desiredModel?: string | null;
  debug?: boolean;
  allowCookieErrors?: boolean;
}

export interface BrowserRuntimeMetadata {
  chromePid?: number;
  chromePort?: number;
  userDataDir?: string;
}

export interface BrowserMetadata {
  config?: BrowserSessionConfig;
  runtime?: BrowserRuntimeMetadata;
}

export interface SessionResponseMetadata {
  id?: string;
  requestId?: string | null;
  status?: string;
  incompleteReason?: string | null;
}

export interface SessionTransportMetadata {
  reason?: TransportFailureReason;
}

export interface SessionUserErrorMetadata {
  category?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface StoredRunOptions {
  prompt?: string;
  file?: string[];
  model?: string;
  maxInput?: number;
  system?: string;
  maxOutput?: number;
  silent?: boolean;
  filesReport?: boolean;
  slug?: string;
  mode?: SessionMode;
  browserConfig?: BrowserSessionConfig;
  verbose?: boolean;
  heartbeatIntervalMs?: number;
  browserInlineFiles?: boolean;
  browserBundleFiles?: boolean;
  background?: boolean;
  search?: boolean;
  baseUrl?: string;
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  status: string;
  promptPreview?: string;
  model?: string;
  cwd?: string;
  options: StoredRunOptions;
  notifications?: SessionNotifications;
  startedAt?: string;
  completedAt?: string;
  mode?: SessionMode;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cost?: number;
  };
  errorMessage?: string;
  elapsedMs?: number;
  browser?: BrowserMetadata;
  response?: SessionResponseMetadata;
  transport?: SessionTransportMetadata;
  error?: SessionUserErrorMetadata;
}

export interface SessionNotifications {
  enabled: boolean;
  sound: boolean;
}

interface SessionLogWriter {
  stream: WriteStream;
  logLine: (line?: string) => void;
  writeChunk: (chunk: string) => boolean;
  logPath: string;
}

interface InitializeSessionOptions extends StoredRunOptions {
  prompt?: string;
  model: string;
}

const ORACLE_HOME = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), '.oracle');
const SESSIONS_DIR = path.join(ORACLE_HOME, 'sessions');
const MAX_STATUS_LIMIT = 1000;
const ZOMBIE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_SLUG = 'session';
const MAX_SLUG_WORDS = 5;
const MIN_CUSTOM_SLUG_WORDS = 3;

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureSessionStorage(): Promise<void> {
  await ensureDir(SESSIONS_DIR);
}

function slugify(text: string | undefined, maxWords = MAX_SLUG_WORDS): string {
  const normalized = text?.toLowerCase() ?? '';
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  const trimmed = words.slice(0, maxWords);
  return trimmed.length > 0 ? trimmed.join('-') : DEFAULT_SLUG;
}

function countSlugWords(slug: string): number {
  return slug.split('-').filter(Boolean).length;
}

function normalizeCustomSlug(candidate: string): string {
  const slug = slugify(candidate, MAX_SLUG_WORDS);
  const wordCount = countSlugWords(slug);
  if (wordCount < MIN_CUSTOM_SLUG_WORDS || wordCount > MAX_SLUG_WORDS) {
    throw new Error(`Custom slug must include between ${MIN_CUSTOM_SLUG_WORDS} and ${MAX_SLUG_WORDS} words.`);
  }
  return slug;
}

export function createSessionId(prompt: string, customSlug?: string): string {
  if (customSlug) {
    return normalizeCustomSlug(customSlug);
  }
  return slugify(prompt);
}

function sessionDir(id: string): string {
  return path.join(SESSIONS_DIR, id);
}

function metaPath(id: string): string {
  return path.join(sessionDir(id), 'session.json');
}

function logPath(id: string): string {
  return path.join(sessionDir(id), 'output.log');
}

function requestPath(id: string): string {
  return path.join(sessionDir(id), 'request.json');
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureUniqueSessionId(baseSlug: string): Promise<string> {
  let candidate = baseSlug;
  let suffix = 2;
  while (await fileExists(sessionDir(candidate))) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function initializeSession(
  options: InitializeSessionOptions,
  cwd: string,
  notifications?: SessionNotifications,
): Promise<SessionMetadata> {
  await ensureSessionStorage();
  const baseSlug = createSessionId(options.prompt || DEFAULT_SLUG, options.slug);
  const sessionId = await ensureUniqueSessionId(baseSlug);
  const dir = sessionDir(sessionId);
  await ensureDir(dir);
  const mode = options.mode ?? 'api';
  const browserConfig = options.browserConfig;
  const metadata: SessionMetadata = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    promptPreview: (options.prompt || '').slice(0, 160),
    model: options.model,
    cwd,
    mode,
    browser: browserConfig ? { config: browserConfig } : undefined,
    notifications,
    options: {
      prompt: options.prompt,
      file: options.file ?? [],
      model: options.model,
      maxInput: options.maxInput,
      system: options.system,
      maxOutput: options.maxOutput,
      silent: options.silent,
      filesReport: options.filesReport,
      slug: sessionId,
      mode,
      browserConfig,
      verbose: options.verbose,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      browserInlineFiles: options.browserInlineFiles,
      browserBundleFiles: options.browserBundleFiles,
      background: options.background,
      search: options.search,
      baseUrl: options.baseUrl,
    },
  };
  await fs.writeFile(metaPath(sessionId), JSON.stringify(metadata, null, 2), 'utf8');
  await fs.writeFile(requestPath(sessionId), JSON.stringify(metadata.options, null, 2), 'utf8');
  await fs.writeFile(logPath(sessionId), '', 'utf8');
  return metadata;
}

export async function readSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  try {
    const raw = await fs.readFile(metaPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as SessionMetadata;
    return await markZombie(parsed, { persist: false }); // transient check; do not touch disk on single read
  } catch {
    return null;
  }
}

export async function updateSessionMetadata(
  sessionId: string,
  updates: Partial<SessionMetadata>,
): Promise<SessionMetadata> {
  const existing = (await readSessionMetadata(sessionId)) ?? ({ id: sessionId } as SessionMetadata);
  const next = { ...existing, ...updates };
  await fs.writeFile(metaPath(sessionId), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function createSessionLogWriter(sessionId: string): SessionLogWriter {
  const stream = createWriteStream(logPath(sessionId), { flags: 'a' });
  const logLine = (line = ''): void => {
    stream.write(`${line}\n`);
  };
  const writeChunk = (chunk: string): boolean => {
    stream.write(chunk);
    return true;
  };
  return { stream, logLine, writeChunk, logPath: logPath(sessionId) };
}

export async function listSessionsMetadata(): Promise<SessionMetadata[]> {
  await ensureSessionStorage();
  const entries = await fs.readdir(SESSIONS_DIR).catch(() => []);
  const metas: SessionMetadata[] = [];
  for (const entry of entries) {
    let meta = await readSessionMetadata(entry);
    if (meta) {
      meta = await markZombie(meta, { persist: true }); // keep stored metadata consistent with zombie detection
      metas.push(meta);
    }
  }
  return metas.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function filterSessionsByRange(
  metas: SessionMetadata[],
  { hours = 24, includeAll = false, limit = 100 }: { hours?: number; includeAll?: boolean; limit?: number },
): { entries: SessionMetadata[]; truncated: boolean; total: number } {
  const maxLimit = Math.min(limit, MAX_STATUS_LIMIT);
  let filtered = metas;
  if (!includeAll) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    filtered = metas.filter((meta) => new Date(meta.createdAt).getTime() >= cutoff);
  }
  const limited = filtered.slice(0, maxLimit);
  const truncated = filtered.length > maxLimit;
  return { entries: limited, truncated, total: filtered.length };
}

export async function readSessionLog(sessionId: string): Promise<string> {
  try {
    return await fs.readFile(logPath(sessionId), 'utf8');
  } catch {
    return '';
  }
}

export async function readSessionRequest(sessionId: string): Promise<StoredRunOptions | null> {
  try {
    const raw = await fs.readFile(requestPath(sessionId), 'utf8');
    return JSON.parse(raw) as StoredRunOptions;
  } catch {
    return null;
  }
}

export async function deleteSessionsOlderThan({
  hours = 24,
  includeAll = false,
}: { hours?: number; includeAll?: boolean } = {}): Promise<{ deleted: number; remaining: number }> {
  await ensureSessionStorage();
  const entries = await fs.readdir(SESSIONS_DIR).catch(() => []);
  if (!entries.length) {
    return { deleted: 0, remaining: 0 };
  }
  const cutoff = includeAll ? Number.NEGATIVE_INFINITY : Date.now() - hours * 60 * 60 * 1000;
  let deleted = 0;

  for (const entry of entries) {
    const dir = sessionDir(entry);
    let createdMs: number | undefined;
    const meta = await readSessionMetadata(entry);
    if (meta?.createdAt) {
      const parsed = Date.parse(meta.createdAt);
      if (!Number.isNaN(parsed)) {
        createdMs = parsed;
      }
    }
    if (createdMs == null) {
      try {
        const stats = await fs.stat(dir);
        createdMs = stats.birthtimeMs || stats.mtimeMs;
      } catch {
        continue;
      }
    }
    if (includeAll || (createdMs != null && createdMs < cutoff)) {
      await fs.rm(dir, { recursive: true, force: true });
      deleted += 1;
    }
  }

  const remaining = Math.max(entries.length - deleted, 0);
  return { deleted, remaining };
}

export async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { ORACLE_HOME, SESSIONS_DIR, MAX_STATUS_LIMIT };
export { ZOMBIE_MAX_AGE_MS };

export async function getSessionPaths(sessionId: string): Promise<{
  dir: string;
  metadata: string;
  log: string;
  request: string;
}> {
  const dir = sessionDir(sessionId);
  const metadata = metaPath(sessionId);
  const log = logPath(sessionId);
  const request = requestPath(sessionId);

  const required = [metadata, log, request];
  const missing: string[] = [];
  for (const file of required) {
    if (!(await fileExists(file))) {
      missing.push(path.basename(file));
    }
  }

  if (missing.length > 0) {
    throw new Error(`Session "${sessionId}" is missing: ${missing.join(', ')}`);
  }

  return { dir, metadata, log, request };
}

async function markZombie(meta: SessionMetadata, { persist }: { persist: boolean }): Promise<SessionMetadata> {
  if (!isZombie(meta)) {
    return meta;
  }
  const updated: SessionMetadata = {
    ...meta,
    status: 'error',
    errorMessage: 'Session marked as zombie (>30m stale)',
    completedAt: new Date().toISOString(),
  };
  if (persist) {
    await fs.writeFile(metaPath(meta.id), JSON.stringify(updated, null, 2), 'utf8');
  }
  return updated;
}

function isZombie(meta: SessionMetadata): boolean {
  if (meta.status !== 'running') {
    return false;
  }
  const reference = meta.startedAt ?? meta.createdAt;
  if (!reference) {
    return false;
  }
  const startedMs = Date.parse(reference);
  if (Number.isNaN(startedMs)) {
    return false;
  }
  return Date.now() - startedMs > ZOMBIE_MAX_AGE_MS;
}
