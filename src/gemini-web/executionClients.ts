import type { BrowserRunResult } from '../browser/types.js';
import type { GeminiExecutionMode } from './executionMode.js';

export interface IGeminiExecutionClient {
  mode: GeminiExecutionMode;
  execute: () => Promise<BrowserRunResult>;
}
