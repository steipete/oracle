import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getCliVersion } from '../../version.js';
import { LoggingMessageNotificationParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureBrowserAvailable, mapConsultToRunOptions } from '../utils.js';
import {
  createSessionLogWriter,
  initializeSession,
  readSessionMetadata,
  readSessionLog,
  type BrowserSessionConfig,
} from '../../sessionManager.js';

async function readSessionLogTail(sessionId: string, maxBytes: number): Promise<string | null> {
  try {
    const log = await readSessionLog(sessionId);
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
  prompt: z.string().min(1, 'Prompt is required.'),
  files: z.array(z.string()).default([]),
  model: z.string().optional(),
  engine: z.enum(['api', 'browser']).optional(),
  browserModelLabel: z.string().optional(),
  search: z.boolean().optional(),
  slug: z.string().optional(),
} satisfies z.ZodRawShape;

const consultOutputShape = {
  sessionId: z.string(),
  status: z.string(),
  output: z.string(),
} satisfies z.ZodRawShape;

export function registerConsultTool(server: McpServer): void {
  server.registerTool(
    'consult',
    {
      title: 'Run an oracle session',
      description:
        'Run a one-shot Oracle session (API or browser). Attach files/dirs for context, optional model/engine overrides, and an optional slug. Background handling follows the CLI defaults; browser runs only start when Chrome is available.',
      // Cast to any to satisfy SDK typings across differing Zod versions.
      inputSchema: consultInputShape as any,
      outputSchema: consultOutputShape as any,
    },
    async (input: unknown) => {
      const textContent = (text: string) => [{ type: 'text' as const, text }];
      const { prompt, files, model, engine, search, browserModelLabel, slug } = consultInputSchema.parse(input);
      const { config: userConfig } = await loadUserConfig();
      const { runOptions, resolvedEngine } = mapConsultToRunOptions({
        prompt,
        files: files ?? [],
        model,
        engine,
        search,
        userConfig,
        env: process.env,
      });
      const cwd = process.cwd();

      const browserGuard = ensureBrowserAvailable(resolvedEngine);
      if (
        resolvedEngine === 'browser' &&
        (browserGuard ||
          (process.platform === 'linux' && !process.env.DISPLAY && !process.env.CHROME_PATH))
      ) {
        return {
          isError: true,
          content: textContent(browserGuard ?? 'Browser engine unavailable: set DISPLAY or CHROME_PATH.'),
        };
      }

      let browserConfig: BrowserSessionConfig | undefined;
      if (resolvedEngine === 'browser') {
        const preferredLabel = (browserModelLabel ?? model)?.trim();
        const desiredModelLabel = resolveBrowserModelLabel(preferredLabel, runOptions.model);
        // Keep the browser path minimal; only forward a desired model label for the ChatGPT picker.
        browserConfig = {
          url: CHATGPT_URL,
          cookieSync: true,
          headless: false,
          hideWindow: false,
          keepBrowser: false,
          desiredModel: desiredModelLabel || mapModelToBrowserLabel(runOptions.model),
        };
      }

      const notifications = resolveNotificationSettings({
        cliNotify: undefined,
        cliNotifySound: undefined,
        env: process.env,
        config: userConfig.notify,
      });

      const sessionMeta = await initializeSession(
        {
          ...runOptions,
          mode: resolvedEngine,
          slug,
          browserConfig,
        },
        cwd,
        notifications,
      );

      const logWriter = createSessionLogWriter(sessionMeta.id);
      let output = '';
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
        });
      } catch (error) {
        log(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          isError: true,
          content: textContent(output),
          structuredContent: {
            sessionId: sessionMeta.id,
            status: 'error',
            output,
            metadata: await readSessionMetadata(sessionMeta.id),
          },
        };
      } finally {
        logWriter.stream.end();
      }

      try {
        const finalMeta = (await readSessionMetadata(sessionMeta.id)) ?? sessionMeta;
        const summary = `Session ${sessionMeta.id} (${finalMeta.status})`;
        const logTail = await readSessionLogTail(sessionMeta.id, 4000);
        return {
          content: textContent(
            [summary, logTail || '(log empty)'].join('\n').trim(),
          ),
          structuredContent: {
            sessionId: sessionMeta.id,
            status: finalMeta.status,
            output: logTail ?? '',
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
