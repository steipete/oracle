import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getCliVersion } from '../../version.js';
import { LoggingMessageNotificationParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import { ensureBrowserAvailable, mapConsultToRunOptions } from '../utils.js';
import {
  createSessionLogWriter,
  initializeSession,
  readSessionMetadata,
  type BrowserSessionConfig,
} from '../../sessionManager.js';
import { performSessionRun } from '../../cli/sessionRunner.js';
import { CHATGPT_URL } from '../../browser/constants.js';
import { consultInputSchema } from '../types.js';

const consultOutputSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  output: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export function registerConsultTool(server: McpServer): void {
  server.registerTool(
    'consult',
    {
      title: 'Run an Oracle session',
      description: 'Execute a prompt with optional files via the Oracle CLI engines and return the stored session result.',
      inputSchema: consultInputSchema as z.ZodTypeAny,
      outputSchema: consultOutputSchema as z.ZodTypeAny,
    },
    async (input: unknown) => {
      const { prompt, files, model, engine, slug } = consultInputSchema.parse(input);
      const { runOptions, resolvedEngine } = mapConsultToRunOptions({ prompt, files: files ?? [], model, engine });
      const cwd = process.cwd();

      const browserGuard = ensureBrowserAvailable(resolvedEngine);
      if (
        resolvedEngine === 'browser' &&
        (browserGuard ||
          (process.platform === 'linux' && !process.env.DISPLAY && !process.env.CHROME_PATH))
      ) {
        return {
          isError: true,
          content: [{ type: 'text', text: browserGuard ?? 'Browser engine unavailable: set DISPLAY or CHROME_PATH.' }],
        };
      }

      let browserConfig: BrowserSessionConfig | undefined;
      const desiredModelLabel = model?.trim();
      if (resolvedEngine === 'browser') {
        // Keep the browser path minimal; only forward a desired model label for the ChatGPT picker.
        browserConfig = {
          url: CHATGPT_URL,
          cookieSync: true,
          headless: false,
          hideWindow: false,
          keepBrowser: false,
          desiredModel: desiredModelLabel || undefined,
        };
      }

      const sessionMeta = await initializeSession(
        {
          ...runOptions,
          mode: resolvedEngine,
          slug,
          browserConfig,
        },
        cwd,
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
          output += `${line}\n`;
          sendLog(line);
        }
      };
      const write = (chunk: string): boolean => {
        logWriter.writeChunk(chunk);
        output += chunk;
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
        });
      } catch (error) {
        log(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          isError: true,
          content: [{ type: 'text', text: output }],
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
        return {
          content: [{ type: 'text', text: output }],
          structuredContent: {
            sessionId: sessionMeta.id,
            status: finalMeta.status,
            output,
            metadata: finalMeta,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Session completed but metadata fetch failed: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    },
  );
}
