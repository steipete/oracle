import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { resolveBrowserConfig } from "./config.js";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  ChromeClient,
  BrowserAttachment,
  ResolvedBrowserConfig,
  BrowserArchiveResult,
} from "./types.js";
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectToRemoteChrome,
  connectWithNewTab,
  closeTab,
  closeRemoteChromeTarget,
} from "./chromeLifecycle.js";
import { syncCookies } from "./cookies.js";
import {
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  installJavaScriptDialogAutoDismissal,
  ensureModelSelection,
  clearPromptComposer,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  readAssistantSnapshot,
} from "./pageActions.js";
import { INPUT_SELECTORS } from "./constants.js";
import { uploadAttachmentViaDataTransfer } from "./actions/remoteFileTransfer.js";
import { ensureThinkingTime } from "./actions/thinkingTime.js";
import { startThinkingStatusMonitor } from "./actions/thinkingStatus.js";
import {
  activateDeepResearch,
  waitForDeepResearchCompletion,
  waitForResearchPlanAutoConfirm,
} from "./actions/deepResearch.js";
import { estimateTokenCount, withRetries, delay } from "./utils.js";
import { formatElapsed } from "../oracle/format.js";
import { CHATGPT_URL, CONVERSATION_TURN_SELECTOR, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import type { LaunchedChrome } from "chrome-launcher";
import { BrowserAutomationError } from "../oracle/errors.js";
import { alignPromptEchoPair, buildPromptEchoMatcher } from "./reattachHelpers.js";
import type { ProfileRunLock } from "./profileState.js";
import {
  cleanupStaleProfileState,
  acquireProfileRunLock,
  findRunningChromeDebugTargetForProfile,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  terminateRecordedChromeForProfile,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "./artifacts.js";
import { collectGeneratedImageArtifacts } from "./chatgptImages.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import { chatgptDomProvider } from "./providers/index.js";
import { resolveAttachRunningConnection } from "./attachRunning.js";
import { connectToExistingChatGptTab } from "./liveTabs.js";
import { captureBrowserDiagnostics } from "./domDebug.js";
import {
  archiveChatGptConversation,
  resolveBrowserArchiveDecision,
} from "./actions/archiveConversation.js";

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from "./types.js";
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
export { parseDuration, delay, normalizeChatgptUrl, isTemporaryChatUrl } from "./utils.js";
export {
  formatThinkingLog,
  formatThinkingWaitingLog,
  buildThinkingStatusExpressionForTest,
  readThinkingStatusForTest,
  sanitizeThinkingText,
  startThinkingStatusMonitorForTest,
} from "./actions/thinkingStatus.js";

function redactBrowserConfigForDebugLog(config: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...config };
  if (Array.isArray(config.inlineCookies)) {
    redacted.inlineCookies = `[redacted:${config.inlineCookies.length} cookies]`;
    redacted.inlineCookieCount = config.inlineCookies.length;
  }
  return redacted;
}

export function redactBrowserConfigForDebugLogForTest(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactBrowserConfigForDebugLog(config);
}

function isCloudflareChallengeError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  return (error.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
}

function isReattachableCaptureError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const stage = (error.details as { stage?: string } | undefined)?.stage;
  return stage === "assistant-timeout" || stage === "assistant-recheck";
}

type PreservedBrowserErrorKind = "cloudflare-challenge" | "reattachable-capture";

function classifyPreservedBrowserError(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  if (headless) return null;
  if (isCloudflareChallengeError(error)) return "cloudflare-challenge";
  if (isReattachableCaptureError(error)) return "reattachable-capture";
  return null;
}

function shouldPreserveBrowserOnError(error: unknown, headless: boolean): boolean {
  return classifyPreservedBrowserError(error, headless) !== null;
}

export function shouldPreserveBrowserOnErrorForTest(error: unknown, headless: boolean): boolean {
  return shouldPreserveBrowserOnError(error, headless);
}

export function classifyPreservedBrowserErrorForTest(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  return classifyPreservedBrowserError(error, headless);
}

function shouldSkipThinkingTimeSelection(
  desiredModel: string | null | undefined,
  thinkingTime: ResolvedBrowserConfig["thinkingTime"],
): boolean {
  if (thinkingTime !== "extended" || !desiredModel) {
    return false;
  }
  const normalized = desiredModel.toLowerCase();
  return (
    normalized === "gpt-5.5-pro" ||
    normalized.includes("gpt-5.5 pro") ||
    normalized.includes("gpt 5.5 pro") ||
    normalized.includes("gpt 5 5 pro")
  );
}

export function shouldSkipThinkingTimeSelectionForTest(
  desiredModel: string | null | undefined,
  thinkingTime: ResolvedBrowserConfig["thinkingTime"],
): boolean {
  return shouldSkipThinkingTimeSelection(desiredModel, thinkingTime);
}

function listIgnoredRemoteChromeFlags(config: {
  attachRunning?: ResolvedBrowserConfig["attachRunning"];
  headless?: ResolvedBrowserConfig["headless"];
  hideWindow?: ResolvedBrowserConfig["hideWindow"];
  keepBrowser?: ResolvedBrowserConfig["keepBrowser"];
  chromePath?: ResolvedBrowserConfig["chromePath"];
}): string[] {
  return [
    config.headless ? "--browser-headless" : null,
    config.hideWindow ? "--browser-hide-window" : null,
    config.keepBrowser ? "--browser-keep-browser" : null,
    !config.attachRunning && config.chromePath ? "--browser-chrome-path" : null,
  ].filter((value): value is string => Boolean(value));
}

function hasBrowserErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof BrowserAutomationError &&
    (error.details as { code?: string } | undefined)?.code === code
  );
}

async function saveOptionalArtifact<T>(
  operation: () => Promise<T | null>,
  logger: BrowserLogger,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Failed to save session artifact: ${message}`);
    return null;
  }
}

type AssistantAnswer = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

async function waitForAssistantOrGeneratedImageResponse(params: {
  Runtime: ChromeClient["Runtime"];
  waitForText: () => Promise<AssistantAnswer>;
  timeoutMs: number;
  minTurnIndex?: number;
  expectedConversationId?: string;
  imageOutputRequested: boolean;
  logger: BrowserLogger;
}): Promise<AssistantAnswer> {
  if (!params.imageOutputRequested) {
    return params.waitForText();
  }

  params.logger("[browser] Waiting for ChatGPT generated image response.");
  const response = await pollGeneratedImageOrTextAssistantResponse(
    params.Runtime,
    params.timeoutMs,
    params.minTurnIndex,
    params.expectedConversationId,
  );
  if (response) {
    if (response.html?.includes("/backend-api/estuary/content?id=file_")) {
      params.logger("[browser] Captured generated image response before text appeared.");
    }
    return response;
  }

  throw new Error("assistant response timeout while waiting for generated image or text");
}

async function attemptAssistantRecheckOrRethrow(
  operation: () => Promise<AssistantAnswer | null>,
): Promise<AssistantAnswer | null> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    return null;
  }
}

async function pollGeneratedImageOrTextAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<AssistantAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, expectedConversationId).catch(
      () => null,
    );
    if (!snapshot && typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
      const relaxedSnapshot = await readAssistantSnapshot(
        Runtime,
        undefined,
        expectedConversationId,
      ).catch(() => null);
      const relaxedHtml = typeof relaxedSnapshot?.html === "string" ? relaxedSnapshot.html : "";
      if (relaxedHtml.includes("/backend-api/estuary/content?id=file_")) {
        snapshot = relaxedSnapshot;
      }
    }
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    const html = typeof snapshot?.html === "string" ? snapshot.html : "";
    const hasGeneratedImage = html.includes("/backend-api/estuary/content?id=file_");
    if (text && (hasGeneratedImage || !isImageOnlyUiChromeText(text))) {
      return {
        text,
        html,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
    }
    await delay(750);
  }
  return null;
}

function isImageOnlyUiChromeText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized.length === 0 ||
    normalized === "edit" ||
    normalized === "stopped thinking" ||
    normalized === "stopped thinking edit"
  );
}

export interface BrowserConversationTurn {
  label: string;
  prompt?: string;
  answerText: string;
  answerMarkdown: string;
}

function normalizeBrowserFollowUpPrompts(values: string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim()).filter(Boolean);
}

export function formatBrowserTurnTranscript(turns: BrowserConversationTurn[]): {
  answerText: string;
  answerMarkdown: string;
} {
  if (turns.length <= 1) {
    const turn = turns[0];
    return {
      answerText: turn?.answerText ?? "",
      answerMarkdown: turn?.answerMarkdown ?? turn?.answerText ?? "",
    };
  }

  const answerMarkdown = turns
    .map((turn, index) => {
      const label = turn.label.trim() || `Turn ${index + 1}`;
      const prompt = turn.prompt?.trim();
      const promptBlock = prompt ? `\n\n### Prompt\n\n${prompt}` : "";
      const answer = (turn.answerMarkdown || turn.answerText).trim() || "_No text captured._";
      return `## ${label}${promptBlock}\n\n### Answer\n\n${answer}`;
    })
    .join("\n\n")
    .trim();

  return {
    answerText: answerMarkdown,
    answerMarkdown,
  };
}

async function maybeArchiveCompletedConversation({
  Runtime,
  logger,
  config,
  conversationUrl,
  followUpCount,
  requiredArtifactsSaved,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  config: ResolvedBrowserConfig;
  conversationUrl?: string | null;
  followUpCount: number;
  requiredArtifactsSaved: boolean;
}): Promise<BrowserArchiveResult> {
  const decision = resolveBrowserArchiveDecision({
    mode: config.archiveConversations,
    chatgptUrl: config.chatgptUrl ?? config.url,
    conversationUrl,
    researchMode: config.researchMode,
    followUpCount,
  });
  if (!decision.shouldArchive) {
    logger(`[browser] ChatGPT archive skipped (${decision.reason}).`);
    return {
      mode: decision.mode,
      attempted: false,
      archived: false,
      reason: decision.reason,
      conversationUrl: conversationUrl ?? undefined,
    };
  }
  if (!requiredArtifactsSaved) {
    logger("[browser] ChatGPT archive skipped (artifact-save-failed).");
    return {
      mode: decision.mode,
      attempted: false,
      archived: false,
      reason: "artifact-save-failed",
      conversationUrl: conversationUrl ?? undefined,
    };
  }
  return archiveChatGptConversation(Runtime, logger, {
    mode: decision.mode,
    conversationUrl,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] ChatGPT archive failed (${message}).`);
    return {
      mode: decision.mode,
      attempted: true,
      archived: false,
      reason: "archive-failed",
      conversationUrl: conversationUrl ?? undefined,
      error: message,
    };
  });
}

export function maybeArchiveCompletedConversationForTest(
  args: Parameters<typeof maybeArchiveCompletedConversation>[0],
): Promise<BrowserArchiveResult> {
  return maybeArchiveCompletedConversation(args);
}

type BrowserSubmissionResult = {
  baselineTurns: number | null;
  baselineAssistantText: string | null;
};

type BrowserSubmissionFallback = {
  prompt: string;
  attachments: BrowserAttachment[];
};

async function runSubmissionWithRecovery({
  prompt,
  attachments,
  fallbackSubmission,
  submit,
  reloadPromptComposer,
  prepareFallbackSubmission,
  logger,
}: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (prompt: string, attachments: BrowserAttachment[]) => Promise<BrowserSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  let currentPrompt = prompt;
  let currentAttachments = attachments;
  let retriedDeadComposer = false;
  let usedFallbackSubmission = false;

  while (true) {
    try {
      return await submit(currentPrompt, currentAttachments);
    } catch (error) {
      const isDeadComposer = hasBrowserErrorCode(error, "dead-composer");
      if (isDeadComposer && !retriedDeadComposer) {
        retriedDeadComposer = true;
        await reloadPromptComposer();
        continue;
      }

      const isPromptTooLarge = hasBrowserErrorCode(error, "prompt-too-large");
      if (fallbackSubmission && isPromptTooLarge && !usedFallbackSubmission) {
        usedFallbackSubmission = true;
        logger("[browser] Inline prompt too large; retrying with file uploads.");
        await prepareFallbackSubmission();
        currentPrompt = fallbackSubmission.prompt;
        currentAttachments = fallbackSubmission.attachments;
        continue;
      }

      throw error;
    }
  }
}

export async function runSubmissionWithRecoveryForTest(args: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (prompt: string, attachments: BrowserAttachment[]) => Promise<BrowserSubmissionResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  return runSubmissionWithRecovery(args);
}

function resolveRemoteTabLeaseProfileDir(
  config: ReturnType<typeof resolveBrowserConfig>,
): string | null {
  if (!config.remoteChrome || !config.manualLogin || !config.manualLoginProfileDir) {
    return null;
  }
  return path.resolve(config.manualLoginProfileDir);
}

export function resolveRemoteTabLeaseProfileDirForTest(
  config: ReturnType<typeof resolveBrowserConfig>,
): string | null {
  return resolveRemoteTabLeaseProfileDir(config);
}

async function closeRemoteConnectionAfterRun(options: {
  connectionClosedUnexpectedly: boolean;
  connection: { close: () => Promise<void> } | null;
  client: Pick<ChromeClient, "close"> | null;
  runStatus: "attempted" | "complete";
}): Promise<void> {
  if (options.connectionClosedUnexpectedly) {
    return;
  }
  if (!options.connection) {
    await options.client?.close();
    return;
  }
  if (options.runStatus === "complete") {
    await options.connection.close();
  } else {
    await options.client?.close();
  }
}

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using browser mode.");
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];
  const fallbackSubmission = options.fallbackSubmission;

  let config = resolveBrowserConfig(options.config);
  const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);
  if (config.researchMode === "deep" && followUpPrompts.length > 0) {
    throw new BrowserAutomationError(
      "Browser follow-ups are not supported with Deep Research mode. Put the full research plan into the initial prompt or run a normal browser consult for multi-turn review.",
      {
        stage: "browser-follow-ups",
        details: { researchMode: "deep", followUps: followUpPrompts.length },
      },
    );
  }
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }
  if (logger.sessionLog === undefined && options.log?.sessionLog) {
    logger.sessionLog = options.log.sessionLog;
  }
  const runtimeHintCb = options.runtimeHintCb;
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined;
  let tabLease: BrowserTabLease | null = null;
  const emitRuntimeHint = async (): Promise<void> => {
    if (!chrome?.port) {
      return;
    }
    const conversationId = lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;
    const hint = {
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId,
      userDataDir,
      controllerPid: process.pid,
    };
    try {
      await runtimeHintCb?.(hint);
      await tabLease?.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...redactBrowserConfigForDebugLog(config),
        promptLength: promptText.length,
      })}`,
    );
  }

  if (config.attachRunning) {
    const attached = await resolveAttachRunningConnection(config, logger);
    config = {
      ...config,
      remoteChrome: { host: attached.host, port: attached.port },
      remoteChromeBrowserWSEndpoint: attached.browserWSEndpoint,
      remoteChromeProfileRoot: attached.profileRoot,
    };
  }

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await pickAvailableDebugPort(preferredPort, logger);
    if (availablePort !== preferredPort) {
      logger(
        `DevTools port ${preferredPort} busy; using ${availablePort} to avoid attaching to stray Chrome.`,
      );
    }
    config = { ...config, debugPort: availablePort };
  }

  // Remote Chrome mode - connect to existing browser
  if (config.remoteChrome) {
    // Warn about ignored local-only options
    const ignoredFlags = listIgnoredRemoteChromeFlags(config);
    if (ignoredFlags.length > 0) {
      logger(`Note: --remote-chrome ignores local Chrome flags (${ignoredFlags.join(", ")}).`);
    }

    return runRemoteBrowserMode(promptText, attachments, config, logger, options);
  }

  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : path.join(os.homedir(), ".oracle", "browser-profile");
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), "oracle-browser-"));
  if (manualLogin) {
    // Learned: manual login reuses a persistent profile so cookies/SSO survive.
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  if (manualLogin) {
    tabLease = await acquireBrowserTabLease(userDataDir, {
      maxConcurrentTabs: config.maxConcurrentTabs,
      timeoutMs: config.timeoutMs,
      logger,
      sessionId: options.sessionId,
    });
  }

  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  let acquiredChrome: { chrome: BrowserChrome; reusedChrome: LaunchedChrome | null };
  try {
    acquiredChrome = manualLogin
      ? await acquireManualLoginChromeForRun(userDataDir, config, logger, options.sessionId)
      : {
          chrome: await launchChrome(
            {
              ...config,
              remoteChrome: config.remoteChrome,
            },
            userDataDir,
            logger,
          ),
          reusedChrome: null,
        };
  } catch (error) {
    if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      await handle.release().catch(() => undefined);
    }
    throw error;
  }
  const { chrome, reusedChrome } = acquiredChrome;
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  if (tabLease) {
    await tabLease.update({
      chromeHost,
      chromePort: chrome.port,
    });
  }
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      {
        isInFlight: () => runStatus !== "complete",
        emitRuntimeHint,
        preserveUserDataDir: manualLogin,
      },
    );
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  let ownsTarget = true;
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let runStatus: "attempted" | "complete" = "attempted";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let appliedCookies = 0;
  let preserveBrowserOnError = false;

  try {
    try {
      if (config.browserTabRef) {
        const attached = await connectToExistingChatGptTab({
          host: chromeHost,
          port: chrome.port,
          ref: config.browserTabRef,
        });
        client = attached.client;
        isolatedTargetId = attached.targetId ?? null;
        lastTargetId = attached.targetId ?? undefined;
        lastUrl = attached.tab.url || lastUrl;
        ownsTarget = false;
        logger(
          `Attached to existing ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
        );
      } else {
        const strictTabIsolation = Boolean(manualLogin && reusedChrome);
        const connection = await connectWithNewTab(chrome.port, logger, config.url, chromeHost, {
          fallbackToDefault: !strictTabIsolation,
          retries: strictTabIsolation ? 3 : 0,
          retryDelayMs: 500,
        });
        client = connection.client;
        isolatedTargetId = connection.targetId ?? null;
        ownsTarget = true;
      }
      if (tabLease && isolatedTargetId) {
        await tabLease.update({
          chromeHost,
          chromePort: chrome.port,
          chromeTargetId: isolatedTargetId,
        });
      }
    } catch (error) {
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        logger("Chrome window closed; attempting to abort run.");
        reject(
          new Error(
            "Chrome window closed before oracle finished. Please keep it open until completion.",
          ),
        );
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);
    const { Network, Page, Runtime, Input, DOM } = client;

    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
    const cookieSyncEnabled = config.cookieSync && (!manualLogin || manualLoginCookieSync);
    if (cookieSyncEnabled) {
      if (manualLoginCookieSync) {
        logger(
          "Manual login mode: seeding persistent profile with cookies from your Chrome profile.",
        );
      }
      if (!config.inlineCookies) {
        logger(
          "Heads-up: macOS may prompt for your Keychain password to read Chrome cookies; use --copy or --render for manual flow.",
        );
      } else {
        logger("Applying inline cookies (skipping Chrome profile read and Keychain prompt)");
      }
      // Learned: always sync cookies before the first navigation so /backend-api/me succeeds.
      const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger, {
        allowErrors: config.allowCookieErrors ?? false,
        filterNames: config.cookieNames ?? undefined,
        inlineCookies: config.inlineCookies ?? undefined,
        cookiePath: config.chromeCookiePath ?? undefined,
        waitMs: config.cookieSyncWaitMs ?? 0,
      });
      appliedCookies = cookieCount;
      if (config.inlineCookies && cookieCount === 0) {
        throw new Error("No inline cookies were applied; aborting before navigation.");
      }
      logger(
        cookieCount > 0
          ? config.inlineCookies
            ? `Applied ${cookieCount} inline cookies`
            : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
          : config.inlineCookies
            ? "No inline cookies applied; continuing without session reuse"
            : "No Chrome cookies found; continuing without session reuse",
      );
    } else {
      logger(
        manualLogin
          ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
          : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
      );
    }

    if (cookieSyncEnabled && !manualLogin && (appliedCookies ?? 0) === 0 && !config.inlineCookies) {
      // Learned: if the profile has no ChatGPT cookies, browser mode will just bounce to login.
      // Fail early so the user knows to sign in.
      throw new BrowserAutomationError(
        "No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode. " +
          "Make sure ChatGPT is signed in in the selected profile, use --browser-manual-login / inline cookies, " +
          "or retry with --browser-cookie-wait 5s if Keychain prompts are slow.",
        {
          stage: "execute-browser",
          details: {
            profile: config.chromeProfile ?? "Default",
            cookiePath: config.chromeCookiePath ?? null,
            hint: "If macOS Keychain prompts or denies access, run oracle from a GUI session or use --copy/--render for the manual flow.",
          },
        },
      );
    }

    if (config.browserTabRef) {
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
      await raceWithDisconnect(ensureLoggedIn(Runtime, logger));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    } else {
      const baseUrl = CHATGPT_URL;
      // First load the base ChatGPT homepage to satisfy potential interstitials,
      // then hop to the requested URL if it differs.
      await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
      // Learned: login checks must happen on the base domain before jumping into project URLs.
      await raceWithDisconnect(
        waitForLogin({
          runtime: Runtime,
          logger,
          appliedCookies,
          manualLogin,
          timeoutMs: config.timeoutMs,
        }),
      );

      if (config.url !== baseUrl) {
        await raceWithDisconnect(
          navigateToPromptReadyWithFallback(Page, Runtime, {
            url: config.url,
            fallbackUrl: baseUrl,
            timeoutMs: config.inputTimeoutMs,
            headless: config.headless,
            logger,
          }),
        );
      } else {
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      }
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    const captureRuntimeSnapshot = async () => {
      try {
        if (client?.Target?.getTargetInfo) {
          const info = await client.Target.getTargetInfo({});
          lastTargetId = info?.targetInfo?.targetId ?? lastTargetId;
          lastUrl = info?.targetInfo?.url ?? lastUrl;
        }
      } catch {
        // ignore
      }
      try {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        if (typeof result?.value === "string") {
          lastUrl = result.value;
        }
      } catch {
        // ignore
      }
      if (lastUrl) {
        logger(`[browser] url = ${lastUrl}`);
      }
      if (chrome?.port) {
        const suffix = lastTargetId ? ` target=${lastTargetId}` : "";
        if (lastUrl) {
          logger(
            `[reattach] chrome port=${chrome.port} host=${chromeHost} url=${lastUrl}${suffix}`,
          );
        } else {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}${suffix}`);
        }
        await emitRuntimeHint();
      }
    };
    let conversationHintInFlight: Promise<boolean> | null = null;
    const updateConversationHint = async (label: string, timeoutMs = 10_000): Promise<boolean> => {
      if (!chrome?.port) {
        return false;
      }
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const { result } = await Runtime.evaluate({
            expression: "location.href",
            returnByValue: true,
          });
          if (typeof result?.value === "string" && result.value.includes("/c/")) {
            lastUrl = result.value;
            logger(`[browser] conversation url (${label}) = ${lastUrl}`);
            await emitRuntimeHint();
            return true;
          }
        } catch {
          // ignore; keep polling until timeout
        }
        await delay(250);
      }
      return false;
    };
    const scheduleConversationHint = (label: string, timeoutMs?: number): void => {
      if (conversationHintInFlight) {
        return;
      }
      // Learned: the /c/ URL can update after the answer; emit hints in the background.
      // Run in the background so prompt submission/streaming isn't blocked by slow URL updates.
      conversationHintInFlight = updateConversationHint(label, timeoutMs)
        .catch(() => false)
        .finally(() => {
          conversationHintInFlight = null;
        });
    };
    await captureRuntimeSnapshot();
    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore") {
      await raceWithDisconnect(
        withRetries(
          () => ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
          {
            retries: 2,
            delayMs: 300,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch((error) => {
        const base = error instanceof Error ? error.message : String(error);
        const hint =
          appliedCookies === 0
            ? " No cookies were applied; log in to ChatGPT in Chrome or provide inline cookies (--browser-inline-cookies[(-file)] or ORACLE_BROWSER_COOKIES_JSON)."
            : "";
        throw new Error(`${base}${hint}`);
      });
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore") {
      logger("Model picker: skipped (strategy=ignore)");
    }
    const deepResearch = config.researchMode === "deep";
    // Handle thinking time selection if specified. Deep Research owns its own effort flow.
    const thinkingTime = config.thinkingTime;
    if (thinkingTime && !deepResearch) {
      if (shouldSkipThinkingTimeSelection(config.desiredModel, thinkingTime)) {
        logger("Thinking time: Pro Extended (via model selection)");
      } else {
        await raceWithDisconnect(
          withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
            retries: 2,
            delayMs: 300,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          }),
        );
      }
    }
    if (deepResearch) {
      await raceWithDisconnect(
        withRetries(() => activateDeepResearch(Runtime, Input, logger), {
          retries: 2,
          delayMs: 500,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        }),
      );
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after Deep Research activation, ${promptText.length.toLocaleString()} chars queued)`,
      );
    }
    const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;
    let profileLock: ProfileRunLock | null = null;
    const acquireProfileLockIfNeeded = async () => {
      if (profileLockTimeoutMs <= 0) return;
      profileLock = await acquireProfileRunLock(userDataDir, {
        timeoutMs: profileLockTimeoutMs,
        logger,
      });
    };
    const releaseProfileLockIfHeld = async () => {
      if (!profileLock) return;
      const handle = profileLock;
      profileLock = null;
      await handle.release().catch(() => undefined);
    };
    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      let inputOnlyAttachments = false;
      await raceWithDisconnect(clearPromptComposer(Runtime, logger));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearComposerAttachments(Runtime, 5_000, logger);
        for (
          let attachmentIndex = 0;
          attachmentIndex < submissionAttachments.length;
          attachmentIndex += 1
        ) {
          const attachment = submissionAttachments[attachmentIndex];
          logger(`Uploading attachment: ${attachment.displayPath}`);
          const uiConfirmed = await uploadAttachmentFile(
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
        // Scale timeout based on number of files: base 45s + 20s per additional file.
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 20_000;
        const waitBudget =
          Math.max(baseTimeout, 45_000) + (submissionAttachments.length - 1) * perFileTimeout;
        await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
        logger("All attachments uploaded");
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      // Learned: return baselineTurns so assistant polling can ignore earlier content.
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames,
      };
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      if (attachmentNames.length > 0) {
        if (inputOnlyAttachments) {
          logger(
            "Attachment UI did not render before send; skipping user-turn attachment verification.",
          );
        } else {
          const verified = await waitForUserTurnAttachments(
            Runtime,
            attachmentNames,
            20_000,
            logger,
            {
              minTurnIndex: baselineTurns ?? undefined,
              expectedPrompt: prompt,
              expectedConversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
            },
          );
          if (!verified) {
            logger(
              "Sent user message did not expose attachment UI; continuing after upload check.",
            );
          } else {
            logger("Verified attachments present on sent user message");
          }
        }
      }
      // Reattach needs a /c/ URL; ChatGPT can update it late, so poll in the background.
      scheduleConversationHint("post-submit", config.timeoutMs ?? 120_000);
      return { baselineTurns, baselineAssistantText };
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await raceWithDisconnect(Page.reload({ ignoreCache: true }));
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    await acquireProfileLockIfNeeded();
    try {
      const submission = await runSubmissionWithRecovery({
        prompt: promptText,
        attachments,
        fallbackSubmission,
        submit: (submissionPrompt, submissionAttachments) =>
          raceWithDisconnect(submitOnce(submissionPrompt, submissionAttachments)),
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await raceWithDisconnect(clearPromptComposer(Runtime, logger));
          await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        },
        logger,
      });
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
    } finally {
      await releaseProfileLockIfHeld();
    }
    const imageArtifactMinTurnIndex = baselineTurns;
    if (deepResearch) {
      await raceWithDisconnect(waitForResearchPlanAutoConfirm(Runtime, logger));
      const researchResult = await raceWithDisconnect(
        waitForDeepResearchCompletion(
          Runtime,
          logger,
          config.timeoutMs,
          baselineTurns,
          Page,
          client,
        ),
      );
      await updateConversationHint("post-deep-research", 15_000).catch(() => false);
      runStatus = "complete";
      const durationMs = Date.now() - startedAt;
      const tokens = estimateTokenCount(researchResult.text);
      const reportArtifact = await saveOptionalArtifact(
        () =>
          saveDeepResearchReportArtifact({
            sessionId: options.sessionId,
            reportMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            logger,
          }),
        logger,
      );
      const transcriptArtifact = await saveOptionalArtifact(
        () =>
          saveBrowserTranscriptArtifact({
            sessionId: options.sessionId,
            prompt: promptText,
            answerMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            artifacts: appendArtifacts(undefined, [reportArtifact]),
            logger,
          }),
        logger,
      );
      const savedArtifacts = appendArtifacts(undefined, [reportArtifact, transcriptArtifact]);
      const archive = await maybeArchiveCompletedConversation({
        Runtime,
        logger,
        config,
        conversationUrl: lastUrl,
        followUpCount: 0,
        requiredArtifactsSaved: Boolean(reportArtifact && transcriptArtifact),
      });
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        answerHtml: researchResult.html,
        artifacts: savedArtifacts,
        archive,
        tookMs: durationMs,
        answerTokens: tokens,
        answerChars: researchResult.text.length,
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
        conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
        controllerPid: process.pid,
      };
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const expectedConversationId = () =>
      lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId(),
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await raceWithDisconnect(delay(recheckDelayMs));
      await updateConversationHint("assistant-recheck", 15_000).catch(() => false);
      await captureRuntimeSnapshot().catch(() => undefined);
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await raceWithDisconnect(Page.navigate({ url: conversationUrl }));
        await raceWithDisconnect(delay(1000));
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            },
          },
        );
      }
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        raceWithDisconnect(
          waitForAssistantOrGeneratedImageResponse({
            Runtime,
            waitForText: () =>
              waitForAssistantResponseWithReload(
                Runtime,
                Page,
                timeoutMs,
                logger,
                baselineTurns ?? undefined,
                expectedConversationId(),
              ),
            timeoutMs,
            logger,
            minTurnIndex: baselineTurns ?? undefined,
            expectedConversationId: expectedConversationId(),
            imageOutputRequested,
          }),
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const imageOutputRequested = Boolean(
      options.generateImagePath ||
      options.outputPath ||
      (options as { generateImage?: string }).generateImage,
    );
    const captureAssistantTurn = async (
      turnPrompt: string,
      label: string,
    ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
      let turnAnswer: AssistantAnswer;
      try {
        await updateConversationHint("assistant-wait", 15_000).catch(() => false);
        turnAnswer = await waitWithThinkingMonitor(() =>
          raceWithDisconnect(
            waitForAssistantOrGeneratedImageResponse({
              Runtime,
              waitForText: () =>
                waitForAssistantResponseWithReload(
                  Runtime,
                  Page,
                  config.timeoutMs,
                  logger,
                  baselineTurns ?? undefined,
                  expectedConversationId(),
                ),
              timeoutMs: config.timeoutMs,
              logger,
              minTurnIndex: baselineTurns ?? undefined,
              expectedConversationId: expectedConversationId(),
              imageOutputRequested,
            }),
          ),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheckOrRethrow(attemptAssistantRecheck);
          if (rechecked) {
            turnAnswer = rechecked;
          } else {
            await updateConversationHint("assistant-timeout", 15_000).catch(() => false);
            await captureRuntimeSnapshot().catch(() => undefined);
            const diagnostics = await captureBrowserDiagnostics(
              Runtime,
              logger,
              "assistant-timeout",
              {
                Page,
                sessionId: options.sessionId,
              },
            ).catch(() => undefined);
            const runtime = {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            };
            throw new BrowserAutomationError(
              "Assistant response timed out before completion; reattach later to capture the answer.",
              { stage: "assistant-timeout", runtime, diagnostics },
              error,
            );
          }
        } else {
          throw error;
        }
      }
      // Ensure we store the final conversation URL even if the UI updated late.
      await updateConversationHint("post-response", 15_000);
      const baselineNormalized = baselineAssistantText
        ? normalizeForComparison(baselineAssistantText)
        : "";
      if (baselineNormalized) {
        const normalizedAnswer = normalizeForComparison(turnAnswer.text ?? "");
        const baselinePrefix =
          baselineNormalized.length >= 80
            ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
            : "";
        const isBaseline =
          normalizedAnswer === baselineNormalized ||
          (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
        if (isBaseline) {
          logger("Detected stale assistant response; waiting for new response...");
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            turnAnswer = refreshed;
          }
        }
      }
      let turnAnswerText = turnAnswer.text;
      const turnAnswerHtml = turnAnswer.html ?? "";
      const copiedMarkdown = await raceWithDisconnect(
        withRetries(
          async () => {
            const attempt = await captureAssistantMarkdown(Runtime, turnAnswer.meta, logger);
            if (!attempt) {
              throw new Error("copy-missing");
            }
            return attempt;
          },
          {
            retries: 2,
            delayMs: 350,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch(() => null);
      let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;

      const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);
      ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
        await maybeRecoverLongAssistantResponse({
          runtime: Runtime,
          baselineTurns,
          answerText: turnAnswerText,
          answerMarkdown: turnAnswerMarkdown,
          logger,
          allowMarkdownUpdate: !copiedMarkdown,
        }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readAssistantSnapshot(
        Runtime,
        baselineTurns ?? undefined,
        expectedConversationId(),
      ).catch(() => null);
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (finalText && finalText !== turnPrompt.trim()) {
        const trimmedMarkdown = turnAnswerMarkdown.trim();
        const finalIsEcho = promptEchoMatcher ? promptEchoMatcher.isEcho(finalText) : false;
        const lengthDelta = finalText.length - trimmedMarkdown.length;
        const missingCopy = !copiedMarkdown && lengthDelta >= 0;
        const likelyTruncatedCopy =
          copiedMarkdown &&
          trimmedMarkdown.length > 0 &&
          lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
        if ((missingCopy || likelyTruncatedCopy) && !finalIsEcho && finalText !== trimmedMarkdown) {
          logger("Refreshed assistant response via final DOM snapshot");
          turnAnswerText = finalText;
          turnAnswerMarkdown = finalText;
        }
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const alignedEcho = alignPromptEchoPair(
        turnAnswerText,
        turnAnswerMarkdown,
        promptEchoMatcher,
        copiedMarkdown ? logger : undefined,
        {
          text: "Aligned assistant response text to copied markdown after prompt echo",
          markdown: "Aligned assistant markdown to response text after prompt echo",
        },
      );
      turnAnswerText = alignedEcho.answerText;
      turnAnswerMarkdown = alignedEcho.answerMarkdown;
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
          if (!isStillEcho) {
            if (!bestText || text.length > bestText.length) {
              bestText = text;
              stableCount = 0;
            } else if (text === bestText) {
              stableCount += 1;
            }
            if (stableCount >= 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          logger("Recovered assistant response after detecting prompt echo");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      const minAnswerChars = 16;
      if (turnAnswerText.trim().length > 0 && turnAnswerText.trim().length < minAnswerChars) {
        const deadline = Date.now() + 12_000;
        let bestText = turnAnswerText.trim();
        let stableCycles = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          if (text && text.length > bestText.length) {
            bestText = text;
            stableCycles = 0;
          } else {
            stableCycles += 1;
          }
          if (stableCycles >= 3 && bestText.length >= minAnswerChars) {
            break;
          }
          await delay(400);
        }
        if (bestText.length > turnAnswerText.trim().length) {
          logger("Refreshed short assistant response from latest DOM snapshot");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      return {
        label,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        answerHtml: turnAnswerHtml,
      };
    };

    const turns: BrowserConversationTurn[] = [];
    const initialTurn = await captureAssistantTurn(promptText, "Initial response");
    turns.push(initialTurn);
    answerText = initialTurn.answerText;
    answerMarkdown = initialTurn.answerMarkdown;
    answerHtml = initialTurn.answerHtml;

    for (let index = 0; index < followUpPrompts.length; index += 1) {
      const followUpPrompt = followUpPrompts[index];
      logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
      await acquireProfileLockIfNeeded();
      try {
        await raceWithDisconnect(clearPromptComposer(Runtime, logger));
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        const submission = await runSubmissionWithRecovery({
          prompt: followUpPrompt,
          attachments: [],
          submit: (submissionPrompt, submissionAttachments) =>
            raceWithDisconnect(submitOnce(submissionPrompt, submissionAttachments)),
          reloadPromptComposer,
          prepareFallbackSubmission: async () => {
            await raceWithDisconnect(clearPromptComposer(Runtime, logger));
            await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
          },
          logger,
        });
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } finally {
        await releaseProfileLockIfHeld();
      }
      const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
      turns.push({ ...turn, prompt: followUpPrompt });
      answerText = turn.answerText;
      answerMarkdown = turn.answerMarkdown;
      answerHtml = turn.answerHtml;
    }

    if (turns.length > 1) {
      const formatted = formatBrowserTurnTranscript(turns);
      answerText = formatted.answerText;
      answerMarkdown = formatted.answerMarkdown;
      answerHtml = "";
    }
    if (connectionClosedUnexpectedly) {
      // Bail out on mid-run disconnects so the session stays reattachable.
      throw new Error("Chrome disconnected before completion");
    }
    const imageArtifacts = await collectGeneratedImageArtifacts({
      Runtime,
      Network,
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      generateImagePath: options.generateImagePath,
      outputPath: options.outputPath,
      answerText,
      waitTimeoutMs: options.config?.timeoutMs,
    });
    answerText = imageArtifacts.answerText || answerText;
    if (imageArtifacts.markdownSuffix) {
      answerMarkdown += imageArtifacts.markdownSuffix;
    }
    const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: promptText,
          answerMarkdown,
          conversationUrl: lastUrl,
          artifacts: savedImageArtifacts,
          logger,
        }),
      logger,
    );
    const savedArtifacts = appendArtifacts(savedImageArtifacts, [transcriptArtifact]);
    const archive = await maybeArchiveCompletedConversation({
      Runtime,
      logger,
      config,
      conversationUrl: lastUrl,
      followUpCount: followUpPrompts.length,
      requiredArtifactsSaved:
        Boolean(transcriptArtifact) &&
        imageArtifacts.savedImages.length === imageArtifacts.imageCount,
    });
    runStatus = "complete";
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      artifacts: savedArtifacts,
      generatedImages: imageArtifacts.generatedImages,
      savedImages: imageArtifacts.savedImages,
      archive,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    const preservedErrorKind = classifyPreservedBrowserError(normalizedError, config.headless);
    if (preservedErrorKind === "cloudflare-challenge") {
      preserveBrowserOnError = true;
      const runtime = {
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      };
      const reuseProfileHint =
        `oracle --engine browser --browser-manual-login ` +
        `--browser-manual-login-profile-dir ${JSON.stringify(userDataDir)}`;
      await emitRuntimeHint();
      logger("Cloudflare challenge detected; leaving browser open so you can complete the check.");
      logger(`Reuse this browser profile with: ${reuseProfileHint}`);
      throw new BrowserAutomationError(
        "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.",
        {
          stage: "cloudflare-challenge",
          runtime,
          reuseProfileHint,
        },
        normalizedError,
      );
    }
    if (preservedErrorKind === "reattachable-capture") {
      preserveBrowserOnError = true;
      await emitRuntimeHint();
      logger("Assistant capture incomplete; leaving browser open for reattach.");
      throw normalizedError;
    }
    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
      logger(`Chrome window closed before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    await emitRuntimeHint();
    throw new BrowserAutomationError(
      "Chrome window closed before oracle finished. Please keep it open until completion.",
      {
        stage: "connection-lost",
        runtime: {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: lastUrl,
          controllerPid: process.pid,
        },
      },
      normalizedError,
    );
  } finally {
    try {
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch {
      // ignore
    }
    // Close the isolated tab once the response has been fully captured to prevent
    // tab accumulation across repeated runs. Keep the tab open on incomplete runs
    // so reattach can recover the response.
    if (runStatus === "complete" && isolatedTargetId && chrome?.port && ownsTarget) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }
    let keepBrowserOpen = effectiveKeepBrowser || preserveBrowserOnError;
    let cleanupProfileLock: ProfileRunLock | null = null;
    let terminatedRecordedChrome = false;
    if (!keepBrowserOpen && manualLogin && tabLease) {
      const cleanupLockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
      if (cleanupLockTimeoutMs > 0) {
        cleanupProfileLock = await acquireProfileRunLock(userDataDir, {
          timeoutMs: cleanupLockTimeoutMs,
          logger,
          sessionId: options.sessionId,
        }).catch(() => null);
      }
      keepBrowserOpen = await hasOtherActiveBrowserTabLeases(userDataDir, tabLease.id).catch(
        () => false,
      );
      if (keepBrowserOpen) {
        logger("[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.");
      } else if (reusedChrome && !connectionClosedUnexpectedly) {
        terminatedRecordedChrome = await terminateRecordedChromeForProfile(
          userDataDir,
          logger,
        ).catch(() => false);
      }
    }
    if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      await handle.release().catch(() => undefined);
    }
    removeDialogHandler?.();
    removeTerminationHooks?.();
    if (!keepBrowserOpen) {
      if (!connectionClosedUnexpectedly) {
        try {
          if (!terminatedRecordedChrome) {
            await chrome.kill();
          }
        } catch {
          // ignore kill failures
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          {
            connectionClosedUnexpectedly,
            host: chromeHost,
          },
        );
        if (shouldCleanup) {
          // Preserve the persistent manual-login profile, but clear stale reattach hints.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (!connectionClosedUnexpectedly) {
        const totalSeconds = (Date.now() - startedAt) / 1000;
        logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
      }
    } else {
      detachKeptChromeProcess(chrome);
      if (!connectionClosedUnexpectedly) {
        logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
      }
    }
    if (cleanupProfileLock) {
      const handle = cleanupProfileLock;
      cleanupProfileLock = null;
      await handle.release().catch(() => undefined);
    }
  }
}

const DEFAULT_DEBUG_PORT = 9222;

async function pickAvailableDebugPort(
  preferredPort: number,
  logger: BrowserLogger,
): Promise<number> {
  const start =
    Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
  for (let offset = 0; offset < 10; offset++) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findEphemeralPort();
  logger(`DevTools ports ${start}-${start + 9} are occupied; falling back to ${fallback}.`);
  return fallback;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to acquire ephemeral port")));
      }
    });
  });
}

async function waitForLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const deadline = Date.now() + Math.min(timeoutMs ?? 1_200_000, 20 * 60_000);
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const loginDetected = message?.toLowerCase().includes("login button");
      const sessionMissing = message?.toLowerCase().includes("session not detected");
      if (!loginDetected && !sessionMissing) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session; please sign in and retry.",
  );
}

async function maybeRecoverLongAssistantResponse({
  runtime,
  baselineTurns,
  answerText,
  answerMarkdown,
  logger,
  allowMarkdownUpdate,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  answerText: string;
  answerMarkdown: string;
  logger: BrowserLogger;
  allowMarkdownUpdate: boolean;
}): Promise<{ answerText: string; answerMarkdown: string }> {
  // Learned: long streaming responses can still be rendering after initial capture.
  // Add a brief delay and re-poll to catch any additional content (#71).
  const capturedLength = answerText.trim().length;
  if (capturedLength <= 500) {
    return { answerText, answerMarkdown };
  }

  await delay(1500);
  let bestLength = capturedLength;
  let bestText = answerText;
  for (let i = 0; i < 5; i++) {
    const laterSnapshot = await readAssistantSnapshot(runtime, baselineTurns ?? undefined).catch(
      () => null,
    );
    const laterText = typeof laterSnapshot?.text === "string" ? laterSnapshot.text.trim() : "";
    if (laterText.length > bestLength) {
      bestLength = laterText.length;
      bestText = laterText;
      await delay(800); // More content appeared, keep waiting
    } else {
      break; // Stable, stop polling
    }
  }
  if (bestLength > capturedLength) {
    logger(`Recovered ${bestLength - capturedLength} additional chars via delayed re-read`);
    return {
      answerText: bestText,
      answerMarkdown: allowMarkdownUpdate ? bestText : answerMarkdown,
    };
  }
  return { answerText, answerMarkdown };
}

async function _assertNavigatedToHttp(
  runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  while (Date.now() < deadline) {
    const { result } = await runtime.evaluate({
      expression: 'typeof location === "object" && location.href ? location.href : ""',
      returnByValue: true,
    });
    const url = typeof result?.value === "string" ? result.value : "";
    lastUrl = url;
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    await delay(250);
  }
  throw new BrowserAutomationError("ChatGPT session not detected; page never left new tab.", {
    stage: "execute-browser",
    details: { url: lastUrl || "(empty)" },
  });
}

type BrowserChrome = LaunchedChrome & { host?: string };

function detachKeptChromeProcess(chrome: Pick<LaunchedChrome, "process">): void {
  try {
    chrome.process?.unref();
  } catch {
    // Best-effort only; cleanup should not mask the original browser result.
  }
}

async function acquireManualLoginChromeForRun(
  userDataDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  sessionId?: string,
  deps: {
    maybeReuse?: typeof maybeReuseRunningChrome;
    launch?: typeof launchChrome;
  } = {},
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  const maybeReuse = deps.maybeReuse ?? maybeReuseRunningChrome;
  const launch = deps.launch ?? launchChrome;
  const lockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
  let launchLock: ProfileRunLock | null = null;

  if (lockTimeoutMs > 0) {
    launchLock = await acquireProfileRunLock(userDataDir, {
      timeoutMs: lockTimeoutMs,
      logger,
      sessionId,
    });
  }

  try {
    const reusedChrome = await maybeReuse(userDataDir, logger, {
      waitForPortMs: config.reuseChromeWaitMs,
    });
    const chrome =
      reusedChrome ??
      (await launch(
        {
          ...config,
          remoteChrome: config.remoteChrome,
        },
        userDataDir,
        logger,
      ));

    // Persist while the launch lock is still held so parallel callers reuse
    // this Chrome instead of racing to start another one on the same profile.
    if (chrome.port) {
      await writeDevToolsActivePort(userDataDir, chrome.port);
      if (!reusedChrome && chrome.pid) {
        await writeChromePid(userDataDir, chrome.pid);
      }
    }

    return { chrome, reusedChrome };
  } finally {
    if (launchLock) {
      await launchLock.release().catch(() => undefined);
    }
  }
}

async function maybeReuseRunningChrome(
  userDataDir: string,
  logger: BrowserLogger,
  options: { waitForPortMs?: number; probe?: typeof verifyDevToolsReachable } = {},
): Promise<LaunchedChrome | null> {
  const waitForPortMs = Math.max(0, options.waitForPortMs ?? 0);
  let port = await readDevToolsPort(userDataDir);
  if (!port && waitForPortMs > 0) {
    const deadline = Date.now() + waitForPortMs;
    logger(`Waiting up to ${formatElapsed(waitForPortMs)} for shared Chrome to appear...`);
    while (!port && Date.now() < deadline) {
      await delay(250);
      port = await readDevToolsPort(userDataDir);
    }
  }
  let pid = await readChromePid(userDataDir);
  if (!port) {
    const discovered = await findRunningChromeDebugTargetForProfile(userDataDir);
    if (!discovered) return null;
    const discoveredProbe = await (options.probe ?? verifyDevToolsReachable)({
      port: discovered.port,
    });
    if (!discoveredProbe.ok) {
      logger(
        `Discovered Chrome for ${userDataDir} on port ${discovered.port} but it was unreachable (${discoveredProbe.error}); launching new Chrome.`,
      );
      return null;
    }
    await writeDevToolsActivePort(userDataDir, discovered.port);
    await writeChromePid(userDataDir, discovered.pid);
    port = discovered.port;
    pid = discovered.pid;
    logger(
      `Discovered running Chrome for ${userDataDir}; reusing (DevTools port ${port}, pid ${pid})`,
    );
    return {
      port,
      pid,
      kill: async () => {},
      process: undefined,
    } as unknown as LaunchedChrome;
  }

  const probe = await (options.probe ?? verifyDevToolsReachable)({ port });
  if (!probe.ok) {
    logger(
      `DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`,
    );
    // Safe cleanup: remove stale DevToolsActivePort; only remove lock files if this was an Oracle-owned pid that died.
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "if_oracle_pid_dead" });
    return null;
  }

  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ""})`,
  );
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error(
      "Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.",
    );
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let tabLease: BrowserTabLease | null = null;
  let lastUrl: string | undefined;
  let attachedExistingTab = false;
  let ownsTarget = true;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    try {
      await runtimeHintCb({
        chromePort: port,
        chromeHost: host,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
        controllerPid: process.pid,
      });
      await tabLease?.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let connectionClosedUnexpectedly = false;
  let runStatus: "attempted" | "complete" = "attempted";
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connection: Awaited<ReturnType<typeof connectToRemoteChrome>> | null = null;
  const browserWSEndpoint = config.remoteChromeBrowserWSEndpoint ?? undefined;
  const chromeProfileRoot = config.remoteChromeProfileRoot ?? undefined;

  try {
    const remoteLeaseProfileDir = config.browserTabRef
      ? null
      : resolveRemoteTabLeaseProfileDir(config);
    if (remoteLeaseProfileDir) {
      await mkdir(remoteLeaseProfileDir, { recursive: true });
      tabLease = await acquireBrowserTabLease(remoteLeaseProfileDir, {
        maxConcurrentTabs: config.maxConcurrentTabs,
        timeoutMs: config.timeoutMs,
        logger,
        sessionId: options.sessionId,
        chromeHost: host,
        chromePort: port,
      });
    }
    if (config.browserTabRef) {
      const attached = await connectToExistingChatGptTab({
        host,
        port,
        ref: config.browserTabRef,
      });
      client = attached.client;
      remoteTargetId = attached.targetId ?? null;
      lastUrl = attached.tab.url || lastUrl;
      attachedExistingTab = true;
      ownsTarget = false;
      logger(
        `Attached to existing remote ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
      );
    } else {
      connection = await connectToRemoteChrome(host, port, logger, config.url, browserWSEndpoint, {
        approvalWaitMs: config.attachRunning && browserWSEndpoint ? 20_000 : undefined,
      });
      client = connection.client;
      remoteTargetId = connection.targetId ?? null;
      ownsTarget = true;
    }
    if (tabLease && remoteTargetId) {
      await tabLease.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId,
      });
    }
    await emitRuntimeHint();
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on("disconnect", markConnectionLost);
    const { Network, Page, Runtime, Input, DOM } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);

    // Skip cookie sync for remote Chrome - it already has cookies
    logger("Skipping cookie sync for remote Chrome (using existing session)");

    if (!attachedExistingTab) {
      await navigateToChatGPT(Page, Runtime, config.url, logger);
      await ensureNotBlocked(Runtime, config.headless, logger);
      await ensureLoggedIn(Runtime, logger, { remoteSession: true });
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    } else {
      await ensureNotBlocked(Runtime, config.headless, logger);
      await ensureLoggedIn(Runtime, logger, { remoteSession: true });
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    try {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      if (typeof result?.value === "string") {
        lastUrl = result.value;
      }
      await emitRuntimeHint();
    } catch {
      // ignore
    }

    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== "ignore") {
      await withRetries(
        () => ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
        {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      );
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore") {
      logger("Model picker: skipped (strategy=ignore)");
    }
    const deepResearch = config.researchMode === "deep";
    // Handle thinking time selection if specified. Deep Research owns its own effort flow.
    const thinkingTime = config.thinkingTime;
    if (thinkingTime && !deepResearch) {
      if (shouldSkipThinkingTimeSelection(config.desiredModel, thinkingTime)) {
        logger("Thinking time: Pro Extended (via model selection)");
      } else {
        await withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        });
      }
    }
    if (deepResearch) {
      await withRetries(() => activateDeepResearch(Runtime, Input, logger), {
        retries: 2,
        delayMs: 500,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      });
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      logger(
        `Prompt textarea ready (after Deep Research activation, ${promptText.length.toLocaleString()} chars queued)`,
      );
    }

    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      await clearPromptComposer(Runtime, logger);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error("Chrome DOM domain unavailable while uploading attachments.");
        }
        await clearComposerAttachments(Runtime, 5_000, logger);
        // Use remote file transfer for remote Chrome (reads local files and injects via CDP)
        for (const attachment of submissionAttachments) {
          logger(`Uploading attachment: ${attachment.displayPath}`);
          await uploadAttachmentViaDataTransfer({ runtime: Runtime, dom: DOM }, attachment, logger);
          await delay(500);
        }
        // Scale timeout based on number of files: base 30s + 15s per additional file
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 15_000;
        const waitBudget =
          Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
        await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
        logger("All attachments uploaded");
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames,
      };
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      return { baselineTurns, baselineAssistantText };
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await Page.reload({ ignoreCache: true });
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    const submission = await runSubmissionWithRecovery({
      prompt: promptText,
      attachments,
      fallbackSubmission: options.fallbackSubmission,
      submit: submitOnce,
      reloadPromptComposer,
      prepareFallbackSubmission: async () => {
        await clearPromptComposer(Runtime, logger);
        await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      },
      logger,
    });
    baselineTurns = submission.baselineTurns;
    baselineAssistantText = submission.baselineAssistantText;
    const imageArtifactMinTurnIndex = baselineTurns;
    if (deepResearch) {
      await waitForResearchPlanAutoConfirm(Runtime, logger);
      const researchResult = await waitForDeepResearchCompletion(
        Runtime,
        logger,
        config.timeoutMs,
        baselineTurns,
        Page,
        client,
      );
      await emitRuntimeHint();
      const durationMs = Date.now() - startedAt;
      const tokens = estimateTokenCount(researchResult.text);
      const reportArtifact = await saveOptionalArtifact(
        () =>
          saveDeepResearchReportArtifact({
            sessionId: options.sessionId,
            reportMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            logger,
          }),
        logger,
      );
      const transcriptArtifact = await saveOptionalArtifact(
        () =>
          saveBrowserTranscriptArtifact({
            sessionId: options.sessionId,
            prompt: promptText,
            answerMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            artifacts: appendArtifacts(undefined, [reportArtifact]),
            logger,
          }),
        logger,
      );
      const savedArtifacts = appendArtifacts(undefined, [reportArtifact, transcriptArtifact]);
      const archive = await maybeArchiveCompletedConversation({
        Runtime,
        logger,
        config,
        conversationUrl: lastUrl,
        followUpCount: 0,
        requiredArtifactsSaved: Boolean(reportArtifact && transcriptArtifact),
      });
      runStatus = "complete";
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        answerHtml: researchResult.html,
        artifacts: savedArtifacts,
        archive,
        tookMs: durationMs,
        answerTokens: tokens,
        answerChars: researchResult.text.length,
        chromePort: port,
        chromeHost: host,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
        controllerPid: process.pid,
      };
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const expectedConversationId = () =>
      lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId(),
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async () => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await delay(recheckDelayMs);
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        lastUrl = conversationUrl;
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await Page.navigate({ url: conversationUrl });
        await delay(1000);
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromeHost: host,
              chromePort: port,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            },
          },
        );
      }
      await emitRuntimeHint();
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        waitForAssistantOrGeneratedImageResponse({
          Runtime,
          waitForText: () =>
            waitForAssistantResponseWithReload(
              Runtime,
              Page,
              timeoutMs,
              logger,
              baselineTurns ?? undefined,
              expectedConversationId(),
            ),
          timeoutMs,
          logger,
          minTurnIndex: baselineTurns ?? undefined,
          expectedConversationId: expectedConversationId(),
          imageOutputRequested,
        }),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const imageOutputRequested = Boolean(
      options.generateImagePath ||
      options.outputPath ||
      (options as { generateImage?: string }).generateImage,
    );
    const captureAssistantTurn = async (
      turnPrompt: string,
      label: string,
    ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
      let turnAnswer: AssistantAnswer;
      try {
        const conversationUrl = await readConversationUrl(Runtime).catch(() => null);
        if (conversationUrl && isConversationUrl(conversationUrl)) {
          lastUrl = conversationUrl;
          await emitRuntimeHint();
        }
        turnAnswer = await waitWithThinkingMonitor(() =>
          waitForAssistantOrGeneratedImageResponse({
            Runtime,
            waitForText: () =>
              waitForAssistantResponseWithReload(
                Runtime,
                Page,
                config.timeoutMs,
                logger,
                baselineTurns ?? undefined,
                expectedConversationId(),
              ),
            timeoutMs: config.timeoutMs,
            logger,
            minTurnIndex: baselineTurns ?? undefined,
            expectedConversationId: expectedConversationId(),
            imageOutputRequested,
          }),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheckOrRethrow(attemptAssistantRecheck);
          if (rechecked) {
            turnAnswer = rechecked;
          } else {
            try {
              const conversationUrl = await readConversationUrl(Runtime);
              if (conversationUrl) {
                lastUrl = conversationUrl;
              }
            } catch {
              // ignore
            }
            await emitRuntimeHint();
            const diagnostics = await captureBrowserDiagnostics(
              Runtime,
              logger,
              "assistant-timeout",
              {
                Page,
                sessionId: options.sessionId,
              },
            ).catch(() => undefined);
            const runtime = {
              chromePort: port,
              chromeHost: host,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              controllerPid: process.pid,
            };
            throw new BrowserAutomationError(
              "Assistant response timed out before completion; reattach later to capture the answer.",
              { stage: "assistant-timeout", runtime, diagnostics },
              error,
            );
          }
        } else {
          throw error;
        }
      }
      const baselineNormalized = baselineAssistantText
        ? normalizeForComparison(baselineAssistantText)
        : "";
      if (baselineNormalized) {
        const normalizedAnswer = normalizeForComparison(turnAnswer.text ?? "");
        const baselinePrefix =
          baselineNormalized.length >= 80
            ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
            : "";
        const isBaseline =
          normalizedAnswer === baselineNormalized ||
          (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
        if (isBaseline) {
          logger("Detected stale assistant response; waiting for new response...");
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            turnAnswer = refreshed;
          }
        }
      }
      let turnAnswerText = turnAnswer.text;
      const turnAnswerHtml = turnAnswer.html ?? "";

      const copiedMarkdown = await withRetries(
        async () => {
          const attempt = await captureAssistantMarkdown(Runtime, turnAnswer.meta, logger);
          if (!attempt) {
            throw new Error("copy-missing");
          }
          return attempt;
        },
        {
          retries: 2,
          delayMs: 350,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      ).catch(() => null);

      let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;
      ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
        await maybeRecoverLongAssistantResponse({
          runtime: Runtime,
          baselineTurns,
          answerText: turnAnswerText,
          answerMarkdown: turnAnswerMarkdown,
          logger,
          allowMarkdownUpdate: !copiedMarkdown,
        }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readAssistantSnapshot(
        Runtime,
        baselineTurns ?? undefined,
        expectedConversationId(),
      ).catch(() => null);
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (
        finalText &&
        finalText !== turnAnswerMarkdown.trim() &&
        finalText !== turnPrompt.trim() &&
        finalText.length >= turnAnswerMarkdown.trim().length
      ) {
        logger("Refreshed assistant response via final DOM snapshot");
        turnAnswerText = finalText;
        turnAnswerMarkdown = finalText;
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);
      const alignedEcho = alignPromptEchoPair(
        turnAnswerText,
        turnAnswerMarkdown,
        promptEchoMatcher,
        copiedMarkdown ? logger : undefined,
        {
          text: "Aligned assistant response text to copied markdown after prompt echo",
          markdown: "Aligned assistant markdown to response text after prompt echo",
        },
      );
      turnAnswerText = alignedEcho.answerText;
      turnAnswerMarkdown = alignedEcho.answerMarkdown;
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
          if (!isStillEcho) {
            if (!bestText || text.length > bestText.length) {
              bestText = text;
              stableCount = 0;
            } else if (text === bestText) {
              stableCount += 1;
            }
            if (stableCount >= 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          logger("Recovered assistant response after detecting prompt echo");
          turnAnswerText = bestText;
          turnAnswerMarkdown = bestText;
        }
      }
      return {
        label,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        answerHtml: turnAnswerHtml,
      };
    };

    const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);
    const turns: BrowserConversationTurn[] = [];
    const initialTurn = await captureAssistantTurn(promptText, "Initial response");
    turns.push(initialTurn);
    answerText = initialTurn.answerText;
    answerMarkdown = initialTurn.answerMarkdown;
    answerHtml = initialTurn.answerHtml;

    for (let index = 0; index < followUpPrompts.length; index += 1) {
      const followUpPrompt = followUpPrompts[index];
      logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
      await clearPromptComposer(Runtime, logger);
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      const submission = await runSubmissionWithRecovery({
        prompt: followUpPrompt,
        attachments: [],
        submit: submitOnce,
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await clearPromptComposer(Runtime, logger);
          await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        },
        logger,
      });
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
      const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
      turns.push({ ...turn, prompt: followUpPrompt });
      answerText = turn.answerText;
      answerMarkdown = turn.answerMarkdown;
      answerHtml = turn.answerHtml;
    }

    if (turns.length > 1) {
      const formatted = formatBrowserTurnTranscript(turns);
      answerText = formatted.answerText;
      answerMarkdown = formatted.answerMarkdown;
      answerHtml = "";
    }
    const imageArtifacts = await collectGeneratedImageArtifacts({
      Runtime,
      Network,
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      generateImagePath: options.generateImagePath,
      outputPath: options.outputPath,
      answerText,
      waitTimeoutMs: options.config?.timeoutMs,
    });
    answerText = imageArtifacts.answerText || answerText;
    if (imageArtifacts.markdownSuffix) {
      answerMarkdown += imageArtifacts.markdownSuffix;
    }
    const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: promptText,
          answerMarkdown,
          conversationUrl: lastUrl,
          artifacts: savedImageArtifacts,
          logger,
        }),
      logger,
    );
    const savedArtifacts = appendArtifacts(savedImageArtifacts, [transcriptArtifact]);
    const archive = await maybeArchiveCompletedConversation({
      Runtime,
      logger,
      config,
      conversationUrl: lastUrl,
      followUpCount: followUpPrompts.length,
      requiredArtifactsSaved:
        Boolean(transcriptArtifact) &&
        imageArtifacts.savedImages.length === imageArtifacts.imageCount,
    });
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);

    runStatus = "complete";
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      browserTransport: "cdp",
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      chromeBrowserWSEndpoint: browserWSEndpoint,
      chromeProfileRoot,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      artifacts: savedArtifacts,
      archive,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;

    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }

    throw new BrowserAutomationError("Remote Chrome connection lost before Oracle finished.", {
      stage: "connection-lost",
      runtime: {
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      },
    });
  } finally {
    try {
      await closeRemoteConnectionAfterRun({
        connectionClosedUnexpectedly,
        connection,
        client,
        runStatus,
      });
    } catch {
      // ignore
    }
    removeDialogHandler?.();
    if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      await handle.release().catch(() => undefined);
    }
    if (ownsTarget) {
      await closeRemoteChromeTarget(host, port, remoteTargetId ?? undefined, logger);
    }
    // Don't kill remote Chrome - it's not ours to manage
    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

export { estimateTokenCount } from "./utils.js";
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from "./config.js";

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  closeRemoteConnectionAfterRun,
  detachKeptChromeProcess,
  isImageOnlyUiChromeText,
  listIgnoredRemoteChromeFlags,
};
export { syncCookies } from "./cookies.js";
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from "./pageActions.js";

export async function maybeReuseRunningChromeForTest(
  userDataDir: string,
  logger: BrowserLogger,
  options: { waitForPortMs?: number; probe?: typeof verifyDevToolsReachable } = {},
): Promise<LaunchedChrome | null> {
  return maybeReuseRunningChrome(userDataDir, logger, options);
}

export async function acquireManualLoginChromeForRunForTest(
  userDataDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  sessionId: string | undefined,
  deps: {
    maybeReuse?: typeof maybeReuseRunningChrome;
    launch?: typeof launchChrome;
  },
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  return acquireManualLoginChromeForRun(userDataDir, config, logger, sessionId, deps);
}

export function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("websocket connection closed") ||
    message.includes("websocket is closed") ||
    message.includes("websocket error") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("target closed")
  );
}

async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
) {
  try {
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
    );
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    const conversationUrl = await readConversationUrl(Runtime);
    if (!conversationUrl || !isConversationUrl(conversationUrl)) {
      throw error;
    }
    logger("Assistant response stalled; reloading conversation and retrying once");
    await Page.navigate({ url: conversationUrl });
    await delay(1000);
    return await waitForAssistantResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
    );
  }
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("assistant-response") ||
    message.includes("watchdog") ||
    message.includes("timeout") ||
    message.includes("capture assistant response")
  );
}

function isAssistantResponseTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (!message) return false;
  return (
    message.includes("assistant-response") ||
    message.includes("assistant response") ||
    message.includes("watchdog") ||
    message.includes("capture assistant response")
  );
}

async function readConversationUrl(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  try {
    const currentUrl = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return typeof currentUrl.result?.value === "string" ? currentUrl.result.value : null;
  } catch {
    return null;
  }
}

interface SessionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that the ChatGPT session is still active by checking for login CTAs
 * and textarea availability. Sessions can expire during long delays (e.g., recheck).
 *
 * @param Runtime - Chrome Runtime client
 * @param logger - Browser logger for diagnostics
 * @returns SessionValidationResult indicating if session is valid and reason if not
 */
async function validateChatGPTSession(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<SessionValidationResult> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildSessionValidationExpression(),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as
      | {
          valid: boolean;
          hasLoginCta: boolean;
          hasTextarea: boolean;
          onAuthPage: boolean;
          pageUrl: string | null;
        }
      | undefined;

    if (!result) {
      return { valid: false, reason: "Failed to evaluate session state" };
    }

    if (result.onAuthPage) {
      return { valid: false, reason: "Redirected to auth page" };
    }

    if (result.hasLoginCta) {
      return { valid: false, reason: "Login button detected on page" };
    }

    if (!result.hasTextarea) {
      return { valid: false, reason: "Prompt textarea not available" };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Session validation error: ${message}`);
    return { valid: false, reason: `Validation error: ${message}` };
  }
}

function buildSessionValidationExpression(): string {
  const selectorLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(async () => {
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    // Check for login CTAs (similar to ensureLoggedIn logic)
    const hasLoginCta = (() => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    })();

    // Check for textarea availability
    const hasTextarea = (() => {
      const selectors = ${selectorLiteral};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) {
          return true;
        }
      }
      return false;
    })();

    return {
      valid: !onAuthPage && !hasLoginCta && hasTextarea,
      hasLoginCta,
      hasTextarea,
      onAuthPage,
      pageUrl,
    };
  })()`;
}

async function readConversationTurnCount(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const selectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { result } = await Runtime.evaluate({
        expression: `document.querySelectorAll(${selectorLiteral}).length`,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (!Number.isFinite(raw)) {
        throw new Error("Turn count not numeric");
      }
      return Math.max(0, Math.floor(raw));
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(150);
        continue;
      }
      if (logger?.verbose) {
        logger(
          `Failed to read conversation turn count: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
  return null;
}

function isConversationUrl(url: string): boolean {
  return /\/c\/[a-z0-9-]+/i.test(url);
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run the same oracle command after adding the rule.",
  ].join("\n");
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

function extractConversationIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      "/mnt/c/Users/Public/AppData/Local/Temp",
      "/mnt/c/Temp",
      "/mnt/c/Windows/Temp",
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  const tmpDir = os.tmpdir();
  if (shouldPreferSystemTmpDir(process.platform, tmpDir, os.homedir())) {
    try {
      await mkdir("/tmp", { recursive: true });
      return "/tmp";
    } catch {
      // Fall back to the inherited tmpdir if /tmp is unavailable.
    }
  }
  return tmpDir;
}

function shouldPreferSystemTmpDir(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  if (platform !== "linux" || !tmpDir || !homeDir) return false;
  const relativeToHome = path.relative(homeDir, tmpDir);
  if (!relativeToHome || relativeToHome.startsWith("..") || path.isAbsolute(relativeToHome)) {
    return false;
  }
  const firstSegment = relativeToHome.split(path.sep, 1)[0];
  return Boolean(firstSegment?.startsWith("."));
}

export function shouldPreferSystemTmpDirForTest(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  return shouldPreferSystemTmpDir(platform, tmpDir, homeDir);
}
