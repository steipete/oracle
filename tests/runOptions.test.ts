import { describe, expect, it } from 'vitest';
import { resolveRunOptionsFromConfig } from '../src/cli/runOptions.js';
import { estimateRequestTokens } from '../src/oracle/tokenEstimate.js';
import { DEFAULT_MODEL, MODEL_CONFIGS } from '../src/oracle/config.js';

describe('resolveRunOptionsFromConfig', () => {
  const basePrompt = 'This prompt is comfortably above twenty characters.';

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

  it('defaults to gpt-5.1-pro when model not provided', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
    });
    expect(runOptions.model).toBe(DEFAULT_MODEL);
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
      prompt: 'Hi there, this exceeds twenty characters.',
      userConfig: { promptSuffix: '// signed' },
    });
    expect(runOptions.prompt).toBe('Hi there, this exceeds twenty characters.\n// signed');
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

  it('keeps browser engine for gemini when auto-detected (no API key)', () => {
    const { runOptions, resolvedEngine, engineCoercedToApi } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'gemini-3-pro',
      env: {},
    });
    expect(resolvedEngine).toBe('browser');
    expect(engineCoercedToApi).toBe(false);
    expect(runOptions.model).toBe('gemini-3-pro');
  });

  it('accepts browser engine explicitly set for gemini', () => {
    const { resolvedEngine, runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'gemini-3-pro',
      engine: 'browser',
    });
    expect(resolvedEngine).toBe('browser');
    expect(runOptions.model).toBe('gemini-3-pro');
  });

  it('accepts browser engine in config when model is gemini', () => {
    const { resolvedEngine, runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'gemini-3-pro',
      userConfig: { engine: 'browser' },
    });
    expect(resolvedEngine).toBe('browser');
    expect(runOptions.model).toBe('gemini-3-pro');
  });

  it('forces api engine for gpt-5.1-codex when engine is auto-detected', () => {
    const { resolvedEngine, runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'gpt-5.1-codex',
      env: {},
    });
    expect(resolvedEngine).toBe('api');
    expect(runOptions.model).toBe('gpt-5.1-codex');
  });

  it('coerces browser engine to api for gpt-5.1-codex', () => {
    const { resolvedEngine, engineCoercedToApi } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'gpt-5.1-codex',
      engine: 'browser',
    });
    expect(resolvedEngine).toBe('api');
    expect(engineCoercedToApi).toBe(true);
  });

  it('coerces browser engine to api for multi-model codex runs', () => {
    const { resolvedEngine } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      models: ['gpt-5.1-codex', 'gpt-5.1-pro'],
      engine: 'browser',
    });
    expect(resolvedEngine).toBe('api');
  });

  it('normalizes shorthand multi-model entries', () => {
    const { runOptions } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      models: ['gpt-5.1', 'gemini', 'sonnet'],
    });

    expect(runOptions.model).toBe('gpt-5.1');
    expect(runOptions.models).toEqual(['gpt-5.1', 'gemini-3-pro', 'claude-4.5-sonnet']);
  });

  it('rejects browser engine for grok when explicitly set', () => {
    expect(() =>
      resolveRunOptionsFromConfig({
        prompt: basePrompt,
        model: 'grok',
        engine: 'browser',
      }),
    ).toThrow(/Browser engine only supports GPT and Gemini/);
  });

  it('forces api engine for grok when auto-selected browser and applies XAI base url', () => {
    // biome-ignore lint/style/useNamingConvention: env var is uppercase by convention
    const env: NodeJS.ProcessEnv = { XAI_BASE_URL: 'https://api.example/v1' } as NodeJS.ProcessEnv;
    const { runOptions, resolvedEngine, engineCoercedToApi } = resolveRunOptionsFromConfig({
      prompt: basePrompt,
      model: 'grok',
      env,
    });
    expect(runOptions.model).toBe('grok-4.1');
    expect(resolvedEngine).toBe('api');
    expect(engineCoercedToApi).toBe(true);
    expect(runOptions.baseUrl).toBe('https://api.example/v1');
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
