import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sessionStore } from '../../sessionStore.js';
import { sessionsInputSchema } from '../types.js';

const sessionsInputShape = {
  id: z
    .string()
    .optional()
    .describe('Session id or slug. If set, returns a single session (use detail:true to include metadata/request).'),
  hours: z.number().optional().describe('Look back this many hours when listing sessions (default: 24).'),
  limit: z.number().optional().describe('Maximum sessions to return when listing (default: 100).'),
  includeAll: z
    .boolean()
    .optional()
    .describe('Include sessions outside the time window when listing (mirrors `oracle status --all`).'),
  detail: z
    .boolean()
    .optional()
    .describe('When id is set, include session metadata + stored request + full log text.'),
} satisfies z.ZodRawShape;

const sessionsOutputShape = {
  entries: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        status: z.string(),
        model: z.string().optional(),
        mode: z.string().optional(),
      }),
    )
    .optional(),
  total: z.number().optional(),
  truncated: z.boolean().optional(),
  session: z
    .object({
      metadata: z.record(z.string(), z.any()),
      log: z.string(),
      request: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
} satisfies z.ZodRawShape;

export function registerSessionsTool(server: McpServer): void {
  server.registerTool(
    'sessions',
    {
      title: 'List or fetch oracle sessions',
      description:
        'Inspect Oracle session history stored under `ORACLE_HOME_DIR` (shared with the CLI). List recent sessions or fetch one by id/slug (optionally including metadata + request + log).',
      inputSchema: sessionsInputShape,
      outputSchema: sessionsOutputShape,
    },
    async (input: unknown) => {
      const textContent = (text: string) => [{ type: 'text' as const, text }];
      const { id, hours = 24, limit = 100, includeAll = false, detail = false } = sessionsInputSchema.parse(input);

      if (id) {
        if (!detail) {
          const metadata = await sessionStore.readSession(id);
          if (!metadata) {
            throw new Error(`Session "${id}" not found.`);
          }
          return {
            content: textContent(`${metadata.createdAt} | ${metadata.status} | ${metadata.model ?? 'n/a'} | ${metadata.id}`),
            structuredContent: {
              entries: [
                {
                  id: metadata.id,
                  createdAt: metadata.createdAt,
                  status: metadata.status,
                  model: metadata.model,
                  mode: metadata.mode,
                },
              ],
              total: 1,
              truncated: false,
            },
          };
        }
        const metadata = await sessionStore.readSession(id);
        if (!metadata) {
          throw new Error(`Session "${id}" not found.`);
        }
        const log = await sessionStore.readLog(id);
        const request = (await sessionStore.readRequest(id)) ?? undefined;
        return {
          content: textContent(log),
          structuredContent: { session: { metadata, log, request } },
        };
      }

      const metas = await sessionStore.listSessions();
      const { entries, truncated, total } = sessionStore.filterSessions(metas, { hours, includeAll, limit });
      return {
        content: [
          {
            type: 'text' as const,
            text: entries.map((entry) => `${entry.createdAt} | ${entry.status} | ${entry.model ?? 'n/a'} | ${entry.id}`).join('\n'),
          },
        ],
        structuredContent: {
          entries: entries.map((entry) => ({
            id: entry.id,
            createdAt: entry.createdAt,
            status: entry.status,
            model: entry.model,
            mode: entry.mode,
          })),
          total,
          truncated,
        },
      };
    },
  );
}
