import fs from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  filterSessionsByRange,
  getSessionPaths,
  listSessionsMetadata,
  readSessionLog,
  readSessionMetadata,
} from '../../sessionManager.js';
import { sessionsInputSchema } from '../types.js';

const sessionsOutputSchema = z.object({
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
});

export function registerSessionsTool(server: McpServer): void {
  server.registerTool(
    'sessions',
    {
      title: 'List or fetch Oracle sessions',
      description: 'List stored sessions or return full stored data for a given session ID/slug.',
      inputSchema: sessionsInputSchema as z.ZodTypeAny,
      outputSchema: sessionsOutputSchema as z.ZodTypeAny,
    },
    async (input: unknown) => {
      const { id, hours = 24, limit = 100, includeAll = false, detail = false } = sessionsInputSchema.parse(input);

      if (id) {
        if (!detail) {
          const metadata = await readSessionMetadata(id);
          if (!metadata) {
            throw new Error(`Session "${id}" not found.`);
          }
          return {
            content: [{ type: 'text', text: `${metadata.createdAt} | ${metadata.status} | ${metadata.model ?? 'n/a'} | ${metadata.id}` }],
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
        const metadata = await readSessionMetadata(id);
        if (!metadata) {
          throw new Error(`Session "${id}" not found.`);
        }
        const log = await readSessionLog(id);
        let request: Record<string, unknown> | undefined;
        try {
          const paths = await getSessionPaths(id);
          const raw = await fs.readFile(paths.request, 'utf8');
          // Old sessions may lack a request payload; treat it as best-effort metadata.
          request = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          request = undefined;
        }
        return {
          content: [{ type: 'text', text: log }],
          structuredContent: { session: { metadata, log, request } },
        };
      }

      const metas = await listSessionsMetadata();
      const { entries, truncated, total } = filterSessionsByRange(metas, { hours, includeAll, limit });
      return {
        content: [
          {
            type: 'text',
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
