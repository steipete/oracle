import type { ModelName } from "../oracle/types.js";
import { DEFAULT_MODEL } from "../oracle/config.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { extractConversationIdFromUrl } from "../browser/reattachHelpers.js";
import { isRecoverableChatGptConversationUrl } from "../browser/reattachability.js";
import { initializeImportedBrowserSession } from "../sessionManager.js";
import type { BrowserSessionConfig, SessionMetadata } from "../sessionStore.js";
import { inferModelFromLabel } from "./options.js";

export interface ImportChatgptConversationOptions {
  url: string;
  slug?: string;
  model?: string;
  force?: boolean;
  cwd?: string;
  browserConfig?: BrowserSessionConfig;
  log?: (message: string) => void;
}

export interface ValidatedChatgptConversationUrl {
  conversationUrl: string;
  conversationId: string;
}

export function validateChatgptConversationUrl(url: string): ValidatedChatgptConversationUrl {
  const conversationUrl = url.trim();
  if (!isRecoverableChatGptConversationUrl(conversationUrl)) {
    throw new Error(
      "ChatGPT import requires an HTTPS conversation URL on chatgpt.com or chat.openai.com with /c/<conversation-id>.",
    );
  }
  const conversationId = extractConversationIdFromUrl(conversationUrl);
  if (!conversationId) {
    throw new Error("Could not extract a ChatGPT conversation id from the URL.");
  }
  return { conversationUrl, conversationId };
}

export function buildImportedBrowserConfig(): BrowserSessionConfig {
  return {
    url: CHATGPT_URL,
    chatgptUrl: CHATGPT_URL,
    modelStrategy: "current",
    archiveConversations: "never",
    researchMode: "off",
  };
}

export async function importChatgptConversation(
  options: ImportChatgptConversationOptions,
): Promise<SessionMetadata> {
  const { conversationUrl, conversationId } = validateChatgptConversationUrl(options.url);
  const model = inferModelFromLabel(options.model ?? DEFAULT_MODEL) as ModelName;
  return await initializeImportedBrowserSession({
    conversationUrl,
    conversationId,
    model,
    slug: options.slug,
    force: options.force,
    cwd: options.cwd,
    browserConfig: options.browserConfig ?? buildImportedBrowserConfig(),
  });
}

export async function runImportChatgptConversation(
  options: ImportChatgptConversationOptions,
): Promise<SessionMetadata> {
  const metadata = await importChatgptConversation(options);
  const log = options.log ?? console.log;
  log(`Imported ChatGPT conversation as session ${metadata.id}.`);
  log("Oracle will verify authentication and prior turns before submitting the first follow-up.");
  log("");
  log("Follow up with:");
  log(`  oracle --followup ${metadata.id} -p "..."`);
  return metadata;
}
