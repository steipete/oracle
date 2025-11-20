import kleur from 'kleur';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionMetadata, SessionMode, BrowserSessionConfig } from '../sessionStore.js';
import type { RunOracleOptions, UsageSummary } from '../oracle.js';
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
import { sessionStore } from '../sessionStore.js';
import { runMultiModelApiSession } from '../oracle/multiModelRunner.js';

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
  await sessionStore.updateSession(sessionMeta.id, {
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
      await sessionStore.updateSession(sessionMeta.id, {
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
      await writeAssistantOutput(runOptions.writeOutputPath, result.answerText, log);
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
    if (runOptions.writeOutputPath && multiModels.length > 1) {
      throw new Error('--write-output is not supported when running multiple models. Run one model at a time.');
    }
    if (multiModels.length > 1) {
      const summary = await runMultiModelApiSession({
        sessionMeta,
        runOptions,
        models: multiModels,
        cwd,
        version,
      });
      for (const result of summary.fulfilled) {
        log('');
        log(kleur.bold(`[${result.model}] Answer:`));
        const body = await sessionStore.readModelLog(sessionMeta.id, result.model);
        if (body.length === 0) {
          log(dim('(no output recorded)'));
          continue;
        }
        write(body);
        if (!body.endsWith('\n')) {
          log('');
        }
      }
      const aggregateUsage = summary.fulfilled.reduce<UsageSummary>(
        (acc, entry) => ({
          inputTokens: acc.inputTokens + entry.usage.inputTokens,
          outputTokens: acc.outputTokens + entry.usage.outputTokens,
          reasoningTokens: acc.reasoningTokens + entry.usage.reasoningTokens,
          totalTokens: acc.totalTokens + entry.usage.totalTokens,
          cost: (acc.cost ?? 0) + (entry.usage.cost ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 },
      );
      const hasFailure = summary.rejected.length > 0;
      await sessionStore.updateSession(sessionMeta.id, {
        status: hasFailure ? 'error' : 'completed',
        completedAt: new Date().toISOString(),
        usage: aggregateUsage,
        elapsedMs: summary.elapsedMs,
        response: undefined,
        transport: undefined,
        error: undefined,
      });
      const totalCharacters = summary.fulfilled.reduce((sum, entry) => sum + entry.answerText.length, 0);
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: `${multiModels.length} models`,
          usage: aggregateUsage,
          characters: totalCharacters,
        },
        notificationSettings,
        log,
      );
      if (hasFailure) {
        throw summary.rejected[0].reason;
      }
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
    await sessionStore.updateSession(sessionMeta.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
    });
    const answerText = extractTextOutput(result.response);
    await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
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
    await sessionStore.updateSession(sessionMeta.id, {
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

async function writeAssistantOutput(targetPath: string | undefined, content: string, log: (message: string) => void) {
  if (!targetPath) return;
  const payload = content.endsWith('\n') ? content : `${content}\n`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, payload, 'utf8');
  log(dim(`Saved assistant output to ${targetPath}`));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
