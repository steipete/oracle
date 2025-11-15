import chalk from 'chalk';
import kleur from 'kleur';
import type { SessionMetadata, SessionTransportMetadata, SessionUserErrorMetadata } from '../sessionManager.js';
import {
  filterSessionsByRange,
  listSessionsMetadata,
  readSessionLog,
  readSessionMetadata,
  SESSIONS_DIR,
  wait,
} from '../sessionManager.js';
import type { OracleResponseMetadata } from '../oracle.js';

const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);

export interface ShowStatusOptions {
  hours: number;
  includeAll: boolean;
  limit: number;
  showExamples?: boolean;
}

const CLEANUP_TIP =
  'Tip: Run "oracle session --clear --hours 24" to prune cached runs (add --all to wipe everything).';

function printCleanupTip(): void {
  console.log(dim(CLEANUP_TIP));
}

export async function showStatus({ hours, includeAll, limit, showExamples = false }: ShowStatusOptions): Promise<void> {
  const metas = await listSessionsMetadata();
  const { entries, truncated, total } = filterSessionsByRange(metas, { hours, includeAll, limit });
  const richTty = process.stdout.isTTY && chalk.level > 0;
  if (!entries.length) {
    console.log('No sessions found for the requested range.');
    printCleanupTip();
    if (showExamples) {
      printStatusExamples();
    }
    return;
  }
  console.log(chalk.bold('Recent Sessions'));
  for (const entry of entries) {
    const statusRaw = (entry.status || 'unknown').padEnd(9);
    const status = richTty ? colorStatus(entry.status ?? 'unknown', statusRaw) : statusRaw;
    const model = (entry.model || 'n/a').padEnd(10);
    const created = entry.createdAt.replace('T', ' ').replace('Z', '');
    console.log(`${created} | ${status} | ${model} | ${entry.id}`);
  }
  if (truncated) {
    console.log(
      chalk.yellow(
        `Showing ${entries.length} of ${total} sessions from the requested range. Run "oracle session --clear" or delete entries in ${SESSIONS_DIR} to free space, or rerun with --status-limit/--status-all.`,
      ),
    );
  }
  printCleanupTip();
  if (showExamples) {
    printStatusExamples();
  }
}

function colorStatus(status: string, padded: string): string {
  switch (status) {
    case 'completed':
      return chalk.green(padded);
    case 'error':
      return chalk.red(padded);
    case 'running':
      return chalk.yellow(padded);
    default:
      return padded;
  }
}

export interface AttachSessionOptions {
  suppressMetadata?: boolean;
}

export async function attachSession(sessionId: string, options?: AttachSessionOptions): Promise<void> {
  const metadata = await readSessionMetadata(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  const initialStatus = metadata.status;
  if (!options?.suppressMetadata) {
    console.log(chalk.bold(`Session: ${sessionId}`));
    const reattachLine = buildReattachLine(metadata);
    if (reattachLine) {
      console.log(chalk.blue(reattachLine));
    }
    console.log(`Created: ${metadata.createdAt}`);
    console.log(`Status: ${metadata.status}`);
    console.log(`Model: ${metadata.model}`);
    const responseSummary = formatResponseMetadata(metadata.response);
    if (responseSummary) {
      console.log(dim(`Response: ${responseSummary}`));
    }
    const transportSummary = formatTransportMetadata(metadata.transport);
    if (transportSummary) {
      console.log(dim(`Transport: ${transportSummary}`));
    }
    const userErrorSummary = formatUserErrorMetadata(metadata.error);
    if (userErrorSummary) {
      console.log(dim(`User error: ${userErrorSummary}`));
    }
  }

  let lastLength = 0;
  const printNew = async () => {
    const text = await readSessionLog(sessionId);
    const nextChunk = text.slice(lastLength);
    if (nextChunk.length > 0) {
      process.stdout.write(nextChunk);
      lastLength = text.length;
    }
  };

  await printNew();

  // biome-ignore lint/nursery/noUnnecessaryConditions: deliberate infinite poll
  while (true) {
    const latest = await readSessionMetadata(sessionId);
    if (!latest) {
      break;
    }
    if (latest.status === 'completed' || latest.status === 'error') {
      await printNew();
      if (!options?.suppressMetadata) {
        if (latest.status === 'error' && latest.errorMessage) {
          console.log('\nResult:');
          console.log(`Session failed: ${latest.errorMessage}`);
        }
        if (latest.usage && initialStatus === 'running') {
          const usage = latest.usage;
          console.log(`\nFinished (tok i/o/r/t: ${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens})`);
        }
      }
      break;
    }
    await wait(1000);
    await printNew();
  }
}

export function formatResponseMetadata(metadata?: OracleResponseMetadata): string | null {
  if (!metadata) {
    return null;
  }
  const parts: string[] = [];
  if (metadata.responseId) {
    parts.push(`response=${metadata.responseId}`);
  }
  if (metadata.requestId) {
    parts.push(`request=${metadata.requestId}`);
  }
  if (metadata.status) {
    parts.push(`status=${metadata.status}`);
  }
  if (metadata.incompleteReason) {
    parts.push(`incomplete=${metadata.incompleteReason}`);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

export function formatTransportMetadata(metadata?: SessionTransportMetadata): string | null {
  if (!metadata?.reason) {
    return null;
  }
  const reasonLabels: Record<string, string> = {
    'client-timeout': 'client timeout (20m deadline hit)',
    'connection-lost': 'connection lost before completion',
    'client-abort': 'request aborted locally',
    unknown: 'unknown transport failure',
  };
  const label = reasonLabels[metadata.reason] ?? 'transport error';
  return `${metadata.reason} — ${label}`;
}

export function formatUserErrorMetadata(metadata?: SessionUserErrorMetadata): string | null {
  if (!metadata) {
    return null;
  }
  const parts: string[] = [];
  if (metadata.category) {
    parts.push(metadata.category);
  }
  if (metadata.message) {
    parts.push(`message=${metadata.message}`);
  }
  if (metadata.details && Object.keys(metadata.details).length > 0) {
    parts.push(`details=${JSON.stringify(metadata.details)}`);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

export function buildReattachLine(metadata: SessionMetadata): string | null {
  if (!metadata.id) {
    return null;
  }
  const referenceTime = metadata.startedAt ?? metadata.createdAt;
  if (!referenceTime) {
    return null;
  }
  const elapsedLabel = formatRelativeDuration(referenceTime);
  if (!elapsedLabel) {
    return null;
  }
  if (metadata.status === 'running') {
    return `Session ${metadata.id} reattached, request started ${elapsedLabel} ago.`;
  }
  return null;
}

function formatRelativeDuration(referenceIso: string): string | null {
  const timestamp = Date.parse(referenceIso);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) {
    return null;
  }
  const seconds = Math.max(1, Math.round(diffMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    const parts = [`${hours}h`];
    if (remainingMinutes > 0) {
      parts.push(`${remainingMinutes}m`);
    }
    return parts.join(' ');
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const parts = [`${days}d`];
  if (remainingHours > 0) {
    parts.push(`${remainingHours}h`);
  }
  if (remainingMinutes > 0 && days === 0) {
    parts.push(`${remainingMinutes}m`);
  }
  return parts.join(' ');
}

function printStatusExamples(): void {
  console.log('');
  console.log(chalk.bold('Usage Examples'));
  console.log(`${chalk.bold('  oracle status --hours 72 --limit 50')}`);
  console.log(dim('    Show 72h of history capped at 50 entries.'));
  console.log(`${chalk.bold('  oracle status --clear --hours 168')}`);
  console.log(dim('    Delete sessions older than 7 days (use --all to wipe everything).'));
  console.log(`${chalk.bold('  oracle session <session-id>')}`);
  console.log(dim('    Attach to a specific running/completed session to stream its output.'));
}
