import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ensureModelSelection,
  waitForAssistantResponse,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  navigateToChatGPT,
  ensurePromptReady,
  ensureNotBlocked,
  ensureLoggedIn,
} from '../../src/browser/pageActions.js';
import * as attachments from '../../src/browser/actions/attachments.js';
import type { ChromeClient } from '../../src/browser/types.js';

const logger = vi.fn();

beforeEach(() => {
  logger.mockClear();
});

describe('ensureModelSelection', () => {
  test('logs when model already selected', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: 'already-selected', label: 'GPT-5.2 Pro' } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureModelSelection(runtime, 'GPT-5.2 Pro', logger)).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith('Model picker: GPT-5.2 Pro');
  });

  test('throws when option missing', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: 'option-not-found' } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureModelSelection(runtime, 'GPT-5 Pro', logger)).rejects.toThrow(
      /Unable to find model option matching/,
    );
  });

  test('throws when button missing', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: 'button-missing' } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureModelSelection(runtime, 'Instant', logger)).rejects.toThrow(
      /Unable to locate the ChatGPT model selector button/,
    );
  });
});

describe('navigateToChatGPT', () => {
  test('navigates and waits for ready state', async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: 'loading' } })
        .mockResolvedValueOnce({ result: { value: 'complete' } }),
    } as unknown as ChromeClient['Runtime'];
    await navigateToChatGPT(
      { navigate } as unknown as ChromeClient['Page'],
      runtime,
      'https://chat.openai.com',
      logger,
    );
    expect(navigate).toHaveBeenCalledWith({ url: 'https://chat.openai.com' });
    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
  });
});

describe('ensurePromptReady', () => {
  test('resolves when input selector enabled', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: true } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensurePromptReady(runtime, 1000, logger)).resolves.toBeUndefined();
    expect(logger).not.toHaveBeenCalled();
  });

  test('throws when timeout reached', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: false } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensurePromptReady(runtime, 0, logger)).rejects.toThrow(/textarea did not appear/i);
  });
});

describe('ensureNotBlocked', () => {
  test('throws descriptive error when cloudflare detected', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: 'Just a moment...' } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureNotBlocked(runtime, true, logger)).rejects.toThrow(/headless mode/i);
    expect(logger).toHaveBeenCalledWith('Cloudflare anti-bot page detected');
  });

  test('passes through when title clean', async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: 'ChatGPT' } })
        .mockResolvedValueOnce({ result: { value: false } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureNotBlocked(runtime, false, logger)).resolves.toBeUndefined();
  });
});

describe('ensureLoggedIn', () => {
  test('logs success when session is present', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { ok: true, status: 200, url: '/backend-api/me' } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureLoggedIn(runtime, logger, { appliedCookies: 2 })).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Login check passed'));
  });

  test('throws with cookie guidance when cookies missing', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { ok: false, status: 401, url: '/backend-api/me', domLoginCta: true, onAuthPage: true } },
      }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureLoggedIn(runtime, logger, { appliedCookies: 0 })).rejects.toThrow(/inline cookies/i);
  });

  test('uses remote hint for remote sessions', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { ok: false, status: 401, url: '/backend-api/me' } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureLoggedIn(runtime, logger, { remoteSession: true })).rejects.toThrow(/remote Chrome session/i);
  });
});

describe('waitForAssistantResponse', () => {
  test('returns captured assistant payload', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          type: 'object',
          value: { text: 'Answer', html: '<p>Answer</p>', messageId: 'mid', turnId: 'tid' },
        },
      }),
    } as unknown as ChromeClient['Runtime'];
    const result = await waitForAssistantResponse(runtime, 1000, logger);
    expect(result.text).toBe('Answer');
    expect(result.meta).toEqual({ messageId: 'mid', turnId: 'tid' });
  });

  test('response observer watches character data mutations', async () => {
    let capturedExpression = '';
    const runtime = {
      evaluate: vi.fn().mockImplementation((params) => {
        if (params?.awaitPromise) {
          capturedExpression = String(params?.expression ?? '');
          throw new Error('stop');
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient['Runtime'];
    await expect(waitForAssistantResponse(runtime, 100, logger)).rejects.toThrow('stop');
    expect(capturedExpression).toContain('characterData: true');
    expect(capturedExpression).toContain('copy-turn-action-button');
    expect(capturedExpression).toContain('isLastAssistantTurnFinished');
    expect(capturedExpression).toContain('lastAssistantTurn.querySelector(FINISHED_SELECTOR)');
    expect(capturedExpression).not.toContain('document.querySelector(FINISHED_SELECTOR)');
    expect(capturedExpression).toContain("lastAssistantTurn.querySelectorAll('.markdown')");
    expect(capturedExpression).not.toContain("document.querySelectorAll('.markdown')");
  });

  test('falls back to snapshot when observer fails', async () => {
    const evaluate = vi.fn().mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
      if (params?.awaitPromise) {
        throw new Error('observer failed');
      }
      if (typeof params?.expression === 'string' && params.expression.includes('extractAssistantTurn')) {
        return {
          result: { value: { text: 'Recovered', html: '<p>Recovered</p>', messageId: 'mid', turnId: 'tid' } },
        };
      }
      return { result: { value: null } };
    });
    const runtime = { evaluate } as unknown as ChromeClient['Runtime'];
    const result = await waitForAssistantResponse(runtime, 200, logger);
    expect(result.text).toBe('Recovered');
    expect(evaluate).toHaveBeenCalled();
  });
});

describe('uploadAttachmentFile', () => {
  test.skip('selects DOM input and uploads file', async () => {
    logger.mockClear();
    vi.spyOn(attachments, 'waitForAttachmentVisible').mockResolvedValue(undefined);
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient['DOM'];
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { matched: true, found: true } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: '/tmp/foo.md', displayPath: 'foo.md' },
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(dom.querySelector).toHaveBeenCalled();
    expect(dom.setFileInputFiles).toHaveBeenCalledWith({ nodeId: 2, files: ['/tmp/foo.md'] });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Attachment queued'));
  }, 15_000);

  test('throws when file input missing', async () => {
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 0 }),
    } as unknown as ChromeClient['DOM'];
    const runtime = {
      evaluate: vi.fn(),
    } as unknown as ChromeClient['Runtime'];
    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: '/tmp/foo.md', displayPath: 'foo.md' },
        logger,
      ),
    ).rejects.toThrow(
      /unable to locate.*attachment input/i,
    );
  });
});

describe('waitForAttachmentCompletion', () => {
  test('resolves when composer ready', async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { state: 'disabled', uploading: true, filesAttached: true } } })
        .mockResolvedValueOnce({ result: { value: { state: 'ready', uploading: false, filesAttached: true } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(waitForAttachmentCompletion(runtime, 500)).resolves.toBeUndefined();
    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
  });

  test('resolves when send button missing but files present', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: { value: { state: 'missing', uploading: false, filesAttached: true } },
      }),
    } as unknown as ChromeClient['Runtime'];
    await expect(waitForAttachmentCompletion(runtime, 200)).resolves.toBeUndefined();
  });

  test('rejects when timeout reached', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { state: 'disabled', uploading: true, filesAttached: false } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(waitForAttachmentCompletion(runtime, 200)).rejects.toThrow(/Attachments did not finish/);
  });
});
