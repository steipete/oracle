import type { SessionMetadata, SessionNotifications, StoredRunOptions, SessionModelRun } from './sessionManager.js';
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
} from './sessionManager.js';
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
  updateModelRun(sessionId: string, model: string, updates: Partial<SessionModelRun>): Promise<SessionModelRun>;
  readLog(sessionId: string): Promise<string>;
  readModelLog(sessionId: string, model: string): Promise<string>;
  readRequest(sessionId: string): Promise<StoredRunOptions | null>;
  listSessions(): Promise<SessionMetadata[]>;
  filterSessions(
    metas: SessionMetadata[],
    options: { hours?: number; includeAll?: boolean; limit?: number },
  ): ReturnType<typeof filterSessionsByRange>;
  deleteOlderThan(options?: { hours?: number; includeAll?: boolean }): Promise<{ deleted: number; remaining: number }>;
  getPaths(sessionId: string): Promise<{ dir: string; metadata: string; log: string; request: string }>;
  sessionsDir(): string;
}

class FileSessionStore implements SessionStore {
  ensureStorage(): Promise<void> {
    return ensureSessionStorage();
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

  updateModelRun(sessionId: string, model: string, updates: Partial<SessionModelRun>): Promise<SessionModelRun> {
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

  deleteOlderThan(options?: { hours?: number; includeAll?: boolean }): Promise<{ deleted: number; remaining: number }> {
    return deleteSessionsOlderThan(options);
  }

  getPaths(sessionId: string): Promise<{ dir: string; metadata: string; log: string; request: string }> {
    return getSessionPaths(sessionId);
  }

  sessionsDir(): string {
    return getSessionsDir();
  }
}

export const sessionStore: SessionStore = new FileSessionStore();
export { wait } from './sessionManager.js';
export type {
  SessionMetadata,
  SessionMode,
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
  SessionTransportMetadata,
  SessionUserErrorMetadata,
  SessionStatus,
  SessionModelRun,
} from './sessionManager.js';

export async function pruneOldSessions(
  hours?: number,
  log?: (message: string) => void,
): Promise<void> {
  if (typeof hours !== 'number' || Number.isNaN(hours) || hours <= 0) {
    return;
  }
  const result = await sessionStore.deleteOlderThan({ hours });
  if (result.deleted > 0) {
    log?.(`Pruned ${result.deleted} stored sessions older than ${hours}h.`);
  }
}
