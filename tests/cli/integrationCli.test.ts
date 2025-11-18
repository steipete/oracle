import { describe, expect, test } from 'vitest';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TSX_BIN = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_ENTRY = path.join(process.cwd(), 'bin', 'oracle-cli.ts');
const CLIENT_FACTORY = path.join(process.cwd(), 'tests', 'fixtures', 'mockClientFactory.cjs');

describe('oracle CLI integration', () => {
  test('stores session metadata using stubbed client factory', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-home-'));
    const testFile = path.join(oracleHome, 'notes.md');
    await writeFile(testFile, 'Integration dry run content', 'utf8');

    const env = {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: env var name
      OPENAI_API_KEY: 'sk-integration',
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_HOME_DIR: oracleHome,
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_NO_DETACH: '1',
    };

    await execFileAsync(
      process.execPath,
      [
        TSX_BIN,
        CLI_ENTRY,
        '--prompt',
        'Integration check',
        '--model',
        'gpt-5.1',
        '--file',
        testFile,
      ],
      { env },
    );

    const sessionsDir = path.join(oracleHome, 'sessions');
    const sessionIds = await readdir(sessionsDir);
    expect(sessionIds.length).toBe(1);
    const metadataPath = path.join(sessionsDir, sessionIds[0], 'session.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    expect(metadata.status).toBe('completed');
    expect(metadata.response?.requestId).toBe('mock-req');
    expect(metadata.usage?.totalTokens).toBe(20);

    await rm(oracleHome, { recursive: true, force: true });
  }, 15000);
});
