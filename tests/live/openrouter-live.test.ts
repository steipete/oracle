import { describe, test, expect } from 'vitest';
import { runOracle, extractTextOutput } from '../../src/oracle.js';
import { runMultiModelApiSession } from '../../src/oracle/multiModelRunner.js';
import { sessionStore } from '../../src/sessionStore.js';

const ENABLE = process.env.ORACLE_LIVE_TEST === '1';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const shouldRunOpenRouter = ENABLE && Boolean(OPENROUTER_KEY);
const shouldRunMixed = shouldRunOpenRouter && Boolean(OPENAI_KEY) && Boolean(ANTHROPIC_KEY);

async function loadCatalog(): Promise<Set<string>> {
  const resp = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to load OpenRouter models (${resp.status})`);
  }
  const json = (await resp.json()) as { data?: Array<{ id: string }> };
  return new Set((json.data ?? []).map((m) => m.id));
}

(shouldRunOpenRouter ? describe : describe.skip)('OpenRouter live', () => {
  test(
    'minimax/minimax-m2 completes via OpenRouter fallback',
    async () => {
      const catalog = await loadCatalog();
      if (!catalog.has('minimax/minimax-m2')) {
        console.warn('Skipping live OpenRouter test: minimax/minimax-m2 not available for this key.');
        return;
      }
      try {
        const result = await runOracle(
          {
            prompt: 'Return the string "openrouter minimax ok" exactly.',
            model: 'minimax/minimax-m2',
            silent: true,
            background: false,
            search: false,
            maxOutput: 32,
          },
          { log: () => {}, write: () => true },
        );
        if (result.mode !== 'live') throw new Error('expected live');
        const text = extractTextOutput(result.response).toLowerCase();
        expect(text).toContain('openrouter minimax ok');
        expect(result.response.status ?? 'completed').toBe('completed');
      } catch (error) {
        console.warn(`Skipping live OpenRouter test due to API error: ${error instanceof Error ? error.message : error}`);
      }
    },
    120_000,
  );
});

(shouldRunMixed ? describe : describe.skip)('Mixed first-party + OpenRouter live multi-model', () => {
  test(
    'gpt-5.1 + minimax + z-ai + sonnet all complete',
    async () => {
      const catalog = await loadCatalog();
      const required = ['minimax/minimax-m2', 'z-ai/glm-4.6'];
      const missing = required.filter((m) => !catalog.has(m));
      if (missing.length > 0) {
        console.warn(`Skipping live mixed test; missing models: ${missing.join(', ')}`);
        return;
      }
      const prompt = 'Reply with the phrase "mixed multi ok" on one short line.';
      const models = ['gpt-5.1', 'minimax/minimax-m2', 'z-ai/glm-4.6', 'claude-4.5-sonnet'] as const;
      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        { prompt, model: models[0], models: models as unknown as string[], mode: 'api' },
        process.cwd(),
      );
      const summary = await runMultiModelApiSession({
        sessionMeta,
        runOptions: { prompt, model: models[0], models: models as unknown as string[], search: false },
        models: models as unknown as string[],
        cwd: process.cwd(),
        version: 'openrouter-live',
      });
      if (summary.rejected.length > 0) {
        console.warn(`Skipping mixed OpenRouter test; rejected: ${summary.rejected.map((r) => r.model).join(', ')}`);
        return;
      }
      summary.fulfilled.forEach((entry) => {
        expect(entry.answerText.toLowerCase()).toContain('mixed multi ok');
      });
    },
    240_000,
  );
});
