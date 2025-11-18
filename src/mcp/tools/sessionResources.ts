import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs/promises';
import { getSessionPaths, readSessionLog, readSessionMetadata } from '../../sessionManager.js';

// URIs:
// - oracle-session://<id>/metadata
// - oracle-session://<id>/log
// - oracle-session://<id>/request

export function registerSessionResources(server: McpServer): void {
  const template = new ResourceTemplate('oracle-session://{id}/{kind}', { list: undefined });

  server.registerResource(
    'oracle-session',
    template,
    {
      title: 'oracle session resources',
      description: 'Read stored session metadata, log, or request payload.',
    },
    async (uri, variables) => {
      const idRaw = variables?.id;
      const kindRaw = variables?.kind;
      // uri-template variables arrive as string | string[]; collapse to first value.
      const id = Array.isArray(idRaw) ? idRaw[0] : (idRaw as string);
      const kind = Array.isArray(kindRaw) ? kindRaw[0] : (kindRaw as string);
      if (!id || !kind) {
        throw new Error('Missing id or kind');
      }
      const paths = await getSessionPaths(id);
      switch (kind) {
        case 'metadata': {
          const metadata = await readSessionMetadata(id);
          if (!metadata) {
            throw new Error(`Session "${id}" not found.`);
          }
          return {
            contents: [
              {
                uri: uri.href,
                text: JSON.stringify(metadata, null, 2),
              },
            ],
          };
        }
        case 'log': {
          const log = await readSessionLog(id);
          return {
            contents: [
              {
                uri: uri.href,
                text: log,
              },
            ],
          };
        }
        case 'request': {
          const raw = await fs.readFile(paths.request, 'utf8');
          return {
            contents: [
              {
                uri: uri.href,
                text: raw,
              },
            ],
          };
        }
        default:
          throw new Error(`Unsupported resource kind: ${kind}`);
      }
    },
  );
}
