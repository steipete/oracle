import kleur from 'kleur';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionMetadata, SessionMode, BrowserSessionConfig } from '../sessionManager.js';
import {
  updateSessionMetadata,
  createSessionLogWriter,
  updateModelRunMetadata,
  SESSIONS_DIR,
} from '../sessionManager.js';
import type { RunOracleOptions, ModelName, UsageSummary } from '../oracle.js';
import {
  runOracle,
  OracleResponseError,
  OracleTransportError,
  extractResponseMetadata,
  asOracleUserError,
  extractTextOutput,
  } from '../oracle.js';
import { runBrowserSessionExecution } from '../browser/sessionRunner.js';
import { formatResponseMetadata, formatTransportMetadata } from './sessionDisplay.js';
import { markErrorLogged } from './errorUtils.js';
import {
  type NotificationSettings,
  sendSessionNotification,
  deriveNotificationSettingsFromMetadata,
} from './notifier.js';

const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);

export interface SessionRunParams {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  mode: SessionMode;
  browserConfig?: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
  write: (chunk: string) => boolean;
  version: string;
  notifications?: NotificationSettings;
}

export async function performSessionRun({
  sessionMeta,
  runOptions,
  mode,
  browserConfig,
  cwd,
  log,
  write,
  version,
  notifications,
}: SessionRunParams): Promise<void> {
  await updateSessionMetadata(sessionMeta.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    mode,
    ...(browserConfig ? { browser: { config: browserConfig } } : {}),
  });
  const notificationSettings = notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env);
  try {
    if (mode === 'browser') {
      if (runOptions.model.startsWith('gemini')) {
        throw new Error('Gemini models are not available in browser mode. Re-run with --engine api.');
      }
      if (process.platform !== 'darwin') {
        throw new Error(
          'Browser engine is only supported on macOS today. Use --engine api instead, or run on macOS.',
        );
      }
      if (!browserConfig) {
        throw new Error('Missing browser configuration for session.');
      }
      const result = await runBrowserSessionExecution(
        { runOptions, browserConfig, cwd, log, cliVersion: version },
        {},
      );
      await updateSessionMetadata(sessionMeta.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        browser: {
          config: browserConfig,
          runtime: result.runtime,
        },
        response: undefined,
        transport: undefined,
        error: undefined,
      });
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: sessionMeta.model,
          usage: result.usage,
          characters: result.answerText?.length,
        },
        notificationSettings,
        log,
        result.answerText?.slice(0, 140),
      );
      return;
    }
    const multiModels = Array.isArray(runOptions.models) ? runOptions.models.filter(Boolean) : [];
    if (multiModels.length > 1) {
      await runMultiModelApiSession({
        sessionMeta,
        runOptions,
        models: multiModels,
        cwd,
        log,
        write,
        version,
        notifications: notificationSettings,
      });
      return;
    }
    const singleModelOverride = multiModels.length === 1 ? multiModels[0] : undefined;
    const apiRunOptions: RunOracleOptions = singleModelOverride
      ? { ...runOptions, model: singleModelOverride, models: undefined }
      : runOptions;
    const result = await runOracle(apiRunOptions, {
      cwd,
      log,
      write,
    });
    if (result.mode !== 'live') {
      throw new Error('Unexpected preview result while running a session.');
    }
    await updateSessionMetadata(sessionMeta.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
    });
    const answerText = extractTextOutput(result.response);
    await sendSessionNotification(
      {
        sessionId: sessionMeta.id,
        sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
        mode,
        model: sessionMeta.model ?? runOptions.model,
        usage: result.usage,
        characters: answerText.length,
      },
      notificationSettings,
      log,
      answerText.slice(0, 140),
    );
  } catch (error: unknown) {
    const message = formatError(error);
    log(`ERROR: ${message}`);
    markErrorLogged(error);
    const userError = asOracleUserError(error);
    if (userError) {
      log(dim(`User error (${userError.category}): ${userError.message}`));
    }
    const responseMetadata = error instanceof OracleResponseError ? error.metadata : undefined;
    const metadataLine = formatResponseMetadata(responseMetadata);
    if (metadataLine) {
      log(dim(`Response metadata: ${metadataLine}`));
    }
    const transportMetadata = error instanceof OracleTransportError ? { reason: error.reason } : undefined;
    const transportLine = formatTransportMetadata(transportMetadata);
    if (transportLine) {
      log(dim(`Transport: ${transportLine}`));
    }
    await updateSessionMetadata(sessionMeta.id, {
      status: 'error',
      completedAt: new Date().toISOString(),
      errorMessage: message,
      mode,
      browser: browserConfig ? { config: browserConfig } : undefined,
      response: responseMetadata,
      transport: transportMetadata,
      error: userError
        ? {
            category: userError.category,
            message: userError.message,
            details: userError.details,
          }
        : undefined,
    });
    if (mode === 'browser') {
      log(dim('Browser fallback:')); // guides users when automation breaks
      log(dim('- Use --engine api to run the same prompt without Chrome.'));
      log(dim('- Add --browser-bundle-files to bundle attachments into a single text file you can drag into ChatGPT.'));
    }
    throw error;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ModelExecutionResult {
  model: ModelName;
  usage: UsageSummary;
  answerText: string;
  logPath: string;
}

interface ModelExecution {
  model: ModelName;
  logPath: string;
  promise: Promise<ModelExecutionResult>;
}

interface MultiModelRunParams {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  models: ModelName[];
  cwd: string;
  log: (message?: string) => void;
  write: (chunk: string) => boolean;
  version: string;
  notifications?: NotificationSettings;
}

async function runMultiModelApiSession(params: MultiModelRunParams): Promise<void> {
  const { sessionMeta, runOptions, models, cwd, log, write, version, notifications } = params;
  const startMs = Date.now();
  log(dim(`Multi-model run queued (${models.join(', ')}). Executing in parallel...`));
  const executions = models.map((model) =>
    startModelExecution({ sessionMeta, runOptions, model, cwd, version }),
  );
  const settled = await Promise.allSettled(executions.map((exec) => exec.promise));
  const fulfilled = settled.filter((entry): entry is PromiseFulfilledResult<ModelExecutionResult> => entry.status === 'fulfilled');
  const rejected = settled.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');

  for (const exec of executions) {
    log('');
    log(kleur.bold(`[${exec.model}] Answer:`));
    const body = await readLogSafe(exec.logPath);
    if (body.length === 0) {
      log(dim('(no output recorded)'));
      continue;
    }
    write(body);
    if (!body.endsWith('\n')) {
      log('');
    }
  }

  const aggregateUsage = fulfilled.reduce<UsageSummary>(
    (acc, entry) => ({
      inputTokens: acc.inputTokens + entry.value.usage.inputTokens,
      outputTokens: acc.outputTokens + entry.value.usage.outputTokens,
      reasoningTokens: acc.reasoningTokens + entry.value.usage.reasoningTokens,
      totalTokens: acc.totalTokens + entry.value.usage.totalTokens,
      cost:
        (acc.cost ?? 0) +
        (entry.value.usage.cost ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 },
  );

  const elapsedMs = Date.now() - startMs;
  const hasFailure = rejected.length > 0;
  await updateSessionMetadata(sessionMeta.id, {
    status: hasFailure ? 'error' : 'completed',
    completedAt: new Date().toISOString(),
    usage: aggregateUsage,
    elapsedMs,
    response: undefined,
    transport: undefined,
    error: undefined,
  });

  const totalCharacters = fulfilled.reduce((sum, entry) => sum + entry.value.answerText.length, 0);
  await sendSessionNotification(
    {
      sessionId: sessionMeta.id,
      sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
      mode: 'api',
      model: `${models.length} models`,
      usage: aggregateUsage,
      characters: totalCharacters,
    },
    notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env),
    log,
  );

  if (hasFailure) {
    throw rejected[0].reason;
  }
}

async function readLogSafe(logPath: string): Promise<string> {
  try {
    return await fs.readFile(logPath, 'utf8');
  } catch {
    return '';
  }
}

function startModelExecution({
  sessionMeta,
  runOptions,
  model,
  cwd,
  version,
}: {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  model: ModelName;
  cwd: string;
  version: string;
}): ModelExecution {
  const logWriter = createSessionLogWriter(sessionMeta.id, model);
  const perModelOptions: RunOracleOptions = {
    ...runOptions,
    model,
    models: undefined,
    sessionId: `${sessionMeta.id}:${model}`,
  };
  const perModelLog = (message?: string): void => {
    logWriter.logLine(message ?? '');
  };
  const perModelWrite = (chunk: string): boolean => {
    logWriter.writeChunk(chunk);
    return true;
  };

  const promise = (async () => {
    await updateModelRunMetadata(sessionMeta.id, model, {
      status: 'running',
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });
    perModelLog(`🧿 oracle (${version}) summons ${model}`);
    const result = await runOracle(perModelOptions, {
      cwd,
      log: perModelLog,
      write: perModelWrite,
    });
    if (result.mode !== 'live') {
      throw new Error('Unexpected preview result while running a session.');
    }
    const answerText = extractTextOutput(result.response);
    await updateModelRunMetadata(sessionMeta.id, model, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      usage: result.usage,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
      log: await describeLog(sessionMeta.id, logWriter.logPath),
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
      await updateModelRunMetadata(sessionMeta.id, model, {
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
        log: await describeLog(sessionMeta.id, logWriter.logPath),
      });
      throw error;
    })
    .finally(() => {
      logWriter.stream.end();
    });

  return { model, logPath: logWriter.logPath, promise };
}

async function describeLog(sessionId: string, logFilePath: string): Promise<{ path: string; bytes?: number }> {
  const dir = path.join(SESSIONS_DIR, sessionId);
  const relative = path.relative(dir, logFilePath);
  try {
    const stats = await fs.stat(logFilePath);
    return { path: relative, bytes: stats.size };
  } catch {
    return { path: relative };
  }
}
