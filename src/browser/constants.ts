import type { BrowserModelStrategy } from './types.js';

export const CHATGPT_URL = 'https://chatgpt.com/';
export const DEFAULT_MODEL_TARGET = 'GPT-5.2 Pro';
export const DEFAULT_MODEL_STRATEGY: BrowserModelStrategy = 'select';
export const COOKIE_URLS = ['https://chatgpt.com', 'https://chat.openai.com', 'https://atlas.openai.com'];

export const INPUT_SELECTORS = [
  'textarea[data-id="prompt-textarea"]',
  'textarea[placeholder*="Send a message"]',
  'textarea[aria-label="Message ChatGPT"]',
  'textarea:not([disabled])',
  'textarea[name="prompt-textarea"]',
  '#prompt-textarea',
  '.ProseMirror',
  '[contenteditable="true"][data-virtualkeyboard="true"]',
];

export const ANSWER_SELECTORS = [
  'article[data-testid^="conversation-turn"][data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn"][data-turn="assistant"]',
  'article[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn"] [data-turn="assistant"]',
  'article[data-testid^="conversation-turn"] .markdown',
  '[data-message-author-role="assistant"] .markdown',
  '[data-turn="assistant"] .markdown',
  '[data-message-author-role="assistant"]',
  '[data-turn="assistant"]',
];

export const CONVERSATION_TURN_SELECTOR =
  'article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"], ' +
  'article[data-message-author-role], div[data-message-author-role], section[data-message-author-role], ' +
  'article[data-turn], div[data-turn], section[data-turn]';
export const ASSISTANT_ROLE_SELECTOR = '[data-message-author-role="assistant"], [data-turn="assistant"]';
export const CLOUDFLARE_SCRIPT_SELECTOR = 'script[src*="/challenge-platform/"]';
export const CLOUDFLARE_TITLE = 'just a moment';
export const PROMPT_PRIMARY_SELECTOR = '#prompt-textarea';
export const PROMPT_FALLBACK_SELECTOR = 'textarea[name="prompt-textarea"]';
export const FILE_INPUT_SELECTORS = [
  'form input[type="file"]:not([accept])',
  'input[type="file"][multiple]:not([accept])',
  'input[type="file"][multiple]',
  'input[type="file"]:not([accept])',
  'form input[type="file"][accept]',
  'input[type="file"][accept]',
  'input[type="file"]',
  'input[type="file"][data-testid*="file"]',
];
// Legacy single selectors kept for compatibility with older call-sites
export const FILE_INPUT_SELECTOR = FILE_INPUT_SELECTORS[0];
export const GENERIC_FILE_INPUT_SELECTOR = FILE_INPUT_SELECTORS[3];
export const MENU_CONTAINER_SELECTOR = '[role="menu"], [data-radix-collection-root]';
export const MENU_ITEM_SELECTOR = 'button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]';
export const UPLOAD_STATUS_SELECTORS = [
  '[data-testid*="upload"]',
  '[data-testid*="attachment"]',
  '[data-testid*="progress"]',
  '[data-state="loading"]',
  '[data-state="uploading"]',
  '[data-state="pending"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
];

export const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[data-testid*="composer-send"]',
  'form button[type="submit"]',
  'button[type="submit"][data-testid*="send"]',
  'button[aria-label*="Send"]',
];
export const SEND_BUTTON_SELECTOR = SEND_BUTTON_SELECTORS[0];
export const MODEL_BUTTON_SELECTOR = '[data-testid="model-switcher-dropdown-button"]';
export const COPY_BUTTON_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
// Action buttons that only appear once a turn has finished rendering.
export const FINISHED_ACTIONS_SELECTOR =
  'button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"], button[aria-label="Share"]';
