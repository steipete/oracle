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

async function assertBuiltArtifacts(): Promise<void> {
  await stat(ORACLE_MCP_BIN);
}

(LIVE && hasOpenAI ? describe : describe.skip)('mcporter live (stdio oracle-mcp)', () => {
  it(
    'lists oracle-local schema',
    async () => {
      await assertBuiltArtifacts();
      const { stdout } = await execFileAsync('npx', ['-y', 'mcporter', 'list', 'oracle-local', '--schema', '--config', MCP_CONFIG], {
        env: process.env,
        timeout: 60_000,
      });
      expect(stdout).toContain('oracle-local');
    },
    90_000,
  );

  it(
    'invokes consult via mcporter',
    async () => {
      await assertBuiltArtifacts();
      const { stdout } = await execFileAsync(
        'npx',
        [
          '-y',
          'mcporter',
          'call',
          'oracle-local.consult',
          'prompt:Say hello from mcporter live',
          'model:gpt-5.1',
          'engine:api',
          '--config',
          MCP_CONFIG,
        ],
        { env: process.env, timeout: 120_000 },
      );
      expect(stdout.toLowerCase()).toContain('say hello');
    },
    150_000,
  );
});
