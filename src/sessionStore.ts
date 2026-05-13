import type {
  SessionMetadata,
  SessionNotifications,
  StoredRunOptions,
  SessionModelRun,
} from "./sessionManager.js";
import {
  ensureSessionStorage,
  initializeSession,
  readSessionMetadata,
  updateSessionMetadata,
  createSessionLogWriter,
  readSessionLog,
  readModelLog,
  readSessionRequest,
  listSessionsMetadata,
  filterSessionsByRange,
  deleteSessionsOlderThan,
  updateModelRunMetadata,
  getSessionPaths,
  getSessionsDir,
} from "./sessionManager.js";
import { ensureOracleHomeDir } from "./oracleHome.js";
type InitializeSessionOptionsType = Parameters<typeof initializeSession>[0];

export interface SessionStore {
  ensureStorage(): Promise<void>;
  createSession(
    options: InitializeSessionOptionsType,
    cwd: string,
    notifications?: SessionNotifications,
    baseSlugOverride?: string,
  ): Promise<SessionMetadata>;
  readSession(sessionId: string): Promise<SessionMetadata | null>;
  updateSession(sessionId: string, updates: Partial<SessionMetadata>): Promise<SessionMetadata>;
  createLogWriter(sessionId: string, model?: string): ReturnType<typeof createSessionLogWriter>;
  updateModelRun(
    sessionId: string,
    model: string,
    updates: Partial<SessionModelRun>,
  ): Promise<SessionModelRun>;
  readLog(sessionId: string): Promise<string>;
  readModelLog(sessionId: string, model: string): Promise<string>;
  readRequest(sessionId: string): Promise<StoredRunOptions | null>;
  listSessions(): Promise<SessionMetadata[]>;
  filterSessions(
    metas: SessionMetadata[],
    options: { hours?: number; includeAll?: boolean; limit?: number },
  ): ReturnType<typeof filterSessionsByRange>;
  deleteOlderThan(options?: {
    hours?: number;
    includeAll?: boolean;
  }): Promise<{ deleted: number; remaining: number }>;
  getPaths(
    sessionId: string,
  ): Promise<{ dir: string; metadata: string; log: string; request: string }>;
  sessionsDir(): string;
}

class FileSessionStore implements SessionStore {
  async ensureStorage(): Promise<void> {
    await ensureOracleHomeDir();
    await ensureSessionStorage();
  }

  createSession(
    options: InitializeSessionOptionsType,
    cwd: string,
    notifications?: SessionNotifications,
    baseSlugOverride?: string,
  ): Promise<SessionMetadata> {
    return initializeSession(options, cwd, notifications, baseSlugOverride);
  }

  readSession(sessionId: string): Promise<SessionMetadata | null> {
    return readSessionMetadata(sessionId);
  }

  updateSession(sessionId: string, updates: Partial<SessionMetadata>): Promise<SessionMetadata> {
    return updateSessionMetadata(sessionId, updates);
  }

  createLogWriter(sessionId: string, model?: string): ReturnType<typeof createSessionLogWriter> {
    return createSessionLogWriter(sessionId, model);
  }

  updateModelRun(
    sessionId: string,
    model: string,
    updates: Partial<SessionModelRun>,
  ): Promise<SessionModelRun> {
    return updateModelRunMetadata(sessionId, model, updates);
  }

  readLog(sessionId: string): Promise<string> {
    return readSessionLog(sessionId);
  }

  readModelLog(sessionId: string, model: string): Promise<string> {
    return readModelLog(sessionId, model);
  }

  readRequest(sessionId: string): Promise<StoredRunOptions | null> {
    return readSessionRequest(sessionId);
  }

  listSessions(): Promise<SessionMetadata[]> {
    return listSessionsMetadata();
  }

  filterSessions(
    metas: SessionMetadata[],
    options: { hours?: number; includeAll?: boolean; limit?: number },
  ): ReturnType<typeof filterSessionsByRange> {
    return filterSessionsByRange(metas, options);
  }

  deleteOlderThan(options?: {
    hours?: number;
    includeAll?: boolean;
  }): Promise<{ deleted: number; remaining: number }> {
    return deleteSessionsOlderThan(options);
  }

  getPaths(
    sessionId: string,
  ): Promise<{ dir: string; metadata: string; log: string; request: string }> {
    return getSessionPaths(sessionId);
  }

  sessionsDir(): string {
    return getSessionsDir();
  }
}

export const sessionStore: SessionStore = new FileSessionStore();
export { wait } from "./sessionManager.js";
export type {
  SessionMetadata,
  SessionMode,
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
  SessionArtifact,
  BrowserHarvestState,
  BrowserHarvestMetadata,
  SessionTransportMetadata,
  SessionUserErrorMetadata,
  SessionEvidenceMetadata,
  SessionStatus,
  SessionModelRun,
  SessionProviderBoundaryOptions,
} from "./sessionManager.js";

export async function pruneOldSessions(
  hours?: number,
  log?: (message: string) => void,
): Promise<void> {
  if (typeof hours !== "number" || Number.isNaN(hours) || hours <= 0) {
    return;
  }
  const result = await sessionStore.deleteOlderThan({ hours });
  if (result.deleted > 0) {
    log?.(`Pruned ${result.deleted} stored sessions older than ${hours}h.`);
  }
}

// ─── PAV boundary persistence (additive — oracle-6np) ────────────────────────
//
// Re-export pane-6 PAV wiring helpers + types so callers that already
// import from `sessionStore` don't need another import path. Existing
// `SessionMetadata` callers see no behavior change — these are purely
// additive surfaces.

export {
  PAV_SESSION_NAMESPACE_SCHEMA_VERSION,
  assertNoRawPromptInMetadata,
  attachPavToProviderResult,
  attachPavToSessionRecord,
  isOrdinaryOracleUsage,
  projectPavMetadata,
  readPavBoundaries,
} from "./oracle/v18/pav_wiring.js";
export type {
  PavBoundaryMetadata,
  ProviderResultLike,
  ProviderResultWithPav,
  SessionPavMetadata,
  SessionRecordLike,
  SessionRecordWithPav,
} from "./oracle/v18/pav_wiring.js";

import type { ProviderBoundaryPavSnapshot } from "./oracle/provider_boundaries_pav.js";
import {
  attachPavToSessionRecord as _attachPavToSessionRecord,
  type SessionRecordLike as _SessionRecordLike,
} from "./oracle/v18/pav_wiring.js";

/**
 * Persist a PAV boundary onto an existing session's metadata. Reads
 * the session, appends the new boundary, writes the updated metadata
 * back. Returns the updated metadata. Ordinary (non-workflow) Oracle
 * runs are returned unchanged.
 */
export async function appendSessionPavBoundary(
  sessionId: string,
  snapshot: ProviderBoundaryPavSnapshot,
): Promise<SessionMetadata> {
  const current = await sessionStore.readSession(sessionId);
  if (!current) {
    throw new Error(`session "${sessionId}" not found`);
  }
  const updated = _attachPavToSessionRecord(current as unknown as _SessionRecordLike, snapshot);
  const patch = updated as Partial<SessionMetadata>;
  return sessionStore.updateSession(sessionId, patch);
}
