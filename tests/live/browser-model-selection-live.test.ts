import { describe, expect, test } from 'vitest';
import { runBrowserMode } from '../../src/browser/index.js';
import type { BrowserLogger } from '../../src/browser/types.js';
import { getCookies } from '@steipete/sweet-cookie';
import { acquireLiveTestLock, releaseLiveTestLock } from './liveLock.js';

const LIVE = process.env.ORACLE_LIVE_TEST === '1';

async function hasChatGptCookies(): Promise<boolean> {
  const { cookies } = await getCookies({
    url: 'https://chatgpt.com',
    origins: ['https://chatgpt.com', 'https://chat.openai.com', 'https://atlas.openai.com'],
    browsers: ['chrome'],
    mode: 'merge',
    chromeProfile: 'Default',
    timeoutMs: 5_000,
  });
  // Learned: ChatGPT session token is the most reliable "logged in" signal for live browser tests.
  const hasSession = cookies.some((cookie) => cookie.name.startsWith('__Secure-next-auth.session-token'));
  if (!hasSession) {
    console.warn(
      'Skipping ChatGPT browser live tests (missing __Secure-next-auth.session-token). Open chatgpt.com in Chrome and retry.',
    );
    return false;
  }
  return true;
}

function createLogCapture() {
  const lines: string[] = [];
  const log: BrowserLogger = (message: string) => {
    lines.push(message);
  };
  return { log, lines };
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

const CASES = [
  {
    name: 'auto',
    desiredModel: 'GPT-5.2',
    expected: ['5.2'],
  },
  {
    name: 'thinking',
    desiredModel: 'GPT-5.2 Thinking',
    expected: ['5.2', 'thinking'],
  },
  {
    name: 'instant',
    desiredModel: 'GPT-5.2 Instant',
    expected: ['5.2', 'instant'],
  },
];

(LIVE ? describe : describe.skip)('ChatGPT browser live model selection', () => {
  test(
    'selects GPT-5.2 variants reliably',
    async () => {
      if (!(await hasChatGptCookies())) return;
      // Learned: serialize live browser tests to avoid Chrome profile contention.
      await acquireLiveTestLock('chatgpt-browser');
      try {
        for (const entry of CASES) {
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            const { log, lines } = createLogCapture();
            try {
              // Learned: echo the prompt token so we can assert we captured the right assistant turn.
              const promptToken = `live browser ${entry.name}`;
              const result = await runBrowserMode({
                prompt: `${promptToken}\nRepeat the first line exactly. No other text.`,
                config: {
                  chromeProfile: 'Default',
                  desiredModel: entry.desiredModel,
                  timeoutMs: 180_000,
                },
                log,
              });

              const normalizedAnswer = result.answerText.toLowerCase().replace(/\s+/g, ' ').trim();
              const normalizedExpected = promptToken.toLowerCase();
              const truncatedOk =
                normalizedExpected.startsWith(normalizedAnswer) &&
                normalizedAnswer.length >= Math.max(0, normalizedExpected.length - 2);
              expect(normalizedAnswer.includes(normalizedExpected) || truncatedOk).toBe(true);

              const modelLog = lines.find((line) => line.toLowerCase().startsWith('model picker:'));
              expect(modelLog).toBeTruthy();
              if (modelLog) {
                const label = normalizeLabel(modelLog.replace(/^model picker:\s*/i, ''));
                for (const token of entry.expected) {
                  expect(label).toContain(token);
                }
              }
              break;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (message.includes('Unable to find model option')) {
                console.warn(`Skipping ${entry.name} model selection (not available for this account): ${message}`);
                break;
              }
              const transient =
                message.includes('Chrome window closed before oracle finished') ||
                message.includes('Prompt did not appear in conversation before timeout') ||
                message.includes('Reattach target did not respond');
              if (transient && attempt < 3) {
                console.warn(`Retrying ${entry.name} model selection (attempt ${attempt + 1}/3): ${message}`);
                await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
                continue;
              }
              throw error;
            }
          }
        }
      } finally {
        await releaseLiveTestLock('chatgpt-browser');
      }
    },
    15 * 60 * 1000,
  );
});
