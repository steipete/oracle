import { describe, expect, test } from 'vitest';
import { isWebSocketClosureError } from '../../src/browser/index.js';

describe('isWebSocketClosureError', () => {
  test('treats inspected target navigation closures as connection loss', () => {
    expect(isWebSocketClosureError(new Error('Inspected target navigated or closed'))).toBe(true);
  });

  test('does not classify unrelated browser errors as connection loss', () => {
    expect(isWebSocketClosureError(new Error('Prompt textarea did not appear before timeout'))).toBe(
      false,
    );
  });
});
