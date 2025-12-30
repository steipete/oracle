import { describe, expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import CDP from 'chrome-remote-interface';
import { runBrowserMode } from '../../src/browser/index.js';
import {
  getDevToolsActivePortPaths,
  verifyDevToolsReachable,
} from '../../src/browser/profileState.js';
import type { BrowserRuntimeMetadata } from '../../src/sessionStore.js';
import { acquireLiveTestLock, releaseLiveTestLock } from './liveLock.js';

const LIVE = process.env.ORACLE_LIVE_TEST === '1';
const MANUAL = process.env.ORACLE_LIVE_TEST_MANUAL_LOGIN === '1';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.oracle', 'browser-profile');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRuntimeHint<T extends { chromePort?: number; chromeTargetId?: string }>(
  getHint: () => T | null,
  timeoutMs = 30_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hint = getHint();
    if (hint?.chromePort && hint?.chromeTargetId) {
      return hint;
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for browser runtime hint.');
}

(LIVE && MANUAL ? describe : describe.skip)('ChatGPT browser live manual-login cleanup', () => {
  test(
    'preserves DevToolsActivePort when connection drops but Chrome stays running',
    async () => {
      const profileDir = process.env.ORACLE_BROWSER_PROFILE_DIR ?? DEFAULT_PROFILE_DIR;
      try {
        await access(profileDir);
      } catch {
        console.warn(`Skipping manual-login live test (missing profile dir: ${profileDir}).`);
        return;
      }

      await acquireLiveTestLock('chatgpt-browser');
      try {
        let runtimeHint: BrowserRuntimeMetadata | null = null;
        const promptToken = `live manual login cleanup ${Date.now()}`;
        const runPromise = runBrowserMode({
          prompt: `${promptToken}\nRepeat the first line exactly. No other text.`,
          config: {
            manualLogin: true,
            manualLoginProfileDir: profileDir,
            keepBrowser: false,
            timeoutMs: 180_000,
          },
          runtimeHintCb: (hint) => {
            runtimeHint = hint;
          },
        });

        const hint = await waitForRuntimeHint(() => runtimeHint);
        const host = hint.chromeHost ?? '127.0.0.1';
        const port = hint.chromePort ?? 0;
        const targetId = hint.chromeTargetId ?? '';

        await delay(1_000);
        await CDP.Close({ host, port, id: targetId });

        let runError: Error | null = null;
        try {
          await runPromise;
        } catch (error) {
          runError = error instanceof Error ? error : new Error(String(error));
        }

        expect(runError).toBeTruthy();
        if (runError) {
          expect(runError.message.toLowerCase()).toMatch(/connection|chrome window closed|target closed/);
        }

        const probe = await verifyDevToolsReachable({ port, host });
        if (!probe.ok) {
          console.warn('Skipping DevToolsActivePort assertion; Chrome not reachable after target close.');
          return;
        }

        const userDataDir = hint.userDataDir ?? profileDir;
        const paths = getDevToolsActivePortPaths(userDataDir);
        expect(paths.some((candidate) => existsSync(candidate))).toBe(true);
      } finally {
        await releaseLiveTestLock('chatgpt-browser');
      }
    },
    12 * 60 * 1000,
  );
});
