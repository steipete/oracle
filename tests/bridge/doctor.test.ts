import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setOracleHomeDirOverrideForTest } from '../../src/oracleHome.js';

// biome-ignore lint/complexity/useRegexLiterals: constructor form avoids control-char lint noise.
const ansiRegex = new RegExp('\\x1B\\[[0-9;]*m', 'g');
const stripAnsi = (text: string): string => text.replace(ansiRegex, '');

vi.mock('../../src/remote/health.js', () => ({
  checkTcpConnection: vi.fn(async () => ({ ok: true })),
  checkRemoteHealth: vi.fn(async () => ({ ok: true, version: 'test', uptimeSeconds: 1 })),
}));

vi.mock('../../src/browser/detect.js', () => ({
  detectChromeBinary: vi.fn(async () => ({ path: '/usr/bin/google-chrome' })),
  detectChromeCookieDb: vi.fn(async () => '/home/user/.config/google-chrome/Default/Cookies'),
}));

import { runBridgeDoctor } from '../../src/cli/bridge/doctor.js';

  describe('oracle bridge doctor', () => {
    let tempDir: string;
    let originalExitCode: number | undefined;

    beforeEach(async () => {
    originalExitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
    process.exitCode = undefined;
    delete process.env.ORACLE_REMOTE_HOST;
    delete process.env.ORACLE_REMOTE_TOKEN;
    delete process.env.ORACLE_ENGINE;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-bridge-doctor-'));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    process.exitCode = originalExitCode;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports healthy remote configuration', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ browser: { remoteHost: '127.0.0.1:9473', remoteToken: 'secret' } }, null, 2),
      'utf8',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(String(msg)));

    await runBridgeDoctor({ verbose: false });

    const output = stripAnsi(logs.join('\n'));
    expect(output).toMatch(/Remote service:\s+configured/i);
    expect(output).toMatch(/TCP connect:\s+ok/i);
    expect(output).toContain('Auth (/health):');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('fails when remote token is missing', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ browser: { remoteHost: '127.0.0.1:9473' } }, null, 2),
      'utf8',
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => logs.push(String(msg)));

    await runBridgeDoctor({ verbose: false });

    const output = stripAnsi(logs.join('\n'));
    expect(output).toMatch(/remoteToken:\s+missing/i);
    expect(output).toMatch(/Problems:/i);
    expect(process.exitCode).toBe(1);
  });
});
