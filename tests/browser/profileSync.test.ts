import { beforeEach, describe, expect, test, vi } from 'vitest';
import path from 'node:path';

const rmMock = vi.fn();
const mkdirMock = vi.fn();
const copyDirMock = vi.fn();
const existsSyncMock = vi.fn();
let spawnResult: { status?: number; error?: Error | null } = { status: 0 };

vi.mock('node:child_process', () => {
  const spawnSync = vi.fn(() => spawnResult);
  return { spawnSync };
});

vi.mock('node:fs', () => {
  const existsSync = (...args: unknown[]) => existsSyncMock(...args);
  return { existsSync };
});

vi.mock('node:fs/promises', () => {
  const rm = (...args: unknown[]) => rmMock(...args);
  const mkdir = (...args: unknown[]) => mkdirMock(...args);
  const cp = (...args: unknown[]) => copyDirMock(...args);
  return { rm, mkdir, cp };
});

vi.mock('../../src/browser/chromeCookies.ts', () => {
  const defaultProfileRoot = vi.fn(async () => '/profiles');
  const expandPath = (p: string) => p;
  const looksLikePath = (value: string) => value.includes('/') || value.includes('\\');
  return { defaultProfileRoot, expandPath, looksLikePath };
});

describe('syncChromeProfile', () => {
  beforeEach(() => {
    rmMock.mockReset();
    mkdirMock.mockReset();
    copyDirMock.mockReset();
    existsSyncMock.mockReset();
    rmMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    copyDirMock.mockResolvedValue(undefined);
    spawnResult = { status: 0 };
    existsSyncMock.mockReturnValue(true);
  });

  test('uses rsync when available and strips locks', async () => {
    const { syncChromeProfile } = await import('../../src/browser/profileSync.js');
    const result = await syncChromeProfile({
      profile: 'Default',
      targetDir: '/tmp/target',
    });
    expect(result.method).toBe('rsync');
    expect(result.profileName).toBe('Default');
    // rm called to clear target + lock cleanup
    const calls = rmMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((p) => p.endsWith('SingletonLock'))).toBe(true);
    expect(calls.some((p) => p.endsWith(path.join('Default', 'DevToolsActivePort')))).toBe(true);
  });

  test('falls back to node copy when rsync fails', async () => {
    spawnResult = { status: 8, error: new Error('rsync missing') };
    const { syncChromeProfile } = await import('../../src/browser/profileSync.js');
    const result = await syncChromeProfile({
      profile: 'Default',
      targetDir: '/tmp/target',
    });
    expect(result.method).toBe('node');
    expect(copyDirMock).toHaveBeenCalled();
  });

  test('resolves profile name via defaultProfileRoot', async () => {
    const { syncChromeProfile } = await import('../../src/browser/profileSync.js');
    const result = await syncChromeProfile({
      profile: 'Profile 2',
      targetDir: '/tmp/target',
    });
    expect(result.source).toBe('/profiles/Profile 2');
  });
});
