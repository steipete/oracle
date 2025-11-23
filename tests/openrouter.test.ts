import { describe, it, expect, vi } from 'vitest';
import { resolveModelConfig, safeModelSlug, isOpenRouterBaseUrl } from '../src/oracle/modelResolver.js';

describe('OpenRouter helpers', () => {
  it('slugifies model ids with slashes', () => {
    expect(safeModelSlug('minimax/minimax-m2')).toBe('minimax__minimax-m2');
  });

  it('hydrates config from OpenRouter catalog', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 'minimax/minimax-m2',
            context_length: 100000,
            pricing: { prompt: 2, completion: 3 },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const config = await resolveModelConfig('minimax/minimax-m2', {
      openRouterApiKey: 'dummy',
      fetcher,
    });

    expect(config.apiModel).toBe('minimax/minimax-m2');
    expect(config.inputLimit).toBe(100000);
    expect(config.pricing?.inputPerToken).toBeCloseTo(2 / 1_000_000);
    expect(config.pricing?.outputPerToken).toBeCloseTo(3 / 1_000_000);
  });

  it('falls back to OpenRouter when provider key is missing but OPENROUTER_API_KEY is present', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch;

    const config = await resolveModelConfig('minimax/minimax-m2', {
      openRouterApiKey: 'dummy',
      fetcher,
    });

    expect(config.apiModel).toBe('minimax/minimax-m2');
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1/responses')).toBe(true);
  });

  it('detects OpenRouter base URLs', () => {
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1/responses')).toBe(true);
    expect(isOpenRouterBaseUrl('https://api.openai.com')).toBe(false);
  });
});
