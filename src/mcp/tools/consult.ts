import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getCliVersion } from '../../version.js';
import { LoggingMessageNotificationParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureBrowserAvailable, mapConsultToRunOptions } from '../utils.js';
import type { BrowserSessionConfig, SessionModelRun } from '../../sessionStore.js';
import { sessionStore } from '../../sessionStore.js';
import { resolveRemoteServiceConfig } from '../../remote/remoteServiceConfig.js';
import { createRemoteBrowserExecutor } from '../../remote/client.js';
import type { BrowserSessionRunnerDeps } from '../../browser/sessionRunner.js';

async function readSessionLogTail(sessionId: string, maxBytes: number): Promise<string | null> {
  try {
    const log = await sessionStore.readLog(sessionId);
    if (log.length <= maxBytes) {
      return log;
    }
    return log.slice(-maxBytes);
  } catch {
    return null;
  }
}
import { performSessionRun } from '../../cli/sessionRunner.js';
import { CHATGPT_URL } from '../../browser/constants.js';
import { consultInputSchema } from '../types.js';
import { loadUserConfig } from '../../config.js';
import { resolveNotificationSettings } from '../../cli/notifier.js';
import { mapModelToBrowserLabel, resolveBrowserModelLabel } from '../../cli/browserConfig.js';

// Use raw shapes so the MCP SDK (with its bundled Zod) wraps them and emits valid JSON Schema.
const consultInputShape = {
  prompt: z
    .string()
    .min(1, 'Prompt is required.')
    .describe('User prompt to run.'),
  files: z
    .array(z.string())
    .default([])
    .describe(
      'Optional file paths or glob patterns (like the CLI `--file`). Resolved relative to the MCP server working directory.',
    ),
  model: z
    .string()
    .optional()
    .describe('Single model name/label. Prefer setting `engine` explicitly to avoid default surprises.'),
  models: z
    .array(z.string())
    .optional()
    .describe('Multi-model fan-out (API engine only). Cannot be combined with browser automation.'),
  engine: z
    .enum(['api', 'browser'])
    .optional()
    .describe(
      'Execution engine. `api` uses OpenAI/other providers. `browser` automates the ChatGPT web UI (supports attachments and ChatGPT-only model labels).',
    ),
  browserModelLabel: z
    .string()
    .optional()
    .describe(
      'Browser-only: explicit ChatGPT UI label to select (overrides model mapping). Example: "GPT-5.2 Thinking".',
    ),
  browserAttachments: z
    .enum(['auto', 'never', 'always'])
    .optional()
    .describe(
      'Browser-only: how to deliver `files`. Use "always" for real ChatGPT file uploads (including images/PDFs). Use "never" to paste file contents inline. "auto" chooses based on prompt size.',
    ),
  browserBundleFiles: z
    .boolean()
    .optional()
    .describe('Browser-only: bundle many files into a single upload (helps with upload limits).'),
  browserThinkingTime: z
    .enum(['light', 'standard', 'extended', 'heavy'])
    .optional()
    .describe('Browser-only: set ChatGPT thinking time when supported by the chosen model.'),
  browserKeepBrowser: z
    .boolean()
    .optional()
    .describe('Browser-only: keep Chrome running after completion (useful for debugging).'),
  search: z
    .boolean()
    .optional()
    .describe('API-only: enable/disable the provider search tool (browser engine ignores this).'),
  slug: z
    .string()
    .optional()
    .describe('Optional human-friendly session id (used for later `oracle sessions` lookups).'),
} satisfies z.ZodRawShape;

const consultModelSummaryShape = z.object({
  model: z.string(),
  status: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      reasoningTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
  response: z
    .object({
      id: z.string().optional(),
      requestId: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
  error: z
    .object({
      category: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  logPath: z.string().optional(),
});

const consultOutputShape = {
  sessionId: z.string(),
  status: z.string(),
  output: z.string(),
  models: z.array(consultModelSummaryShape).optional(),
} satisfies z.ZodRawShape;

export type ConsultModelSummary = z.infer<typeof consultModelSummaryShape>;

export function summarizeModelRunsForConsult(
  runs?: SessionModelRun[] | null,
): ConsultModelSummary[] | undefined {
  if (!runs || runs.length === 0) {
    return undefined;
  }
  return runs.map((run) => {
    const response = run.response
      ? {
          id: run.response.id ?? undefined,
          requestId: run.response.requestId ?? undefined,
          status: run.response.status ?? undefined,
        }
      : undefined;
    const error = run.error
      ? {
          category: run.error.category,
          message: run.error.message,
        }
      : undefined;
    return {
      model: run.model,
      status: run.status ?? 'unknown',
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      usage: run.usage,
      response,
      error,
      logPath: run.log?.path,
    };
  });
}

export function registerConsultTool(server: McpServer): void {
  server.registerTool(
    'consult',
    {
      title: 'Run an oracle session',
      description:
        'Run a one-shot Oracle session (API or ChatGPT browser automation). Use `files` to attach project context. For browser-based image/file uploads, set `browserAttachments:"always"`. Sessions are stored under `ORACLE_HOME_DIR` (shared with the CLI).',
      // Cast to any to satisfy SDK typings across differing Zod versions.
      inputSchema: consultInputShape,
      outputSchema: consultOutputShape,
    },
    async (input: unknown) => {
      const textContent = (text: string) => [{ type: 'text' as const, text }];
      const {
        prompt,
        files,
        model,
        models,
        engine,
        search,
        browserModelLabel,
        browserAttachments,
        browserBundleFiles,
        browserThinkingTime,
        browserKeepBrowser,
        slug,
      } = consultInputSchema.parse(input);
      const { config: userConfig } = await loadUserConfig();
      const { runOptions, resolvedEngine } = mapConsultToRunOptions({
        prompt,
        files: files ?? [],
        model,
        models,
        engine,
        search,
        browserAttachments,
        browserBundleFiles,
        userConfig,
        env: process.env,
      });
      const cwd = process.cwd();

      const resolvedRemote = resolveRemoteServiceConfig({ userConfig, env: process.env });
      const browserGuard = ensureBrowserAvailable(resolvedEngine, { remoteHost: resolvedRemote.host });
      if (resolvedEngine === 'browser' && browserGuard) {
        return {
          isError: true,
          content: textContent(browserGuard),
        };
      }

      let browserDeps: BrowserSessionRunnerDeps | undefined;
      if (resolvedEngine === 'browser' && resolvedRemote.host) {
        if (!resolvedRemote.token) {
          return {
            isError: true,
            content: textContent(
              `Remote host configured (${resolvedRemote.host}) but remote token is missing. Run \`oracle bridge client --connect <...>\` or set ORACLE_REMOTE_TOKEN.`,
            ),
          };
        }
        browserDeps = {
          executeBrowser: createRemoteBrowserExecutor({ host: resolvedRemote.host, token: resolvedRemote.token }),
        };
      }

      let browserConfig: BrowserSessionConfig | undefined;
      if (resolvedEngine === 'browser') {
        const envProfileDir = (process.env.ORACLE_BROWSER_PROFILE_DIR ?? '').trim();
        const hasProfileDir = envProfileDir.length > 0;
        const preferredLabel = (browserModelLabel ?? model)?.trim();
        const isChatGptModel = runOptions.model.startsWith('gpt-') && !runOptions.model.includes('codex');
        const desiredModelLabel = isChatGptModel
          ? mapModelToBrowserLabel(runOptions.model)
          : resolveBrowserModelLabel(preferredLabel, runOptions.model);
        const configuredUrl = userConfig.browser?.chatgptUrl ?? userConfig.browser?.url ?? undefined;
        // Default to manual-login when a persistent profile dir is provided (common for Codex/Claude).
        const manualLogin = hasProfileDir;
        browserConfig = {
          url: configuredUrl ?? CHATGPT_URL,
          cookieSync: !manualLogin,
          headless: false,
          hideWindow: false,
          keepBrowser: browserKeepBrowser ?? false,
          manualLogin,
          manualLoginProfileDir: manualLogin ? envProfileDir : null,
          thinkingTime: browserThinkingTime,
          desiredModel: desiredModelLabel || mapModelToBrowserLabel(runOptions.model),
        };
      }

      const notifications = resolveNotificationSettings({
        cliNotify: undefined,
        cliNotifySound: undefined,
        env: process.env,
        config: userConfig.notify,
      });

      const sessionMeta = await sessionStore.createSession(
        {
          ...runOptions,
          mode: resolvedEngine,
          slug,
          browserConfig,
        },
        cwd,
        notifications,
      );

      const logWriter = sessionStore.createLogWriter(sessionMeta.id);
      // Best-effort: emit MCP logging notifications for live chunks but never block the run.
      const sendLog = (text: string, level: 'info' | 'debug' = 'info') =>
        server.server
          .sendLoggingMessage(
            LoggingMessageNotificationParamsSchema.parse({
              level,
              data: { text, bytes: Buffer.byteLength(text, 'utf8') },
            }),
          )
          .catch(() => {});

      // Stream logs to both the session log and MCP logging notifications, but avoid buffering in memory
      const log = (line?: string): void => {
        logWriter.logLine(line);
        if (line !== undefined) {
          sendLog(line);
        }
      };
      const write = (chunk: string): boolean => {
        logWriter.writeChunk(chunk);
        sendLog(chunk, 'debug');
        return true;
      };

      try {
        await performSessionRun({
          sessionMeta,
          runOptions,
          mode: resolvedEngine,
          browserConfig,
          cwd,
          log,
          write,
          version: getCliVersion(),
          notifications,
          muteStdout: true,
          browserDeps,
        });
      } catch (error) {
        log(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          isError: true,
          content: textContent(`Session ${sessionMeta.id} failed: ${error instanceof Error ? error.message : String(error)}`),
        };
      } finally {
        logWriter.stream.end();
      }

      try {
        const finalMeta = (await sessionStore.readSession(sessionMeta.id)) ?? sessionMeta;
        const summary = `Session ${sessionMeta.id} (${finalMeta.status})`;
        const logTail = await readSessionLogTail(sessionMeta.id, 4000);
        const modelsSummary = summarizeModelRunsForConsult(finalMeta.models);
        return {
          content: textContent([summary, logTail || '(log empty)'].join('\n').trim()),
          structuredContent: {
            sessionId: sessionMeta.id,
            status: finalMeta.status,
            output: logTail ?? '',
            models: modelsSummary,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: textContent(`Session completed but metadata fetch failed: ${error instanceof Error ? error.message : String(error)}`),
        };
      }
    },
  );
}
