import { describe, expect, test } from 'vitest';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), 'bin', 'oracle-cli.ts');
const CLIENT_FACTORY = path.join(process.cwd(), 'tests', 'fixtures', 'mockClientFactory.cjs');
const INTEGRATION_TIMEOUT = process.platform === 'win32' ? 60000 : 30000;

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
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_DISABLE_KEYTAR: '1',
    };

    await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
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
  }, INTEGRATION_TIMEOUT);

  test('persists followup lineage and reuses previous_response_id during --exec-session', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-followup-'));
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
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_DISABLE_KEYTAR: '1',
    };

    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, '--prompt', 'Parent run', '--model', 'gpt-5.1'],
      { env },
    );

    const sessionsDir = path.join(oracleHome, 'sessions');
    const [parentId] = await readdir(sessionsDir);
    expect(parentId).toBeTruthy();
    const parentMeta = JSON.parse(await readFile(path.join(sessionsDir, parentId, 'meta.json'), 'utf8'));
    const parentResponseId = String(parentMeta.response?.responseId ?? '');
    expect(parentResponseId.startsWith('resp_')).toBe(true);

    await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        CLI_ENTRY,
        '--prompt',
        'Child run',
        '--model',
        'gpt-5.1',
        '--followup',
        parentId,
      ],
      { env },
    );

    const allSessions = await readdir(sessionsDir);
    expect(allSessions.length).toBe(2);
    const childId = allSessions.find((id) => id !== parentId);
    expect(childId).toBeTruthy();
    const childMeta = JSON.parse(await readFile(path.join(sessionsDir, childId as string, 'meta.json'), 'utf8'));
    expect(childMeta.options?.previousResponseId).toBe(parentResponseId);
    expect(childMeta.options?.followupSessionId).toBe(parentId);

    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, '--exec-session', childId as string],
      {
        env: {
          ...env,
          // biome-ignore lint/style/useNamingConvention: env var name
          ORACLE_TEST_REQUIRE_PREV: '1',
        },
      },
    );

    await rm(oracleHome, { recursive: true, force: true });
  }, INTEGRATION_TIMEOUT);

  test('accepts direct response ids in --followup and persists chain metadata', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-followup-resp-'));
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
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_DISABLE_KEYTAR: '1',
    };
    const directResponseId = 'resp_direct_followup_12345';

    await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        CLI_ENTRY,
        '--prompt',
        'Child from direct response id',
        '--model',
        'gpt-5.1',
        '--followup',
        directResponseId,
      ],
      { env },
    );

    const sessionsDir = path.join(oracleHome, 'sessions');
    const [sessionId] = await readdir(sessionsDir);
    expect(sessionId).toBeTruthy();
    const metadata = JSON.parse(await readFile(path.join(sessionsDir, sessionId, 'meta.json'), 'utf8'));
    expect(metadata.options?.previousResponseId).toBe(directResponseId);
    expect(metadata.options?.followupSessionId).toBeUndefined();
    expect(metadata.options?.followupModel).toBeUndefined();

    await rm(oracleHome, { recursive: true, force: true });
  }, INTEGRATION_TIMEOUT);

  test('requires --followup-model when parent session has multiple model runs', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-followup-multi-error-'));
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
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_DISABLE_KEYTAR: '1',
    };

    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, '--prompt', 'Parent multi followup', '--models', 'gpt-5.1,gpt-5.2'],
      { env },
    );

    const sessionsDir = path.join(oracleHome, 'sessions');
    const [parentId] = await readdir(sessionsDir);
    expect(parentId).toBeTruthy();

    try {
      await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          CLI_ENTRY,
          '--prompt',
          'Child missing followup model',
          '--model',
          'gpt-5.1',
          '--followup',
          parentId,
        ],
        { env },
      );
      throw new Error('Expected oracle CLI to fail but it succeeded.');
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && error !== null && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';
      expect(stderr).toMatch(/multiple model runs/i);
      expect(stderr).toMatch(/--followup-model/i);
    }

    await rm(oracleHome, { recursive: true, force: true });
  }, INTEGRATION_TIMEOUT);

  test('uses --followup-model to continue from the selected parent model response', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-followup-multi-select-'));
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
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_DISABLE_KEYTAR: '1',
    };

    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, '--prompt', 'Parent multi followup select', '--models', 'gpt-5.1,gpt-5.2'],
      { env },
    );

    const sessionsDir = path.join(oracleHome, 'sessions');
    const [parentId] = await readdir(sessionsDir);
    expect(parentId).toBeTruthy();

    const parentMeta = JSON.parse(await readFile(path.join(sessionsDir, parentId, 'meta.json'), 'utf8'));
    const selectedRun = (
      (parentMeta.models as Array<{ model: string; response?: { responseId?: string } }> | undefined) ?? []
    ).find((run) => run.model === 'gpt-5.2');
    const selectedResponseId = selectedRun?.response?.responseId;
    expect(selectedResponseId).toBeTruthy();
    expect(String(selectedResponseId).startsWith('resp_')).toBe(true);

    await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        CLI_ENTRY,
        '--prompt',
        'Child with followup model select',
        '--model',
        'gpt-5.1',
        '--followup',
        parentId,
        '--followup-model',
        'gpt-5.2',
      ],
      { env },
    );

    const allSessions = await readdir(sessionsDir);
    expect(allSessions.length).toBe(2);
    const childId = allSessions.find((id) => id !== parentId);
    expect(childId).toBeTruthy();
    const childMeta = JSON.parse(await readFile(path.join(sessionsDir, childId as string, 'meta.json'), 'utf8'));
    expect(childMeta.options?.previousResponseId).toBe(selectedResponseId);
    expect(childMeta.options?.followupSessionId).toBe(parentId);
    expect(childMeta.options?.followupModel).toBe('gpt-5.2');

    await rm(oracleHome, { recursive: true, force: true });
  }, INTEGRATION_TIMEOUT);

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
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_DISABLE_KEYTAR: '1',
    };

    try {
      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', CLI_ENTRY, '--prompt', 'conflict', '--model', 'gpt-5.1', '--models', 'gpt-5.1-pro'],
        { env },
      );
      throw new Error('Expected oracle CLI to fail but it succeeded.');
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && error !== null && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';
      expect(stderr).toMatch(/--models cannot be combined with --model/i);
    }

    await rm(oracleHome, { recursive: true, force: true });
  }, INTEGRATION_TIMEOUT);

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
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_DISABLE_KEYTAR: '1',
    };

    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, '--prompt', 'Codex integration', '--model', 'gpt-5.1-codex'],
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
  }, INTEGRATION_TIMEOUT);

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
      // biome-ignore lint/style/useNamingConvention: env var name
      ORACLE_DISABLE_KEYTAR: '1',
    };

    try {
      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', CLI_ENTRY, '--prompt', 'Codex Max integration', '--model', 'gpt-5.1-codex-max'],
        { env },
      );
      throw new Error('Expected oracle CLI to fail but it succeeded.');
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && error !== null && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';
      expect(stderr).toMatch(/codex-max is not available yet/i);
    }

    await rm(oracleHome, { recursive: true, force: true });
  }, INTEGRATION_TIMEOUT);

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
      [
        '--import',
        'tsx',
        CLI_ENTRY,
        '--prompt',
        'Multi run test prompt long enough',
        '--models',
        'gpt-5.1,gemini-3-pro,claude-4.5-sonnet',
      ],
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
  }, INTEGRATION_TIMEOUT);

  test('accepts shorthand multi-model list and normalizes to canonical IDs', async () => {
    const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-multi-shorthand-'));
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
      [
        '--import',
        'tsx',
        CLI_ENTRY,
        '--prompt',
        'Shorthand multi-model normalization prompt that is safely over twenty characters.',
        '--models',
        'gpt-5.1,gemini,sonnet',
      ],
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
  }, INTEGRATION_TIMEOUT);
});
