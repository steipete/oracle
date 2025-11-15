import { describe, expect, it } from 'vitest';
import { resolveEngine, type EngineMode } from '../src/cli/engine.js';

const envWithKey = { ...process.env, OPENAI_API_KEY: 'sk-test' } as NodeJS.ProcessEnv;
const envWithoutKey = { ...process.env } as NodeJS.ProcessEnv;
delete envWithoutKey.OPENAI_API_KEY;

describe('resolveEngine', () => {
  it('prefers api when no flags and OPENAI_API_KEY is set', () => {
    const engine = resolveEngine({ engine: undefined, browserFlag: false, env: envWithKey });
    expect(engine).toBe<EngineMode>('api');
  });

  it('falls back to browser when no flags and no OPENAI_API_KEY', () => {
    const engine = resolveEngine({ engine: undefined, browserFlag: false, env: envWithoutKey });
    expect(engine).toBe<EngineMode>('browser');
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

