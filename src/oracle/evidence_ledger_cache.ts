import fs from "node:fs/promises";
import path from "node:path";

import type { EvidenceLedgerEntry } from "./evidence_ledger.js";
import { canonicalJSON, sha256OfBytes } from "./v18/evidence.js";

export const EVIDENCE_LEDGER_HEAD_CACHE_SCHEMA_VERSION =
  "evidence_ledger_head_cache.v1" as const;
export const DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL = 32;

const TAIL_READ_CHUNK_BYTES = 4096;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export interface EvidenceLedgerAppendHeadState {
  readonly nextSequence: number;
  readonly prevHash: `sha256:${string}`;
  readonly chainExtended: boolean;
  readonly ledgerSizeBytes: number;
  readonly ledgerMtimeMs: number | null;
}

export interface EvidenceLedgerAppendHeadOptions {
  readonly genesisHash: `sha256:${string}`;
  readonly ledgerSchemaVersion: string;
  readonly flushInterval?: number;
  readonly now?: () => Date;
}

interface EvidenceLedgerHeadCacheRecord extends EvidenceLedgerAppendHeadState {
  readonly appendsSinceFlush: number;
}

interface DurableEvidenceLedgerHeadCache {
  readonly schema_version: typeof EVIDENCE_LEDGER_HEAD_CACHE_SCHEMA_VERSION;
  readonly ledger_size_bytes: number;
  readonly ledger_mtime_ms: number | null;
  readonly next_sequence: number;
  readonly head_hash: `sha256:${string}`;
  readonly chain_extended: boolean;
  readonly updated_at: string;
}

export interface EvidenceLedgerHeadCacheStats {
  readonly memoryHits: number;
  readonly sidecarHits: number;
  readonly tailReads: number;
  readonly tailBytesRead: number;
  readonly fullFallbacks: number;
  readonly durableFlushes: number;
  readonly nonFatalUpdateFailures: number;
}

const headCache = new Map<string, EvidenceLedgerHeadCacheRecord>();
let stats = {
  memoryHits: 0,
  sidecarHits: 0,
  tailReads: 0,
  tailBytesRead: 0,
  fullFallbacks: 0,
  durableFlushes: 0,
  nonFatalUpdateFailures: 0,
};

export async function getEvidenceLedgerAppendHead(
  filePath: string,
  options: EvidenceLedgerAppendHeadOptions,
): Promise<EvidenceLedgerAppendHeadState> {
  const key = path.resolve(filePath);
  const ledgerStat = await statLedger(key);
  const cached = headCache.get(key);
  if (cached && statMatches(cached, ledgerStat)) {
    stats.memoryHits += 1;
    return stateFromRecord(cached);
  }

  const durable = await readDurableHeadCache(key, ledgerStat);
  if (durable) {
    stats.sidecarHits += 1;
    const record = { ...durable, appendsSinceFlush: 0 };
    headCache.set(key, record);
    return stateFromRecord(record);
  }

  const state = await readTailHeadState(key, ledgerStat, options);
  headCache.set(key, { ...state, appendsSinceFlush: 0 });
  return state;
}

export async function recordEvidenceLedgerAppend(
  filePath: string,
  entry: EvidenceLedgerEntry,
  options: Pick<EvidenceLedgerAppendHeadOptions, "flushInterval" | "now"> = {},
): Promise<void> {
  const key = path.resolve(filePath);
  try {
    const ledgerStat = await fs.stat(key);
    const previous = headCache.get(key);
    const record: EvidenceLedgerHeadCacheRecord = {
      nextSequence: entry.sequence + 1,
      prevHash: entry.entry_hash,
      chainExtended: true,
      ledgerSizeBytes: ledgerStat.size,
      ledgerMtimeMs: ledgerStat.mtimeMs,
      appendsSinceFlush: (previous?.appendsSinceFlush ?? 0) + 1,
    };
    headCache.set(key, record);

    if (record.appendsSinceFlush >= flushInterval(options)) {
      await flushEvidenceLedgerHeadCache(key, options);
    }
  } catch {
    stats.nonFatalUpdateFailures += 1;
    // The ledger line has already been appended before callers invoke this
    // cache hook. Treat cache maintenance as non-authoritative: drop the warm
    // head so the next append reconciles from the on-disk ledger tail.
    headCache.delete(key);
  }
}

export async function flushEvidenceLedgerHeadCache(
  filePath?: string,
  options: Pick<EvidenceLedgerAppendHeadOptions, "now"> = {},
): Promise<void> {
  if (filePath) {
    const key = path.resolve(filePath);
    const record = headCache.get(key);
    if (record) {
      await writeDurableHeadCache(key, record, options);
      headCache.set(key, { ...record, appendsSinceFlush: 0 });
    }
    return;
  }

  for (const [key, record] of headCache) {
    await writeDurableHeadCache(key, record, options);
    headCache.set(key, { ...record, appendsSinceFlush: 0 });
  }
}

export function evidenceLedgerHeadCachePath(filePath: string): string {
  return `${filePath}.head.json`;
}

export function recordEvidenceLedgerHeadCacheFallback(): void {
  stats.fullFallbacks += 1;
}

export function clearEvidenceLedgerHeadCache(): void {
  headCache.clear();
}

export function resetEvidenceLedgerHeadCacheStats(): void {
  stats = {
    memoryHits: 0,
    sidecarHits: 0,
    tailReads: 0,
    tailBytesRead: 0,
    fullFallbacks: 0,
    durableFlushes: 0,
    nonFatalUpdateFailures: 0,
  };
}

export function getEvidenceLedgerHeadCacheStats(): EvidenceLedgerHeadCacheStats {
  return { ...stats };
}

async function readTailHeadState(
  filePath: string,
  ledgerStat: Awaited<ReturnType<typeof statLedger>>,
  options: EvidenceLedgerAppendHeadOptions,
): Promise<EvidenceLedgerAppendHeadState> {
  if (!ledgerStat || ledgerStat.size === 0) {
    return {
      nextSequence: 0,
      prevHash: options.genesisHash,
      chainExtended: false,
      ledgerSizeBytes: ledgerStat?.size ?? 0,
      ledgerMtimeMs: ledgerStat?.mtimeMs ?? null,
    };
  }

  stats.tailReads += 1;
  const line = await readLastNonEmptyLine(filePath, ledgerStat.size);
  if (!line) {
    return {
      nextSequence: 0,
      prevHash: options.genesisHash,
      chainExtended: false,
      ledgerSizeBytes: ledgerStat.size,
      ledgerMtimeMs: ledgerStat.mtimeMs,
    };
  }

  const entry = parseTailEntry(line, options.ledgerSchemaVersion);
  return {
    nextSequence: entry.sequence + 1,
    prevHash: entry.entry_hash,
    chainExtended: true,
    ledgerSizeBytes: ledgerStat.size,
    ledgerMtimeMs: ledgerStat.mtimeMs,
  };
}

async function readLastNonEmptyLine(filePath: string, fileSize: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    let position = fileSize;
    const chunks: Buffer[] = [];
    while (position > 0) {
      const readSize = Math.min(TAIL_READ_CHUNK_BYTES, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, position);
      if (bytesRead <= 0) break;
      chunks.unshift(Buffer.from(buffer.subarray(0, bytesRead)));
      stats.tailBytesRead += bytesRead;

      const text = Buffer.concat(chunks).toString("utf8");
      const trimmed = text.replace(/[\r\n]+$/, "");
      if (!trimmed && position === 0) return "";
      const newlineIndex = trimmed.lastIndexOf("\n");
      if (newlineIndex >= 0) {
        return trimmed.slice(newlineIndex + 1).replace(/\r$/, "");
      }
      if (position === 0) {
        return trimmed.replace(/\r$/, "");
      }
    }
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseTailEntry(line: string, ledgerSchemaVersion: string): EvidenceLedgerEntry {
  const parsed = JSON.parse(line) as EvidenceLedgerEntry;
  if (parsed.schema_version !== ledgerSchemaVersion) {
    throw new Error(`tail entry has wrong schema_version "${parsed.schema_version}"`);
  }
  if (!Number.isInteger(parsed.sequence) || parsed.sequence < 0) {
    throw new Error(`tail entry has invalid sequence ${String(parsed.sequence)}`);
  }
  if (!parsed.prev_hash || !SHA256_RE.test(parsed.prev_hash)) {
    throw new Error(`tail entry has invalid prev_hash ${String(parsed.prev_hash)}`);
  }
  if (!parsed.entry_hash || !SHA256_RE.test(parsed.entry_hash)) {
    throw new Error(`tail entry has invalid entry_hash ${String(parsed.entry_hash)}`);
  }
  if (!parsed.timestamp || typeof parsed.timestamp !== "string") {
    throw new Error("tail entry has invalid timestamp");
  }
  if (!parsed.event || typeof parsed.event !== "object") {
    throw new Error("tail entry has invalid event");
  }

  const computed = sha256OfBytes(
    canonicalJSON({
      schema_version: parsed.schema_version,
      sequence: parsed.sequence,
      timestamp: parsed.timestamp,
      event: parsed.event,
      prev_hash: parsed.prev_hash,
    }),
  );
  if (computed !== parsed.entry_hash) {
    throw new Error(
      `tail entry_hash mismatch (recorded ${parsed.entry_hash}, computed ${computed})`,
    );
  }

  return parsed;
}

async function readDurableHeadCache(
  filePath: string,
  ledgerStat: Awaited<ReturnType<typeof statLedger>>,
): Promise<EvidenceLedgerAppendHeadState | null> {
  if (!ledgerStat) return null;
  let raw: string;
  try {
    raw = await fs.readFile(evidenceLedgerHeadCachePath(filePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: DurableEvidenceLedgerHeadCache;
  try {
    parsed = JSON.parse(raw) as DurableEvidenceLedgerHeadCache;
  } catch {
    return null;
  }

  if (parsed.schema_version !== EVIDENCE_LEDGER_HEAD_CACHE_SCHEMA_VERSION) return null;
  if (parsed.ledger_size_bytes !== ledgerStat.size) return null;
  if (parsed.ledger_mtime_ms !== ledgerStat.mtimeMs) return null;
  if (!Number.isInteger(parsed.next_sequence) || parsed.next_sequence < 0) return null;
  if (!SHA256_RE.test(parsed.head_hash)) return null;

  return {
    nextSequence: parsed.next_sequence,
    prevHash: parsed.head_hash,
    chainExtended: parsed.chain_extended,
    ledgerSizeBytes: parsed.ledger_size_bytes,
    ledgerMtimeMs: parsed.ledger_mtime_ms,
  };
}

async function writeDurableHeadCache(
  filePath: string,
  record: EvidenceLedgerHeadCacheRecord,
  options: Pick<EvidenceLedgerAppendHeadOptions, "now">,
): Promise<void> {
  const target = evidenceLedgerHeadCachePath(filePath);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload: DurableEvidenceLedgerHeadCache = {
    schema_version: EVIDENCE_LEDGER_HEAD_CACHE_SCHEMA_VERSION,
    ledger_size_bytes: record.ledgerSizeBytes,
    ledger_mtime_ms: record.ledgerMtimeMs,
    next_sequence: record.nextSequence,
    head_hash: record.prevHash,
    chain_extended: record.chainExtended,
    updated_at: (options.now ? options.now() : new Date()).toISOString(),
  };

  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
  if (process.platform !== "win32") {
    await fs.chmod(target, 0o600).catch(() => undefined);
  }
  stats.durableFlushes += 1;
}

async function statLedger(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function statMatches(
  record: EvidenceLedgerHeadCacheRecord,
  ledgerStat: Awaited<ReturnType<typeof statLedger>>,
): boolean {
  return (
    record.ledgerSizeBytes === (ledgerStat?.size ?? 0) &&
    record.ledgerMtimeMs === (ledgerStat?.mtimeMs ?? null)
  );
}

function stateFromRecord(record: EvidenceLedgerHeadCacheRecord): EvidenceLedgerAppendHeadState {
  return {
    nextSequence: record.nextSequence,
    prevHash: record.prevHash,
    chainExtended: record.chainExtended,
    ledgerSizeBytes: record.ledgerSizeBytes,
    ledgerMtimeMs: record.ledgerMtimeMs,
  };
}

function flushInterval(options: Pick<EvidenceLedgerAppendHeadOptions, "flushInterval">): number {
  return Math.max(1, options.flushInterval ?? DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL);
}
