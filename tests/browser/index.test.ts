import { describe, expect, test } from 'vitest';
import { shouldPreserveBrowserOnErrorForTest } from '../../src/browser/index.js';
import { BrowserAutomationError } from '../../src/oracle/errors.js';

describe('shouldPreserveBrowserOnErrorForTest', () => {
  test('preserves the browser for headful cloudflare challenge errors', () => {
    const error = new BrowserAutomationError('Cloudflare challenge detected.', {
      stage: 'cloudflare-challenge',
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test('does not preserve the browser for headless cloudflare challenge errors', () => {
    const error = new BrowserAutomationError('Cloudflare challenge detected.', {
      stage: 'cloudflare-challenge',
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test('does not preserve the browser for unrelated browser errors', () => {
    const error = new BrowserAutomationError('other browser error', {
      stage: 'execute-browser',
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
  });
});
