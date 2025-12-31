/**
 * Gemini Browser Automation Constants
 * Selectors and configuration for automating gemini.google.com/app
 */

export const GEMINI_APP_URL = 'https://gemini.google.com/app';
export const GEMINI_BASE_URL = 'https://gemini.google.com';

// Model picker options (Fast/Thinking/Pro)
// Based on live testing of gemini.google.com/app (Dec 2024)
// The model picker is SEPARATE from the Tools drawer
export const GEMINI_MODEL_PICKER_OPTIONS = {
  'gemini-3-fast': 'Fast',       // gemini-flash-3-fast
  'gemini-3-thinking': 'Thinking', // gemini-flash-3-thinking
  'gemini-3-pro': 'Pro',         // gemini-3-pro-preview
} as const;

// Tools available via the Tools drawer (separate from model picker)
// These are accessed by clicking Tools button, then selecting the tool
export const GEMINI_TOOLS = {
  'deep-research': 'Deep Research',
  'create-videos': 'Create videos (Veo 3.1)',
  'create-images': 'Create images',
  'canvas': 'Canvas',
  'guided-learning': 'Guided Learning',
  'deep-think': 'Deep Think',
} as const;

export type GeminiTool = keyof typeof GEMINI_TOOLS;

// Combined model identifiers (for backward compatibility)
export const GEMINI_DEEP_THINK_MODELS = {
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-3-pro': 'Pro',
  'gemini-3-fast': 'Fast',
  'gemini-3-thinking': 'Thinking',
  'gemini-deep-think': 'Deep Think',  // This is a TOOL, not model picker
  'deep-think': 'Deep Think',          // This is a TOOL, not model picker
  'gemini-deep-research': 'Deep Research', // This is a TOOL
} as const;

export type GeminiDeepThinkModel = keyof typeof GEMINI_DEEP_THINK_MODELS;

export const DEFAULT_GEMINI_MODEL: GeminiDeepThinkModel = 'gemini-3-thinking';

// Cookie URLs for Gemini authentication
export const GEMINI_COOKIE_URLS = [
  'https://gemini.google.com',
  'https://accounts.google.com',
  'https://www.google.com',
];

// Input selectors for Gemini prompt textarea
// Verified from live testing Dec 2024
export const GEMINI_INPUT_SELECTORS = [
  // Primary: contenteditable textbox with role
  '[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  // Rich text editor (ProseMirror-like)
  '.ql-editor[contenteditable="true"]',
  '[contenteditable="true"][data-placeholder]',
  // Textarea fallbacks
  'textarea[aria-label*="prompt"]',
  'textarea[aria-label*="message"]',
  'textarea[placeholder*="Enter"]',
  'textarea[placeholder*="Ask"]',
  'textarea.prompt-textarea',
  // Generic fallback
  '[data-testid="text-input"]',
  'textarea:not([disabled])',
];

// Response container selectors for Gemini
export const GEMINI_RESPONSE_SELECTORS = [
  // Model response containers
  '.model-response-text',
  '[data-message-author="model"]',
  '.response-container .markdown-content',
  '.message-content[data-author="model"]',
  // Conversation turn selectors
  '.conversation-turn[data-role="model"]',
  '[data-testid="model-response"]',
  // Fallback selectors
  '.response-content',
  '.model-message',
];

// Thinking/reasoning indicators for Deep Think mode
// Verified from live testing Dec 2024
export const GEMINI_THINKING_SELECTORS = [
  // Primary: Show thinking button (data-test-id verified)
  '[data-test-id="thoughts-header-button"]',
  'button[aria-label*="Show thinking"]',
  // Deep Think progress indicators
  '[data-testid*="thinking"]',
  '[data-testid*="reasoning"]',
  '.thinking-indicator',
  '.reasoning-progress',
  // Loading/processing indicators
  '[aria-label*="thinking"]',
  '[aria-label*="processing"]',
  '.loading-shimmer',
  '[role="progressbar"]',
  // Status text
  '[data-status="thinking"]',
  '[data-status="reasoning"]',
];

// Model picker/switcher selectors
// Verified from live testing Dec 2024 - uses "bard-mode" naming
export const GEMINI_MODEL_PICKER_SELECTORS = [
  // Primary: Bard mode menu button (data-test-id verified)
  '[data-test-id="bard-mode-menu-button"]',
  // Fallbacks
  '[data-testid="model-selector"]',
  '[data-testid="model-picker"]',
  'button[aria-label*="model"]',
  'button[aria-label*="Model"]',
  '.model-selector-button',
  '[role="combobox"][aria-label*="model"]',
];

// Model option selectors in the picker dropdown
// Verified from live testing Dec 2024
export const GEMINI_MODEL_OPTION_SELECTORS = {
  fast: '[data-test-id="bard-mode-option-flash"]',
  thinking: '[data-test-id="bard-mode-option-thinking"]',
  pro: '[data-test-id="bard-mode-option-pro"]',
};

// Tools button selector - opens the tools drawer
// Verified from live testing Dec 2024
export const GEMINI_TOOLS_BUTTON_SELECTOR = 'button:has-text("Tools")';

// Tools drawer item selectors
// Accessed via Tools button → select tool from drawer
// Verified from live testing Dec 2024
export const GEMINI_TOOL_SELECTORS = {
  'deep-research': 'button:has-text("Deep Research")',
  'create-videos': 'button:has-text("Create videos")',
  'create-images': 'button:has-text("Create images")',
  'canvas': 'button:has-text("Canvas")',
  'guided-learning': 'button:has-text("Guided Learning")',
  'deep-think': 'button:has-text("Deep Think")',
} as const;

// Tool deselection button selectors (appear when tool is active)
// Format: "Deselect {ToolName}" with close icon
export const GEMINI_TOOL_DESELECT_SELECTORS = {
  'deep-think': 'button:has-text("Deselect Deep Think")',
  'deep-research': 'button:has-text("Deselect Deep Research")',
  'create-images': 'button:has-text("Deselect Image")',
} as const;

// Tool active indicators - placeholders change when tool is active
export const GEMINI_TOOL_PLACEHOLDERS = {
  default: 'Ask Gemini',
  'deep-think': 'Ask a complex question',
  'create-images': 'Describe your image',
} as const;

// Send/submit button selectors
export const GEMINI_SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="submit"]',
  'button[type="submit"]',
  'button.send-button',
  '[data-testid="composer-submit"]',
];

// Google consent/login related selectors
export const GEMINI_CONSENT_SELECTORS = {
  acceptAll: 'button:has-text("Accept all")',
  rejectAll: 'button:has-text("Reject all")',
  signIn: 'button:has-text("Sign in"), a:has-text("Sign in")',
};

// Login detection selectors
export const GEMINI_LOGIN_SELECTORS = [
  // Sign in buttons/links on landing page
  'a[href*="ServiceLogin"]',
  'button:has-text("Sign in")',
  'a:has-text("Sign in")',
  // Account picker
  '[data-identifier]',
  '.account-picker',
  // Logged in indicators
  '[aria-label*="Google Account"]',
  'img[alt*="profile"]',
];

// Attachment/file upload selectors
export const GEMINI_FILE_INPUT_SELECTORS = [
  'input[type="file"]',
  'input[type="file"][accept]',
  '[data-testid="file-upload"]',
  'button[aria-label*="upload"]',
  'button[aria-label*="attach"]',
];

// Copy button for response
export const GEMINI_COPY_BUTTON_SELECTOR = 'button[aria-label*="Copy"], button[data-testid="copy-button"]';

// Stop generation button
export const GEMINI_STOP_BUTTON_SELECTOR = 'button[aria-label*="Stop"], button[data-testid="stop-button"]';

// Cloudflare/anti-bot detection
export const GEMINI_BLOCKED_SELECTORS = {
  cloudflare: 'script[src*="/challenge-platform/"]',
  captcha: '[data-testid="captcha"]',
  blocked: '.blocked-content',
};

// Timeout defaults (in milliseconds)
export const GEMINI_TIMEOUTS = {
  navigation: 45_000,
  login: 120_000,
  promptReady: 30_000,
  response: 300_000,        // Standard response timeout (5 min)
  deepThinkResponse: 600_000, // Deep Think can take 10+ minutes for complex queries
  thinkingPoll: 2_000,      // Poll interval for checking response status
  attachmentUpload: 60_000,
  imageGeneration: 60_000,  // Image generation timeout
};
