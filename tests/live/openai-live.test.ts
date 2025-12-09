import { describe, test, expect } from 'vitest';
import { runOracle, extractTextOutput, OracleTransportError } from '../../src/oracle.ts';

const ENABLE_LIVE = process.env.ORACLE_LIVE_TEST === '1';
const LIVE_API_KEY = process.env.OPENAI_API_KEY;

if (!ENABLE_LIVE || !LIVE_API_KEY) {
  describe.skip('OpenAI live smoke tests', () => {
    test('Set ORACLE_LIVE_TEST=1 with a real OPENAI_API_KEY to run these integration tests.', () => {});
  });
} else {
  const sharedDeps = {
    apiKey: LIVE_API_KEY,
    log: () => {},
    write: () => true,
  } as const;

  describe('OpenAI live smoke tests', () => {
    test(
      'gpt-5.1 returns completed (no in_progress)',
      async () => {
        const result = await runOracle(
          {
            prompt: 'Reply with "live 5.1 completion" on one line.',
            model: 'gpt-5.1',
            silent: true,
            background: false,
            heartbeatIntervalMs: 0,
            maxOutput: 64,
          },
          sharedDeps,
        );
        if (result.mode !== 'live') {
          throw new Error('Expected live result');
        }
        const text = extractTextOutput(result.response).toLowerCase();
        expect(text).toContain('live 5.1 completion');
        expect(result.response.status ?? 'completed').toBe('completed');
      },
      5 * 60 * 1000,
    );

    test(
      'gpt-5-pro background flow eventually completes',
      async () => {
        const result = await runOracle(
          {
            prompt: 'Reply with "live pro smoke test" on a single line.',
            model: 'gpt-5-pro',
            silent: true,
            heartbeatIntervalMs: 2000,
          },
          sharedDeps,
        );
        if (result.mode !== 'live') {
          throw new Error('Expected live result');
        }
        const text = extractTextOutput(result.response);
        expect(text.toLowerCase()).toContain('live pro smoke test');
        expect(result.response.status ?? 'completed').toBe('completed');
      },
      30 * 60 * 1000,
    );

    test(
      'gpt-5 foreground flow still streams normally',
      async () => {
        const result = await runOracle(
          {
            prompt: 'Reply with "live base smoke test" on a single line.',
            model: 'gpt-5.1',
            silent: true,
            background: false,
            heartbeatIntervalMs: 0,
          },
          sharedDeps,
        );
        if (result.mode !== 'live') {
          throw new Error('Expected live result');
        }
        const text = extractTextOutput(result.response);
        expect(text.toLowerCase()).toContain('live base smoke test');
        expect(result.response.status ?? 'completed').toBe('completed');
      },
      10 * 60 * 1000,
    );

    test(
      'gpt-5.1-pro currently reports model-unavailable (temporary guard)',
      async () => {
        try {
          await runOracle(
            {
              prompt: 'This should fail because gpt-5.1-pro is not live yet.',
              model: 'gpt-5.1-pro',
              silent: true,
              background: false,
              heartbeatIntervalMs: 0,
              maxOutput: 16,
            },
            sharedDeps,
          );
          expect.fail(
            'gpt-5.1-pro is now available; remove the temporary model-unavailable guard and this test.',
          );
        } catch (error) {
          expect(error).toBeInstanceOf(OracleTransportError);
          const transport = error as OracleTransportError;
          expect(transport.reason).toBe('model-unavailable');
          expect(transport.message).toContain('gpt-5.1-pro');
          expect(transport.message).toContain('gpt-5-pro');
        }
      },
      2 * 60 * 1000,
    );
  });
}
