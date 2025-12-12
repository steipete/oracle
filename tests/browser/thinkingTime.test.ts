import { describe, expect, it } from 'vitest';
import { buildThinkingTimeExpressionForTest } from '../../src/browser/actions/thinkingTime.js';

describe('browser thinking-time selection expression', () => {
  it('uses centralized menu selectors and normalized matching', () => {
    const expression = buildThinkingTimeExpressionForTest();
    expect(expression).toContain('const MENU_CONTAINER_SELECTOR');
    expect(expression).toContain('const MENU_ITEM_SELECTOR');
    expect(expression).toContain('role=\\"menu\\"');
    expect(expression).toContain('data-radix-collection-root');
    expect(expression).toContain('role=\\"menuitem\\"');
    expect(expression).toContain('role=\\"menuitemradio\\"');
    expect(expression).toContain('thinking time');
    expect(expression).toContain('normalize');
    expect(expression).toContain('extended');
  });
});
