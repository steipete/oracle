import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  clearPromptComposer,
  submitPrompt,
} from "./pageActions.js";
import type { BrowserAttachment, BrowserLogger, ChromeClient } from "./types.js";
import { launchChrome, connectToChrome, hideChromeWindow } from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { cleanupStaleProfileState } from "./profileState.js";
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
} from "./reattachHelpers.js";
import { estimateTokenCount } from "./utils.js";

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  ensurePromptReady?: typeof ensurePromptReady;
  clearPromptComposer?: typeof clearPromptComposer;
  submitPrompt?: typeof submitPrompt;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  promptPreview?: string;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  answerTokens?: number;
  tookMs?: number;
  runtime?: BrowserRuntimeMetadata;
}

export interface ContinueBrowserSessionOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
}

async function readCurrentHref(Runtime: ChromeClient["Runtime"]): Promise<string> {
  const { result } = await Runtime.evaluate({
    expression: "location.href",
    returnByValue: true,
  });
  return typeof result?.value === "string" ? result.value : "";
}

function mergeRuntimeMetadata(
  runtime: BrowserRuntimeMetadata,
  updates: {
    chromePid?: number;
    chromeHost?: string;
    chromePort?: number;
    chromeTargetId?: string;
    tabUrl?: string;
    userDataDir?: string;
    controllerPid?: number;
  },
): BrowserRuntimeMetadata {
  const tabUrl = updates.tabUrl || runtime.tabUrl;
  return {
    ...runtime,
    chromePid: updates.chromePid ?? runtime.chromePid,
    chromeHost: updates.chromeHost ?? runtime.chromeHost,
    chromePort: updates.chromePort ?? runtime.chromePort,
    chromeTargetId: updates.chromeTargetId ?? runtime.chromeTargetId,
    tabUrl,
    conversationId: tabUrl ? extractConversationIdFromUrl(tabUrl) : runtime.conversationId,
    userDataDir: updates.userDataDir ?? runtime.userDataDir,
    controllerPid: updates.controllerPid ?? runtime.controllerPid,
  };
}

async function closeClient(client: ChromeClient | null | undefined): Promise<void> {
  if (!client || typeof client.close !== "function") {
    return;
  }
  try {
    await client.close();
  } catch {
    // ignore
  }
}

async function ensureConversationOpenForRuntime(
  Runtime: ChromeClient["Runtime"],
  runtime: BrowserRuntimeMetadata,
  promptPreview?: string,
): Promise<void> {
  const href = await readCurrentHref(Runtime);
  if (href.includes("/c/")) {
    const currentId = extractConversationIdFromUrl(href);
    if (!runtime.conversationId || (currentId && currentId === runtime.conversationId)) {
      return;
    }
  }
  const opened = await openConversationFromSidebarWithRetry(
    Runtime,
    {
      conversationId: runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
      preferProjects: true,
      promptPreview,
    },
    15_000,
  );
  if (!opened) {
    throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
  }
  await waitForLocationChange(Runtime, 15_000);
}

async function captureConversationResponse(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  deps: ReattachDeps,
  timeoutMs: number,
  promptPreview?: string,
): Promise<ReattachResult> {
  const startedAt = Date.now();
  const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
  const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
  const minTurnIndex = await readConversationTurnIndex(Runtime, logger);
  const promptEcho = buildPromptEchoMatcher(promptPreview);
  const answer = await withTimeout(
    waitForResponse(Runtime, timeoutMs, logger, minTurnIndex ?? undefined),
    timeoutMs + 5_000,
    "Reattach response timed out",
  );
  const recovered = await recoverPromptEcho(
    Runtime,
    answer,
    promptEcho,
    logger,
    minTurnIndex,
    timeoutMs,
  );
  const markdown =
    (await withTimeout(
      captureMarkdown(Runtime, recovered.meta, logger),
      15_000,
      "Reattach markdown capture timed out",
    )) ?? recovered.text;
  const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
  const answerText = aligned.answerMarkdown || aligned.answerText;
  return {
    answerText,
    answerMarkdown: aligned.answerMarkdown,
    answerTokens: estimateTokenCount(answerText),
    tookMs: Date.now() - startedAt,
  };
}

async function submitFollowupPrompt(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
  prompt: string,
  config: BrowserSessionConfig | undefined,
  deps: ReattachDeps,
): Promise<void> {
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const clearComposer = deps.clearPromptComposer ?? clearPromptComposer;
  const submit = deps.submitPrompt ?? submitPrompt;
  await ensurePromptReadyForFollowup(Runtime, config?.inputTimeoutMs, logger);
  await clearComposer(Runtime, logger);
  const baselineTurns = await readConversationTurnIndex(Runtime, logger);
  await submit(
    {
      runtime: Runtime,
      input: Input,
      baselineTurns: baselineTurns ?? undefined,
      inputTimeoutMs: config?.inputTimeoutMs ?? undefined,
    },
    prompt,
    logger,
  );
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
    logger("No running Chrome detected; reopening browser to locate the session.");
    return recoverSession(runtime, config);
  }

  const host = runtime.chromeHost ?? "127.0.0.1";
  let client: ChromeClient | null = null;
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
    client = (await connect({
      host,
      port: runtime.chromePort,
      target: target?.targetId,
    })) as unknown as ChromeClient;
    const { Runtime, DOM } = client;
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }

    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: "1+1", returnByValue: true }),
      pingTimeoutMs,
      "Reattach target did not respond",
    );
    await ensureConversationOpenForRuntime(Runtime, runtime, deps.promptPreview);
    const result = await captureConversationResponse(
      Runtime,
      logger,
      deps,
      timeoutMs,
      deps.promptPreview,
    );
    const href = await readCurrentHref(Runtime);
    await closeClient(client);

    return {
      ...result,
      runtime: mergeRuntimeMetadata(runtime, {
        chromeHost: host,
        chromePort: runtime.chromePort,
        chromeTargetId: target?.targetId,
        tabUrl: href || runtime.tabUrl,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    await closeClient(client);
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
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const chrome = await launchChrome(resolved, userDataDir, logger);
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const client = await connectToChrome(chrome.port, logger, chromeHost);
  const { Network, Page, Runtime, DOM } = client;

  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM && typeof DOM.enable === "function") {
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
      waitMs: resolved.cookieSyncWaitMs ?? 0,
    });
  }

  await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
  await ensureNotBlocked(Runtime, resolved.headless, logger);
  await ensureLoggedIn(Runtime, logger, { appliedCookies });
  if (resolved.url !== CHATGPT_URL) {
    await navigateToChatGPT(Page, Runtime, resolved.url, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
  }
  await ensurePromptReadyForFollowup(Runtime, resolved.inputTimeoutMs, logger);

  const conversationUrl = buildConversationUrl(runtime, resolved.url);
  if (conversationUrl) {
    logger(`Reopening conversation at ${conversationUrl}`);
    await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensurePromptReadyForFollowup(Runtime, resolved.inputTimeoutMs, logger);
  } else {
    const opened = await openConversationFromSidebarWithRetry(
      Runtime,
      {
        conversationId:
          runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
        preferProjects:
          resolved.url !== CHATGPT_URL ||
          Boolean(
            runtime.tabUrl && (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
          ),
        promptPreview: deps.promptPreview,
      },
      15_000,
    );
    if (!opened) {
      throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
    }
    await waitForLocationChange(Runtime, 15_000);
  }

  const result = await captureConversationResponse(
    Runtime,
    logger,
    deps,
    resolved.timeoutMs ?? 120_000,
    deps.promptPreview,
  );
  const href = await readCurrentHref(Runtime);
  await closeClient(client);
  if (!resolved.keepBrowser) {
    try {
      await chrome.kill();
    } catch {
      // ignore
    }
    if (manualLogin) {
      await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
        () => undefined,
      );
    } else {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    ...result,
    runtime: mergeRuntimeMetadata(runtime, {
      chromePid: chrome.pid,
      chromeHost,
      chromePort: chrome.port,
      tabUrl: href || conversationUrl || runtime.tabUrl,
      userDataDir,
      controllerPid: process.pid,
    }),
  };
}

export async function continueBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  options: ContinueBrowserSessionOptions,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt text is required to continue a browser session.");
  }
  if ((options.attachments?.length ?? 0) > 0) {
    throw new Error("Browser follow-up does not support attachments yet.");
  }

  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      continueBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, prompt, deps));

  if (!runtime.chromePort) {
    logger("No running Chrome detected; reopening browser to continue the session.");
    return recoverSession(runtime, config);
  }

  const host = runtime.chromeHost ?? "127.0.0.1";
  let client: ChromeClient | null = null;
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
    client = (await connect({
      host,
      port: runtime.chromePort,
      target: target?.targetId,
    })) as unknown as ChromeClient;
    const { Runtime, DOM, Input } = client;
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }

    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: "1+1", returnByValue: true }),
      pingTimeoutMs,
      "Follow-up target did not respond",
    );
    await ensureConversationOpenForRuntime(Runtime, runtime, deps.promptPreview);
    await submitFollowupPrompt(Runtime, Input, logger, prompt, config, deps);
    const result = await captureConversationResponse(Runtime, logger, deps, timeoutMs, prompt);
    const href = await readCurrentHref(Runtime);
    await closeClient(client);

    return {
      ...result,
      runtime: mergeRuntimeMetadata(runtime, {
        chromeHost: host,
        chromePort: runtime.chromePort,
        chromeTargetId: target?.targetId,
        tabUrl: href || runtime.tabUrl,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome follow-up failed (${message}); reopening browser to continue the session.`,
    );
    await closeClient(client);
    return recoverSession(runtime, config);
  }
}

async function continueBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  prompt: string,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-followup-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const chrome = await launchChrome(resolved, userDataDir, logger);
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const client = await connectToChrome(chrome.port, logger, chromeHost);
  const { Network, Page, Runtime, DOM, Input } = client;

  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM && typeof DOM.enable === "function") {
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
      waitMs: resolved.cookieSyncWaitMs ?? 0,
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
    await ensureConversationOpenForRuntime(Runtime, runtime, deps.promptPreview);
  }

  await submitFollowupPrompt(Runtime, Input, logger, prompt, resolved, deps);
  const result = await captureConversationResponse(
    Runtime,
    logger,
    deps,
    resolved.timeoutMs ?? 120_000,
    prompt,
  );
  const href = await readCurrentHref(Runtime);
  await closeClient(client);

  if (!resolved.keepBrowser) {
    try {
      await chrome.kill();
    } catch {
      // ignore
    }
    if (manualLogin) {
      await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
        () => undefined,
      );
    } else {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    ...result,
    runtime: mergeRuntimeMetadata(runtime, {
      chromePid: chrome.pid,
      chromeHost,
      chromePort: chrome.port,
      tabUrl: href || conversationUrl || runtime.tabUrl,
      userDataDir,
      controllerPid: process.pid,
    }),
  };
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  mergeRuntimeMetadata,
  openConversationFromSidebar,
};
