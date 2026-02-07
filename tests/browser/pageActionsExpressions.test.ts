import { describe, expect, test } from 'vitest';
import {
  buildAssistantExtractorForTest,
  buildConversationDebugExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildCopyExpressionForTest,
} from '../../src/browser/pageActions.ts';
import { CONVERSATION_TURN_SELECTOR, ASSISTANT_ROLE_SELECTOR } from '../../src/browser/constants.ts';

describe('browser automation expressions', () => {
  test('assistant extractor references constants', () => {
    const expression = buildAssistantExtractorForTest('capture');
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(JSON.stringify(ASSISTANT_ROLE_SELECTOR));
  });

  test('conversation debug expression references conversation selector', () => {
    const expression = buildConversationDebugExpressionForTest();
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
  });

  test('markdown fallback filters user turns and respects assistant indicators', () => {
    const expression = buildMarkdownFallbackExtractorForTest('2');
    expect(expression).not.toContain('const MIN_TURN_INDEX = (MIN_TURN_INDEX');
    expect(expression).toContain('const __minTurn');
    expect(expression).toContain("role !== 'user'");
    expect(expression).toContain('copy-turn-action-button');
    expect(expression).toContain(CONVERSATION_TURN_SELECTOR);
  });

  test('markdown fallback does not self-reference MIN_TURN_INDEX literal', () => {
    const expression = buildMarkdownFallbackExtractorForTest('MIN_TURN_INDEX');
    expect(expression).toContain('MIN_TURN_INDEX');
    expect(expression).not.toContain('const MIN_TURN_INDEX = (MIN_TURN_INDEX');
    expect(expression).toContain('const __minTurn');
  });

  test('copy expression scopes to assistant turn buttons', () => {
    const expression = buildCopyExpressionForTest({});
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(ASSISTANT_ROLE_SELECTOR);
    expect(expression).toContain('isAssistantTurn');
    expect(expression).toContain('copy-turn-action-button');
  });
});
