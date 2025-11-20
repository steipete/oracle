export const CHATGPT_URL = 'https://chatgpt.com/';
export const DEFAULT_MODEL_TARGET = 'ChatGPT 5.1';
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
  'article[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn"] .markdown',
  '[data-message-author-role="assistant"] .markdown',
  '[data-message-author-role="assistant"]',
];

export const CONVERSATION_TURN_SELECTOR = 'article[data-testid^="conversation-turn"]';
export const ASSISTANT_ROLE_SELECTOR = '[data-message-author-role="assistant"]';
export const CLOUDFLARE_SCRIPT_SELECTOR = 'script[src*="/challenge-platform/"]';
export const CLOUDFLARE_TITLE = 'just a moment';
export const PROMPT_PRIMARY_SELECTOR = '#prompt-textarea';
export const PROMPT_FALLBACK_SELECTOR = 'textarea[name="prompt-textarea"]';
export const FILE_INPUT_SELECTOR = 'form input[type="file"]:not([accept])';
export const GENERIC_FILE_INPUT_SELECTOR = 'input[type="file"]:not([accept])';
export const MENU_CONTAINER_SELECTOR = '[role="menu"], [data-radix-collection-root]';
export const MENU_ITEM_SELECTOR = 'button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]';
export const UPLOAD_STATUS_SELECTORS = [
  '[data-testid*="upload"]',
  '[data-testid*="attachment"]',
  '[data-state="loading"]',
  '[aria-live="polite"]',
];

export const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const SEND_BUTTON_SELECTOR = '[data-testid="send-button"]';
export const MODEL_BUTTON_SELECTOR = '[data-testid="model-switcher-dropdown-button"]';
export const COPY_BUTTON_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
// Action buttons that only appear once a turn has finished rendering.
export const FINISHED_ACTIONS_SELECTOR =
  'button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"], button[aria-label="Share"]';
