import chalk from 'chalk';
import kleur from 'kleur';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import type {
  ClientLike,
  OracleResponse,
  OracleRequestBody,
  PreviewMode,
  ResponseStreamLike,
  RunOracleDeps,
  RunOracleOptions,
  RunOracleResult,
} from './types.js';
import { DEFAULT_SYSTEM_PROMPT, MODEL_CONFIGS, TOKENIZER_OPTIONS } from './config.js';
import { readFiles } from './files.js';
import { buildPrompt, buildRequestBody } from './request.js';
import { estimateRequestTokens } from './tokenEstimate.js';
import { formatElapsed, formatUSD } from './format.js';
import { getFileTokenStats, printFileTokenStats } from './tokenStats.js';
import {
  OracleResponseError,
  OracleTransportError,
  PromptValidationError,
  describeTransportError,
  toTransportError,
} from './errors.js';
import { createDefaultClientFactory } from './client.js';
import { startHeartbeat } from '../heartbeat.js';
import { startOscProgress } from './oscProgress.js';
import { getCliVersion } from '../version.js';
import { createFsAdapter } from './fsAdapter.js';
const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);
const BACKGROUND_MAX_WAIT_MS = 30 * 60 * 1000;
const BACKGROUND_POLL_INTERVAL_MS = 5000;
const BACKGROUND_RETRY_BASE_MS = 3000;
const BACKGROUND_RETRY_MAX_MS = 15000;

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function runOracle(options: RunOracleOptions, deps: RunOracleDeps = {}): Promise<RunOracleResult> {
  const {
    apiKey = options.apiKey ?? process.env.OPENAI_API_KEY,
    cwd = process.cwd(),
    fs: fsModule = createFsAdapter(fs),
    log = console.log,
    write = (text: string) => process.stdout.write(text),
    now = () => performance.now(),
    clientFactory = createDefaultClientFactory(),
    client,
    wait = defaultWait,
  } = deps;
  const baseUrl = options.baseUrl?.trim() || process.env.OPENAI_BASE_URL?.trim();

  const maskApiKey = (key: string | undefined | null): string | null => {
    if (!key) return null;
    if (key.length <= 8) return `${key[0] ?? ''}***${key[key.length - 1] ?? ''}`;
    const prefix = key.slice(0, 4);
    const suffix = key.slice(-4);
    return `${prefix}****${suffix}`;
  };

  const logVerbose = (message: string): void => {
    if (options.verbose) {
      log(dim(`[verbose] ${message}`));
    }
  };

  const previewMode = resolvePreviewMode(options.previewMode ?? options.preview);
  const isPreview = Boolean(previewMode);

  if (!apiKey) {
    throw new PromptValidationError('Missing OPENAI_API_KEY. Set it via the environment or a .env file.', {
      env: 'OPENAI_API_KEY',
    });
  }

  const maskedKey = maskApiKey(apiKey);
  if (maskedKey) {
    log(dim(`Using OPENAI_API_KEY=${maskedKey}`));
  }
  if (baseUrl) {
    log(dim(`Using OpenAI BASE URL: ${baseUrl}`));
  }

  const modelConfig = MODEL_CONFIGS[options.model];
  if (!modelConfig) {
    throw new PromptValidationError(
      `Unsupported model "${options.model}". Choose one of: ${Object.keys(MODEL_CONFIGS).join(', ')}`,
      { model: options.model },
    );
  }
  const useBackground = options.background ?? (options.model === 'gpt-5-pro');

  const inputTokenBudget = options.maxInput ?? modelConfig.inputLimit;
  const files = await readFiles(options.file ?? [], { cwd, fsModule });
  const searchEnabled = options.search !== false;
  logVerbose(`cwd: ${cwd}`);
  if (files.length > 0) {
    const displayPaths = files
      .map((file) => path.relative(cwd, file.path) || file.path)
      .slice(0, 10)
      .join(', ');
    const extra = files.length > 10 ? ` (+${files.length - 10} more)` : '';
    logVerbose(`Attached files (${files.length}): ${displayPaths}${extra}`);
  } else {
    logVerbose('No files attached.');
    if (!isPreview) {
      log(dim('Tip: no files attached — Oracle works best with project context. Add files via --file path/to/code or docs.'));
    }
  }
  const fileTokenInfo = getFileTokenStats(files, {
    cwd,
    tokenizer: modelConfig.tokenizer,
    tokenizerOptions: TOKENIZER_OPTIONS,
    inputTokenBudget,
  });
  const totalFileTokens = fileTokenInfo.totalTokens;
  logVerbose(`Attached files use ${totalFileTokens.toLocaleString()} tokens`);

  const systemPrompt = options.system?.trim() || DEFAULT_SYSTEM_PROMPT;
  const promptWithFiles = buildPrompt(options.prompt, files, cwd);
  const fileCount = files.length;
  const cliVersion = getCliVersion();
  const richTty = process.stdout.isTTY && chalk.level > 0;
  const headerModelLabel = richTty ? chalk.cyan(modelConfig.model) : modelConfig.model;
  const requestBody = buildRequestBody({
    modelConfig,
    systemPrompt,
    userPrompt: promptWithFiles,
    searchEnabled,
    maxOutputTokens: options.maxOutput,
    background: useBackground,
    storeResponse: useBackground,
  });
  const estimatedInputTokens = estimateRequestTokens(requestBody, modelConfig);
  const tokenLabel = richTty ? chalk.green(estimatedInputTokens.toLocaleString()) : estimatedInputTokens.toLocaleString();
  const fileLabel = richTty ? chalk.magenta(fileCount.toString()) : fileCount.toString();
  const headerLine = `oracle (${cliVersion}) consulting ${headerModelLabel}'s crystal ball with ${tokenLabel} tokens and ${fileLabel} files...`;
  const shouldReportFiles =
    (options.filesReport || fileTokenInfo.totalTokens > inputTokenBudget) && fileTokenInfo.stats.length > 0;
  if (!isPreview) {
    log(headerLine);
    if (options.model === 'gpt-5-pro') {
      log(dim('Pro is thinking, this can take up to 30 minutes...'));
    }
    log(dim('Press Ctrl+C to cancel.'));
  }
  if (shouldReportFiles) {
    printFileTokenStats(fileTokenInfo, { inputTokenBudget, log });
  }
  if (estimatedInputTokens > inputTokenBudget) {
    throw new PromptValidationError(
      `Input too large (${estimatedInputTokens.toLocaleString()} tokens). Limit is ${inputTokenBudget.toLocaleString()} tokens.`,
      { estimatedInputTokens, inputTokenBudget },
    );
  }

  logVerbose(`Estimated tokens (request body): ${estimatedInputTokens.toLocaleString()}`);

  if (isPreview && previewMode) {
    if (previewMode === 'json' || previewMode === 'full') {
      log('Request JSON');
      log(JSON.stringify(requestBody, null, 2));
      log('');
    }
    if (previewMode === 'full') {
      log('Assembled Prompt');
      log(promptWithFiles);
      log('');
    }
    log(
      `Estimated input tokens: ${estimatedInputTokens.toLocaleString()} / ${inputTokenBudget.toLocaleString()} (model: ${modelConfig.model})`,
    );
    return {
      mode: 'preview',
      previewMode,
      requestBody,
      estimatedInputTokens,
      inputTokenBudget,
    };
  }

  const openAiClient: ClientLike = client ?? clientFactory(apiKey, { baseUrl });
  logVerbose('Dispatching request to OpenAI Responses API...');
  const stopOscProgress = startOscProgress({
    label: useBackground ? 'Waiting for OpenAI (background)' : 'Waiting for OpenAI',
    targetMs: useBackground ? BACKGROUND_MAX_WAIT_MS : 10 * 60_000,
    write,
  });

  const runStart = now();
  let response: OracleResponse | null = null;
  let elapsedMs = 0;
  let sawTextDelta = false;
  let answerHeaderPrinted = false;
  const ensureAnswerHeader = () => {
    if (!options.silent && !answerHeaderPrinted) {
      log('');
      log(chalk.bold('Answer:'));
      answerHeaderPrinted = true;
    }
  };

  try {
    if (useBackground) {
      response = await executeBackgroundResponse({
        client: openAiClient,
        requestBody,
        log,
        wait,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        now,
      });
      elapsedMs = now() - runStart;
    } else {
      const stream: ResponseStreamLike = await openAiClient.responses.stream(requestBody);
      let heartbeatActive = false;
      let stopHeartbeat: (() => void) | null = null;
      const stopHeartbeatNow = () => {
        if (!heartbeatActive) {
          return;
        }
        heartbeatActive = false;
        stopHeartbeat?.();
        stopHeartbeat = null;
      };
      if (options.heartbeatIntervalMs && options.heartbeatIntervalMs > 0) {
        heartbeatActive = true;
        stopHeartbeat = startHeartbeat({
          intervalMs: options.heartbeatIntervalMs,
          log: (message) => log(message),
          isActive: () => heartbeatActive,
          makeMessage: (elapsedMs) => {
            const elapsedText = formatElapsed(elapsedMs);
            return `API connection active — ${elapsedText} elapsed. Expect up to ~10 min before GPT-5 responds.`;
          },
        });
      }
      try {
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') {
            stopOscProgress();
            stopHeartbeatNow();
            sawTextDelta = true;
            ensureAnswerHeader();
            if (!options.silent && typeof event.delta === 'string') {
              write(event.delta);
            }
          }
        }
      } catch (streamError) {
        if (typeof stream.abort === 'function') {
          stream.abort();
        }
        stopHeartbeatNow();
        const transportError = toTransportError(streamError);
        log(chalk.yellow(describeTransportError(transportError)));
        throw transportError;
      }
      response = await stream.finalResponse();
      stopHeartbeatNow();
      elapsedMs = now() - runStart;
    }
  } finally {
    stopOscProgress();
  }

  if (!response) {
    throw new Error('OpenAI did not return a response.');
  }

  logVerbose(`Response status: ${response.status ?? 'completed'}`);

  if (response.status && response.status !== 'completed') {
    // OpenAI can reply `in_progress` even after the stream closes; give it a brief grace poll.
    if (response.id && response.status === 'in_progress') {
      const polishingStart = now();
      const pollIntervalMs = 2_000;
      const maxWaitMs = 60_000;
      log(chalk.dim('Response still in_progress; polling until completion...'));
      // Short polling loop — we don't want to hang forever, just catch late finalization.
      while (now() - polishingStart < maxWaitMs) {
        await wait(pollIntervalMs);
        const refreshed = await openAiClient.responses.retrieve(response.id);
        if (refreshed.status === 'completed') {
          response = refreshed;
          break;
        }
      }
    }

    if (response.status !== 'completed') {
      const detail = response.error?.message || response.incomplete_details?.reason || response.status;
      log(
        chalk.yellow(
          `OpenAI ended the run early (status=${response.status}${
            response.incomplete_details?.reason ? `, reason=${response.incomplete_details.reason}` : ''
          }).`,
        ),
      );
      throw new OracleResponseError(`Response did not complete: ${detail}`, response);
    }
  }

  const answerText = extractTextOutput(response);
  if (!options.silent) {
    // biome-ignore lint/nursery/noUnnecessaryConditions: flips true when streaming events arrive
    if (sawTextDelta) {
      write('\n\n');
    } else {
      ensureAnswerHeader();
      log(answerText || chalk.dim('(no text output)'));
      log('');
    }
  }

  const usage = response.usage ?? {};
  const inputTokens = usage.input_tokens ?? estimatedInputTokens;
  const outputTokens = usage.output_tokens ?? 0;
  const reasoningTokens = usage.reasoning_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens + reasoningTokens;
  const cost = inputTokens * modelConfig.pricing.inputPerToken + outputTokens * modelConfig.pricing.outputPerToken;

  const elapsedDisplay = formatElapsed(elapsedMs);
  const statsParts: string[] = [];
  const modelLabel = modelConfig.model + (modelConfig.reasoning ? '[high]' : '');
  statsParts.push(modelLabel);
  statsParts.push(formatUSD(cost));
  const tokensDisplay = [inputTokens, outputTokens, reasoningTokens, totalTokens]
    .map((value, index) => formatTokenValue(value, usage, index))
    .join('/');
  statsParts.push(`tok(i/o/r/t)=${tokensDisplay}`);
  const actualInput = usage.input_tokens;
  if (actualInput !== undefined) {
    const delta = actualInput - estimatedInputTokens;
    const deltaText = delta === 0 ? '' : delta > 0 ? ` (+${delta.toLocaleString()})` : ` (${delta.toLocaleString()})`;
    statsParts.push(
      `est→actual=${estimatedInputTokens.toLocaleString()}→${actualInput.toLocaleString()}${deltaText}`,
    );
  }
  if (!searchEnabled) {
    statsParts.push('search=off');
  }
  if (files.length > 0) {
    statsParts.push(`files=${files.length}`);
  }

  log(chalk.blue(`Finished in ${elapsedDisplay} (${statsParts.join(' | ')})`));

  return {
    mode: 'live',
    response,
    usage: { inputTokens, outputTokens, reasoningTokens, totalTokens, cost },
    elapsedMs,
  };
}

function formatTokenValue(
  value: number,
  usage: OracleResponse['usage'],
  index: number,
): string {
  const estimatedFlag =
    (index === 0 && usage?.input_tokens == null) ||
    (index === 1 && usage?.output_tokens == null) ||
    (index === 2 && usage?.reasoning_tokens == null) ||
    (index === 3 && usage?.total_tokens == null);
  const text = value.toLocaleString();
  return estimatedFlag ? `${text}*` : text;
}

function resolvePreviewMode(value: boolean | string | undefined): PreviewMode | undefined {
  const allowed = new Set<PreviewMode>(['summary', 'json', 'full']);
  if (typeof value === 'string' && value.length > 0) {
    return allowed.has(value as PreviewMode) ? (value as PreviewMode) : 'summary';
  }
  if (value) {
    return 'summary';
  }
  return undefined;
}

export function extractTextOutput(response: OracleResponse): string {
  if (Array.isArray(response.output_text) && response.output_text.length > 0) {
    return response.output_text.join('\n');
  }
  if (Array.isArray(response.output)) {
    const segments: string[] = [];
    for (const item of response.output) {
      if (Array.isArray(item.content)) {
        for (const chunk of item.content) {
          if (chunk && (chunk.type === 'output_text' || chunk.type === 'text') && chunk.text) {
            segments.push(chunk.text);
          }
        }
      } else if (typeof item.text === 'string') {
        segments.push(item.text);
      }
    }
    return segments.join('\n');
  }
  return '';
}

interface BackgroundExecutionParams {
  client: ClientLike;
  requestBody: OracleRequestBody;
  log: (message: string) => void;
  wait: (ms: number) => Promise<void>;
  heartbeatIntervalMs?: number;
  now: () => number;
}

async function executeBackgroundResponse(params: BackgroundExecutionParams): Promise<OracleResponse> {
  const { client, requestBody, log, wait, heartbeatIntervalMs, now } = params;
  const initialResponse = await client.responses.create(requestBody);
  if (!initialResponse || !initialResponse.id) {
    throw new OracleResponseError('OpenAI did not return a response ID for the background run.', initialResponse);
  }
  const responseId = initialResponse.id;
  log(
    dim(
      `OpenAI scheduled background response ${responseId} (status=${initialResponse.status ?? 'unknown'}). Monitoring up to ${Math.round(
        BACKGROUND_MAX_WAIT_MS / 60000,
      )} minutes for completion...`,
    ),
  );
  let heartbeatActive = false;
  let stopHeartbeat: (() => void) | null = null;
  const stopHeartbeatNow = () => {
    if (!heartbeatActive) {
      return;
    }
    heartbeatActive = false;
    stopHeartbeat?.();
    stopHeartbeat = null;
  };
  if (heartbeatIntervalMs && heartbeatIntervalMs > 0) {
    heartbeatActive = true;
    stopHeartbeat = startHeartbeat({
      intervalMs: heartbeatIntervalMs,
      log: (message) => log(message),
      isActive: () => heartbeatActive,
      makeMessage: (elapsedMs) => {
        const elapsedText = formatElapsed(elapsedMs);
        return `OpenAI background run still in progress — ${elapsedText} elapsed.`;
      },
    });
  }
  try {
    return await pollBackgroundResponse({
      client,
      responseId,
      initialResponse,
      log,
      wait,
      now,
      maxWaitMs: BACKGROUND_MAX_WAIT_MS,
    });
  } finally {
    stopHeartbeatNow();
  }
}

interface BackgroundPollParams {
  client: ClientLike;
  responseId: string;
  initialResponse: OracleResponse;
  log: (message: string) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  maxWaitMs: number;
}

async function pollBackgroundResponse(params: BackgroundPollParams): Promise<OracleResponse> {
  const { client, responseId, initialResponse, log, wait, now, maxWaitMs } = params;
  const startMark = now();
  let response = initialResponse;
  let firstCycle = true;
  let lastStatus: string | undefined = response.status;
  // biome-ignore lint/nursery/noUnnecessaryConditions: intentional polling loop
  while (true) {
    const status = response.status ?? 'completed';
    // biome-ignore lint/nursery/noUnnecessaryConditions: guard only for first iteration
    if (firstCycle) {
      firstCycle = false;
      log(dim(`OpenAI background response status=${status}. We'll keep retrying automatically.`));
    } else if (status !== lastStatus && status !== 'completed') {
      log(dim(`OpenAI background response status=${status}.`));
    }
    lastStatus = status;

    if (status === 'completed') {
      return response;
    }
    if (status !== 'in_progress' && status !== 'queued') {
      const detail = response.error?.message || response.incomplete_details?.reason || status;
      throw new OracleResponseError(`Response did not complete: ${detail}`, response);
    }
    if (now() - startMark >= maxWaitMs) {
      throw new OracleTransportError('client-timeout', 'Timed out waiting for OpenAI background response to finish.');
    }

    await wait(BACKGROUND_POLL_INTERVAL_MS);
    if (now() - startMark >= maxWaitMs) {
      throw new OracleTransportError('client-timeout', 'Timed out waiting for OpenAI background response to finish.');
    }
    const { response: nextResponse, reconnected } = await retrieveBackgroundResponseWithRetry({
      client,
      responseId,
      wait,
      now,
      maxWaitMs,
      startMark,
      log,
    });
    if (reconnected) {
      const nextStatus = nextResponse.status ?? 'in_progress';
      log(dim(`Reconnected to OpenAI background response (status=${nextStatus}). OpenAI is still working...`));
    }
    response = nextResponse;
  }
}

interface RetrieveRetryParams {
  client: ClientLike;
  responseId: string;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  maxWaitMs: number;
  startMark: number;
  log: (message: string) => void;
}

async function retrieveBackgroundResponseWithRetry(
  params: RetrieveRetryParams,
): Promise<{ response: OracleResponse; reconnected: boolean }> {
  const { client, responseId, wait, now, maxWaitMs, startMark, log } = params;
  let retries = 0;
  // biome-ignore lint/nursery/noUnnecessaryConditions: intentional retry loop
  while (true) {
    try {
      const next = await client.responses.retrieve(responseId);
      return { response: next, reconnected: retries > 0 };
    } catch (error) {
      const transportError = asRetryableTransportError(error);
      if (!transportError) {
        throw error;
      }
      retries += 1;
      const delay = Math.min(BACKGROUND_RETRY_BASE_MS * 2 ** (retries - 1), BACKGROUND_RETRY_MAX_MS);
      log(chalk.yellow(`${describeTransportError(transportError)} Retrying in ${formatElapsed(delay)}...`));
      await wait(delay);
      if (now() - startMark >= maxWaitMs) {
        throw new OracleTransportError('client-timeout', 'Timed out waiting for OpenAI background response to finish.');
      }
    }
  }
}

function asRetryableTransportError(error: unknown): OracleTransportError | null {
  if (error instanceof OracleTransportError) {
    return error;
  }
  if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) {
    return toTransportError(error);
  }
  return null;
}
