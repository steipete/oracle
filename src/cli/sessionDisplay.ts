import chalk from 'chalk';
import kleur from 'kleur';
import type {
  SessionMetadata,
  SessionTransportMetadata,
  SessionUserErrorMetadata,
  SessionStatus,
  SessionModelRun,
} from '../sessionStore.js';
import type { OracleResponseMetadata } from '../oracle.js';
import { renderMarkdownAnsi } from './markdownRenderer.js';
import { formatElapsed, formatUSD } from '../oracle/format.js';
import { MODEL_CONFIGS } from '../oracle.js';
import { sessionStore, wait } from '../sessionStore.js';

const isTty = (): boolean => Boolean(process.stdout.isTTY);
const dim = (text: string): string => (isTty() ? kleur.dim(text) : text);
export const MAX_RENDER_BYTES = 200_000;
const MODEL_COLUMN_WIDTH = 18;

export interface ShowStatusOptions {
  hours: number;
  includeAll: boolean;
  limit: number;
  showExamples?: boolean;
  modelFilter?: string;
}

const CLEANUP_TIP =
  'Tip: Run "oracle session --clear --hours 24" to prune cached runs (add --all to wipe everything).';

export async function showStatus({
  hours,
  includeAll,
  limit,
  showExamples = false,
  modelFilter,
}: ShowStatusOptions): Promise<void> {
  const metas = await sessionStore.listSessions();
  const { entries, truncated, total } = sessionStore.filterSessions(metas, { hours, includeAll, limit });
  const filteredEntries = modelFilter ? entries.filter((entry) => matchesModel(entry, modelFilter)) : entries;
  const richTty = process.stdout.isTTY && chalk.level > 0;
  if (!filteredEntries.length) {
    console.log(CLEANUP_TIP);
    if (showExamples) {
      printStatusExamples();
    }
    return;
  }
  console.log(chalk.bold('Recent Sessions'));
  console.log(chalk.dim('Timestamp             Chars  Cost  Status     Models              ID'));
  for (const entry of filteredEntries) {
    const statusRaw = (entry.status || 'unknown').padEnd(9);
    const status = richTty ? colorStatus(entry.status ?? 'unknown', statusRaw) : statusRaw;
    const modelColumn = formatModelColumn(entry, MODEL_COLUMN_WIDTH, richTty);
    const created = formatTimestamp(entry.createdAt);
    const chars = entry.options?.prompt?.length ?? entry.promptPreview?.length ?? 0;
    const charLabel = chars > 0 ? String(chars).padStart(5) : '    -';
    const costValue = resolveCost(entry);
    const costLabel = costValue != null ? formatCostTable(costValue) : '     -';
    console.log(`${created} | ${charLabel} | ${costLabel} | ${status} | ${modelColumn} | ${entry.id}`);
  }
  if (truncated) {
    const sessionsDir = sessionStore.sessionsDir();
    console.log(
      chalk.yellow(
        `Showing ${entries.length} of ${total} sessions from the requested range. Run "oracle session --clear" or delete entries in ${sessionsDir} to free space, or rerun with --status-limit/--status-all.`,
      ),
    );
  }
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
  renderMarkdown?: boolean;
  renderPrompt?: boolean;
  model?: string;
}

type LiveRenderState = {
  pending: string;
  inFence: boolean;
  fenceDelimiter?: string;
  inTable: boolean;
  renderedBytes: number;
  fallback: boolean;
  noticedFallback: boolean;
};

export async function attachSession(sessionId: string, options?: AttachSessionOptions): Promise<void> {
  const metadata = await sessionStore.readSession(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  const normalizedModelFilter = options?.model?.trim().toLowerCase();
  if (normalizedModelFilter) {
    const availableModels =
      metadata.models?.map((model) => model.model.toLowerCase()) ??
      (metadata.model ? [metadata.model.toLowerCase()] : []);
    if (!availableModels.includes(normalizedModelFilter)) {
      console.error(chalk.red(`Model "${options?.model}" not found in session ${sessionId}.`));
      process.exitCode = 1;
      return;
    }
  }
  const initialStatus = metadata.status;
  const wantsRender = Boolean(options?.renderMarkdown);
  const isVerbose = Boolean(process.env.ORACLE_VERBOSE_RENDER);
  if (!options?.suppressMetadata) {
    const reattachLine = buildReattachLine(metadata);
    if (reattachLine) {
      console.log(chalk.blue(reattachLine));
    }
    console.log(`Created: ${metadata.createdAt}`);
    console.log(`Status: ${metadata.status}`);
    if (metadata.models && metadata.models.length > 0) {
      console.log('Models:');
      for (const run of metadata.models) {
        const usage = run.usage
          ? ` tok=${run.usage.outputTokens?.toLocaleString() ?? 0}/${run.usage.totalTokens?.toLocaleString() ?? 0}`
          : '';
        console.log(`- ${chalk.cyan(run.model)} — ${run.status}${usage}`);
      }
    } else if (metadata.model) {
      console.log(`Model: ${metadata.model}`);
    }
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

  const shouldTrimIntro = initialStatus === 'completed' || initialStatus === 'error';
  if (options?.renderPrompt !== false) {
    const prompt = await readStoredPrompt(sessionId);
    if (prompt) {
      console.log(chalk.bold('Prompt:'));
      console.log(renderMarkdownAnsi(prompt));
      console.log(dim('---'));
    }
  }
  if (shouldTrimIntro) {
    const fullLog = await buildSessionLogForDisplay(sessionId, metadata, normalizedModelFilter);
    const trimmed = trimBeforeFirstAnswer(fullLog);
    const size = Buffer.byteLength(trimmed, 'utf8');
    const canRender = wantsRender && isTty() && size <= MAX_RENDER_BYTES;
    if (wantsRender && size > MAX_RENDER_BYTES) {
      const msg = `Render skipped (log too large: ${size} bytes > ${MAX_RENDER_BYTES}). Showing raw text.`;
      console.log(dim(msg));
      if (isVerbose) {
        console.log(dim(`Verbose: renderMarkdown=true tty=${isTty()} size=${size}`));
      }
    } else if (wantsRender && !isTty()) {
      const msg = 'Render requested but stdout is not a TTY; showing raw text.';
      console.log(dim(msg));
      if (isVerbose) {
        console.log(dim(`Verbose: renderMarkdown=true tty=${isTty()} size=${size}`));
      }
    }
    if (canRender) {
      if (isVerbose) {
        console.log(dim(`Verbose: rendering markdown (size=${size}, tty=${isTty()})`));
      }
      process.stdout.write(renderMarkdownAnsi(trimmed));
    } else {
      process.stdout.write(trimmed);
    }
    const summary = formatCompletionSummary(metadata, { includeSlug: true });
    if (summary) {
      console.log(`\n${chalk.green.bold(summary)}`);
    }
    return;
  }

  if (wantsRender) {
    console.log(dim('Render will apply after completion; streaming raw text meanwhile...'));
    if (isVerbose) {
      console.log(dim(`Verbose: streaming phase renderMarkdown=true tty=${isTty()}`));
    }
  }

  const liveRenderState: LiveRenderState | null = wantsRender && isTty()
    ? { pending: '', inFence: false, inTable: false, renderedBytes: 0, fallback: false, noticedFallback: false }
    : null;

  let lastLength = 0;
  const renderLiveChunk = (chunk: string): void => {
    if (!liveRenderState || chunk.length === 0) {
      process.stdout.write(chunk);
      return;
    }
    if (liveRenderState.fallback) {
      process.stdout.write(chunk);
      return;
    }

    liveRenderState.pending += chunk;
    const { chunks, remainder } = extractRenderableChunks(liveRenderState.pending, liveRenderState);
    liveRenderState.pending = remainder;

    for (const candidate of chunks) {
      const projected = liveRenderState.renderedBytes + Buffer.byteLength(candidate, 'utf8');
      if (projected > MAX_RENDER_BYTES) {
        if (!liveRenderState.noticedFallback) {
          console.log(dim(`Render skipped (log too large: > ${MAX_RENDER_BYTES} bytes). Showing raw text.`));
          liveRenderState.noticedFallback = true;
        }
        liveRenderState.fallback = true;
        process.stdout.write(candidate + liveRenderState.pending);
        liveRenderState.pending = '';
        return;
      }
      process.stdout.write(renderMarkdownAnsi(candidate));
      liveRenderState.renderedBytes += Buffer.byteLength(candidate, 'utf8');
    }
  };

  const flushRemainder = (): void => {
    if (!liveRenderState || liveRenderState.fallback) {
      return;
    }
    if (liveRenderState.pending.length === 0) {
      return;
    }
    const text = liveRenderState.pending;
    liveRenderState.pending = '';
    const projected = liveRenderState.renderedBytes + Buffer.byteLength(text, 'utf8');
    if (projected > MAX_RENDER_BYTES) {
      if (!liveRenderState.noticedFallback) {
        console.log(dim(`Render skipped (log too large: > ${MAX_RENDER_BYTES} bytes). Showing raw text.`));
      }
      process.stdout.write(text);
      liveRenderState.fallback = true;
      return;
    }
    process.stdout.write(renderMarkdownAnsi(text));
  };

  const printNew = async () => {
    const text = await buildSessionLogForDisplay(sessionId, metadata, normalizedModelFilter);
    const nextChunk = text.slice(lastLength);
    if (nextChunk.length > 0) {
      renderLiveChunk(nextChunk);
      lastLength = text.length;
    }
  };

  await printNew();

  // biome-ignore lint/nursery/noUnnecessaryConditions: deliberate infinite poll
  while (true) {
    const latest = await sessionStore.readSession(sessionId);
    if (!latest) {
      break;
    }
    if (latest.status === 'completed' || latest.status === 'error') {
      await printNew();
      flushRemainder();
      if (!options?.suppressMetadata) {
        if (latest.status === 'error' && latest.errorMessage) {
          console.log('\nResult:');
          console.log(`Session failed: ${latest.errorMessage}`);
        }
        if (latest.status === 'completed' && latest.usage) {
          const summary = formatCompletionSummary(latest, { includeSlug: true });
          if (summary) {
            console.log(`\n${chalk.green.bold(summary)}`);
          } else {
            const usage = latest.usage;
            console.log(
              `\nFinished (tok i/o/r/t: ${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens})`,
            );
          }
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
    'client-timeout': 'client timeout (deadline exceeded)',
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

export function trimBeforeFirstAnswer(logText: string): string {
  const marker = 'Answer:';
  const index = logText.indexOf(marker);
  if (index === -1) {
    return logText;
  }
  return logText.slice(index);
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
  console.log(dim(CLEANUP_TIP));
}

function matchesModel(entry: SessionMetadata, filter: string): boolean {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const models =
    entry.models?.map((model) => model.model.toLowerCase()) ?? (entry.model ? [entry.model.toLowerCase()] : []);
  return models.includes(normalized);
}

function formatModelColumn(entry: SessionMetadata, width: number, richTty: boolean): string {
  const models =
    entry.models && entry.models.length > 0
      ? entry.models
      : entry.model
        ? [{ model: entry.model, status: entry.status as SessionStatus }]
        : [];
  if (models.length === 0) {
    return 'n/a'.padEnd(width);
  }
  const badges = models.map((model) => formatModelBadge(model, richTty));
  const text = badges.join(' ');
  if (text.length > width) {
    return `${text.slice(0, width - 1)}…`;
  }
  return text.padEnd(width);
}

function formatModelBadge(model: SessionModelRun, richTty: boolean): string {
  const glyph = statusGlyph(model.status);
  const text = `${model.model}${glyph}`;
  return richTty ? chalk.cyan(text) : text;
}

function statusGlyph(status: SessionStatus | undefined): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'running':
      return '⌛';
    case 'pending':
      return '…';
    case 'error':
      return '✖';
    case 'cancelled':
      return '⦻';
    default:
      return '?';
  }
}

async function buildSessionLogForDisplay(
  sessionId: string,
  fallbackMeta: SessionMetadata,
  modelFilter?: string,
): Promise<string> {
  const normalizedFilter = modelFilter?.trim().toLowerCase();
  const freshMetadata = (await sessionStore.readSession(sessionId)) ?? fallbackMeta;
  const models = freshMetadata.models ?? fallbackMeta.models ?? [];
  if (models.length === 0) {
    if (normalizedFilter) {
      return await sessionStore.readModelLog(sessionId, modelFilter as string);
    }
    return await sessionStore.readLog(sessionId);
  }
  const candidates =
    normalizedFilter != null
      ? models.filter((model) => model.model.toLowerCase() === normalizedFilter)
      : models;
  if (candidates.length === 0) {
    return '';
  }
  const sections: string[] = [];
  for (const model of candidates) {
    const body = await sessionStore.readModelLog(sessionId, model.model);
    sections.push(`=== ${model.model} ===\n${body}`.trimEnd());
  }
  return sections.join('\n\n');
}

function extractRenderableChunks(text: string, state: LiveRenderState): { chunks: string[]; remainder: string } {
  const chunks: string[] = [];
  let buffer = '';
  const lines = text.split(/(\n)/);
  for (let i = 0; i < lines.length; i += 1) {
    const segment = lines[i];
    if (segment === '\n') {
      buffer += segment;
      // Detect code fences
      const prev = lines[i - 1] ?? '';
      const fenceMatch = prev.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
      if (!state.inFence && fenceMatch) {
        state.inFence = true;
        state.fenceDelimiter = fenceMatch[2];
      } else if (state.inFence && state.fenceDelimiter && prev.startsWith(state.fenceDelimiter)) {
        state.inFence = false;
        state.fenceDelimiter = undefined;
      }

      const trimmed = prev.trim();
      if (!state.inFence) {
        if (!state.inTable && trimmed.startsWith('|') && trimmed.includes('|')) {
          state.inTable = true;
        }
        if (state.inTable && trimmed === '') {
          state.inTable = false;
        }
      }

      const safeBreak = !state.inFence && !state.inTable && trimmed === '';
      if (safeBreak) {
        chunks.push(buffer);
        buffer = '';
      }
      continue;
    }
    buffer += segment;
  }
  return { chunks, remainder: buffer };
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const locale = 'en-US';
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: undefined,
    hour12: true,
  };
  const formatted = date.toLocaleString(locale, opts);
  return formatted.replace(/(, )(\d:)/, '$1 $2');
}

export function formatCompletionSummary(
  metadata: SessionMetadata,
  options: { includeSlug?: boolean } = {},
): string | null {
  if (!metadata.usage || metadata.elapsedMs == null) {
    return null;
  }
  const modeLabel = metadata.mode === 'browser' ? `${metadata.model ?? 'n/a'}[browser]` : metadata.model ?? 'n/a';
  const usage = metadata.usage;
  const cost = metadata.mode === 'browser' ? null : resolveCost(metadata);
  const costPart = cost != null ? ` | ${formatUSD(cost)}` : '';
  const tokensDisplay = `${usage.inputTokens}/${usage.outputTokens}/${usage.reasoningTokens}/${usage.totalTokens}`;
  const filesCount = metadata.options?.file?.length ?? 0;
  const filesPart = filesCount > 0 ? ` | files=${filesCount}` : '';
  const slugPart = options.includeSlug ? ` | slug=${metadata.id}` : '';
  return `Finished in ${formatElapsed(metadata.elapsedMs)} (${modeLabel}${costPart} | tok(i/o/r/t)=${tokensDisplay}${filesPart}${slugPart})`;
}

function resolveCost(metadata: SessionMetadata): number | null {
  if (metadata.mode === 'browser') {
    return null;
  }
  if (metadata.usage?.cost != null) {
    return metadata.usage.cost;
  }
  if (!metadata.model || !metadata.usage) {
    return null;
  }
  const pricing = MODEL_CONFIGS[metadata.model as keyof typeof MODEL_CONFIGS]?.pricing;
  if (!pricing) {
    return null;
  }
  const input = metadata.usage.inputTokens ?? 0;
  const output = metadata.usage.outputTokens ?? 0;
  const cost = input * pricing.inputPerToken + output * pricing.outputPerToken;
  return cost > 0 ? cost : null;
}

function formatCostTable(cost: number): string {
  return `$${cost.toFixed(3)}`.padStart(7);
}

async function readStoredPrompt(sessionId: string): Promise<string | null> {
  const request = await sessionStore.readRequest(sessionId);
  if (request?.prompt && request.prompt.trim().length > 0) {
    return request.prompt;
  }
  const meta = await sessionStore.readSession(sessionId);
  if (meta?.options?.prompt && meta.options.prompt.trim().length > 0) {
    return meta.options.prompt;
  }
  return null;
}
