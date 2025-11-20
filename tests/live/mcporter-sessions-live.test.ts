import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const LIVE = process.env.ORACLE_LIVE_TEST === '1';
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const MCP_CONFIG = path.join(process.cwd(), 'config', 'mcporter.json');
const ORACLE_MCP_BIN = path.join(process.cwd(), 'dist', 'bin', 'oracle-mcp.js');

async function ensureBuilt(): Promise<void> {
  await stat(ORACLE_MCP_BIN);
}

type McporterOutput = { result?: unknown; error?: unknown; sessionId?: string };

async function runMcporter(args: string[]): Promise<McporterOutput> {
  const { stdout } = await execFileAsync('npx', ['-y', 'mcporter', ...args], {
    env: process.env,
    timeout: 180_000,
  });
  try {
    return JSON.parse(stdout) as McporterOutput;
  } catch {
    return { result: stdout };
  }
}

(LIVE && hasOpenAI ? describe : describe.skip)('mcporter sessions live', () => {
  it(
    'creates a session via consult then fetches it via sessions tool',
    async () => {
      await ensureBuilt();
      const consult = await runMcporter([
        'call',
        'oracle-local.consult',
        'prompt:mcporter session smoke',
        'model:gpt-5.1',
        'engine:api',
        '--config',
        MCP_CONFIG,
      ]);
      expect(consult).not.toHaveProperty('error');
      const consultResult = consult.result as
        | { sessionId?: string }
        | string
        | undefined;
      const sessionId =
        (consultResult && typeof consultResult === 'object' ? consultResult.sessionId : undefined) ||
        (consultResult && typeof consultResult === 'string' ? consultResult : undefined) ||
        consult.sessionId ||
        null;
      expect(sessionId).toBeTruthy();

      const detail = await runMcporter([
        'call',
        'oracle-local.sessions',
        `id:${sessionId}`,
        'detail:true',
        '--config',
        MCP_CONFIG,
      ]);
      expect(detail).not.toHaveProperty('error');
      const detailBody = detail as { result?: unknown };
      const body = detailBody.result ?? detail;
      const text = JSON.stringify(body);
      expect(text).toContain(String(sessionId));
      expect(text.toLowerCase()).toContain('completed');
    },
    180_000,
  );
});
