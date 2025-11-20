import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const getCookiesPromised = vi.fn();
const getPassword = vi.fn();

vi.mock('chrome-cookies-secure', () => ({ default: { getCookiesPromised } }));
vi.mock('keytar', () => ({ default: { getPassword } }));

const macTest = process.platform === 'darwin' ? test : test.skip;
const originalTimeoutEnv = process.env.ORACLE_COOKIE_LOAD_TIMEOUT_MS;
const originalProbeEnv = process.env.ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS;

describe('loadChromeCookies hardening', () => {
  afterEach(() => {
    if (originalTimeoutEnv === undefined) {
      delete process.env.ORACLE_COOKIE_LOAD_TIMEOUT_MS;
    } else {
      process.env.ORACLE_COOKIE_LOAD_TIMEOUT_MS = originalTimeoutEnv;
    }
    if (originalProbeEnv === undefined) {
      delete process.env.ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS;
    } else {
      process.env.ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS = originalProbeEnv;
    }
    vi.resetModules();
    vi.resetAllMocks();
  });

  test('times out when chrome-cookies-secure never resolves', async () => {
    process.env.ORACLE_COOKIE_LOAD_TIMEOUT_MS = '20';
    getPassword.mockResolvedValue('secret');
    getCookiesPromised.mockReturnValue(new Promise(() => {}));

    const { loadChromeCookies } = await import('../../src/browser/chromeCookies.js');
    const cookieFile = await createTempCookieFile();

    try {
      await expect(
        loadChromeCookies({ targetUrl: 'https://chatgpt.com', explicitCookiePath: cookieFile }),
      ).rejects.toThrow(/Timed out reading Chrome cookies/i);
    } finally {
      await fs.rm(path.dirname(cookieFile), { recursive: true, force: true });
    }
  });

  macTest('fails fast when keychain lookup rejects', async () => {
    process.env.ORACLE_COOKIE_LOAD_TIMEOUT_MS = '20';
    process.env.ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS = '20';
    getPassword.mockRejectedValue(new Error('Keychain access denied'));
    getCookiesPromised.mockResolvedValue([]);

    const { loadChromeCookies } = await import('../../src/browser/chromeCookies.js');
    const cookieFile = await createTempCookieFile();

    try {
      await expect(
        loadChromeCookies({ targetUrl: 'https://chatgpt.com', explicitCookiePath: cookieFile }),
      ).rejects.toThrow(/Keychain/);
      expect(getCookiesPromised).not.toHaveBeenCalled();
    } finally {
      await fs.rm(path.dirname(cookieFile), { recursive: true, force: true });
    }
  });
});

async function createTempCookieFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-cookies-'));
  const cookieFile = path.join(dir, 'Cookies');
  await fs.writeFile(cookieFile, '');
  return cookieFile;
}
