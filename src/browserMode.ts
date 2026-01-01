export type {
  BrowserAutomationConfig,
  BrowserRunOptions,
  BrowserRunResult,
} from './browser/index.js';

export {
  runBrowserMode,
  CHATGPT_URL,
  GROK_URL,
  DEFAULT_MODEL_STRATEGY,
  DEFAULT_MODEL_TARGET,
  parseDuration,
  normalizeBrowserUrl,
  normalizeChatgptUrl,
  normalizeGrokUrl,
  isTemporaryChatUrl,
} from './browser/index.js';
