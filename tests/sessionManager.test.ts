import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { setOracleHomeDirOverrideForTest } from '../src/oracleHome.js';

type SessionModule = typeof import('../src/sessionManager.ts');
type SessionMetadata = Awaited<ReturnType<SessionModule['initializeSession']>>;

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-session-tests-'));
  setOracleHomeDirOverrideForTest(oracleHomeDir);
  sessionModule = await import('../src/sessionManager.ts');
  await sessionModule.ensureSessionStorage();
});

beforeEach(async () => {
  await rm(sessionModule.getSessionsDir(), { recursive: true, force: true });
  await sessionModule.ensureSessionStorage();
});

afterAll(async () => {
  await rm(oracleHomeDir, { recursive: true, force: true });
  setOracleHomeDirOverrideForTest(null);
});

describe('session storage setup', () => {
  test('ensureSessionStorage creates the sessions directory', async () => {
    await rm(sessionModule.getSessionsDir(), { recursive: true, force: true });
    await sessionModule.ensureSessionStorage();
    const stats = await stat(sessionModule.getSessionsDir());
    expect(stats.isDirectory()).toBe(true);
  });
});

describe('session identifiers', () => {
  test('createSessionId slugifies prompts without timestamps', () => {
    const id = sessionModule.createSessionId('  Hello, WORLD??? -- Example ');
    expect(id).toBe('hello-world-example');
  });

  test('createSessionId preserves whole words up to max limit', () => {
    const id = sessionModule.createSessionId('Alpha beta gamma delta epsilon zeta');
    expect(id).toBe('alpha-beta-gamma-delta-epsilon');
  });

  test('createSessionId accepts custom slugs and enforces word bounds', () => {
    const id = sessionModule.createSessionId('ignored', 'Launch plan QA sync ready??');
    expect(id).toBe('launch-plan-qa-sync-ready');
    expect(() => sessionModule.createSessionId('ignored', 'only two')).toThrow(/Custom slug/i);
  });

  test('createSessionId truncates overly long words to keep slugs readable', () => {
    const id = sessionModule.createSessionId('abcdefghijklm nopqrstuvwxyz shorty');
    expect(id).toBe('abcdefghij-nopqrstuvw-shorty');
  });
});

describe('session lifecycle', () => {
  test('initializeSession writes metadata, request, and log files', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-04-01T00:00:00Z'));
	    const metadata = await sessionModule.initializeSession(
	      {
	        prompt: 'Inspect code',
	        model: 'gpt-5.2-pro',
	        file: ['notes.md'],
	        maxInput: 123,
	        system: 'SYS',
        maxOutput: 456,
        silent: false,
        filesReport: true,
      },
      '/tmp/cwd',
    );
    vi.useRealTimers();
	    const baseDir = path.join(sessionModule.getSessionsDir(), metadata.id);
	    const storedMeta = JSON.parse(await readFile(path.join(baseDir, 'meta.json'), 'utf8'));
	    expect(storedMeta.options.file).toEqual(['notes.md']);
	    await expect(readFile(path.join(baseDir, 'request.json'), 'utf8')).rejects.toThrow();
	    const modelMeta = JSON.parse(await readFile(path.join(baseDir, 'models', 'gpt-5.2-pro.json'), 'utf8'));
	    expect(modelMeta.status).toBe('pending');
	    const perModelLog = await readFile(path.join(baseDir, 'models', 'gpt-5.2-pro.log'), 'utf8');
	    expect(perModelLog).toBe('');
	    const logContent = await readFile(path.join(baseDir, 'output.log'), 'utf8');
	    expect(logContent).toBe('');
	  });

  test('readSessionMetadata returns null for missing sessions and updateSessionMetadata persists changes', async () => {
	    expect(await sessionModule.readSessionMetadata('missing')).toBeNull();
	    const meta = await sessionModule.initializeSession(
	      { prompt: 'Update me', model: 'gpt-5.2-pro' },
	      '/tmp/cwd',
	    );
	    await sessionModule.updateSessionMetadata(meta.id, { status: 'complete', promptPreview: 'value' });
    const updated = await sessionModule.readSessionMetadata(meta.id);
    expect(updated?.status).toBe('complete');
    expect(updated?.promptPreview).toBe('value');
  });

  test('createSessionLogWriter appends logs and supports chunk writes', async () => {
	    const meta = await sessionModule.initializeSession(
	      { prompt: 'Log history', model: 'gpt-5.2-pro' },
	      '/tmp/cwd',
	    );
    const writer = sessionModule.createSessionLogWriter(meta.id);
    writer.logLine('First line');
    writer.writeChunk('Second chunk');
    writer.stream.end();
    await new Promise<void>((resolve) => writer.stream.once('close', () => resolve()));
    const logText = await sessionModule.readSessionLog(meta.id);
    expect(logText).toContain('First line');
    expect(logText).toContain('Second chunk');
  });

  test('readSessionLog falls back to empty string when no log exists', async () => {
    expect(await sessionModule.readSessionLog('missing')).toBe('');
  });

  test('initializeSession appends numeric suffix when slug already exists', async () => {
	    const first = await sessionModule.initializeSession(
	      { prompt: 'Duplicate slug please', model: 'gpt-5.2-pro', slug: 'alpha beta gamma' },
	      '/tmp/cwd',
	    );
	    const second = await sessionModule.initializeSession(
	      { prompt: 'Duplicate slug please again', model: 'gpt-5.2-pro', slug: 'alpha beta gamma' },
	      '/tmp/cwd',
	    );
    expect(first.id).toBe('alpha-beta-gamma');
    expect(second.id).toBe('alpha-beta-gamma-2');
  });

  test('initializeSession can restart from a base slug override and appends suffix on conflict', async () => {
    const first = await sessionModule.initializeSession(
      { prompt: 'Original', model: 'gpt-5.2-pro', slug: 'alpha beta gamma' },
      '/tmp/cwd',
    );
    const restarted = await sessionModule.initializeSession(
      { prompt: 'Restarted', model: 'gpt-5.2-pro' },
      '/tmp/cwd',
      undefined,
      first.id,
    );
    expect(restarted.id).toBe('alpha-beta-gamma-2');
  });

  test('marks stale running sessions as zombies after 60 minutes', async () => {
	    const meta = await sessionModule.initializeSession({ prompt: 'Zombie', model: 'gpt-5.2-pro' }, '/tmp/cwd');
    const staleStarted = new Date(Date.now() - sessionModule.ZOMBIE_MAX_AGE_MS - 60_000).toISOString();
    await sessionModule.updateSessionMetadata(meta.id, { status: 'running', startedAt: staleStarted });
    const listed = await sessionModule.listSessionsMetadata();
    const zombie = listed.find((m) => m.id === meta.id);
    expect(zombie?.status).toBe('error');
    expect(zombie?.errorMessage).toMatch(/zombie/i);
    const persisted = await sessionModule.readSessionMetadata(meta.id);
    expect(persisted?.status).toBe('error');
  });

  test('keeps running browser sessions when Chrome runtime is reachable', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const meta = await sessionModule.initializeSession(
      { prompt: 'Browser live', model: 'gpt-5.2-pro', mode: 'browser' },
      '/tmp/cwd',
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: 'running',
      mode: 'browser',
      browser: {
        runtime: {
          chromePid: process.pid,
          chromePort: port,
          chromeHost: '127.0.0.1',
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(refreshed?.status).toBe('running');
  });

  test('marks running browser sessions as error when Chrome runtime is gone', async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: 'Browser dead', model: 'gpt-5.2-pro', mode: 'browser' },
      '/tmp/cwd',
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: 'running',
      mode: 'browser',
      browser: {
        runtime: {
          chromePid: 999999,
          chromePort: 1,
          chromeHost: '127.0.0.1',
        },
      },
    });
    const refreshed = await sessionModule.readSessionMetadata(meta.id);
    expect(refreshed?.status).toBe('error');
    expect(refreshed?.errorMessage).toMatch(/chrome/i);
  });
});

describe('session listing and filtering', () => {
  test('listSessionsMetadata sorts newest first and filterSessionsByRange enforces limits', async () => {
	    vi.useFakeTimers();
	    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
	    await sessionModule.initializeSession({ prompt: 'Old session', model: 'gpt-5.2-pro' }, '/tmp/a');
	    vi.setSystemTime(new Date('2025-01-02T12:00:00Z'));
	    const recent = await sessionModule.initializeSession(
	      { prompt: 'Recent session', model: 'gpt-5.2-pro' },
	      '/tmp/b',
	    );
    vi.setSystemTime(new Date('2025-01-03T00:00:00Z'));
    const metas = await sessionModule.listSessionsMetadata();
    expect(metas[0].id).toBe(recent.id);

    const rangeResult = sessionModule.filterSessionsByRange(metas, { hours: 24 });
    expect(rangeResult.entries.map((entry: SessionMetadata) => entry.id)).toEqual([recent.id]);

    const limited = sessionModule.filterSessionsByRange(metas, { includeAll: true, limit: 1 });
    expect(limited.entries).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(limited.total).toBe(2);
    vi.useRealTimers();
  });

  test('deleteSessionsOlderThan removes only sessions past the cutoff', async () => {
	    vi.useFakeTimers();
	    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
	    const oldMeta = await sessionModule.initializeSession({ prompt: 'Old', model: 'gpt-5.2-pro' }, '/tmp/a');
	    vi.setSystemTime(new Date('2025-01-03T00:00:00Z'));
	    const freshMeta = await sessionModule.initializeSession({ prompt: 'Fresh', model: 'gpt-5.2-pro' }, '/tmp/b');
    vi.setSystemTime(new Date('2025-01-03T12:00:00Z'));

    const result = await sessionModule.deleteSessionsOlderThan({ hours: 24 });
    expect(result).toEqual({ deleted: 1, remaining: 1 });
    expect(await sessionModule.readSessionMetadata(oldMeta.id)).toBeNull();
    expect(await sessionModule.readSessionMetadata(freshMeta.id)).not.toBeNull();
    vi.useRealTimers();
  });

  test('deleteSessionsOlderThan clears everything when includeAll is true', async () => {
	    const meta = await sessionModule.initializeSession({ prompt: 'Only', model: 'gpt-5.2-pro' }, '/tmp/c');
	    const result = await sessionModule.deleteSessionsOlderThan({ includeAll: true });
	    expect(result).toEqual({ deleted: 1, remaining: 0 });
	    expect(await sessionModule.readSessionMetadata(meta.id)).toBeNull();
	  });
});

describe('wait helper', () => {
  test('wait resolves after the requested duration', async () => {
    vi.useFakeTimers();
    const pending = sessionModule.wait(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
