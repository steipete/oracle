import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import net from 'node:net';
import type { BrowserModelStrategy, CookieParam } from './browser/types.js';
import type { TransportFailureReason, AzureOptions, ModelName, ThinkingTimeLevel } from './oracle.js';
import { DEFAULT_MODEL, formatElapsed } from './oracle.js';
import { safeModelSlug } from './oracle/modelResolver.js';
import { getOracleHomeDir } from './oracleHome.js';

export type SessionMode = 'api' | 'browser';

export interface BrowserSessionConfig {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  chatgptUrl?: string | null;
  url?: string;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  cookieSync?: boolean;
  cookieNames?: string[] | null;
  cookieSyncWaitMs?: number;
  inlineCookies?: CookieParam[] | null;
  inlineCookiesSource?: string | null;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  debug?: boolean;
  allowCookieErrors?: boolean;
  remoteChrome?: { host: string; port: number } | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  /** Thinking time intensity: 'light', 'standard', 'extended', 'heavy' */
  thinkingTime?: ThinkingTimeLevel;
}

export interface BrowserRuntimeMetadata {
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
  /** PID of the controller process that launched this browser run. Helps detect orphaned sessions. */
  controllerPid?: number;
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
  models?: ModelName[];
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
  browserAttachments?: 'auto' | 'never' | 'always';
  browserInlineFiles?: boolean;
  browserBundleFiles?: boolean;
  background?: boolean;
  search?: boolean;
  baseUrl?: string;
  azure?: AzureOptions;
  effectiveModelId?: string;
  renderPlain?: boolean;
  writeOutputPath?: string;
  timeoutSeconds?: number | 'auto';
  httpTimeoutMs?: number;
  zombieTimeoutMs?: number;
  zombieUseLastActivity?: boolean;
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  status: string;
  promptPreview?: string;
  model?: string;
  models?: SessionModelRun[];
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

export type SessionStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled';

export interface SessionModelRun {
  model: string;
  status: SessionStatus;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cost?: number;
  };
  response?: SessionResponseMetadata;
  transport?: SessionTransportMetadata;
  error?: SessionUserErrorMetadata;
  log?: {
    path: string;
    bytes?: number;
  };
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

export function getSessionsDir(): string {
  return path.join(getOracleHomeDir(), 'sessions');
}
const METADATA_FILENAME = 'meta.json';
const LEGACY_SESSION_FILENAME = 'session.json';
const LEGACY_REQUEST_FILENAME = 'request.json';
const MODELS_DIRNAME = 'models';
const MODEL_JSON_EXTENSION = '.json';
const MODEL_LOG_EXTENSION = '.log';
const MAX_STATUS_LIMIT = 1000;
const ZOMBIE_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes
const CHROME_RUNTIME_TIMEOUT_MS = 250;
const DEFAULT_SLUG = 'session';
const MAX_SLUG_WORDS = 5;
const MIN_CUSTOM_SLUG_WORDS = 3;
const MAX_SLUG_WORD_LENGTH = 10;

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureSessionStorage(): Promise<void> {
  await ensureDir(getSessionsDir());
}

function slugify(text: string | undefined, maxWords = MAX_SLUG_WORDS): string {
  const normalized = text?.toLowerCase() ?? '';
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  const trimmed = words
    .slice(0, maxWords)
    .map((word) => word.slice(0, MAX_SLUG_WORD_LENGTH));
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
  return path.join(getSessionsDir(), id);
}

function metaPath(id: string): string {
  return path.join(sessionDir(id), METADATA_FILENAME);
}

function requestPath(id: string): string {
  return path.join(sessionDir(id), LEGACY_REQUEST_FILENAME);
}

function legacySessionPath(id: string): string {
  return path.join(sessionDir(id), LEGACY_SESSION_FILENAME);
}

function logPath(id: string): string {
  return path.join(sessionDir(id), 'output.log');
}

function modelsDir(id: string): string {
  return path.join(sessionDir(id), MODELS_DIRNAME);
}

function modelJsonPath(id: string, model: string): string {
  const slug = safeModelSlug(model);
  return path.join(modelsDir(id), `${slug}${MODEL_JSON_EXTENSION}`);
}

function modelLogPath(id: string, model: string): string {
  const slug = safeModelSlug(model);
  return path.join(modelsDir(id), `${slug}${MODEL_LOG_EXTENSION}`);
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

async function listModelRunFiles(sessionId: string): Promise<SessionModelRun[]> {
  const dir = modelsDir(sessionId);
  const entries = await fs.readdir(dir).catch(() => []);
  const result: SessionModelRun[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(MODEL_JSON_EXTENSION)) {
      continue;
    }
    const jsonPath = path.join(dir, entry);
    try {
      const raw = await fs.readFile(jsonPath, 'utf8');
      const parsed = JSON.parse(raw) as SessionModelRun;
      const normalized = ensureModelLogReference(sessionId, parsed);
      result.push(normalized);
    } catch {
      // ignore malformed model files
    }
  }
  return result;
}

function ensureModelLogReference(sessionId: string, record: SessionModelRun): SessionModelRun {
  const logPathRelative =
    record.log?.path ?? path.relative(sessionDir(sessionId), modelLogPath(sessionId, record.model));
  return {
    ...record,
    log: { path: logPathRelative, bytes: record.log?.bytes },
  };
}

async function readModelRunFile(sessionId: string, model: string): Promise<SessionModelRun | null> {
  try {
    const raw = await fs.readFile(modelJsonPath(sessionId, model), 'utf8');
    const parsed = JSON.parse(raw) as SessionModelRun;
    return ensureModelLogReference(sessionId, parsed);
  } catch {
    return null;
  }
}

export async function updateModelRunMetadata(
  sessionId: string,
  model: string,
  updates: Partial<SessionModelRun>,
): Promise<SessionModelRun> {
  await ensureDir(modelsDir(sessionId));
  const existing = (await readModelRunFile(sessionId, model)) ?? {
    model,
    status: 'pending',
  };
  const next: SessionModelRun = ensureModelLogReference(sessionId, {
    ...existing,
    ...updates,
    model,
  });
  await fs.writeFile(modelJsonPath(sessionId, model), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export async function readModelRunMetadata(sessionId: string, model: string): Promise<SessionModelRun | null> {
  return readModelRunFile(sessionId, model);
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
  const modelList: ModelName[] =
    Array.isArray(options.models) && options.models.length > 0
      ? options.models
      : options.model
        ? [options.model as ModelName]
        : [];

  const metadata: SessionMetadata = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    promptPreview: (options.prompt || '').slice(0, 160),
    model: modelList[0] ?? options.model,
    models: modelList.map((modelName) => ({
      model: modelName,
      status: 'pending',
    })),
    cwd,
    mode,
    browser: browserConfig ? { config: browserConfig } : undefined,
    notifications,
    options: {
      prompt: options.prompt,
      file: options.file ?? [],
      model: options.model,
      models: modelList,
      effectiveModelId: options.effectiveModelId,
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
      browserAttachments: options.browserAttachments,
      browserInlineFiles: options.browserInlineFiles,
      browserBundleFiles: options.browserBundleFiles,
      background: options.background,
      search: options.search,
      baseUrl: options.baseUrl,
      azure: options.azure,
      timeoutSeconds: options.timeoutSeconds,
      httpTimeoutMs: options.httpTimeoutMs,
      zombieTimeoutMs: options.zombieTimeoutMs,
      zombieUseLastActivity: options.zombieUseLastActivity,
      writeOutputPath: options.writeOutputPath,
    },
  };
  await ensureDir(modelsDir(sessionId));
  await fs.writeFile(metaPath(sessionId), JSON.stringify(metadata, null, 2), 'utf8');
  await Promise.all(
    (modelList.length > 0 ? modelList : [metadata.model ?? DEFAULT_MODEL]).map(async (modelName) => {
      const jsonPath = modelJsonPath(sessionId, modelName);
      const logFilePath = modelLogPath(sessionId, modelName);
      const modelRecord: SessionModelRun = {
        model: modelName,
        status: 'pending',
        log: { path: path.relative(sessionDir(sessionId), logFilePath) },
      };
      await fs.writeFile(jsonPath, JSON.stringify(modelRecord, null, 2), 'utf8');
      await fs.writeFile(logFilePath, '', 'utf8');
    }),
  );
  await fs.writeFile(logPath(sessionId), '', 'utf8');
  return metadata;
}

export async function readSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  const modern = await readModernSessionMetadata(sessionId);
  if (modern) {
    return modern;
  }
  const legacy = await readLegacySessionMetadata(sessionId);
  if (legacy) {
    return legacy;
  }
  return null;
}

export async function updateSessionMetadata(
  sessionId: string,
  updates: Partial<SessionMetadata>,
): Promise<SessionMetadata> {
  const existing =
    (await readModernSessionMetadata(sessionId)) ??
    (await readLegacySessionMetadata(sessionId)) ??
    ({ id: sessionId } as SessionMetadata);
  const next = { ...existing, ...updates };
  await fs.writeFile(metaPath(sessionId), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

async function readModernSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  try {
    const raw = await fs.readFile(metaPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as SessionMetadata | StoredRunOptions;
    if (!isSessionMetadataRecord(parsed)) {
      return null;
    }
    const enriched = await attachModelRuns(parsed, sessionId);
    const runtimeChecked = await markDeadBrowser(enriched, { persist: false });
    return await markZombie(runtimeChecked, { persist: false });
  } catch {
    return null;
  }
}

async function readLegacySessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  try {
    const raw = await fs.readFile(legacySessionPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as SessionMetadata;
    const enriched = await attachModelRuns(parsed, sessionId);
    const runtimeChecked = await markDeadBrowser(enriched, { persist: false });
    return await markZombie(runtimeChecked, { persist: false });
  } catch {
    return null;
  }
}

function isSessionMetadataRecord(value: unknown): value is SessionMetadata {
  return Boolean(value && typeof (value as SessionMetadata).id === 'string' && (value as SessionMetadata).status);
}

async function attachModelRuns(meta: SessionMetadata, sessionId: string): Promise<SessionMetadata> {
  const runs = await listModelRunFiles(sessionId);
  if (runs.length === 0) {
    return meta;
  }
  return { ...meta, models: runs };
}

export function createSessionLogWriter(sessionId: string, model?: string): SessionLogWriter {
  const targetPath = model ? modelLogPath(sessionId, model) : logPath(sessionId);
  if (model) {
    void ensureDir(modelsDir(sessionId));
  }
  const stream = createWriteStream(targetPath, { flags: 'a' });
  const logLine = (line = ''): void => {
    stream.write(`${line}\n`);
  };
  const writeChunk = (chunk: string): boolean => {
    stream.write(chunk);
    return true;
  };
  return { stream, logLine, writeChunk, logPath: targetPath };
}

export async function listSessionsMetadata(): Promise<SessionMetadata[]> {
  await ensureSessionStorage();
  const entries = await fs.readdir(getSessionsDir()).catch(() => []);
  const metas: SessionMetadata[] = [];
  for (const entry of entries) {
    let meta = await readSessionMetadata(entry);
    if (meta) {
      meta = await markDeadBrowser(meta, { persist: true });
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
  const runs = await listModelRunFiles(sessionId);
  if (runs.length === 0) {
    try {
      return await fs.readFile(logPath(sessionId), 'utf8');
    } catch {
      return '';
    }
  }
  const sections: string[] = [];
  let hasContent = false;
  const ordered = runs
    .slice()
    .sort((a, b) => (a.startedAt && b.startedAt ? a.startedAt.localeCompare(b.startedAt) : a.model.localeCompare(b.model)));
  for (const run of ordered) {
    const logFile =
      run.log?.path
        ? path.isAbsolute(run.log.path)
          ? run.log.path
          : path.join(sessionDir(sessionId), run.log.path)
        : modelLogPath(sessionId, run.model);
    let body = '';
    try {
      body = await fs.readFile(logFile, 'utf8');
    } catch {
      body = '';
    }
    if (body.length > 0) {
      hasContent = true;
    }
    sections.push(`=== ${run.model} ===\n${body}`.trimEnd());
  }
  if (!hasContent) {
    try {
      return await fs.readFile(logPath(sessionId), 'utf8');
    } catch {
      // ignore and return structured header-only log
    }
  }
  return sections.join('\n\n');
}

export async function readModelLog(sessionId: string, model: string): Promise<string> {
  try {
    return await fs.readFile(modelLogPath(sessionId, model), 'utf8');
  } catch {
    return '';
  }
}

export async function readSessionRequest(sessionId: string): Promise<StoredRunOptions | null> {
  const modern = await readModernSessionMetadata(sessionId);
  if (modern?.options) {
    return modern.options;
  }
  try {
    const raw = await fs.readFile(requestPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    if (isSessionMetadataRecord(parsed)) {
      return parsed.options ?? null;
    }
    return parsed as StoredRunOptions;
  } catch {
    return null;
  }
}

export async function deleteSessionsOlderThan({
  hours = 24,
  includeAll = false,
}: { hours?: number; includeAll?: boolean } = {}): Promise<{ deleted: number; remaining: number }> {
  await ensureSessionStorage();
  const entries = await fs.readdir(getSessionsDir()).catch(() => []);
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

export { MAX_STATUS_LIMIT };
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

  const required = [metadata, log];
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
  if (!(await isZombie(meta))) {
    return meta;
  }
  if (meta.mode === 'browser') {
    const runtime = meta.browser?.runtime;
    if (runtime) {
      const signals: boolean[] = [];
      if (runtime.chromePid) {
        signals.push(isProcessAlive(runtime.chromePid));
      }
      if (runtime.chromePort) {
        const host = runtime.chromeHost ?? '127.0.0.1';
        signals.push(await isPortOpen(host, runtime.chromePort));
      }
      if (signals.some(Boolean)) {
        return meta;
      }
    }
  }
  const maxAgeMs = resolveZombieMaxAgeMs(meta);
  const updated: SessionMetadata = {
    ...meta,
    status: 'error',
    errorMessage: `Session marked as zombie (> ${formatElapsed(maxAgeMs)} stale)`,
    completedAt: new Date().toISOString(),
  };
  if (persist) {
    await fs.writeFile(metaPath(meta.id), JSON.stringify(updated, null, 2), 'utf8');
  }
  return updated;
}

async function markDeadBrowser(meta: SessionMetadata, { persist }: { persist: boolean }): Promise<SessionMetadata> {
  if (meta.status !== 'running' || meta.mode !== 'browser') {
    return meta;
  }
  const runtime = meta.browser?.runtime;
  if (!runtime) {
    return meta;
  }
  const signals: boolean[] = [];
  if (runtime.chromePid) {
    signals.push(isProcessAlive(runtime.chromePid));
  }
  if (runtime.chromePort) {
    const host = runtime.chromeHost ?? '127.0.0.1';
    signals.push(await isPortOpen(host, runtime.chromePort));
  }
  if (signals.length === 0 || signals.some(Boolean)) {
    return meta;
  }
  const response = meta.response
    ? {
        ...meta.response,
        status: 'error',
        incompleteReason: meta.response.incompleteReason ?? 'chrome-disconnected',
      }
    : { status: 'error', incompleteReason: 'chrome-disconnected' };
  const updated: SessionMetadata = {
    ...meta,
    status: 'error',
    errorMessage: 'Browser session ended (Chrome is no longer reachable)',
    completedAt: new Date().toISOString(),
    response,
  };
  if (persist) {
    await fs.writeFile(metaPath(meta.id), JSON.stringify(updated, null, 2), 'utf8');
  }
  return updated;
}

async function isZombie(meta: SessionMetadata): Promise<boolean> {
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
  const useLastActivity = meta.options?.zombieUseLastActivity === true;
  const lastActivityMs = useLastActivity ? await getLastActivityMs(meta) : null;
  const anchorMs = lastActivityMs ?? startedMs;
  const maxAgeMs = resolveZombieMaxAgeMs(meta);
  return Date.now() - anchorMs > maxAgeMs;
}

function resolveZombieMaxAgeMs(meta: SessionMetadata): number {
  const explicit = meta.options?.zombieTimeoutMs;
  const hasExplicit = typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0;
  let maxAgeMs = hasExplicit ? explicit : ZOMBIE_MAX_AGE_MS;
  if (!hasExplicit) {
    const timeoutSeconds = meta.options?.timeoutSeconds;
    if (typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
      const timeoutMs = timeoutSeconds * 1000;
      if (timeoutMs > maxAgeMs) {
        maxAgeMs = timeoutMs;
      }
    }
  }
  return maxAgeMs;
}

async function getLastActivityMs(meta: SessionMetadata): Promise<number | null> {
  const candidates = new Set<string>();
  candidates.add(logPath(meta.id));
  const modelNames = new Set<string>();
  if (typeof meta.model === 'string' && meta.model.length > 0) {
    modelNames.add(meta.model);
  }
  if (Array.isArray(meta.models)) {
    for (const entry of meta.models) {
      if (entry?.model) {
        modelNames.add(entry.model);
      }
    }
  }
  for (const modelName of modelNames) {
    candidates.add(modelLogPath(meta.id, modelName));
  }
  let latest = 0;
  let sawStat = false;
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      const mtimeMs = Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : stats.mtime.getTime();
      if (Number.isFinite(mtimeMs)) {
        latest = Math.max(latest, mtimeMs);
        sawStat = true;
      }
    } catch {
      // ignore missing logs; fallback to startedAt
    }
  }
  return sawStat ? latest : null;
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ESRCH' || code === 'EINVAL') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    return true;
  }
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  if (!port || port <= 0 || port > 65535) {
    return false;
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const cleanup = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
      socket.unref();
      resolve(result);
    };
    const timer = setTimeout(() => cleanup(false), CHROME_RUNTIME_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      cleanup(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      cleanup(false);
    });
  });
}
