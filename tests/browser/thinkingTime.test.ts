import { describe, expect, it } from 'vitest';
import { buildThinkingTimeSelectionExpressionForTest } from '../../src/browser/actions/thinkingTime.js';

describe('browser thinking-time selection expression', () => {
  it('targets the thinking-time menu and Extended option', () => {
    const expression = buildThinkingTimeSelectionExpressionForTest();
    expect(expression).toContain('thinking time');
    expect(expression).toContain('extended');
    expect(expression).toContain('MENU_CONTAINER_SELECTOR');
    expect(expression).toContain('MENU_ITEM_SELECTOR');
  });
});

