import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = path.join(process.cwd(), 'dist/bin/oracle-mcp.js');

describe('oracle-mcp schemas', () => {
  const client = new Client({ name: 'schema-smoke', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    stderr: 'pipe',
    cwd: path.dirname(entry),
  });

  beforeAll(async () => {
    await client.connect(transport);
  }, 15_000);

  afterAll(async () => {
    await client.close().catch(() => {});
  });

  it('exposes object schemas for tools', async () => {
    const { tools } = await client.listTools({}, { timeout: 10_000 });
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        if (!schema) continue;
        expect(schema.type).toBe('object');
      }
    }
  });
});
