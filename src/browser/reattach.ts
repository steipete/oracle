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
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
} from "./pageActions.js";
import type { BrowserAttachment, BrowserLogger, ChromeClient } from "./types.js";
import { launchChrome, connectToChrome, hideChromeWindow } from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { BrowserAutomationError } from "../oracle/errors.js";
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
import { delay, estimateTokenCount } from "./utils.js";

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  ensurePromptReady?: typeof ensurePromptReady;
  clearPromptComposer?: typeof clearPromptComposer;
  submitPrompt?: typeof submitPrompt;
  clearComposerAttachments?: typeof clearComposerAttachments;
  uploadAttachmentFile?: typeof uploadAttachmentFile;
  waitForAttachmentCompletion?: typeof waitForAttachmentCompletion;
  waitForUserTurnAttachments?: typeof waitForUserTurnAttachments;
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
  fallbackSubmission?: { prompt: string; attachments: BrowserAttachment[] };
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
  DOM: ChromeClient["DOM"] | undefined,
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
  options: ContinueBrowserSessionOptions,
  config: BrowserSessionConfig | undefined,
  deps: ReattachDeps,
): Promise<void> {
  const ensurePromptReadyForFollowup = deps.ensurePromptReady ?? ensurePromptReady;
  const clearComposer = deps.clearPromptComposer ?? clearPromptComposer;
  const submit = deps.submitPrompt ?? submitPrompt;
  const clearAttachments = deps.clearComposerAttachments ?? clearComposerAttachments;
  const uploadAttachment = deps.uploadAttachmentFile ?? uploadAttachmentFile;
  const waitForAttachments = deps.waitForAttachmentCompletion ?? waitForAttachmentCompletion;
  const waitForSentAttachments = deps.waitForUserTurnAttachments ?? waitForUserTurnAttachments;
  const submitOnce = async (prompt: string, attachments: BrowserAttachment[] = []) => {
    await ensurePromptReadyForFollowup(Runtime, config?.inputTimeoutMs ?? 60_000, logger);
    await clearComposer(Runtime, logger);
    const attachmentNames = attachments.map((attachment) => path.basename(attachment.path));
    let attachmentWaitTimedOut = false;
    let inputOnlyAttachments = false;
    if (attachments.length > 0) {
      if (!DOM) {
        throw new Error("Chrome DOM domain unavailable while uploading attachments.");
      }
      await clearAttachments(Runtime, 5_000, logger);
      for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
        const attachment = attachments[attachmentIndex];
        logger(`Uploading attachment: ${attachment.displayPath}`);
        const uiConfirmed = await uploadAttachment(
          { runtime: Runtime, dom: DOM, input: Input },
          attachment,
          logger,
          { expectedCount: attachmentIndex + 1 },
        );
        if (!uiConfirmed) {
          inputOnlyAttachments = true;
        }
        await delay(500);
      }
      const baseTimeout = config?.inputTimeoutMs ?? 30_000;
      const perFileTimeout = 20_000;
      const waitBudget = Math.max(baseTimeout, 45_000) + (attachments.length - 1) * perFileTimeout;
      try {
        await waitForAttachments(Runtime, waitBudget, attachmentNames, logger);
        logger("All attachments uploaded");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Attachments did not finish uploading before timeout/i.test(message)) {
          attachmentWaitTimedOut = true;
          logger(
            `[browser] Attachment upload timed out after ${Math.round(waitBudget / 1000)}s; continuing without confirmation.`,
          );
        } else {
          throw error;
        }
      }
    }
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
    if (attachmentNames.length === 0) {
      return;
    }
    if (attachmentWaitTimedOut) {
      logger("Attachment confirmation timed out; skipping user-turn attachment verification.");
      return;
    }
    if (inputOnlyAttachments) {
      logger(
        "Attachment UI did not render before send; skipping user-turn attachment verification.",
      );
      return;
    }
    const verified = await waitForSentAttachments(Runtime, attachmentNames, 20_000, logger);
    if (!verified) {
      throw new Error("Sent user message did not expose attachment UI after upload.");
    }
    logger("Verified attachments present on sent user message");
  };
  try {
    await submitOnce(options.prompt, options.attachments ?? []);
  } catch (error) {
    const isPromptTooLarge =
      error instanceof BrowserAutomationError &&
      (error.details as { code?: string } | undefined)?.code === "prompt-too-large";
    if (options.fallbackSubmission && isPromptTooLarge) {
      logger("[browser] Inline prompt too large; retrying with file uploads.");
      await submitOnce(options.fallbackSubmission.prompt, options.fallbackSubmission.attachments);
      return;
    }
    throw error;
  }
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

  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      continueBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, options, deps));

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
    await submitFollowupPrompt(Runtime, DOM, Input, logger, options, config, deps);
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
  options: ContinueBrowserSessionOptions,
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

  await submitFollowupPrompt(Runtime, DOM, Input, logger, options, resolved, deps);
  const result = await captureConversationResponse(
    Runtime,
    logger,
    deps,
    resolved.timeoutMs ?? 120_000,
    options.prompt,
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
