import { describe, expect, it } from 'vitest';
import { buildModelMatchersLiteralForTest } from '../../src/browser/actions/modelSelection.js';

const expectSome = (arr: string[], predicate: (s: string) => boolean) => {
  expect(arr.some(predicate)).toBe(true);
};

describe('browser model selection arbitrary labels', () => {
  it('accepts custom label tokens (e.g., 5.1 Instant)', () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest('5.1 Instant');
    expectSome(labelTokens, (t) => t.includes('5.1'));
    expectSome(labelTokens, (t) => t.includes('instant'));
    // We still generate reasonable testid-based hints for 5.1 models
    expectSome(testIdTokens, (t) => t.includes('gpt-5-1'));
  });

  it('accepts Thinking label', () => {
    const { labelTokens } = buildModelMatchersLiteralForTest('Thinking');
    expectSome(labelTokens, (t) => t.includes('thinking'));
  });
});
