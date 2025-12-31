/**
 * Gemini Browser Automation - Main Entry Point
 *
 * Provides browser automation for Google Gemini Deep Think
 * similar to the ChatGPT browser mode.
 */

import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { ChromeClient } from '../browser/types.js';
import type {
  GeminiBrowserConfig,
  GeminiBrowserRunOptions,
  GeminiBrowserRunResult,
  GeminiDeepResearchRunResult,
  BrowserLogger,
} from './types.js';
import {
  GEMINI_APP_URL,
  GEMINI_COOKIE_URLS,
  GEMINI_TIMEOUTS,
  DEFAULT_GEMINI_MODEL,
} from './constants.js';
import type { GeminiDeepThinkModel } from './constants.js';

// Re-use Chrome lifecycle from browser module
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectToChrome,
  connectToRemoteChrome,
} from '../browser/chromeLifecycle.js';
import { syncCookies } from '../browser/cookies.js';
import { delay, estimateTokenCount } from '../browser/utils.js';

// Gemini-specific actions
import {
  navigateToGemini,
  handleGeminiConsent,
  ensureGeminiLoggedIn,
  ensureGeminiPromptReady,
} from './actions/navigation.js';
import { ensureGeminiModelSelection } from './actions/modelSelection.js';
import { submitGeminiPrompt } from './actions/promptComposer.js';
import {
  waitForGeminiResponse,
  readGeminiResponse,
  captureGeminiMarkdown,
} from './actions/assistantResponse.js';
import { isDeepResearchRequested } from './actions/toolsSelection.js';
import { runDeepResearchFlow } from './actions/deepResearch.js';

export type { GeminiBrowserConfig, GeminiBrowserRunOptions, GeminiBrowserRunResult, GeminiDeepResearchRunResult };
export { GEMINI_APP_URL, DEFAULT_GEMINI_MODEL };

const DEFAULT_DEBUG_PORT = 9223; // Different from ChatGPT to allow both to run

/**
 * Run Gemini in browser automation mode
 */
export async function runGeminiBrowserMode(
  options: GeminiBrowserRunOptions,
): Promise<GeminiBrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error('Prompt text is required for Gemini browser mode.');
  }

  const config = resolveGeminiConfig(options.config);
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }

  if (config.debug) {
    logger(`[gemini-browser] config: ${JSON.stringify({ ...config, promptLength: promptText.length })}`);
  }

  // Remote Chrome mode
  if (config.remoteChrome) {
    return runRemoteGeminiBrowserMode(promptText, config, logger, options);
  }

  // Local Chrome mode
  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : path.join(os.homedir(), '.oracle', 'gemini-browser-profile');

  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(os.tmpdir(), 'oracle-gemini-'));

  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode; using persistent profile at ${userDataDir}`);
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  // Build a compatible config for launchChrome (which expects ChatGPT config shape)
  const chromeConfig = {
    chromeProfile: config.chromeProfile ?? null,
    chromePath: config.chromePath ?? null,
    chromeCookiePath: config.chromeCookiePath ?? null,
    url: config.url ?? GEMINI_APP_URL,
    chatgptUrl: null, // Not used for Gemini, but required by type
    timeoutMs: config.timeoutMs ?? GEMINI_TIMEOUTS.response,
    debugPort: config.debugPort ?? DEFAULT_DEBUG_PORT,
    inputTimeoutMs: config.inputTimeoutMs ?? GEMINI_TIMEOUTS.promptReady,
    cookieSync: config.cookieSync ?? true,
    cookieNames: config.cookieNames ?? null,
    inlineCookies: config.inlineCookies ?? null,
    inlineCookiesSource: config.inlineCookiesSource ?? null,
    headless: config.headless ?? false,
    keepBrowser: config.keepBrowser ?? false,
    hideWindow: config.hideWindow ?? false,
    desiredModel: config.desiredModel ?? null,
    modelStrategy: 'select' as const,
    debug: config.debug ?? false,
    allowCookieErrors: config.allowCookieErrors ?? false,
    remoteChrome: null,
    manualLogin: config.manualLogin ?? false,
    manualLoginProfileDir: config.manualLoginProfileDir ?? null,
    manualLoginCookieSync: config.manualLoginCookieSync ?? false,
    thinkingTime: undefined,
  };

  const chrome = await launchChrome(
    chromeConfig,
    userDataDir,
    logger,
  );

  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  let removeTerminationHooks: (() => void) | null = null;
  let runStatus: 'attempted' | 'complete' = 'attempted';

  try {
    removeTerminationHooks = registerTerminationHooks(chrome, userDataDir, effectiveKeepBrowser, logger, {
      isInFlight: () => runStatus !== 'complete',
      preserveUserDataDir: manualLogin,
    });
  } catch {
    // ignore
  }

  let client: Awaited<ReturnType<typeof connectToChrome>> | null = null;
  const startedAt = Date.now();
  let answerText = '';
  let answerMarkdown = '';
  let answerHtml = '';
  let thinkingText = '';
  let modelUsed = '';
  let connectionClosedUnexpectedly = false;
  let appliedCookies = 0;

  try {
    client = await connectToChrome(chrome.port, logger);
    const { Network, Page, Runtime, Input, DOM } = client;

    // Track disconnection
    client.on('disconnect', () => {
      connectionClosedUnexpectedly = true;
      logger('Chrome window closed unexpectedly');
    });

    // Enable required domains
    await Promise.all([
      Network.enable({}),
      Page.enable(),
      Runtime.enable(),
      DOM?.enable?.(),
    ].filter(Boolean));

    // Hide window if requested
    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    // Clear cookies if not manual login
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    // Sync cookies from Chrome profile
    if (config.cookieSync && (!manualLogin || config.manualLoginCookieSync)) {
      const cookieCount = await syncCookies(
        Network,
        GEMINI_COOKIE_URLS[0],
        config.chromeProfile,
        logger,
        {
          allowErrors: config.allowCookieErrors ?? false,
          filterNames: config.cookieNames ?? undefined,
          inlineCookies: config.inlineCookies ?? undefined,
          cookiePath: config.chromeCookiePath ?? undefined,
          // Override URL for Google cookies
        },
      );
      appliedCookies = cookieCount;
      logger(cookieCount > 0
        ? `Applied ${cookieCount} Google cookies from Chrome profile`
        : 'No Google cookies found; continuing'
      );
    }

    // Navigate to Gemini
    await navigateToGemini(Page, Runtime, config.url ?? GEMINI_APP_URL, logger);

    // Handle consent screen if present
    await handleGeminiConsent(Runtime, logger);
    await delay(500);

    // Ensure logged in
    await ensureGeminiLoggedIn(Runtime, logger, {
      appliedCookies,
      manualLogin,
    });

    // Wait for prompt input
    await ensureGeminiPromptReady(Runtime, config.inputTimeoutMs ?? GEMINI_TIMEOUTS.promptReady, logger);
    logger(`Prompt input ready (${promptText.length} chars queued)`);

    // Select model if specified
    const desiredModel = (config.desiredModel ?? DEFAULT_GEMINI_MODEL) as GeminiDeepThinkModel;
    const modelResult = await ensureGeminiModelSelection(Runtime, desiredModel, logger);
    modelUsed = modelResult.modelSelected;

    // Check if this is a Deep Research request
    const isDeepResearch = isDeepResearchRequested(desiredModel);

    // Submit prompt
    await submitGeminiPrompt({ runtime: Runtime, input: Input }, promptText, logger);

    if (isDeepResearch) {
      // Deep Research flow: wait for plan, start research, wait for completion
      logger('Running Deep Research flow...');
      const researchTimeout = config.timeoutMs ?? GEMINI_TIMEOUTS.deepResearchResponse;
      const researchResult = await runDeepResearchFlow(Runtime, researchTimeout, logger);

      answerText = researchResult.text;
      answerHtml = researchResult.html ?? '';
      answerMarkdown = researchResult.markdown ?? researchResult.text;

      runStatus = 'complete';

      const durationMs = Date.now() - startedAt;
      return {
        answerText,
        answerMarkdown,
        answerHtml: answerHtml || undefined,
        modelUsed,
        deepThinkActive: false,
        tookMs: durationMs,
        answerTokens: estimateTokenCount(answerMarkdown),
        answerChars: answerText.length,
        chromePid: chrome.pid,
        chromePort: chrome.port,
        userDataDir,
        controllerPid: process.pid,
        // Deep Research specific fields
        deepResearchResult: researchResult,
        isDeepResearch: true,
      } as GeminiDeepResearchRunResult;
    }

    // Regular flow (Deep Think, regular chat, etc.)
    // Take baseline snapshot
    const baselineSnapshot = await readGeminiResponse(Runtime);

    // Wait for response
    const response = await waitForGeminiResponse(
      Runtime,
      config.timeoutMs ?? GEMINI_TIMEOUTS.response,
      logger,
      baselineSnapshot,
    );

    answerText = response.text;
    answerHtml = response.html ?? '';
    thinkingText = response.thinking ?? '';

    // Try to get markdown version
    const markdown = await captureGeminiMarkdown(Runtime, logger);
    answerMarkdown = markdown ?? answerText;

    // Build final output
    if (config.showThinking && thinkingText) {
      answerMarkdown = `## Thinking\n\n${thinkingText}\n\n## Response\n\n${answerMarkdown}`;
    }

    runStatus = 'complete';

    const durationMs = Date.now() - startedAt;
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml || undefined,
      thinkingText: thinkingText || undefined,
      modelUsed,
      deepThinkActive: modelUsed.includes('deep') || modelUsed.includes('think'),
      tookMs: durationMs,
      answerTokens: estimateTokenCount(answerMarkdown),
      answerChars: answerText.length,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      userDataDir,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    logger(`Gemini browser run failed: ${normalizedError.message}`);

    if (config.debug && normalizedError.stack) {
      logger(normalizedError.stack);
    }

    throw normalizedError;
  } finally {
    try {
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch {
      // ignore
    }

    removeTerminationHooks?.();

    if (!effectiveKeepBrowser) {
      if (!connectionClosedUnexpectedly) {
        try {
          await chrome.kill();
        } catch {
          // ignore
        }
      }

      if (!manualLogin) {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }

      if (!connectionClosedUnexpectedly) {
        const totalSeconds = (Date.now() - startedAt) / 1000;
        logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
      }
    } else {
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
  }
}

/**
 * Run Gemini with remote Chrome connection
 */
async function runRemoteGeminiBrowserMode(
  promptText: string,
  config: ReturnType<typeof resolveGeminiConfig>,
  logger: BrowserLogger,
  _options: GeminiBrowserRunOptions,
): Promise<GeminiBrowserRunResult> {
  if (!config.remoteChrome) {
    throw new Error('Remote Chrome config is required');
  }
  const { host, port } = config.remoteChrome;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  const startedAt = Date.now();
  let answerText = '';
  let answerMarkdown = '';
  let answerHtml = '';
  let thinkingText = '';
  let modelUsed = '';
  let connectionClosedUnexpectedly = false;

  try {
    const connection = await connectToRemoteChrome(host, port, logger, config.url ?? GEMINI_APP_URL);
    client = connection.client;

    client.on('disconnect', () => {
      connectionClosedUnexpectedly = true;
    });

    const { Network, Page, Runtime, Input, DOM } = client;

    await Promise.all([
      Network.enable({}),
      Page.enable(),
      Runtime.enable(),
      DOM?.enable?.(),
    ].filter(Boolean));

    // Navigate and verify login
    await navigateToGemini(Page, Runtime, config.url ?? GEMINI_APP_URL, logger);
    await handleGeminiConsent(Runtime, logger);
    await ensureGeminiLoggedIn(Runtime, logger, { remoteSession: true });
    await ensureGeminiPromptReady(Runtime, config.inputTimeoutMs ?? GEMINI_TIMEOUTS.promptReady, logger);

    // Select model
    const desiredModel = (config.desiredModel ?? DEFAULT_GEMINI_MODEL) as GeminiDeepThinkModel;
    const modelResult = await ensureGeminiModelSelection(Runtime, desiredModel, logger);
    modelUsed = modelResult.modelSelected;

    // Check if this is a Deep Research request
    const isDeepResearch = isDeepResearchRequested(desiredModel);

    // Submit prompt
    await submitGeminiPrompt({ runtime: Runtime, input: Input }, promptText, logger);

    if (isDeepResearch) {
      // Deep Research flow
      logger('Running Deep Research flow...');
      const researchTimeout = config.timeoutMs ?? GEMINI_TIMEOUTS.deepResearchResponse;
      const researchResult = await runDeepResearchFlow(Runtime, researchTimeout, logger);

      answerText = researchResult.text;
      answerHtml = researchResult.html ?? '';
      answerMarkdown = researchResult.markdown ?? researchResult.text;

      const durationMs = Date.now() - startedAt;
      return {
        answerText,
        answerMarkdown,
        answerHtml: answerHtml || undefined,
        modelUsed,
        deepThinkActive: false,
        tookMs: durationMs,
        answerTokens: estimateTokenCount(answerMarkdown),
        answerChars: answerText.length,
        chromePort: port,
        chromeHost: host,
        controllerPid: process.pid,
        deepResearchResult: researchResult,
        isDeepResearch: true,
      } as GeminiDeepResearchRunResult;
    }

    // Regular flow
    const baselineSnapshot = await readGeminiResponse(Runtime);

    const response = await waitForGeminiResponse(
      Runtime,
      config.timeoutMs ?? GEMINI_TIMEOUTS.response,
      logger,
      baselineSnapshot,
    );

    answerText = response.text;
    answerHtml = response.html ?? '';
    thinkingText = response.thinking ?? '';

    const markdown = await captureGeminiMarkdown(Runtime, logger);
    answerMarkdown = markdown ?? answerText;

    if (config.showThinking && thinkingText) {
      answerMarkdown = `## Thinking\n\n${thinkingText}\n\n## Response\n\n${answerMarkdown}`;
    }

    const durationMs = Date.now() - startedAt;
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml || undefined,
      thinkingText: thinkingText || undefined,
      modelUsed,
      deepThinkActive: modelUsed.includes('deep') || modelUsed.includes('think'),
      tookMs: durationMs,
      answerTokens: estimateTokenCount(answerMarkdown),
      answerChars: answerText.length,
      chromePort: port,
      chromeHost: host,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    logger(`Remote Gemini browser run failed: ${normalizedError.message}`);
    throw normalizedError;
  } finally {
    try {
      if (!connectionClosedUnexpectedly && client) {
        await client.close();
      }
    } catch {
      // ignore
    }

    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

/**
 * Resolve and apply defaults to Gemini config
 */
function resolveGeminiConfig(config?: GeminiBrowserConfig): Required<Omit<GeminiBrowserConfig,
  'chromeProfile' | 'chromePath' | 'chromeCookiePath' | 'desiredModel' | 'remoteChrome' | 'thinkingLevel'
>> & GeminiBrowserConfig {
  return {
    chromeProfile: config?.chromeProfile ?? null,
    chromePath: config?.chromePath ?? null,
    chromeCookiePath: config?.chromeCookiePath ?? null,
    url: config?.url ?? GEMINI_APP_URL,
    timeoutMs: config?.timeoutMs ?? GEMINI_TIMEOUTS.response,
    debugPort: config?.debugPort ?? null,
    inputTimeoutMs: config?.inputTimeoutMs ?? GEMINI_TIMEOUTS.promptReady,
    cookieSync: config?.cookieSync ?? true,
    cookieNames: config?.cookieNames ?? null,
    inlineCookies: config?.inlineCookies ?? null,
    inlineCookiesSource: config?.inlineCookiesSource ?? null,
    headless: config?.headless ?? false,
    keepBrowser: config?.keepBrowser ?? false,
    hideWindow: config?.hideWindow ?? false,
    desiredModel: config?.desiredModel ?? null,
    debug: config?.debug ?? false,
    allowCookieErrors: config?.allowCookieErrors ?? false,
    remoteChrome: config?.remoteChrome ?? null,
    manualLogin: config?.manualLogin ?? false,
    manualLoginProfileDir: config?.manualLoginProfileDir ?? null,
    manualLoginCookieSync: config?.manualLoginCookieSync ?? false,
    thinkingLevel: config?.thinkingLevel,
    showThinking: config?.showThinking ?? false,
  };
}
