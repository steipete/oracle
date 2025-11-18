import { describe, expect, test, vi } from 'vitest';
import { startOscProgress, supportsOscProgress } from '../../src/oracle/oscProgress.ts';

describe('supportsOscProgress', () => {
  const baseEnv = { ...process.env };

  test('returns false when not a TTY', () => {
    expect(supportsOscProgress(baseEnv, false)).toBe(false);
  });

  test('can be disabled with ORACLE_NO_OSC_PROGRESS', () => {
    // biome-ignore lint/style/useNamingConvention: env keys mirror real process env.
    expect(supportsOscProgress({ ...baseEnv, ORACLE_NO_OSC_PROGRESS: '1' }, true)).toBe(false);
  });

  test('detects Ghostty / WezTerm / Windows Terminal', () => {
    // biome-ignore lint/style/useNamingConvention: env keys mirror real process env.
    expect(supportsOscProgress({ ...baseEnv, TERM_PROGRAM: 'Ghostty' }, true)).toBe(true);
    // biome-ignore lint/style/useNamingConvention: env keys mirror real process env.
    expect(supportsOscProgress({ ...baseEnv, TERM_PROGRAM: 'WezTerm' }, true)).toBe(true);
    // biome-ignore lint/style/useNamingConvention: env keys mirror real process env.
    expect(supportsOscProgress({ ...baseEnv, WT_SESSION: '1' }, true)).toBe(true);
  });

  test('force flag still requires TTY', () => {
    // biome-ignore lint/style/useNamingConvention: env keys mirror real process env.
    expect(supportsOscProgress({ ...baseEnv, ORACLE_FORCE_OSC_PROGRESS: '1' }, false)).toBe(false);
    // biome-ignore lint/style/useNamingConvention: env keys mirror real process env.
    expect(supportsOscProgress({ ...baseEnv, ORACLE_FORCE_OSC_PROGRESS: '1' }, true)).toBe(true);
  });
});

describe('startOscProgress', () => {
  test('emits OSC 9;4 sequences and clears on stop', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stop = startOscProgress({
      label: 'Waiting',
      targetMs: 2_000,
      // biome-ignore lint/style/useNamingConvention: env keys mirror real process env.
      env: { ...process.env, ORACLE_FORCE_OSC_PROGRESS: '1' },
      isTty: true,
      write: (chunk) => writes.push(chunk),
    });

    // initial activate
    expect(writes.at(0)).toBe('\u001b]9;4;1;0;Waiting\u001b\\');

    // advance past target to trigger at least one progress update
    vi.advanceTimersByTime(2_200);
    const progressed = writes.some((chunk) => /\]9;4;1;[1-9]\d?;/.test(chunk));
    expect(progressed).toBe(true);

    stop();
    expect(writes.at(-1)).toBe('\u001b]9;4;0;0;Waiting\u001b\\');
    vi.useRealTimers();
  });
});
