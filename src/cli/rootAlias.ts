import { attachSession, showStatus, type ShowStatusOptions } from './sessionDisplay.js';

export interface StatusAliasOptions {
  status?: boolean;
  session?: string;
}

export interface StatusAliasDependencies {
  attachSession: (sessionId: string) => Promise<void>;
  showStatus: (options: ShowStatusOptions) => Promise<void>;
}

const defaultDeps: StatusAliasDependencies = {
  attachSession,
  showStatus,
};

export async function handleStatusFlag(
  options: StatusAliasOptions,
  deps: StatusAliasDependencies = defaultDeps,
): Promise<boolean> {
  if (!options.status) {
    return false;
  }
  if (options.session) {
    await deps.attachSession(options.session);
    return true;
  }
  await deps.showStatus({ hours: 24, includeAll: false, limit: 100, showExamples: true });
  return true;
}

export interface SessionAliasOptions {
  session?: string;
}

export interface SessionAliasDependencies {
  attachSession: (sessionId: string) => Promise<void>;
}

const defaultSessionDeps: SessionAliasDependencies = {
  attachSession,
};

/**
 * Hidden root-level alias to attach to a stored session (`--session <id>`).
 * Returns true when the alias was handled so callers can short-circuit.
 */
export async function handleSessionAlias(
  options: SessionAliasOptions,
  deps: SessionAliasDependencies = defaultSessionDeps,
): Promise<boolean> {
  if (!options.session) {
    return false;
  }
  await deps.attachSession(options.session);
  return true;
}
