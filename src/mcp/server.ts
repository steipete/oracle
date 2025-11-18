#!/usr/bin/env node
import 'dotenv/config';
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getCliVersion } from '../version.js';
import { registerConsultTool } from './tools/consult.js';
import { registerSessionsTool } from './tools/sessions.js';
import { registerSessionResources } from './tools/sessionResources.js';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    {
      name: 'oracle-mcp',
      version: getCliVersion(),
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerConsultTool(server);
  registerSessionsTool(server);
  registerSessionResources(server);

  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error('MCP transport error:', error);
  };
  transport.onclose = () => {
    // Keep quiet on normal close; caller owns lifecycle.
  };

  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('oracle-mcp')) {
  startMcpServer().catch((error) => {
    console.error('Failed to start oracle-mcp:', error);
    process.exitCode = 1;
  });
}
