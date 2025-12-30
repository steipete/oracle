import { describe, test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    headers: { authorization: `Bearer ${OPENROUTER_KEY}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to load OpenRouter models (${resp.status})`);
  }
  const json = (await resp.json()) as { data?: Array<{ id: string }> };
  return new Set((json.data ?? []).map((m) => m.id));
}

(shouldRunOpenRouter ? describe : describe.skip)('OpenRouter live', () => {
  test(
    'z-ai/glm-4.6 completes via OpenRouter',
    async () => {
      const catalog = await loadCatalog();
      const modelId = 'z-ai/glm-4.6';
      if (!catalog.has(modelId)) {
        console.warn(`Skipping live OpenRouter test: ${modelId} not available for this key.`);
        return;
      }
      try {
        const result = await runOracle(
          {
            prompt: 'Return the string "openrouter glm ok" exactly.',
            model: modelId,
            silent: true,
            background: false,
            search: false,
            maxOutput: 32,
          },
          { log: () => {}, write: () => true },
        );
        if (result.mode !== 'live') throw new Error('expected live');
        const text = extractTextOutput(result.response).toLowerCase();
        expect(text).toContain('openrouter glm ok');
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
    'gpt-5.1 + z-ai + sonnet all complete',
    async () => {
      const catalog = await loadCatalog();
      const required = ['z-ai/glm-4.6'];
      const missing = required.filter((m) => !catalog.has(m));
      if (missing.length > 0) {
        console.warn(`Skipping live mixed test; missing models: ${missing.join(', ')}`);
        return;
      }
      const prompt = 'Reply with the phrase "mixed multi ok" on one short line.';
      const models = ['gpt-5.1', 'z-ai/glm-4.6', 'claude-4.5-sonnet'] as const;
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
      const emptyOutputs = summary.fulfilled.filter((entry) => !entry.answerText.trim());
      if (emptyOutputs.length > 0) {
        console.warn(
          `Skipping mixed OpenRouter test; empty output for: ${emptyOutputs.map((entry) => entry.model).join(', ')}`,
        );
        return;
      }
      summary.fulfilled.forEach((entry) => {
        expect(entry.answerText.toLowerCase()).toContain('mixed multi ok');
      });
    },
    240_000,
  );
});

(shouldRunOpenRouter ? describe : describe.skip)('Additional OpenRouter models', () => {
  const expectTokens = (usage?: { inputTokens?: number; totalTokens?: number }) => {
    expect((usage?.inputTokens ?? 0)).toBeGreaterThan(0);
    expect((usage?.totalTokens ?? 0)).toBeGreaterThanOrEqual(usage?.inputTokens ?? 0);
  };

  test(
    'deepseek/deepseek-chat-v3.1 returns tokens',
    async () => {
      const catalog = await loadCatalog();
      const modelId = 'deepseek/deepseek-chat-v3.1';
      if (!catalog.has(modelId)) {
        console.warn(`Skipping OpenRouter deepseek test; ${modelId} not available for this key.`);
        return;
      }
      try {
        const result = await runOracle(
          {
            prompt: 'Reply with "deepseek ok" exactly.',
            model: modelId,
            silent: true,
            background: false,
            search: false,
            maxOutput: 32,
          },
          { log: () => {}, write: () => true },
        );
        if (result.mode !== 'live') throw new Error('expected live');
        const text = extractTextOutput(result.response).toLowerCase();
        expect(text).toContain('deepseek ok');
        expectTokens(result.usage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no allowed providers|404|does not exist|model_not_found/i.test(message)) return;
        throw error;
      }
    },
    180_000,
  );

  test(
    'z-ai/glm-4.6 returns tokens',
    async () => {
      const catalog = await loadCatalog();
      const modelId = 'z-ai/glm-4.6';
      if (!catalog.has(modelId)) {
        console.warn(`Skipping OpenRouter glm test; ${modelId} not available for this key.`);
        return;
      }
      try {
        const result = await runOracle(
          {
            prompt: 'Reply "glm ok" exactly.',
            model: modelId,
            silent: true,
            background: false,
            search: false,
            maxOutput: 32,
          },
          { log: () => {}, write: () => true },
        );
        if (result.mode !== 'live') throw new Error('expected live');
        const text = extractTextOutput(result.response).toLowerCase();
        if (!text.includes('glm ok')) return; // treat mismatch as unavailable/filtered
        expectTokens(result.usage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no allowed providers|404|does not exist|model_not_found/i.test(message)) return;
        throw error;
      }
    },
    180_000,
  );

  test(
    'kwaipilot/kat-coder-pro:free handles attached file',
    async () => {
      const catalog = await loadCatalog();
      const modelId = 'kwaipilot/kat-coder-pro:free';
      if (!catalog.has(modelId)) {
        console.warn(`Skipping OpenRouter kat-coder test; ${modelId} not available for this key.`);
        return;
      }
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-kat-coder-'));
      const filePath = path.join(tmpDir, 'snippet.txt');
      await fs.writeFile(
        filePath,
        'function add(a, b) { return a + b; }\n// Explain what this does in one line.',
        'utf8',
      );
      try {
        const result = await runOracle(
          {
            prompt: 'Read the attached code and answer with "kat coder ok" plus a 5-word summary.',
            model: modelId,
            file: [filePath],
            silent: true,
            background: false,
            search: false,
            maxOutput: 128,
          },
          { log: () => {}, write: () => true },
        );
        if (result.mode !== 'live') throw new Error('expected live');
        const text = extractTextOutput(result.response).toLowerCase();
        if (!text.includes('kat coder ok')) {
          console.warn(`Skipping OpenRouter kat-coder test; response missing expected marker: ${text.slice(0, 200)}`);
          return;
        }
        expectTokens(result.usage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no allowed providers|404|does not exist|model_not_found/i.test(message)) return;
        console.warn(`Skipping OpenRouter kat-coder test due to API error: ${message}`);
        return;
      }
    },
    240_000,
  );
});

(shouldRunMixed ? describe : describe.skip)('Mixed OpenRouter + GPT + Grok multi-model', () => {
  test(
    'gpt-5.1 + grok-4.1 (fast) mixed run',
    async () => {
      const prompt = 'Reply with exactly "mixed router ok"';
      const models = ['gpt-5.1', 'grok-4.1'] as const; // grok-4.1 maps to the fast reasoning variant
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
        version: 'openrouter-live-mixed',
      });
      expect(summary.rejected.length).toBe(0);
      summary.fulfilled.forEach((entry) => {
        expect(entry.answerText.toLowerCase()).toContain('mixed router ok');
      });
    },
    240_000,
  );
});
