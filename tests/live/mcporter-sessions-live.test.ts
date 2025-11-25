import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const LIVE = process.env.ORACLE_LIVE_TEST === '1';
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const baseUrl = process.env.OPENAI_BASE_URL ?? '';
const isOpenRouterBase = baseUrl.includes('openrouter');
const OPENAI_ENV = {
  // biome-ignore lint/style/useNamingConvention: environment variable key
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  // biome-ignore lint/style/useNamingConvention: environment variable key
  OPENROUTER_API_KEY: '',
};
const MCP_CONFIG = path.join(process.cwd(), 'config', 'mcporter.json');
const ORACLE_MCP_BIN = path.join(process.cwd(), 'dist', 'bin', 'oracle-mcp.js');

async function ensureBuilt(): Promise<void> {
  await stat(ORACLE_MCP_BIN);
}

type McporterOutput = { result?: unknown; error?: unknown; sessionId?: string; text?: string };

async function runMcporter(args: string[]): Promise<McporterOutput> {
  try {
    const { stdout } = await execFileAsync('pnpm', ['exec', 'mcporter', ...args], {
      env: { ...process.env, ...OPENAI_ENV },
      timeout: 180_000,
    });
    try {
      const parsed = JSON.parse(stdout) as McporterOutput;
      return { ...parsed, text: stdout };
    } catch {
      return { result: stdout, text: stdout };
    }
  } catch (error) {
    return { error };
  }
}

function extractSessionId(output: McporterOutput): string | null {
  if (typeof output.sessionId === 'string' && output.sessionId.length > 0) {
    return output.sessionId;
  }
  const result = output.result;
  if (result && typeof result === 'object' && 'sessionId' in result) {
    const sessionIdValue = (result as { sessionId?: unknown }).sessionId;
    if (typeof sessionIdValue === 'string') {
      return sessionIdValue;
    }
  }
  const text = typeof output.text === 'string' ? output.text : typeof output.result === 'string' ? output.result : '';
  // Matches "Session abc-def (completed)" or any bare slug looking token
  const regex = /Session\s+([a-z0-9-]{3,})\b/i;
  const match = regex.exec(text);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

(LIVE && hasOpenAI && !isOpenRouterBase ? describe : describe.skip)('mcporter sessions live', () => {
  it(
    'creates a session via consult then fetches it via sessions tool',
    async () => {
      await ensureBuilt();
      const slug = `mcporter session smoke live ${Date.now().toString(36)}`;
      const consult = await runMcporter([
        'call',
        'oracle-local.consult',
        'prompt:mcporter session smoke',
        'model:gpt-5.1',
        'engine:api',
        `slug:${slug}`,
        '--config',
        MCP_CONFIG,
      ]);
      if (consult.error) {
        const message = String((consult.error as Error).message ?? consult.error);
        if (message.includes('appears offline') || message.includes('timed out')) {
          console.warn('oracle-local unavailable, skipping mcporter sessions live test:', message);
          return;
        }
        throw consult.error;
      }
      const consultResult = consult.result as
        | { sessionId?: string }
        | string
        | undefined;
      const sessionId =
        extractSessionId(consult) ||
        (consultResult && typeof consultResult === 'object' ? consultResult.sessionId : undefined) ||
        (consultResult && typeof consultResult === 'string' ? consultResult : undefined) ||
        consult.sessionId ||
        null;
      expect(sessionId).toBeTruthy();

      const summary = await runMcporter([
        'call',
        'oracle-local.sessions',
        `id:${sessionId}`,
        '--config',
        MCP_CONFIG,
      ]);
      expect(summary).not.toHaveProperty('error');
      const summaryText =
        typeof summary.result === 'string'
          ? summary.result
          : summary.text ?? JSON.stringify(summary.result ?? summary);
      expect(summaryText).toContain(String(sessionId));
      expect(summaryText.toLowerCase()).toContain('completed');

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
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      expect(text.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
