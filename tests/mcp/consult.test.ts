import { describe, expect, test } from 'vitest';
import type { SessionModelRun } from '../../src/sessionStore.js';
import { summarizeModelRunsForConsult } from '../../src/mcp/tools/consult.ts';

describe('summarizeModelRunsForConsult', () => {
  test('maps per-model metadata into consult summaries', () => {
    const runs: SessionModelRun[] = [
      {
        model: 'gpt-5.1-pro',
        status: 'completed',
        startedAt: '2025-11-19T00:00:00Z',
        completedAt: '2025-11-19T00:00:30Z',
        usage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, totalTokens: 1200 },
        response: { id: 'resp_123', requestId: 'req_456', status: 'completed' },
        log: { path: 'models/gpt-5.1-pro.log' },
      },
    ];
    const result = summarizeModelRunsForConsult(runs);
    expect(result).toEqual([
      expect.objectContaining({
        model: 'gpt-5.1-pro',
        status: 'completed',
        usage: expect.objectContaining({ totalTokens: 1200 }),
        response: expect.objectContaining({ id: 'resp_123' }),
        logPath: 'models/gpt-5.1-pro.log',
      }),
    ]);
  });

  test('returns undefined for empty lists', () => {
    expect(summarizeModelRunsForConsult([])).toBeUndefined();
    expect(summarizeModelRunsForConsult(undefined)).toBeUndefined();
  });
});
