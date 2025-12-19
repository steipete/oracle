import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionMetadata } from '../sessionStore.js';
import type { RunOracleOptions, ModelName, UsageSummary } from '../oracle.js';
import {
  runOracle,
  OracleResponseError,
  OracleTransportError,
  extractResponseMetadata,
  asOracleUserError,
  extractTextOutput,
} from '../oracle.js';
import type { SessionStore } from '../sessionStore.js';
import { sessionStore } from '../sessionStore.js';
import { findOscProgressSequences, OSC_PROGRESS_PREFIX } from 'osc-progress';

export interface MultiModelRunParams {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  models: ModelName[];
  cwd: string;
  version: string;
  /** Optional callback invoked as soon as an individual model finishes (before aggregate completion). */
  onModelDone?: (result: ModelExecutionResult) => Promise<void> | void;
}

export interface ModelExecutionResult {
  model: ModelName;
  usage: UsageSummary;
  answerText: string;
  logPath: string;
}

export interface MultiModelRunSummary {
  fulfilled: ModelExecutionResult[];
  rejected: Array<{ model: ModelName; reason: unknown }>;
  elapsedMs: number;
}

interface MultiModelRunDependencies {
  store?: SessionStore;
  runOracleImpl?: typeof runOracle;
  now?: () => number;
}

function forwardOscProgress(chunk: string, shouldForward: boolean): void {
  if (!shouldForward || !chunk.includes(OSC_PROGRESS_PREFIX)) {
    return;
  }
  for (const seq of findOscProgressSequences(chunk)) {
    process.stdout.write(seq.raw);
  }
}

const defaultDeps: MultiModelRunDependencies = {
  store: sessionStore,
  runOracleImpl: runOracle,
  now: () => Date.now(),
};

export async function runMultiModelApiSession(
  params: MultiModelRunParams,
  deps: MultiModelRunDependencies = defaultDeps,
): Promise<MultiModelRunSummary> {
  const { sessionMeta, runOptions, models, cwd } = params;
  const { onModelDone } = params;
  const store = deps.store ?? sessionStore;
  const runOracleImpl = deps.runOracleImpl ?? runOracle;
  const now = deps.now ?? (() => Date.now());
  const startMark = now();

  const executions = models.map((model) =>
    startModelExecution({
      sessionMeta,
      runOptions,
      model,
      cwd,
      store,
      runOracleImpl,
    }),
  );
  const settled = await Promise.allSettled(
    executions.map((exec) =>
      exec.promise.then(
        async (value) => {
          if (onModelDone) {
            await onModelDone(value);
          }
          return value;
        },
        (error) => {
          throw error;
        },
      ),
    ),
  );
  const fulfilled: ModelExecutionResult[] = [];
  const rejected: Array<{ model: ModelName; reason: unknown }> = [];
  settled.forEach((result, index) => {
    const exec = executions[index];
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value);
    } else {
      rejected.push({ model: exec.model, reason: result.reason });
    }
  });

  return {
    fulfilled,
    rejected,
    elapsedMs: now() - startMark,
  };
}

function startModelExecution({
  sessionMeta,
  runOptions,
  model,
  cwd,
  store,
  runOracleImpl,
}: {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  model: ModelName;
  cwd: string;
  store: SessionStore;
  runOracleImpl: typeof runOracle;
}): { model: ModelName; promise: Promise<ModelExecutionResult> } {
  const logWriter = store.createLogWriter(sessionMeta.id, model);
  const perModelOptions: RunOracleOptions = {
    ...runOptions,
    model,
    models: undefined,
    sessionId: `${sessionMeta.id}:${model}`,
  };
  const perModelLog = (message?: string): void => {
    logWriter.logLine(message ?? '');
  };
  const mirrorOscProgress = process.stdout.isTTY === true;
  const perModelWrite = (chunk: string): boolean => {
    logWriter.writeChunk(chunk);
    forwardOscProgress(chunk, mirrorOscProgress);
    return true;
  };

  const promise = (async () => {
    await store.updateModelRun(sessionMeta.id, model, {
      status: 'running',
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });
    const result = await runOracleImpl(
      {
        ...perModelOptions,
        effectiveModelId: model,
        // Drop per-model preamble; the aggregate runner prints the shared header and tips once.
        suppressHeader: true,
        suppressAnswerHeader: true,
        suppressTips: true,
      },
      {
        cwd,
        log: perModelLog,
        write: perModelWrite,
      },
    );
    if (result.mode !== 'live') {
      throw new Error('Unexpected preview result while running a session.');
    }
    const answerText = extractTextOutput(result.response);
    await store.updateModelRun(sessionMeta.id, model, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      usage: result.usage,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
      log: await describeLog(sessionMeta.id, logWriter.logPath, store),
    });
    return {
      model,
      usage: result.usage,
      answerText,
      logPath: logWriter.logPath,
    };
  })()
    .catch(async (error) => {
      const userError = asOracleUserError(error);
      const responseMetadata = error instanceof OracleResponseError ? error.metadata : undefined;
      const transportMetadata = error instanceof OracleTransportError ? { reason: error.reason } : undefined;
      await store.updateModelRun(sessionMeta.id, model, {
        status: 'error',
        completedAt: new Date().toISOString(),
        response: responseMetadata,
        transport: transportMetadata,
        error: userError
          ? {
              category: userError.category,
              message: userError.message,
              details: userError.details,
            }
          : undefined,
        log: await describeLog(sessionMeta.id, logWriter.logPath, store),
      });
      throw error;
    })
    .finally(() => {
      logWriter.stream.end();
    });

  return { model, promise };
}

async function describeLog(
  sessionId: string,
  logFilePath: string,
  store: SessionStore,
): Promise<{ path: string; bytes?: number }> {
  const { dir } = await store.getPaths(sessionId);
  const relative = path.relative(dir, logFilePath);
  try {
    const stats = await fsStat(logFilePath);
    return { path: relative, bytes: stats.size };
  } catch {
    return { path: relative };
  }
}

async function fsStat(target: string): Promise<{ size: number }> {
  const stats = await fs.stat(target);
  return { size: stats.size };
}
