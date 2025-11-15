import { describe, expect, test, vi } from 'vitest';
import { ensureModelSelection, waitForAssistantResponse } from '../../src/browser/pageActions.js';
import type { ChromeClient } from '../../src/browser/types.js';

const logger = vi.fn();

describe('ensureModelSelection', () => {
  test('logs when model already selected', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: 'already-selected', label: 'ChatGPT 5.1' } } }),
    } as unknown as ChromeClient['Runtime'];
    await expect(ensureModelSelection(runtime, 'ChatGPT 5.1', logger)).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith('Model picker: ChatGPT 5.1');
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
});
