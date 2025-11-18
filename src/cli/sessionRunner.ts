import kleur from 'kleur';
import type { SessionMetadata, SessionMode, BrowserSessionConfig } from '../sessionManager.js';
import { updateSessionMetadata } from '../sessionManager.js';
import type { RunOracleOptions } from '../oracle.js';
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
      );
      return;
    }
    const result = await runOracle(runOptions, {
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
    throw error;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
