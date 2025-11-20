import { describe, expect, test } from 'vitest';
import { mapConsultToRunOptions } from '../../src/mcp/utils.js';

describe('mapConsultToRunOptions', () => {
  test('passes multi-model selections through to run options', () => {
    const env: NodeJS.ProcessEnv = {};
    env.OPENAI_API_KEY = 'sk-test';
    const { runOptions } = mapConsultToRunOptions({
      prompt: 'multi',
      files: [],
      model: 'gpt-5.1-pro',
      models: ['gemini-3-pro'],
      userConfig: undefined,
      env,
    });
    expect(runOptions.model).toBe('gpt-5.1-pro');
    expect(runOptions.models).toEqual(['gpt-5.1-pro', 'gemini-3-pro']);
  });
});
