import { describe, expect, it } from 'vitest';
import { runOracle, extractTextOutput } from '../../src/oracle.js';

const live = process.env.ORACLE_LIVE_TEST === '1';
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

(live ? describe : describe.skip)('Claude 4.5 live smoke', () => {
  if (!hasKey) {
    it.skip('requires ANTHROPIC_API_KEY', () => {});
    return;
  }

  it(
    'returns a short answer',
    async () => {
      const result = await runOracle(
        {
          prompt: 'Give one short sentence about photosynthesis.',
          model: 'claude-4.5-sonnet',
          search: false,
        },
        { log: () => {}, write: () => true },
      );
      if (result.mode !== 'live') {
        throw new Error(`Expected live result, received ${result.mode ?? 'unknown'}`);
      }
      const text = extractTextOutput(result.response);
      expect(text?.length ?? 0).toBeGreaterThan(10);
    },
    120_000,
  );
});
