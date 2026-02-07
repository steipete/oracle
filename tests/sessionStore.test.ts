import { beforeEach, afterEach, describe, expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { setOracleHomeDirOverrideForTest } from '../src/oracleHome.js';
import { sessionStore as store } from '../src/sessionStore.js';

describe('sessionStore', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-store-'));
    setOracleHomeDirOverrideForTest(tmpHome);
    await store.ensureStorage();
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await rm(tmpHome, { recursive: true, force: true });
  });

  test('creates sessions and reads metadata/request', async () => {
    const meta = await store.createSession(
      { prompt: 'Inspect me', model: 'gpt-5.2-pro', search: false },
      process.cwd(),
    );
    const fetched = await store.readSession(meta.id);
    expect(fetched?.id).toBe(meta.id);
    expect(fetched?.options?.search).toBe(false);
    const request = await store.readRequest(meta.id);
    expect(request?.prompt).toBe('Inspect me');
  });

  test('persists waitPreference and gemini browser metadata for restarts', async () => {
    const meta = await store.createSession(
      {
        prompt: 'Persist me',
        model: 'gemini-3-pro',
        mode: 'browser',
        waitPreference: false,
        youtube: 'https://example.com/video',
        generateImage: 'in.png',
        editImage: 'edit.png',
        outputPath: 'out.png',
        aspectRatio: '1:1',
        geminiShowThoughts: true,
      },
      process.cwd(),
    );
    const fetched = await store.readSession(meta.id);
    expect(fetched?.options.waitPreference).toBe(false);
    expect(fetched?.options.youtube).toBe('https://example.com/video');
    expect(fetched?.options.generateImage).toBe('in.png');
    expect(fetched?.options.editImage).toBe('edit.png');
    expect(fetched?.options.outputPath).toBe('out.png');
    expect(fetched?.options.aspectRatio).toBe('1:1');
    expect(fetched?.options.geminiShowThoughts).toBe(true);
  });

  test('writes per-model logs and aggregates combined log', async () => {
    const meta = await store.createSession(
      {
        prompt: 'Combine logs',
        model: 'gpt-5.2-pro',
        models: ['gpt-5.2-pro', 'gemini-3-pro'],
      },
      process.cwd(),
    );
    const writerPro = store.createLogWriter(meta.id, 'gpt-5.2-pro');
    writerPro.logLine('pro-line');
    writerPro.stream.end();
    await finished(writerPro.stream);

    const writerGem = store.createLogWriter(meta.id, 'gemini-3-pro');
    writerGem.logLine('gem-line');
    writerGem.stream.end();
    await finished(writerGem.stream);

    const combined = await store.readLog(meta.id);
    expect(combined).toContain('gpt-5.2-pro');
    expect(combined).toContain('gemini-3-pro');
    expect(combined).toContain('pro-line');
    expect(combined).toContain('gem-line');

    const proLog = await store.readModelLog(meta.id, 'gpt-5.2-pro');
    expect(proLog).toContain('pro-line');
  });

  test('readLog falls back to combined log when per-model logs missing', async () => {
    const meta = await store.createSession({ prompt: 'fallback', model: 'gpt-5.2-pro' }, process.cwd());
    const writer = store.createLogWriter(meta.id);
    writer.logLine('combined-only');
    writer.stream.end();
    await finished(writer.stream);

    const combined = await store.readLog(meta.id);
    expect(combined).toContain('combined-only');
  });

  test('deleteOlderThan prunes sessions past cutoff', async () => {
    const recent = await store.createSession({ prompt: 'recent', model: 'gpt-5.2-pro' }, process.cwd());
    const old = await store.createSession({ prompt: 'old', model: 'gpt-5.2-pro' }, process.cwd());
    await store.updateSession(old.id, {
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    const result = await store.deleteOlderThan({ hours: 24 });
    expect(result.deleted).toBe(1);
    const oldMeta = await store.readSession(old.id);
    const recentMeta = await store.readSession(recent.id);
    expect(oldMeta).toBeNull();
    expect(recentMeta).not.toBeNull();
  });
});
