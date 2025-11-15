import { beforeEach, describe, expect, test, vi } from 'vitest';
import { syncCookies } from '../../src/browser/cookies.js';

const getCookiesPromised = vi.fn();
vi.mock('chrome-cookies-secure', () => ({ getCookiesPromised }));

const logger = vi.fn();

beforeEach(() => {
  getCookiesPromised.mockReset();
  logger.mockReset();
});

describe('syncCookies', () => {
  test('replays cookies via DevTools Network.setCookie', async () => {
    getCookiesPromised.mockResolvedValue([
      { name: 'sid', value: 'abc', domain: '.chatgpt.com' },
      { name: 'csrftoken', value: 'xyz', domain: 'chatgpt.com' },
    ]);
    const setCookie = vi.fn().mockResolvedValue({ success: true });
    const applied = await syncCookies({ setCookie } as any, 'https://chatgpt.com', null, logger);
    expect(applied).toBe(2);
    expect(setCookie).toHaveBeenCalledTimes(2);
  });

  test('swallows failures and returns zero', async () => {
    getCookiesPromised.mockRejectedValue(new Error('boom'));
    const applied = await syncCookies({ setCookie: vi.fn() } as any, 'https://chatgpt.com', null, logger);
    expect(applied).toBe(0);
  });
});
