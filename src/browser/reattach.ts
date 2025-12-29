import CDP from 'chrome-remote-interface';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from '../sessionStore.js';
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
} from './pageActions.js';
import type { BrowserLogger, ChromeClient } from './types.js';
import { launchChrome, connectToChrome, hideChromeWindow } from './chromeLifecycle.js';
import { resolveBrowserConfig } from './config.js';
import { syncCookies } from './cookies.js';
import { CHATGPT_URL } from './constants.js';
import { cleanupStaleProfileState } from './profileState.js';
import {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  readConversationTurnIndex,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from './reattachHelpers.js';

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  recoverSession?: (runtime: BrowserRuntimeMetadata, config: BrowserSessionConfig | undefined) => Promise<ReattachResult>;
  promptPreview?: string;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));

  if (!runtime.chromePort) {
    logger('No running Chrome detected; reopening browser to locate the session.');
    return recoverSession(runtime, config);
  }

  const host = runtime.chromeHost ?? '127.0.0.1';
  try {
    const listTargets =
      deps.listTargets ??
      (async () => {
        const targets = await CDP.List({ host, port: runtime.chromePort as number });
        return targets as unknown as TargetInfoLite[];
      });
    const connect = deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options));
    const targetList = (await listTargets()) as TargetInfoLite[];
    const target = pickTarget(targetList, runtime);
    const client: ChromeClient = (await connect({
      host,
      port: runtime.chromePort,
      target: target?.targetId,
    })) as unknown as ChromeClient;
    const { Runtime, DOM } = client;
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === 'function') {
      await DOM.enable();
    }

    const ensureConversationOpen = async () => {
      const { result } = await Runtime.evaluate({ expression: 'location.href', returnByValue: true });
      const href = typeof result?.value === 'string' ? result.value : '';
      if (href.includes('/c/')) {
        const currentId = extractConversationIdFromUrl(href);
        if (!runtime.conversationId || (currentId && currentId === runtime.conversationId)) {
          return;
        }
      }
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId: runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ''),
          preferProjects: true,
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error('Unable to locate prior ChatGPT conversation in sidebar.');
      }
      await waitForLocationChange(Runtime, 15_000);
    };

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: '1+1', returnByValue: true }),
      pingTimeoutMs,
      'Reattach target did not respond',
    );
    await ensureConversationOpen();
    const minTurnIndex = await readConversationTurnIndex(Runtime, logger);
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    const answer = await withTimeout(
      waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined),
      timeoutMs + 5_000,
      'Reattach response timed out',
    );
    const recovered = await recoverPromptEcho(Runtime, answer, promptEcho, logger, minTurnIndex, timeoutMs);
    const markdown = (await withTimeout(
      captureMarkdown(Runtime, recovered.meta, logger),
      15_000,
      'Reattach markdown capture timed out',
    )) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);

    if (client && typeof client.close === 'function') {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }

    return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Existing Chrome reattach failed (${message}); reopening browser to locate the session.`);
    return recoverSession(runtime, config);
  }
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? resolved.manualLoginProfileDir ?? path.join(os.homedir(), '.oracle', 'browser-profile')
    : await mkdtemp(path.join(os.tmpdir(), 'oracle-reattach-'));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const chrome = await launchChrome(resolved, userDataDir, logger);
  const chromeHost = (chrome as unknown as { host?: string }).host ?? '127.0.0.1';
  const client = await connectToChrome(chrome.port, logger, chromeHost);
  const { Network, Page, Runtime, DOM } = client;

  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM && typeof DOM.enable === 'function') {
    await DOM.enable();
  }
  if (!resolved.headless && resolved.hideWindow) {
    await hideChromeWindow(chrome, logger);
  }

  let appliedCookies = 0;
  if (!manualLogin && resolved.cookieSync) {
    appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
      allowErrors: resolved.allowCookieErrors,
      filterNames: resolved.cookieNames ?? undefined,
      inlineCookies: resolved.inlineCookies ?? undefined,
      cookiePath: resolved.chromeCookiePath ?? undefined,
    });
  }

  await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
  await ensureNotBlocked(Runtime, resolved.headless, logger);
  await ensureLoggedIn(Runtime, logger, { appliedCookies });
  if (resolved.url !== CHATGPT_URL) {
    await navigateToChatGPT(Page, Runtime, resolved.url, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
  }
  await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

  const conversationUrl = buildConversationUrl(runtime, resolved.url);
  if (conversationUrl) {
    logger(`Reopening conversation at ${conversationUrl}`);
    await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
  } else {
    const opened = await openConversationFromSidebarWithRetry(
      Runtime,
      {
        conversationId: runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ''),
        preferProjects:
          resolved.url !== CHATGPT_URL ||
          Boolean(runtime.tabUrl && (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes('/project'))),
        promptPreview: deps.promptPreview,
      },
      15_000,
    );
    if (!opened) {
      throw new Error('Unable to locate prior ChatGPT conversation in sidebar.');
    }
    await waitForLocationChange(Runtime, 15_000);
  }

  const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
  const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
  const timeoutMs = resolved.timeoutMs ?? 120_000;
  const minTurnIndex = await readConversationTurnIndex(Runtime, logger);
  const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
  const answer = await waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined);
  const recovered = await recoverPromptEcho(Runtime, answer, promptEcho, logger, minTurnIndex, timeoutMs);
  const markdown = (await captureMarkdown(Runtime, recovered.meta, logger)) ?? recovered.text;
  const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);

  if (client && typeof client.close === 'function') {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
  if (!resolved.keepBrowser) {
    try {
      await chrome.kill();
    } catch {
      // ignore
    }
    if (manualLogin) {
      await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: 'never' }).catch(() => undefined);
    } else {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
};
