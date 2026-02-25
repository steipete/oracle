import chalk from 'chalk';
import kleur from 'kleur';
import type {
  SessionMetadata,
  SessionTransportMetadata,
  SessionUserErrorMetadata,
} from '../sessionStore.js';
import type { OracleResponseMetadata } from '../oracle.js';
import { renderMarkdownAnsi } from './markdownRenderer.js';
import { formatFinishLine } from '../oracle/finishLine.js';
import { sessionStore, wait } from '../sessionStore.js';
import { formatTokenCount, formatTokenValue } from '../oracle/runUtils.js';
import type { BrowserLogger } from '../browser/types.js';
import { resumeBrowserSession } from '../browser/reattach.js';
import { estimateTokenCount } from '../browser/utils.js';
import { formatSessionTableHeader, formatSessionTableRow, resolveSessionCost } from './sessionTable.js';
import {
  abbreviateResponseId,
  buildResponseOwnerIndex,
  resolveSessionLineage,
} from './sessionLineage.js';

const isTty = (): boolean => Boolean(process.stdout.isTTY);
const dim = (text: string): string => (isTty() ? kleur.dim(text) : text);
export const MAX_RENDER_BYTES = 200_000;

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
  const responseOwners = buildResponseOwnerIndex(metas);
  if (!filteredEntries.length) {
    console.log(CLEANUP_TIP);
    if (showExamples) {
      printStatusExamples();
    }
    return;
  }
  console.log(chalk.bold('Recent Sessions'));
  console.log(formatSessionTableHeader(richTty));
  const treeRows = buildStatusTreeRows(filteredEntries, responseOwners);
  for (const row of treeRows) {
    const line = formatSessionTableRow(row.entry, { rich: richTty, displaySlug: row.displaySlug });
    const detachedParent =
      row.detachedParentLabel != null
        ? richTty
          ? chalk.gray(` <- ${row.detachedParentLabel}`)
          : ` <- ${row.detachedParentLabel}`
        : '';
    console.log(`${line}${detachedParent}`);
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
  let metadata = await sessionStore.readSession(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  if (metadata.mode === 'browser' && metadata.status === 'running' && !metadata.browser?.runtime) {
    await wait(250);
    const refreshed = await sessionStore.readSession(sessionId);
    if (refreshed) {
      metadata = refreshed;
    }
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
  const runtime = metadata.browser?.runtime;
  const controllerAlive = isProcessAlive(runtime?.controllerPid);

  const hasChromeDisconnect = metadata.response?.incompleteReason === 'chrome-disconnected';
  const statusAllowsReattach = metadata.status === 'running' || (metadata.status === 'error' && hasChromeDisconnect);
  const hasFallbackSessionInfo = Boolean(runtime?.chromePort || runtime?.tabUrl || runtime?.conversationId);
  const canReattach =
    statusAllowsReattach &&
    metadata.mode === 'browser' &&
    hasFallbackSessionInfo &&
    (hasChromeDisconnect || (runtime?.controllerPid && !controllerAlive));

  if (canReattach) {
    const portInfo = runtime?.chromePort ? `port ${runtime.chromePort}` : 'unknown port';
    const urlInfo = runtime?.tabUrl ? `url=${runtime.tabUrl}` : 'url=unknown';
    console.log(chalk.yellow(`Attempting to reattach to the existing Chrome session (${portInfo}, ${urlInfo})...`));
    try {
      const result = await resumeBrowserSession(
        runtime as NonNullable<typeof runtime>,
        metadata.browser?.config,
        Object.assign(
          ((message?: string) => {
            if (message) {
              console.log(dim(message));
            }
          }) as unknown as BrowserLogger,
          { verbose: true },
        ),
        { promptPreview: metadata.promptPreview },
      );
      const outputTokens = estimateTokenCount(result.answerMarkdown);
      const logWriter = sessionStore.createLogWriter(sessionId);
      logWriter.logLine('[reattach] captured assistant response from existing Chrome tab');
      logWriter.logLine('Answer:');
      logWriter.logLine(result.answerMarkdown || result.answerText);
      logWriter.stream.end();
      if (metadata.model) {
        await sessionStore.updateModelRun(metadata.id, metadata.model, {
          status: 'completed',
          usage: {
            inputTokens: 0,
            outputTokens,
            reasoningTokens: 0,
            totalTokens: outputTokens,
          },
          completedAt: new Date().toISOString(),
        });
      }
      await sessionStore.updateSession(sessionId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        usage: {
          inputTokens: 0,
          outputTokens,
          reasoningTokens: 0,
          totalTokens: outputTokens,
        },
        browser: {
          config: metadata.browser?.config,
          runtime,
        },
        response: { status: 'completed' },
        error: undefined,
        transport: undefined,
      });
      console.log(chalk.green('Reattach succeeded; session marked completed.'));
      metadata = (await sessionStore.readSession(sessionId)) ?? metadata;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`Reattach failed: ${message}`));
    }
  }
  if (!options?.suppressMetadata) {
    const reattachLine = buildReattachLine(metadata);
    if (reattachLine) {
      console.log(chalk.blue(reattachLine));
    }
    const chainLine = await buildSessionChainLine(metadata);
    if (chainLine) {
      console.log(dim(`Chain: ${chainLine}`));
    }
    console.log(`Created: ${metadata.createdAt}`);
    console.log(`Status: ${metadata.status}`);
    if (metadata.models && metadata.models.length > 0) {
      console.log('Models:');
      for (const run of metadata.models) {
        const usage = run.usage
          ? ` tok=${formatTokenCount(run.usage.outputTokens ?? 0)}/${formatTokenCount(run.usage.totalTokens ?? 0)}`
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

interface StatusTreeRow {
  entry: SessionMetadata;
  displaySlug: string;
  detachedParentLabel?: string;
}

function buildStatusTreeRows(
  entries: SessionMetadata[],
  responseOwners: ReadonlyMap<string, string>,
): StatusTreeRow[] {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const orderIndex = new Map(entries.map((entry, index) => [entry.id, index]));
  const lineageById = new Map<string, ReturnType<typeof resolveSessionLineage>>();
  const childMap = new Map<string, SessionMetadata[]>();

  for (const entry of entries) {
    const lineage = resolveSessionLineage(entry, responseOwners);
    lineageById.set(entry.id, lineage);
    const parentId = lineage?.parentSessionId;
    if (parentId && parentId !== entry.id && entryById.has(parentId)) {
      const siblings = childMap.get(parentId) ?? [];
      siblings.push(entry);
      childMap.set(parentId, siblings);
    }
  }

  for (const siblings of childMap.values()) {
    siblings.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
  }

  const rows: StatusTreeRow[] = [];
  const visited = new Set<string>();

  const walkChild = (entry: SessionMetadata, ancestorHasMore: boolean[], isLast: boolean): void => {
    if (visited.has(entry.id)) {
      return;
    }
    visited.add(entry.id);
    const children = childMap.get(entry.id) ?? [];
    const nodeBranch = isLast ? '└─ ' : '├─ ';
    const prefix = `${ancestorHasMore.map((hasMore) => (hasMore ? '│  ' : '   ')).join('')}${nodeBranch}`;
    rows.push({ entry, displaySlug: `${prefix}${entry.id}` });

    children.forEach((child, index) => {
      walkChild(child, [...ancestorHasMore, !isLast], index === children.length - 1);
    });
  };

  const walkRoot = (entry: SessionMetadata): void => {
    if (visited.has(entry.id)) {
      return;
    }
    visited.add(entry.id);
    const lineage = lineageById.get(entry.id);
    const hiddenParent =
      lineage?.parentSessionId && !entryById.has(lineage.parentSessionId)
        ? `${lineage.parentSessionId} (${abbreviateResponseId(lineage.parentResponseId)})`
        : undefined;
    const children = childMap.get(entry.id) ?? [];
    rows.push({ entry, displaySlug: entry.id, detachedParentLabel: hiddenParent });
    children.forEach((child, index) => {
      walkChild(child, [], index === children.length - 1);
    });
  };

  const roots = entries.filter((entry) => {
    const parentId = lineageById.get(entry.id)?.parentSessionId;
    return !(parentId && parentId !== entry.id && entryById.has(parentId));
  });

  roots.forEach((entry) => walkRoot(entry));
  entries.forEach((entry) => walkRoot(entry));
  return rows;
}

async function buildSessionChainLine(metadata: SessionMetadata): Promise<string | null> {
  const lineageWithoutLookup = resolveSessionLineage(metadata);
  if (!lineageWithoutLookup) {
    return `root -> ${metadata.id}`;
  }
  if (lineageWithoutLookup.parentSessionId) {
    return `${lineageWithoutLookup.parentSessionId} (${abbreviateResponseId(lineageWithoutLookup.parentResponseId)}) -> ${
      metadata.id
    }`;
  }
  const sessions = await sessionStore.listSessions().catch(() => []);
  const responseOwners = buildResponseOwnerIndex(sessions);
  const lineage = resolveSessionLineage(metadata, responseOwners) ?? lineageWithoutLookup;
  if (lineage.parentSessionId) {
    return `${lineage.parentSessionId} (${abbreviateResponseId(lineage.parentResponseId)}) -> ${metadata.id}`;
  }
  return `${abbreviateResponseId(lineage.parentResponseId)} -> ${metadata.id}`;
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
    normalizedFilter
      ? models.filter((model) => model.model.toLowerCase() === normalizedFilter)
      : models;
  if (candidates.length === 0) {
    return '';
  }
  const sections: string[] = [];
  let hasContent = false;
  for (const model of candidates) {
    const body = (await sessionStore.readModelLog(sessionId, model.model)) ?? '';
    if (body.trim().length > 0) {
      hasContent = true;
    }
    sections.push(`=== ${model.model} ===\n${body}`.trimEnd());
  }
  if (!hasContent) {
    // Fallback for runs that recorded output only in the session log (e.g., browser runs without per-model logs).
    return await sessionStore.readLog(sessionId);
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

export function formatCompletionSummary(
  metadata: SessionMetadata,
  options: { includeSlug?: boolean } = {},
): string | null {
  if (!metadata.usage || metadata.elapsedMs == null) {
    return null;
  }
  const modeLabel = metadata.mode === 'browser' ? `${metadata.model ?? 'n/a'}[browser]` : metadata.model ?? 'n/a';
  const usage = metadata.usage;
  const cost = resolveSessionCost(metadata);
  const tokensDisplay = [
    usage.inputTokens ?? 0,
    usage.outputTokens ?? 0,
    usage.reasoningTokens ?? 0,
    usage.totalTokens ?? 0,
  ]
    .map((value, index) =>
      formatTokenValue(value, {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        reasoning_tokens: usage.reasoningTokens,
        total_tokens: usage.totalTokens,
      }, index),
    )
    .join('/');
  const tokensPart = (() => {
    const parts = tokensDisplay.split('/');
    if (parts.length !== 4) return tokensDisplay;
    return `↑${parts[0]} ↓${parts[1]} ↻${parts[2]} Δ${parts[3]}`;
  })();
  const filesCount = metadata.options?.file?.length ?? 0;
  const filesPart = filesCount > 0 ? `files=${filesCount}` : null;
  const slugPart = options.includeSlug ? `slug=${metadata.id}` : null;
  const { line1, line2 } = formatFinishLine({
    elapsedMs: metadata.elapsedMs,
    model: modeLabel,
    costUsd: cost ?? null,
    tokensPart,
    detailParts: [filesPart, slugPart],
  });
  return line2 ? `${line1} | ${line2}` : line1;
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
