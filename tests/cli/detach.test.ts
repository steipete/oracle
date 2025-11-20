import { describe, expect, test } from 'vitest';
import { shouldDetachSession } from '../../src/cli/detach.js';

describe('shouldDetachSession', () => {
  test('disables detach when env disables it', () => {
    const result = shouldDetachSession({
      engine: 'api',
      model: 'gpt-5.1',
      waitPreference: true,
      disableDetachEnv: true,
    });
    expect(result).toBe(false);
  });

  test('disables detach for non-pro models (gemini, codex, 5.1)', () => {
    const result = shouldDetachSession({
      engine: 'api',
      model: 'gemini-3-pro',
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(result).toBe(false);

    const codex = shouldDetachSession({
      engine: 'api',
      model: 'gpt-5.1-codex',
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(codex).toBe(false);

    const standard = shouldDetachSession({
      engine: 'api',
      model: 'gpt-5.1',
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(standard).toBe(false);
  });

  test('allows detach for pro models when env permits', () => {
    const pro51 = shouldDetachSession({
      engine: 'api',
      model: 'gpt-5.1-pro',
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(pro51).toBe(true);
  });
});
