import chalk from 'chalk';
import type { Command, OptionValues } from 'commander';
import { usesDefaultStatusFilters } from './options.js';
import { attachSession, showStatus, type AttachSessionOptions, type ShowStatusOptions } from './sessionDisplay.js';
import { deleteSessionsOlderThan, getSessionPaths } from '../sessionManager.js';

export interface StatusOptions extends OptionValues {
  hours: number;
  limit: number;
  all: boolean;
  clear?: boolean;
  clean?: boolean;
  render?: boolean;
  renderMarkdown?: boolean;
  path?: boolean;
  verboseRender?: boolean;
  hidePrompt?: boolean;
}

interface SessionCommandDependencies {
  showStatus: (options: ShowStatusOptions) => Promise<void> | void;
  attachSession: (sessionId: string, options?: AttachSessionOptions) => Promise<void>;
  usesDefaultStatusFilters: (cmd: Command) => boolean;
  deleteSessionsOlderThan: typeof deleteSessionsOlderThan;
  getSessionPaths: typeof import('../sessionManager.js').getSessionPaths;
}

const defaultDependencies: SessionCommandDependencies = {
  showStatus,
  attachSession,
  usesDefaultStatusFilters,
  deleteSessionsOlderThan,
  getSessionPaths,
};

const SESSION_OPTION_KEYS = new Set(['hours', 'limit', 'all', 'clear', 'clean', 'render', 'renderMarkdown', 'path']);

export async function handleSessionCommand(
  sessionId: string | undefined,
  command: Command,
  deps: SessionCommandDependencies = defaultDependencies,
): Promise<void> {
  const sessionOptions = command.opts<StatusOptions>();
  if (sessionOptions.verboseRender) {
    process.env.ORACLE_VERBOSE_RENDER = '1';
  }
  const renderSource = command.getOptionValueSource?.('render');
  const renderMarkdownSource = command.getOptionValueSource?.('renderMarkdown');
  const renderExplicit = renderSource === 'cli' || renderMarkdownSource === 'cli';
  const autoRender = !renderExplicit && process.stdout.isTTY;
  const pathRequested = Boolean(sessionOptions.path);
  const clearRequested = Boolean(sessionOptions.clear || sessionOptions.clean);
  if (clearRequested) {
    if (sessionId) {
      console.error('Cannot combine a session ID with --clear. Remove the ID to delete cached sessions.');
      process.exitCode = 1;
      return;
    }
    const hours = sessionOptions.hours;
    const includeAll = sessionOptions.all;
    const result = await deps.deleteSessionsOlderThan({ hours, includeAll });
    const scope = includeAll ? 'all stored sessions' : `sessions older than ${hours}h`;
    console.log(formatSessionCleanupMessage(result, scope));
    return;
  }
  if (sessionId === 'clear' || sessionId === 'clean') {
    console.error('Session cleanup now uses --clear. Run "oracle session --clear --hours <n>" instead.');
    process.exitCode = 1;
    return;
  }
  if (pathRequested) {
    if (!sessionId) {
      console.error('The --path flag requires a session ID.');
      process.exitCode = 1;
      return;
    }
    try {
      const paths = await deps.getSessionPaths(sessionId);
      const richTty = Boolean(process.stdout.isTTY && chalk.level > 0);
      const label = (text: string): string => (richTty ? chalk.cyan(text) : text);
      const value = (text: string): string => (richTty ? chalk.dim(text) : text);
      console.log(`${label('Session dir:')} ${value(paths.dir)}`);
      console.log(`${label('Metadata:')} ${value(paths.metadata)}`);
      console.log(`${label('Request:')} ${value(paths.request)}`);
      console.log(`${label('Log:')} ${value(paths.log)}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (!sessionId) {
    const showExamples = deps.usesDefaultStatusFilters(command);
    await deps.showStatus({
      hours: sessionOptions.all ? Infinity : sessionOptions.hours,
      includeAll: sessionOptions.all,
      limit: sessionOptions.limit,
      showExamples,
    });
    return;
  }
  // Surface any root-level flags that were provided but are ignored when attaching to a session.
  const ignoredFlags = listIgnoredFlags(command);
  if (ignoredFlags.length > 0) {
    console.log(`Ignoring flags on session attach: ${ignoredFlags.join(', ')}`);
  }
  const renderMarkdown = Boolean(sessionOptions.render || sessionOptions.renderMarkdown || autoRender);
  await deps.attachSession(sessionId, { renderMarkdown, renderPrompt: !sessionOptions.hidePrompt });
}

export function formatSessionCleanupMessage(
  result: { deleted: number; remaining: number },
  scope: string,
): string {
  const deletedLabel = `${result.deleted} ${result.deleted === 1 ? 'session' : 'sessions'}`;
  const remainingLabel = `${result.remaining} ${result.remaining === 1 ? 'session' : 'sessions'} remain`;
  const hint = 'Run "oracle session --clear --all" to delete everything.';
  return `Deleted ${deletedLabel} (${scope}). ${remainingLabel}.\n${hint}`;
}

function listIgnoredFlags(command: Command): string[] {
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const ignored: string[] = [];
  for (const key of Object.keys(opts)) {
    if (SESSION_OPTION_KEYS.has(key)) {
      continue;
    }
    const source = command.getOptionValueSource?.(key);
    if (source !== 'cli' && source !== 'env') {
      continue;
    }
    const value = opts[key];
    if (value === undefined || value === false || value === null) {
      continue;
    }
    ignored.push(key);
  }
  return ignored;
}
