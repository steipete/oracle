import type { OracleRequestBody, ModelConfig } from './types.js';
import { TOKENIZER_OPTIONS } from './config.js';

/**
 * Estimate input tokens from the full request body instead of just system/user text.
 * This is a conservative approximation: we tokenize the key textual fields and add a fixed buffer
 * to cover structural JSON overhead and server-side wrappers (tools/reasoning/background/store).
 */
export function estimateRequestTokens(
  requestBody: OracleRequestBody,
  modelConfig: ModelConfig,
  bufferTokens = 200,
): number {
  const parts: string[] = [];

  if (requestBody.instructions) {
    parts.push(requestBody.instructions);
  }

  for (const turn of requestBody.input ?? []) {
    for (const content of turn.content ?? []) {
      if (typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  if (requestBody.tools && requestBody.tools.length > 0) {
    parts.push(JSON.stringify(requestBody.tools));
  }

  if (requestBody.reasoning) {
    parts.push(JSON.stringify(requestBody.reasoning));
  }

  if (requestBody.background) {
    parts.push('background:true');
  }
  if (requestBody.store) {
    parts.push('store:true');
  }

  const concatenated = parts.join('\n');
  const baseEstimate = modelConfig.tokenizer(concatenated, TOKENIZER_OPTIONS);
  return baseEstimate + bufferTokens;
}
