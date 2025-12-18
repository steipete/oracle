import { describe, expect, it } from 'vitest';
import { resolveEngine, defaultWaitPreference, type EngineMode } from '../src/cli/engine.js';

// biome-ignore lint/style/useNamingConvention: env var names are uppercase with underscores
const envWithKey = { ...process.env, OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;
const envWithoutKey = { ...process.env } as NodeJS.ProcessEnv;
delete envWithoutKey.OPENAI_API_KEY;
delete envWithKey.ORACLE_ENGINE;
delete envWithoutKey.ORACLE_ENGINE;

describe('resolveEngine', () => {
  it('prefers api when no flags and OPENAI_API_KEY is set', () => {
    const engine = resolveEngine({ engine: undefined, browserFlag: false, env: envWithKey });
    expect(engine).toBe<EngineMode>('api');
  });

  it('falls back to browser when no flags and no OPENAI_API_KEY', () => {
    const engine = resolveEngine({ engine: undefined, browserFlag: false, env: envWithoutKey });
    expect(engine).toBe<EngineMode>('browser');
  });

  it('respects ORACLE_ENGINE=browser even when OPENAI_API_KEY is set', () => {
    const env = { ...envWithKey } as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env['ORACLE_ENGINE'] = 'browser';
    const engine = resolveEngine({ engine: undefined, browserFlag: false, env });
    expect(engine).toBe<EngineMode>('browser');
  });

  it('respects ORACLE_ENGINE=api even without OPENAI_API_KEY', () => {
    const env = { ...envWithoutKey } as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env['ORACLE_ENGINE'] = 'api';
    const engine = resolveEngine({ engine: undefined, browserFlag: false, env });
    expect(engine).toBe<EngineMode>('api');
  });

  it('respects explicit --engine api even without OPENAI_API_KEY', () => {
    const engine = resolveEngine({ engine: 'api', browserFlag: false, env: envWithoutKey });
    expect(engine).toBe<EngineMode>('api');
  });

  it('lets legacy --browser override everything', () => {
    const engine = resolveEngine({ engine: 'api', browserFlag: true, env: envWithKey });
    expect(engine).toBe<EngineMode>('browser');
  });
});

describe('defaultWaitPreference', () => {
  it('disables wait for pro API runs', () => {
    expect(defaultWaitPreference('gpt-5.2-pro', 'api')).toBe(false);
  });

  it('keeps wait enabled for Codex and browser models', () => {
    expect(defaultWaitPreference('gpt-5.1-codex', 'api')).toBe(true);
    expect(defaultWaitPreference('gpt-5.2-pro', 'browser')).toBe(true);
  });
});
