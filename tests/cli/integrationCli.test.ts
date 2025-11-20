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
    const metadataPath = path.join(sessionsDir, sessionIds[0], 'meta.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    expect(metadata.status).toBe('completed');
    expect(metadata.response?.requestId).toBe('mock-req');
    expect(metadata.usage?.totalTokens).toBe(20);
    expect(metadata.options?.effectiveModelId).toBe('gpt-5.1');

    await rm(oracleHome, { recursive: true, force: true });
  }, 15000);

  test('rejects mixing --model and --models regardless of source', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-multi-conflict-'));
    const env = {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: env var name
      OPENAI_API_KEY: 'sk-integration',
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_HOME_DIR: oracleHome,
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
    };

    await expect(
      execFileAsync(
        process.execPath,
        [TSX_BIN, CLI_ENTRY, '--prompt', 'conflict', '--model', 'gpt-5.1', '--models', 'gpt-5.1-pro'],
        { env },
      ),
    ).rejects.toThrow(/--models cannot be combined with --model/i);

    await rm(oracleHome, { recursive: true, force: true });
  }, 10000);

  test('runs gpt-5.1-codex via API-only path', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-codex-'));
    const env = {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: environment variable name
      OPENAI_API_KEY: 'sk-integration',
      // biome-ignore lint/style/useNamingConvention: environment variable name
      ORACLE_HOME_DIR: oracleHome,
      // biome-ignore lint/style/useNamingConvention: environment variable name
      ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
      // biome-ignore lint/style/useNamingConvention: environment variable name
      ORACLE_NO_DETACH: '1',
    };

    await execFileAsync(
      process.execPath,
      [TSX_BIN, CLI_ENTRY, '--prompt', 'Codex integration', '--model', 'gpt-5.1-codex'],
      { env },
    );

    const sessionsDir = path.join(oracleHome, 'sessions');
    const sessionIds = await readdir(sessionsDir);
    expect(sessionIds.length).toBe(1);
    const metadataPath = path.join(sessionsDir, sessionIds[0], 'meta.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    expect(metadata.model).toBe('gpt-5.1-codex');
    expect(metadata.mode).toBe('api');
    expect(metadata.usage?.totalTokens).toBe(20);

    await rm(oracleHome, { recursive: true, force: true });
  }, 15000);

  test('rejects gpt-5.1-codex-max until OpenAI ships the API', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-codex-max-'));
    const env = {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: environment variable name
      OPENAI_API_KEY: 'sk-integration',
      // biome-ignore lint/style/useNamingConvention: environment variable name
      ORACLE_HOME_DIR: oracleHome,
      // biome-ignore lint/style/useNamingConvention: environment variable name
      ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
    };

    await expect(
      execFileAsync(
        process.execPath,
        [TSX_BIN, CLI_ENTRY, '--prompt', 'Codex Max integration', '--model', 'gpt-5.1-codex-max'],
        { env },
      ),
    ).rejects.toThrow(/codex-max is not available yet/i);

    await rm(oracleHome, { recursive: true, force: true });
  }, 10000);

  test('runs multi-model across OpenAI, Gemini, and Claude with custom factory', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-multi-'));
    const env = {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: env var name
      OPENAI_API_KEY: 'sk-integration',
      // biome-ignore lint/style/useNamingConvention: env var name
      GEMINI_API_KEY: 'gk-integration',
      // biome-ignore lint/style/useNamingConvention: env var name
      ANTHROPIC_API_KEY: 'ak-integration',
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_HOME_DIR: oracleHome,
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_CLIENT_FACTORY: path.join(process.cwd(), 'tests', 'fixtures', 'mockPolyClient.cjs'),
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_NO_DETACH: '1',
    };

    await execFileAsync(
      process.execPath,
      [TSX_BIN, CLI_ENTRY, '--prompt', 'Multi run test prompt long enough', '--models', 'gpt-5.1,gemini-3-pro,claude-4.5-sonnet'],
      { env },
    );

    const sessionsDir = path.join(oracleHome, 'sessions');
    const sessionIds = await readdir(sessionsDir);
    expect(sessionIds.length).toBe(1);
    const sessionDir = path.join(sessionsDir, sessionIds[0]);
    const metadata = JSON.parse(await readFile(path.join(sessionDir, 'meta.json'), 'utf8'));
    const selectedModels = (metadata.models as Array<{ model: string }> | undefined)?.map(
      (m: { model: string }) => m.model,
    );
    expect(selectedModels).toEqual(
      expect.arrayContaining(['gpt-5.1', 'gemini-3-pro', 'claude-4.5-sonnet']),
    );
    expect(metadata.status).toBe('completed');

    await rm(oracleHome, { recursive: true, force: true });
  }, 15000);
});
