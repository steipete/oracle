import { describe, expect, test } from 'vitest';
import type { SessionModelRun } from '../../src/sessionStore.js';
import { buildConsultBrowserConfig, summarizeModelRunsForConsult } from '../../src/mcp/tools/consult.ts';
import type { UserConfig } from '../../src/config.js';

describe('summarizeModelRunsForConsult', () => {
  test('maps per-model metadata into consult summaries', () => {
    const runs: SessionModelRun[] = [
      {
        model: 'gpt-5.2-pro',
        status: 'completed',
        startedAt: '2025-11-19T00:00:00Z',
        completedAt: '2025-11-19T00:00:30Z',
        usage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, totalTokens: 1200 },
        response: { id: 'resp_123', requestId: 'req_456', status: 'completed' },
        log: { path: 'models/gpt-5.2-pro.log' },
      },
    ];
    const result = summarizeModelRunsForConsult(runs);
    expect(result).toEqual([
      expect.objectContaining({
        model: 'gpt-5.2-pro',
        status: 'completed',
        usage: expect.objectContaining({ totalTokens: 1200 }),
        response: expect.objectContaining({ id: 'resp_123' }),
        logPath: 'models/gpt-5.2-pro.log',
      }),
    ]);
  });

  test('returns undefined for empty lists', () => {
    expect(summarizeModelRunsForConsult([])).toBeUndefined();
    expect(summarizeModelRunsForConsult(undefined)).toBeUndefined();
  });

  test('merges browser defaults from config for consult runs', () => {
    const userConfig = {
      browser: {
        chatgptUrl: 'https://chatgpt.com/g/g-p-foo/project',
        debugPort: 9224,
        keepBrowser: true,
        manualLogin: true,
        manualLoginProfileDir: '/tmp/oracle-profile',
        cookieSync: false,
        thinkingTime: 'extended',
      },
    } as UserConfig;

    const config = buildConsultBrowserConfig({
      userConfig,
      env: {},
      runModel: 'gpt-5.1',
      inputModel: 'gpt-5.1',
    });

    expect(config).toMatchObject({
      chatgptUrl: 'https://chatgpt.com/g/g-p-foo/project',
      url: 'https://chatgpt.com/g/g-p-foo/project',
      debugPort: 9224,
      keepBrowser: true,
      manualLogin: true,
      manualLoginProfileDir: '/tmp/oracle-profile',
      thinkingTime: 'extended',
      desiredModel: 'GPT-5.2',
      cookieSync: false,
    });
  });

  test('lets explicit consult inputs override config defaults without dropping cookie settings', () => {
    const userConfig = {
      browser: {
        cookieSync: true,
        keepBrowser: false,
        manualLogin: false,
        manualLoginCookieSync: true,
        manualLoginProfileDir: '/tmp/config-profile',
        thinkingTime: 'light',
      },
    } as UserConfig;

    const config = buildConsultBrowserConfig({
      userConfig,
      env: {
        ['ORACLE_BROWSER_PROFILE_DIR']: '/tmp/env-profile',
      },
      runModel: 'claude-3.7-sonnet',
      inputModel: 'claude-3.7-sonnet',
      browserModelLabel: 'Claude Sonnet',
      browserKeepBrowser: true,
      browserThinkingTime: 'heavy',
    });

    expect(config).toMatchObject({
      keepBrowser: true,
      manualLogin: true,
      manualLoginProfileDir: '/tmp/env-profile',
      manualLoginCookieSync: true,
      thinkingTime: 'heavy',
      desiredModel: 'Claude Sonnet',
      cookieSync: true,
    });
  });
});
