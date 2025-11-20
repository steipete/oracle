import type { SessionStore, SessionMetadata } from '../sessionStore.js';
import chalk from 'chalk';

interface DuplicatePromptGuardOptions {
  prompt: string | undefined | null;
  force?: boolean;
  sessionStore: SessionStore;
  log?: (message: string) => void;
}

export async function shouldBlockDuplicatePrompt({
  prompt,
  force,
  sessionStore,
  log = console.log,
}: DuplicatePromptGuardOptions): Promise<boolean> {
  if (force) return false;
  const normalized = prompt?.trim();
  if (!normalized) return false;

  const running = (await sessionStore.listSessions()).filter((entry) => entry.status === 'running');
  const duplicate = running.find(
    (entry: SessionMetadata) => (entry.options?.prompt?.trim?.() ?? '') === normalized,
  );
  if (!duplicate) return false;

  log(
    chalk.yellow(
      `A session with the same prompt is already running (${duplicate.id}). Reattach with "oracle session ${duplicate.id}" or rerun with --force to start another run.`,
    ),
  );
  return true;
}
