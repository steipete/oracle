import { describe, expect, test, vi } from 'vitest';
import { ensureModelSelection, waitForAssistantResponse } from '../../src/browser/pageActions.js';

const logger = vi.fn();

describe('ensureModelSelection', () => {
  test('passes when runtime selects target model', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: 'already-selected', label: 'ChatGPT 5.1' } } }),
    };
    await expect(ensureModelSelection(runtime as any, 'ChatGPT 5.1', logger)).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith('Model picker: ChatGPT 5.1');
  });

  test('throws when option missing', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: 'option-not-found' } } }),
    };
    await expect(ensureModelSelection(runtime as any, 'GPT-5 Pro', logger)).rejects.toThrow(/Failed to select model/);
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
    };
    const result = await waitForAssistantResponse(runtime as any, 1000, logger);
    expect(result.text).toBe('Answer');
    expect(result.meta).toEqual({ messageId: 'mid', turnId: 'tid' });
  });
});
