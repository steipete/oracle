import { describe, expect, it } from 'vitest';
import { resolveRunOptionsFromConfig } from '../src/cli/runOptions.js';
import { estimateRequestTokens } from '../src/oracle/tokenEstimate.js';
import { MODEL_CONFIGS } from '../src/oracle/config.js';

describe('resolveRunOptionsFromConfig', () => {
  const basePrompt = 'Hello';

  it('uses config engine when none provided and env lacks OPENAI_API_KEY', () => {
    const { resolvedEngine } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      userConfig: { engine: 'browser' },
      env: {},
    });
    expect(resolvedEngine).toBe('browser');
  });

  it('prefers explicit engine over config', () => {
    const { resolvedEngine } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      engine: 'api',
      userConfig: { engine: 'browser' },
    });
    expect(resolvedEngine).toBe('api');
  });

  it('uses config model when caller does not provide one', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      userConfig: { model: 'gpt-5.1' },
    });
    expect(runOptions.model).toBe('gpt-5.1');
  });

  it('appends prompt suffix from config', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: 'Hi',
      userConfig: { promptSuffix: '// signed' },
    });
    expect(runOptions.prompt).toBe('Hi\n// signed');
  });

  it('honors search off', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      userConfig: { search: 'off' },
    });
    expect(runOptions.search).toBe(false);
  });

  it('uses heartbeatSeconds from config', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      userConfig: { heartbeatSeconds: 5 },
    });
    expect(runOptions.heartbeatIntervalMs).toBe(5000);
  });

  it('passes filesReport/background from config', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      userConfig: { filesReport: true, background: false },
    });
    expect(runOptions.filesReport).toBe(true);
    expect(runOptions.background).toBe(false);
  });

  it('includes apiBaseUrl from config', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      userConfig: { apiBaseUrl: 'https://proxy.test/v1' },
    });
    expect(runOptions.baseUrl).toBe('https://proxy.test/v1');
  });

  it('falls back to OPENAI_BASE_URL env', () => {
    const env = {} as NodeJS.ProcessEnv;
    env.OPENAI_BASE_URL = 'https://env.example/v2';
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      env,
    });
    expect(runOptions.baseUrl).toBe('https://env.example/v2');
  });
});

describe('estimateRequestTokens', () => {
  const modelConfig = MODEL_CONFIGS['gpt-5.1'];

  it('includes instructions, input text, tools, reasoning, background/store, plus buffer', () => {
    const request = {
      model: 'gpt-5.1',
      instructions: 'sys',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hello world' }],
        },
      ],
      tools: [{ type: 'web_search_preview' }],
      reasoning: { effort: 'high' },
      background: true,
      store: true,
    };
    const estimate = estimateRequestTokens(request as unknown as Parameters<typeof estimateRequestTokens>[0], modelConfig, 10);
    // Rough sanity: base tokenizer on text parts should be > 0; buffer ensures > base.
    expect(estimate).toBeGreaterThan(10);
  });

  it('adds buffer even with minimal input', () => {
    const request = {
      model: 'gpt-5.1',
      instructions: 'a',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'b' }] }],
    };
    const estimate = estimateRequestTokens(request as unknown as Parameters<typeof estimateRequestTokens>[0], modelConfig, 50);
    expect(estimate).toBeGreaterThanOrEqual(50);
  });
});
