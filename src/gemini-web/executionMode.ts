import type { GeminiWebModelId } from './client.js';

export type GeminiExecutionMode = 'dom' | 'http';

export interface GeminiExecutionModeSelection {
  mode: GeminiExecutionMode;
  reasons: string[];
}

export interface GeminiExecutionModeInput {
  model: GeminiWebModelId;
  attachmentPaths: string[];
  generateImagePath?: string;
  editImagePath?: string;
}

export function selectGeminiExecutionMode(input: GeminiExecutionModeInput): GeminiExecutionModeSelection {
  const reasons: string[] = [];
  if (input.model !== 'gemini-3-pro-deep-think') {
    return { mode: 'http', reasons: ['model'] };
  }

  if (input.attachmentPaths.length > 0) {
    reasons.push('attachments');
  }
  if (input.generateImagePath) {
    reasons.push('image-generation');
  }
  if (input.editImagePath) {
    reasons.push('image-edit');
  }

  return reasons.length === 0
    ? { mode: 'dom', reasons: [] }
    : { mode: 'http', reasons };
}
