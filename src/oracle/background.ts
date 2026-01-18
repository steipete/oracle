import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import chalk from 'chalk';
import { formatElapsed } from './format.js';
import { startHeartbeat } from '../heartbeat.js';
import {
  OracleResponseError,
  OracleTransportError,
  describeTransportError,
  toTransportError,
} from './errors.js';
import type { ClientLike, OracleResponse, OracleRequestBody } from './types.js';

const BACKGROUND_POLL_INTERVAL_MS = 5000;
const BACKGROUND_RETRY_BASE_MS = 3000;
const BACKGROUND_RETRY_MAX_MS = 15000;

interface BackgroundExecutionParams {
  client: ClientLike;
  requestBody: OracleRequestBody;
  log: (message: string) => void;
  wait: (ms: number) => Promise<void>;
  heartbeatIntervalMs?: number;
  now: () => number;
  maxWaitMs: number;
}

export async function executeBackgroundResponse(params: BackgroundExecutionParams): Promise<OracleResponse> {
  const { client, requestBody, log, wait, heartbeatIntervalMs, now, maxWaitMs } = params;
  let initialResponse: OracleResponse;
  try {
    initialResponse = await client.responses.create(requestBody);
  } catch (error) {
    const transportError = toTransportError(error, requestBody.model);
    log(chalk.yellow(describeTransportError(transportError, maxWaitMs)));
    throw transportError;
  }
  if (!initialResponse || !initialResponse.id) {
    throw new OracleResponseError('API did not return a response ID for the background run.', initialResponse);
  }
  const responseId = initialResponse.id;
  log(
    chalk.dim(
      `API scheduled background response ${responseId} (status=${initialResponse.status ?? 'unknown'}). Monitoring up to ${Math.round(
        maxWaitMs / 60000,
      )} minutes for completion...`,
    ),
  );
  let heartbeatActive = false;
  let stopHeartbeat: (() => void) | null = null;
  const stopHeartbeatNow = () => {
    if (!heartbeatActive) return;
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
        return `API background run still in progress — ${elapsedText} elapsed.`;
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
      maxWaitMs,
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
  // biome-ignore lint/nursery/noUnnecessaryConditions: intentional polling loop.
  while (true) {
    const status = response.status ?? 'completed';
    // firstCycle toggles immediately; keep for clarity in logs.
    if (firstCycle) {
      firstCycle = false;
      log(chalk.dim(`API background response status=${status}. We'll keep retrying automatically.`));
    } else if (status !== lastStatus && status !== 'completed') {
      log(chalk.dim(`API background response status=${status}.`));
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
      throw new OracleTransportError('client-timeout', 'Timed out waiting for API background response to finish.');
    }

    await wait(BACKGROUND_POLL_INTERVAL_MS);
    if (now() - startMark >= maxWaitMs) {
      throw new OracleTransportError('client-timeout', 'Timed out waiting for API background response to finish.');
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
      log(chalk.dim(`Reconnected to API background response (status=${nextStatus}). API is still working...`));
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
      log(chalk.yellow(`${describeTransportError(transportError, maxWaitMs)} Retrying in ${formatElapsed(delay)}...`));
      await wait(delay);
      if (now() - startMark >= maxWaitMs) {
        throw new OracleTransportError('client-timeout', 'Timed out waiting for API background response to finish.');
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
