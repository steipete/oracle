import { launch, type LaunchedChrome } from "chrome-launcher";
import type { SessionMetadata } from "../sessionStore.js";
import type { BrowserLogger } from "./types.js";
import { isRecoverableChatGptConversationUrl } from "./reattachability.js";
import { harvestChatGptTab, openChatGptTarget } from "./liveTabs.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

export interface RecoveredConversation {
  host: string;
  port: number;
  url: string;
  chrome: LaunchedChrome | null;
}

export interface RecoveryEndpoint {
  host: string;
  port: number;
}

/**
 * Picks the URL to navigate the recovered Chrome tab to.
 *
 * Preference order matches `resolveSessionTabRef`: `harvest.url` (post-harvest,
 * always a ChatGPT conversation URL when present) wins over `runtime.tabUrl`
 * (the URL the original run last navigated to, which can be stale).
 *
 * Both candidates are gated by `isRecoverableChatGptConversationUrl` so a stale
 * home / project shell URL or an unrelated external URL stored in metadata
 * cannot navigate the persistent signed-in profile to the wrong page.
 */
export function resolveRecoveryUrl(meta: SessionMetadata): string | null {
  const harvest = meta?.browser?.harvest ?? {};
  const runtime = meta?.browser?.runtime ?? {};
  for (const candidate of [harvest.url, runtime.tabUrl]) {
    if (isRecoverableChatGptConversationUrl(candidate)) {
      return candidate as string;
    }
  }
  return null;
}

export function resolveRecoveryProfileDir(meta: SessionMetadata): string {
  const config = meta?.browser?.config;
  if (config?.manualLogin !== true) {
    throw new Error(
      "Cannot recover conversation: session was not run with a manual-login browser profile.",
    );
  }
  const runtime = meta?.browser?.runtime;
  const profileDir = runtime?.userDataDir ?? config.manualLoginProfileDir;
  if (typeof profileDir !== "string" || profileDir.trim().length === 0) {
    throw new Error(
      "Cannot recover conversation: session metadata has no manual-login profile directory.",
    );
  }
  return profileDir;
}

async function waitForRecoveredConversationReady(
  endpoint: RecoveryEndpoint,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const harvested = await harvestChatGptTab({ ...endpoint, ref: url });
      if (harvested.authenticated || harvested.assistantCount > 0) {
        return;
      }
      lastError = new Error(`recovered tab is still ${harvested.state}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Recovered ChatGPT conversation did not become ready in time.${suffix}`);
}

/**
 * Re-open a previously-harvested ChatGPT conversation by relaunching Chrome
 * with the session's persistent profile and navigating to the saved tab URL.
 *
 * Used as a fallback when `harvestChatGptTab` can find no live tab matching the
 * stored target (common after the original CLI run exits and closes its
 * browser). ChatGPT preserves attachments + history at the conversation URL,
 * so harvesting against the relaunched tab returns the original message + any
 * assistant response that completed after the original run gave up.
 */
export async function recoverConversationTab(
  meta: SessionMetadata,
  logger: BrowserLogger,
  options: { existingEndpoint?: RecoveryEndpoint; readyTimeoutMs?: number } = {},
): Promise<RecoveredConversation> {
  const url = resolveRecoveryUrl(meta);
  if (!url) {
    throw new Error(
      "Cannot recover conversation: session metadata has no recoverable ChatGPT conversation URL " +
        "(expected browser.harvest.url or browser.runtime.tabUrl to be a chatgpt.com/c/<id> URL).",
    );
  }
  const userDataDir = resolveRecoveryProfileDir(meta);
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  if (options.existingEndpoint) {
    try {
      logger(
        `[browser] Recovery: opening saved conversation in existing Chrome at ` +
          `${options.existingEndpoint.host}:${options.existingEndpoint.port}`,
      );
      await openChatGptTarget({ ...options.existingEndpoint, url });
      await waitForRecoveredConversationReady(options.existingEndpoint, url, readyTimeoutMs);
      return { ...options.existingEndpoint, url, chrome: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`[browser] Recovery: existing Chrome could not reopen the conversation (${message}).`);
    }
  }

  logger(
    `[browser] Recovery: relaunching Chrome with profile ${userDataDir} and navigating to ${url}`,
  );

  const chrome = await launch({
    chromeFlags: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=AutomationControlled,TranslateUI",
      "--disable-sync",
      "--password-store=basic",
      "--use-mock-keychain",
      "--lang=en-US",
      url,
    ],
    userDataDir,
    handleSIGINT: false,
  });

  const host = "127.0.0.1";
  const port = chrome.port;

  await waitForRecoveredConversationReady({ host, port }, url, readyTimeoutMs);

  logger(`[browser] Recovery: Chrome listening on ${host}:${port}; tab loaded.`);

  return { host, port, url, chrome };
}
