import type { LaunchedChrome } from "chrome-launcher";
import { acquireBrowserTabLease, type BrowserTabLease } from "./tabLeaseRegistry.js";
import {
  preserveRecoveryChrome,
  recordRecoveryChromeOwnership,
  terminateRecoveryChrome,
} from "./recoveryChromeLifecycle.js";
import type { SessionMetadata } from "../sessionStore.js";
import type { BrowserLogger } from "./types.js";
import { isAnswerNowPlaceholderText } from "./actions/assistantResponse.js";
import { resolveBrowserConfig } from "./config.js";
import { acquireManualLoginChromeForRun, isImageOnlyUiChromeText } from "./index.js";
import { isRecoverableChatGptConversationUrl } from "./reattachability.js";
import { harvestChatGptTab, openChatGptTarget, type LiveChromeEndpoint } from "./liveTabs.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 1_000;

export interface RecoveredConversation extends RecoveryEndpoint {
  host: string;
  port: number;
  url: string;
  ref: string;
  chrome: LaunchedChrome | null;
  release: (closeAfterRecover?: boolean) => Promise<void>;
}

export interface RecoveryEndpoint extends LiveChromeEndpoint {
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
  const resolved = resolveBrowserConfig(config);
  if (!resolved.manualLogin) {
    throw new Error(
      "Cannot recover conversation: session was not run with a manual-login browser profile.",
    );
  }
  const runtime = meta?.browser?.runtime;
  const profileDir = runtime?.userDataDir ?? resolved.manualLoginProfileDir;
  if (typeof profileDir !== "string" || profileDir.trim().length === 0) {
    throw new Error(
      "Cannot recover conversation: session metadata has no recorded manual-login profile directory.",
    );
  }
  return profileDir;
}

async function waitForRecoveredConversationReady(
  endpoint: RecoveryEndpoint,
  ref: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const harvested = await harvestChatGptTab({ ...endpoint, ref });
      if (isRecoveredConversationHarvestReady(harvested)) {
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

export function isRecoveredConversationHarvestReady(harvested: {
  stopExists?: boolean;
  assistantCount?: number;
  assistantFollowsLatestUser?: boolean;
  lastAssistantTurnIndex?: number;
  lastUserTurnIndex?: number;
  lastAssistantMarkdown?: string | null;
  lastAssistantText?: string | null;
  lastAssistantSnippet?: string | null;
}): boolean {
  const latestAssistant =
    harvested.lastAssistantText ??
    harvested.lastAssistantMarkdown ??
    harvested.lastAssistantSnippet ??
    "";
  const assistantFollowsLatestUser =
    harvested.assistantFollowsLatestUser === true ||
    (typeof harvested.lastAssistantTurnIndex === "number" &&
      typeof harvested.lastUserTurnIndex === "number" &&
      harvested.lastAssistantTurnIndex > harvested.lastUserTurnIndex);
  const hasHydratedUserTurn =
    typeof harvested.lastUserTurnIndex === "number" && harvested.lastUserTurnIndex >= 0;
  return (
    (harvested.stopExists === true && hasHydratedUserTurn) ||
    ((harvested.assistantCount ?? 0) > 0 &&
      assistantFollowsLatestUser &&
      latestAssistant.trim().length > 0 &&
      !isImageOnlyUiChromeText(latestAssistant) &&
      !isAnswerNowPlaceholderText(latestAssistant) &&
      !/^answer now$/i.test(latestAssistant.trim()))
  );
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
  options: {
    existingEndpoint?: RecoveryEndpoint;
    readyTimeoutMs?: number;
    waitForReady?: boolean;
  } = {},
): Promise<RecoveredConversation> {
  const url = resolveRecoveryUrl(meta);
  if (!url) {
    throw new Error(
      "Cannot recover conversation: session metadata has no recoverable ChatGPT conversation URL " +
        "(expected browser.harvest.url or browser.runtime.tabUrl to be a chatgpt.com/c/<id> URL).",
    );
  }
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const waitForReady = options.waitForReady !== false;
  const config = resolveBrowserConfig(meta.browser?.config);
  let lease: BrowserTabLease | undefined;
  let profileDir: string | undefined;
  let chrome: Awaited<ReturnType<typeof acquireManualLoginChromeForRun>>["chrome"] | undefined;
  let reused = false;
  const acquireLease = async () => {
    profileDir ??= resolveRecoveryProfileDir(meta);
    lease ??= await acquireBrowserTabLease(profileDir, {
      maxConcurrentTabs: config.maxConcurrentTabs,
      timeoutMs: config.timeoutMs,
      logger,
      sessionId: meta.id,
    });
  };
  const release = async (closeAfterRecover = !config.keepBrowser) => {
    try {
      await lease?.release({
        onRelease: async ({ isLastLease }) => {
          if (!profileDir) return;
          if (!closeAfterRecover) {
            await preserveRecoveryChrome(profileDir);
          } else if (isLastLease) {
            await terminateRecoveryChrome(profileDir, logger);
          }
        },
      });
    } finally {
      chrome?.process?.unref();
    }
  };
  try {
    if (options.existingEndpoint) {
      const localEndpoint = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
        options.existingEndpoint.host,
      );
      if (config.manualLogin && localEndpoint && !config.remoteChrome) await acquireLease();
      try {
        logger(
          `[browser] Recovery: opening saved conversation in existing Chrome at ` +
            `${options.existingEndpoint.host}:${options.existingEndpoint.port}`,
        );
        const targetId = await openChatGptTarget({ ...options.existingEndpoint, url });
        await lease?.update({
          chromeHost: options.existingEndpoint.host,
          chromePort: options.existingEndpoint.port,
          chromeTargetId: targetId,
          tabUrl: url,
        });
        if (waitForReady) {
          await waitForRecoveredConversationReady(
            options.existingEndpoint,
            targetId,
            readyTimeoutMs,
          );
        }
        return { ...options.existingEndpoint, url, ref: targetId, chrome: null, release };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(
          `[browser] Recovery: existing Chrome could not reopen the conversation (${message}).`,
        );
      }
    }
    await acquireLease();
    const userDataDir = profileDir!;
    logger(
      `[browser] Recovery: relaunching Chrome with profile ${userDataDir} and navigating to ${url}`,
    );
    const launchStartedAt = Date.now();
    const acquired = await acquireManualLoginChromeForRun(userDataDir, config, logger, meta.id, {});
    chrome = acquired.chrome;
    reused = Boolean(acquired.reusedChrome);
    if (!reused && chrome.pid)
      await recordRecoveryChromeOwnership(userDataDir, chrome.pid, launchStartedAt);
    const host = chrome.host ?? "127.0.0.1";
    const port = chrome.port;
    const targetId = await openChatGptTarget({ host, port, url });
    if (waitForReady) {
      await waitForRecoveredConversationReady({ host, port }, targetId, readyTimeoutMs);
    }
    logger(`[browser] Recovery: Chrome listening on ${host}:${port}; tab loaded.`);
    await lease!.update({
      chromeHost: host,
      chromePort: port,
      chromeTargetId: targetId,
      tabUrl: url,
    });
    return { host, port, url, ref: targetId, chrome, release };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}
