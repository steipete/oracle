import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { resolveBrowserConfig } from './config.js';
import type { BrowserRunOptions, BrowserRunResult, BrowserLogger, ChromeClient, BrowserAttachment } from './types.js';
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectToChrome,
  connectToRemoteChrome,
  closeRemoteChromeTarget,
} from './chromeLifecycle.js';
import { syncCookies } from './cookies.js';
import {
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  clearPromptComposer,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  readAssistantSnapshot,
} from './pageActions.js';
import { uploadAttachmentViaDataTransfer } from './actions/remoteFileTransfer.js';
import { ensureThinkingTime } from './actions/thinkingTime.js';
import { estimateTokenCount, withRetries, delay } from './utils.js';
import { formatElapsed } from '../oracle/format.js';
import { CHATGPT_URL, CONVERSATION_TURN_SELECTOR, DEFAULT_MODEL_STRATEGY } from './constants.js';
import type { LaunchedChrome } from 'chrome-launcher';
import { BrowserAutomationError } from '../oracle/errors.js';
import { alignPromptEchoPair, buildPromptEchoMatcher } from './reattachHelpers.js';
import {
  cleanupStaleProfileState,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from './profileState.js';

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from './types.js';
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from './constants.js';
export { parseDuration, delay, normalizeChatgptUrl, isTemporaryChatUrl } from './utils.js';

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error('Prompt text is required when using browser mode.');
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];
  const fallbackSubmission = options.fallbackSubmission;

  let config = resolveBrowserConfig(options.config);
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
  const emitRuntimeHint = async (): Promise<void> => {
    if (!runtimeHintCb || !chrome?.port) {
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
      await runtimeHintCb(hint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...config,
        promptLength: promptText.length,
      })}`,
    );
  }

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await pickAvailableDebugPort(preferredPort, logger);
    if (availablePort !== preferredPort) {
      logger(`DevTools port ${preferredPort} busy; using ${availablePort} to avoid attaching to stray Chrome.`);
    }
    config = { ...config, debugPort: availablePort };
  }

  // Remote Chrome mode - connect to existing browser
  if (config.remoteChrome) {
    // Warn about ignored local-only options
    if (config.headless || config.hideWindow || config.keepBrowser || config.chromePath) {
      logger(
        'Note: --remote-chrome ignores local Chrome flags ' +
        '(--browser-headless, --browser-hide-window, --browser-keep-browser, --browser-chrome-path).'
      );
    }

    return runRemoteBrowserMode(promptText, attachments, config, logger, options);
  }

  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : path.join(os.homedir(), '.oracle', 'browser-profile');
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), 'oracle-browser-'));
  if (manualLogin) {
    // Learned: manual login reuses a persistent profile so cookies/SSO survive.
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  const reusedChrome = manualLogin ? await maybeReuseRunningChrome(userDataDir, logger) : null;
  const chrome =
    reusedChrome ??
    (await launchChrome(
      {
        ...config,
        remoteChrome: config.remoteChrome,
      },
      userDataDir,
      logger,
    ));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? '127.0.0.1';
  // Persist profile state so future manual-login runs can reuse this Chrome.
  if (manualLogin && chrome.port) {
    await writeDevToolsActivePort(userDataDir, chrome.port);
    if (!reusedChrome && chrome.pid) {
      await writeChromePid(userDataDir, chrome.pid);
    }
  }
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(chrome, userDataDir, effectiveKeepBrowser, logger, {
      isInFlight: () => runStatus !== 'complete',
      emitRuntimeHint,
      preserveUserDataDir: manualLogin,
    });
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: Awaited<ReturnType<typeof connectToChrome>> | null = null;
  const startedAt = Date.now();
  let answerText = '';
  let answerMarkdown = '';
  let answerHtml = '';
  let runStatus: 'attempted' | 'complete' = 'attempted';
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let appliedCookies = 0;

  try {
    try {
      client = await connectToChrome(chrome.port, logger, chromeHost);
    } catch (error) {
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on('disconnect', () => {
        connectionClosedUnexpectedly = true;
        logger('Chrome window closed; attempting to abort run.');
        reject(new Error('Chrome window closed before oracle finished. Please keep it open until completion.'));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);
    const { Network, Page, Runtime, Input, DOM } = client;

    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === 'function') {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const cookieSyncEnabled = config.cookieSync && !manualLogin;
  if (cookieSyncEnabled) {
    if (!config.inlineCookies) {
      logger(
        'Heads-up: macOS may prompt for your Keychain password to read Chrome cookies; use --copy or --render for manual flow.',
      );
    } else {
      logger('Applying inline cookies (skipping Chrome profile read and Keychain prompt)');
    }
    // Learned: always sync cookies before the first navigation so /backend-api/me succeeds.
    const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger, {
      allowErrors: config.allowCookieErrors ?? false,
      filterNames: config.cookieNames ?? undefined,
      inlineCookies: config.inlineCookies ?? undefined,
      cookiePath: config.chromeCookiePath ?? undefined,
      });
      appliedCookies = cookieCount;
      if (config.inlineCookies && cookieCount === 0) {
        throw new Error('No inline cookies were applied; aborting before navigation.');
      }
      logger(
        cookieCount > 0
          ? config.inlineCookies
            ? `Applied ${cookieCount} inline cookies`
            : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? 'Default'}`
          : config.inlineCookies
            ? 'No inline cookies applied; continuing without session reuse'
            : 'No Chrome cookies found; continuing without session reuse',
      );
    } else {
      logger(
        manualLogin
          ? 'Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in.'
          : 'Skipping Chrome cookie sync (--browser-no-cookie-sync)',
      );
    }

    if (cookieSyncEnabled && !manualLogin && (appliedCookies ?? 0) === 0 && !config.inlineCookies) {
      // Learned: if the profile has no ChatGPT cookies, browser mode will just bounce to login.
      // Fail early so the user knows to sign in.
      throw new BrowserAutomationError(
        'No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode. ' +
          'Make sure ChatGPT is signed in in the selected profile, or use --browser-manual-login / inline cookies.',
        {
          stage: 'execute-browser',
          details: {
            profile: config.chromeProfile ?? 'Default',
            cookiePath: config.chromeCookiePath ?? null,
            hint: 'If macOS Keychain prompts or denies access, run oracle from a GUI session or use --copy/--render for the manual flow.',
          },
        },
      );
    }

    const baseUrl = CHATGPT_URL;
    // First load the base ChatGPT homepage to satisfy potential interstitials,
    // then hop to the requested URL if it differs.
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
    await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    // Learned: login checks must happen on the base domain before jumping into project URLs.
    await raceWithDisconnect(
      waitForLogin({ runtime: Runtime, logger, appliedCookies, manualLogin, timeoutMs: config.timeoutMs }),
    );

    if (config.url !== baseUrl) {
      await raceWithDisconnect(navigateToChatGPT(Page, Runtime, config.url, logger));
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    }
    await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    logger(`Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`);
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
          expression: 'location.href',
          returnByValue: true,
        });
        if (typeof result?.value === 'string') {
          lastUrl = result.value;
        }
      } catch {
        // ignore
      }
      if (lastUrl) {
        logger(`[browser] url = ${lastUrl}`);
      }
      if (chrome?.port) {
        const suffix = lastTargetId ? ` target=${lastTargetId}` : '';
        if (lastUrl) {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost} url=${lastUrl}${suffix}`);
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
          const { result } = await Runtime.evaluate({ expression: 'location.href', returnByValue: true });
          if (typeof result?.value === 'string' && result.value.includes('/c/')) {
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
    if (config.desiredModel && modelStrategy !== 'ignore') {
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
            ? ' No cookies were applied; log in to ChatGPT in Chrome or provide inline cookies (--browser-inline-cookies[(-file)] or ORACLE_BROWSER_COOKIES_JSON).'
            : '';
        throw new Error(`${base}${hint}`);
      });
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(`Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`);
    } else if (modelStrategy === 'ignore') {
      logger('Model picker: skipped (strategy=ignore)');
    }
    // Handle thinking time selection if specified
    const thinkingTime = config.thinkingTime;
    if (thinkingTime) {
      await raceWithDisconnect(
        withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(`[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`);
            }
          },
        }),
      );
    }
    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === 'string' ? baselineSnapshot.text.trim() : '';
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      let inputOnlyAttachments = false;
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error('Chrome DOM domain unavailable while uploading attachments.');
        }
        await clearComposerAttachments(Runtime, 5_000, logger);
        for (let attachmentIndex = 0; attachmentIndex < submissionAttachments.length; attachmentIndex += 1) {
          const attachment = submissionAttachments[attachmentIndex];
          logger(`Uploading attachment: ${attachment.displayPath}`);
          const uiConfirmed = await uploadAttachmentFile(
            { runtime: Runtime, dom: DOM },
            attachment,
            logger,
            { expectedCount: attachmentIndex + 1 },
          );
          if (!uiConfirmed) {
            inputOnlyAttachments = true;
          }
          await delay(500);
        }
        // Scale timeout based on number of files: base 30s + 15s per additional file
        const baseTimeout = config.inputTimeoutMs ?? 30_000;
        const perFileTimeout = 15_000;
        const waitBudget = Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
        await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
        logger('All attachments uploaded');
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      // Learned: return baselineTurns so assistant polling can ignore earlier content.
      const committedTurns = await submitPrompt(
        {
          runtime: Runtime,
          input: Input,
          attachmentNames,
          baselineTurns: baselineTurns ?? undefined,
          inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        },
        prompt,
        logger,
      );
      if (typeof committedTurns === 'number' && Number.isFinite(committedTurns)) {
        if (baselineTurns === null || committedTurns > baselineTurns) {
          baselineTurns = Math.max(0, committedTurns - 1);
        }
      }
      if (attachmentNames.length > 0) {
        if (inputOnlyAttachments) {
          logger('Attachment UI did not render before send; skipping user-turn attachment verification.');
        } else {
          const verified = await waitForUserTurnAttachments(Runtime, attachmentNames, 20_000, logger);
          if (verified) {
            logger('Verified attachments present on sent user message');
          }
        }
      }
      // Reattach needs a /c/ URL; ChatGPT can update it late, so poll in the background.
      scheduleConversationHint('post-submit', config.timeoutMs ?? 120_000);
      return { baselineTurns, baselineAssistantText };
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    try {
      const submission = await raceWithDisconnect(submitOnce(promptText, attachments));
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
    } catch (error) {
      const isPromptTooLarge =
        error instanceof BrowserAutomationError &&
        (error.details as { code?: string } | undefined)?.code === 'prompt-too-large';
      if (fallbackSubmission && isPromptTooLarge) {
        // Learned: when prompts truncate, retry with file uploads so the UI receives the full content.
        logger('[browser] Inline prompt too large; retrying with file uploads.');
        await raceWithDisconnect(clearPromptComposer(Runtime, logger));
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        const submission = await raceWithDisconnect(
          submitOnce(fallbackSubmission.prompt, fallbackSubmission.attachments),
        );
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } else {
        throw error;
      }
    }
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, ' ').trim();
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(() => null);
        const text = typeof snapshot?.text === 'string' ? snapshot.text.trim() : '';
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized || (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    let answer = await raceWithDisconnect(
      waitForAssistantResponseWithReload(
        Runtime,
        Page,
        config.timeoutMs,
        logger,
        baselineTurns ?? undefined,
      ),
    );
    // Ensure we store the final conversation URL even if the UI updated late.
    await updateConversationHint('post-response', 15_000);
    const baselineNormalized = baselineAssistantText ? normalizeForComparison(baselineAssistantText) : '';
    if (baselineNormalized) {
      const normalizedAnswer = normalizeForComparison(answer.text ?? '');
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : '';
      const isBaseline =
        normalizedAnswer === baselineNormalized ||
        (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
      if (isBaseline) {
        logger('Detected stale assistant response; waiting for new response...');
        const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
        if (refreshed) {
          answer = refreshed;
        }
      }
    }
    answerText = answer.text;
    answerHtml = answer.html ?? '';
    const copiedMarkdown = await raceWithDisconnect(
      withRetries(
        async () => {
          const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
          if (!attempt) {
            throw new Error('copy-missing');
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
    answerMarkdown = copiedMarkdown ?? answerText;

    const promptEchoMatcher = buildPromptEchoMatcher(promptText);

    // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
    const finalSnapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(() => null);
    const finalText = typeof finalSnapshot?.text === 'string' ? finalSnapshot.text.trim() : '';
    if (finalText && finalText !== promptText.trim()) {
      const trimmedMarkdown = answerMarkdown.trim();
      const finalIsEcho = promptEchoMatcher ? promptEchoMatcher.isEcho(finalText) : false;
      const lengthDelta = finalText.length - trimmedMarkdown.length;
      const missingCopy = !copiedMarkdown && lengthDelta >= 0;
      const likelyTruncatedCopy =
        copiedMarkdown &&
        trimmedMarkdown.length > 0 &&
        lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
      if ((missingCopy || likelyTruncatedCopy) && !finalIsEcho && finalText !== trimmedMarkdown) {
        logger('Refreshed assistant response via final DOM snapshot');
        answerText = finalText;
        answerMarkdown = finalText;
      }
    }

    // Detect prompt echo using normalized comparison (whitespace-insensitive).
    const alignedEcho = alignPromptEchoPair(
      answerText,
      answerMarkdown,
      promptEchoMatcher,
      copiedMarkdown ? logger : undefined,
      {
        text: 'Aligned assistant response text to copied markdown after prompt echo',
        markdown: 'Aligned assistant markdown to response text after prompt echo',
      },
    );
    answerText = alignedEcho.answerText;
    answerMarkdown = alignedEcho.answerMarkdown;
    const isPromptEcho = alignedEcho.isEcho;
    if (isPromptEcho) {
      logger('Detected prompt echo in response; waiting for actual assistant response...');
      const deadline = Date.now() + 15_000;
      let bestText: string | null = null;
      let stableCount = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(() => null);
        const text = typeof snapshot?.text === 'string' ? snapshot.text.trim() : '';
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
        logger('Recovered assistant response after detecting prompt echo');
        answerText = bestText;
        answerMarkdown = bestText;
      }
    }
    const minAnswerChars = 16;
    if (answerText.trim().length > 0 && answerText.trim().length < minAnswerChars) {
      const deadline = Date.now() + 12_000;
      let bestText = answerText.trim();
      let stableCycles = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(() => null);
        const text = typeof snapshot?.text === 'string' ? snapshot.text.trim() : '';
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
      if (bestText.length > answerText.trim().length) {
        logger('Refreshed short assistant response from latest DOM snapshot');
        answerText = bestText;
        answerMarkdown = bestText;
      }
    }
    if (connectionClosedUnexpectedly) {
      // Bail out on mid-run disconnects so the session stays reattachable.
      throw new Error('Chrome disconnected before completion');
    }
    stopThinkingMonitor?.();
    runStatus = 'complete';
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    stopThinkingMonitor?.();
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') && normalizedError.stack) {
      logger(`Chrome window closed before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    await emitRuntimeHint();
    throw new BrowserAutomationError(
      'Chrome window closed before oracle finished. Please keep it open until completion.',
      {
        stage: 'connection-lost',
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
    removeTerminationHooks?.();
    if (!effectiveKeepBrowser) {
      if (!connectionClosedUnexpectedly) {
        try {
          await chrome.kill();
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
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: 'never' }).catch(() => undefined);
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (!connectionClosedUnexpectedly) {
        const totalSeconds = (Date.now() - startedAt) / 1000;
        logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
      }
    } else if (!connectionClosedUnexpectedly) {
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
  }
}

const DEFAULT_DEBUG_PORT = 9222;

async function pickAvailableDebugPort(preferredPort: number, logger: BrowserLogger): Promise<number> {
  const start = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
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
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to acquire ephemeral port')));
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
  runtime: ChromeClient['Runtime'];
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
      const loginDetected = message?.toLowerCase().includes('login button');
      const sessionMissing = message?.toLowerCase().includes('session not detected');
      if (!loginDetected && !sessionMissing) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          'Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...',
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  throw new Error('Manual login mode timed out waiting for ChatGPT session; please sign in and retry.');
}

async function _assertNavigatedToHttp(
  runtime: ChromeClient['Runtime'],
  _logger: BrowserLogger,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const { result } = await runtime.evaluate({
      expression: 'typeof location === "object" && location.href ? location.href : ""',
      returnByValue: true,
    });
    const url = typeof result?.value === 'string' ? result.value : '';
    lastUrl = url;
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    await delay(250);
  }
  throw new BrowserAutomationError('ChatGPT session not detected; page never left new tab.', {
    stage: 'execute-browser',
    details: { url: lastUrl || '(empty)' },
  });
}

async function maybeReuseRunningChrome(userDataDir: string, logger: BrowserLogger): Promise<LaunchedChrome | null> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) return null;

  const probe = await verifyDevToolsReachable({ port });
  if (!probe.ok) {
    logger(`DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`);
    // Safe cleanup: remove stale DevToolsActivePort; only remove lock files if this was an Oracle-owned pid that died.
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: 'if_oracle_pid_dead' });
    return null;
  }

  const pid = await readChromePid(userDataDir);
  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ''})`,
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
    throw new Error('Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.');
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let lastUrl: string | undefined;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    try {
      await runtimeHintCb({
        chromePort: port,
        chromeHost: host,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const startedAt = Date.now();
  let answerText = '';
  let answerMarkdown = '';
  let answerHtml = '';
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;

  try {
    const connection = await connectToRemoteChrome(host, port, logger, config.url);
    client = connection.client;
    remoteTargetId = connection.targetId ?? null;
    await emitRuntimeHint();
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on('disconnect', markConnectionLost);
    const { Network, Page, Runtime, Input, DOM } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === 'function') {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);

    // Skip cookie sync for remote Chrome - it already has cookies
    logger('Skipping cookie sync for remote Chrome (using existing session)');

    await navigateToChatGPT(Page, Runtime, config.url, logger);
    await ensureNotBlocked(Runtime, config.headless, logger);
    await ensureLoggedIn(Runtime, logger, { remoteSession: true });
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    logger(`Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`);
    try {
      const { result } = await Runtime.evaluate({
        expression: 'location.href',
        returnByValue: true,
      });
      if (typeof result?.value === 'string') {
        lastUrl = result.value;
      }
      await emitRuntimeHint();
    } catch {
      // ignore
    }

    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (config.desiredModel && modelStrategy !== 'ignore') {
      await withRetries(
        () => ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
        {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(`[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`);
            }
          },
        },
      );
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      logger(`Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`);
    } else if (modelStrategy === 'ignore') {
      logger('Model picker: skipped (strategy=ignore)');
    }
    // Handle thinking time selection if specified
    const thinkingTime = config.thinkingTime;
    if (thinkingTime) {
      await withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger), {
        retries: 2,
        delayMs: 300,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(`[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`);
          }
        },
      });
    }

    const submitOnce = async (prompt: string, submissionAttachments: BrowserAttachment[]) => {
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === 'string' ? baselineSnapshot.text.trim() : '';
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      if (submissionAttachments.length > 0) {
        if (!DOM) {
          throw new Error('Chrome DOM domain unavailable while uploading attachments.');
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
        const waitBudget = Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
        await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
        logger('All attachments uploaded');
      }
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      const committedTurns = await submitPrompt(
        {
          runtime: Runtime,
          input: Input,
          attachmentNames,
          baselineTurns: baselineTurns ?? undefined,
          inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        },
        prompt,
        logger,
      );
      if (typeof committedTurns === 'number' && Number.isFinite(committedTurns)) {
        if (baselineTurns === null || committedTurns > baselineTurns) {
          baselineTurns = Math.max(0, committedTurns - 1);
        }
      }
      return { baselineTurns, baselineAssistantText };
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    try {
      const submission = await submitOnce(promptText, attachments);
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
    } catch (error) {
      const isPromptTooLarge =
        error instanceof BrowserAutomationError &&
        (error.details as { code?: string } | undefined)?.code === 'prompt-too-large';
      if (options.fallbackSubmission && isPromptTooLarge) {
        logger('[browser] Inline prompt too large; retrying with file uploads.');
        await clearPromptComposer(Runtime, logger);
        await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        const submission = await submitOnce(options.fallbackSubmission.prompt, options.fallbackSubmission.attachments);
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } else {
        throw error;
      }
    }
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, ' ').trim();
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(() => null);
        const text = typeof snapshot?.text === 'string' ? snapshot.text.trim() : '';
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized || (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    let answer = await waitForAssistantResponseWithReload(
      Runtime,
      Page,
      config.timeoutMs,
      logger,
      baselineTurns ?? undefined,
    );
    const baselineNormalized = baselineAssistantText ? normalizeForComparison(baselineAssistantText) : '';
    if (baselineNormalized) {
      const normalizedAnswer = normalizeForComparison(answer.text ?? '');
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : '';
      const isBaseline =
        normalizedAnswer === baselineNormalized ||
        (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
      if (isBaseline) {
        logger('Detected stale assistant response; waiting for new response...');
        const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
        if (refreshed) {
          answer = refreshed;
        }
      }
    }
    answerText = answer.text;
    answerHtml = answer.html ?? '';

    const copiedMarkdown = await withRetries(
      async () => {
        const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
        if (!attempt) {
          throw new Error('copy-missing');
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

    answerMarkdown = copiedMarkdown ?? answerText;

    // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
    const finalSnapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(() => null);
    const finalText = typeof finalSnapshot?.text === 'string' ? finalSnapshot.text.trim() : '';
    if (
      finalText &&
      finalText !== answerMarkdown.trim() &&
      finalText !== promptText.trim() &&
      finalText.length >= answerMarkdown.trim().length
    ) {
      logger('Refreshed assistant response via final DOM snapshot');
      answerText = finalText;
      answerMarkdown = finalText;
    }

    // Detect prompt echo using normalized comparison (whitespace-insensitive).
    const promptEchoMatcher = buildPromptEchoMatcher(promptText);
    const alignedEcho = alignPromptEchoPair(
      answerText,
      answerMarkdown,
      promptEchoMatcher,
      copiedMarkdown ? logger : undefined,
      {
        text: 'Aligned assistant response text to copied markdown after prompt echo',
        markdown: 'Aligned assistant markdown to response text after prompt echo',
      },
    );
    answerText = alignedEcho.answerText;
    answerMarkdown = alignedEcho.answerMarkdown;
    const isPromptEcho = alignedEcho.isEcho;
    if (isPromptEcho) {
      logger('Detected prompt echo in response; waiting for actual assistant response...');
      const deadline = Date.now() + 15_000;
      let bestText: string | null = null;
      let stableCount = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(Runtime, baselineTurns ?? undefined).catch(() => null);
        const text = typeof snapshot?.text === 'string' ? snapshot.text.trim() : '';
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
        logger('Recovered assistant response after detecting prompt echo');
        answerText = bestText;
        answerMarkdown = bestText;
      }
    }
    stopThinkingMonitor?.();

    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);

    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    stopThinkingMonitor?.();
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;

    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }

    throw new BrowserAutomationError('Remote Chrome connection lost before Oracle finished.', {
      stage: 'connection-lost',
      runtime: {
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      },
    });
  } finally {
    try {
      if (!connectionClosedUnexpectedly && client) {
        await client.close();
      }
    } catch {
      // ignore
    }
    await closeRemoteChromeTarget(host, port, remoteTargetId ?? undefined, logger);
    // Don't kill remote Chrome - it's not ours to manage
    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

export { estimateTokenCount } from './utils.js';
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from './config.js';
export { syncCookies } from './cookies.js';
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
} from './pageActions.js';

function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('websocket connection closed') ||
    message.includes('websocket is closed') ||
    message.includes('websocket error') ||
    message.includes('target closed')
  );
}

export function formatThinkingLog(startedAt: number, now: number, message: string, locatorSuffix: string): string {
  const elapsedMs = now - startedAt;
  const elapsedText = formatElapsed(elapsedMs);
  const progress = Math.min(1, elapsedMs / 600_000); // soft target: 10 minutes
  const pct = Math.round(progress * 100)
    .toString()
    .padStart(3, ' ');
  const statusLabel = message ? ` — ${message}` : '';
  return `${pct}% [${elapsedText} / ~10m]${statusLabel}${locatorSuffix}`;
}

async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient['Runtime'],
  Page: ChromeClient['Page'],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
) {
  try {
    return await waitForAssistantResponse(Runtime, timeoutMs, logger, minTurnIndex);
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    const conversationUrl = await readConversationUrl(Runtime);
    if (!conversationUrl || !isConversationUrl(conversationUrl)) {
      throw error;
    }
    logger('Assistant response stalled; reloading conversation and retrying once');
    await Page.navigate({ url: conversationUrl });
    await delay(1000);
    return await waitForAssistantResponse(Runtime, timeoutMs, logger, minTurnIndex);
  }
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('assistant-response') ||
    message.includes('watchdog') ||
    message.includes('timeout') ||
    message.includes('capture assistant response')
  );
}

async function readConversationUrl(Runtime: ChromeClient['Runtime']): Promise<string | null> {
  try {
    const currentUrl = await Runtime.evaluate({ expression: 'location.href', returnByValue: true });
    return typeof currentUrl.result?.value === 'string' ? currentUrl.result.value : null;
  } catch {
    return null;
  }
}

async function readConversationTurnCount(
  Runtime: ChromeClient['Runtime'],
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
      const raw = typeof result?.value === 'number' ? result.value : Number(result?.value);
      if (!Number.isFinite(raw)) {
        throw new Error('Turn count not numeric');
      }
      return Math.max(0, Math.floor(raw));
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(150);
        continue;
      }
      if (logger?.verbose) {
        logger(`Failed to read conversation turn count: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
  }
  return null;
}

function isConversationUrl(url: string): boolean {
  return /\/c\/[a-z0-9-]+/i.test(url);
}

function startThinkingStatusMonitor(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  includeDiagnostics = false,
): () => void {
  let stopped = false;
  let pending = false;
  let lastMessage: string | null = null;
  const startedAt = Date.now();
  const interval = setInterval(async () => {
    // stop flag flips asynchronously
    if (stopped || pending) {
      return;
    }
    pending = true;
    try {
      const nextMessage = await readThinkingStatus(Runtime);
      if (nextMessage && nextMessage !== lastMessage) {
        lastMessage = nextMessage;
        let locatorSuffix = '';
        if (includeDiagnostics) {
          try {
            const snapshot = await readAssistantSnapshot(Runtime);
            locatorSuffix = ` | assistant-turn=${snapshot ? 'present' : 'missing'}`;
          } catch {
            locatorSuffix = ' | assistant-turn=error';
          }
        }
        logger(formatThinkingLog(startedAt, Date.now(), nextMessage, locatorSuffix));
      }
    } catch {
      // ignore DOM polling errors
    } finally {
      pending = false;
    }
  }, 1500);
  interval.unref?.();
  return () => {
    // multiple callers may race to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
  };
}

async function readThinkingStatus(Runtime: ChromeClient['Runtime']): Promise<string | null> {
  const expression = buildThinkingStatusExpression();
  try {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = typeof result.value === 'string' ? result.value.trim() : '';
    const sanitized = sanitizeThinkingText(value);
    return sanitized || null;
  } catch {
    return null;
  }
}

function sanitizeThinkingText(raw: string): string {
  if (!raw) {
    return '';
  }
  const trimmed = raw.trim();
  const prefixPattern = /^(pro thinking)\s*[•:\-–—]*\s*/i;
  if (prefixPattern.test(trimmed)) {
    return trimmed.replace(prefixPattern, '').trim();
  }
  return trimmed;
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    '',
    'PowerShell (admin):',
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    '',
    'Re-run the same oracle command after adding the rule.',
  ].join('\n');
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes('microsoft');
}

function extractConversationIdFromUrl(url: string): string | undefined {
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      '/mnt/c/Users/Public/AppData/Local/Temp',
      '/mnt/c/Temp',
      '/mnt/c/Windows/Temp',
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
  return os.tmpdir();
}

function buildThinkingStatusExpression(): string {
  const selectors = [
    'span.loading-shimmer',
    'span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary',
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
    '[role="status"]',
    '[aria-live="polite"]',
  ];
  const keywords = ['pro thinking', 'thinking', 'reasoning', 'clarifying', 'planning', 'drafting', 'summarizing'];
  const selectorLiteral = JSON.stringify(selectors);
  const keywordsLiteral = JSON.stringify(keywords);
  return `(() => {
    const selectors = ${selectorLiteral};
    const keywords = ${keywordsLiteral};
    const nodes = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    }
    document.querySelectorAll('[data-testid]').forEach((node) => nodes.add(node));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const text = node.textContent?.trim();
      if (!text) {
        continue;
      }
      const classLabel = (node.className || '').toLowerCase();
      const dataLabel = ((node.getAttribute('data-testid') || '') + ' ' + (node.getAttribute('aria-label') || ''))
        .toLowerCase();
      const normalizedText = text.toLowerCase();
      const matches = keywords.some((keyword) =>
        normalizedText.includes(keyword) || classLabel.includes(keyword) || dataLabel.includes(keyword)
      );
      if (matches) {
        const shimmerChild = node.querySelector(
          'span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary',
        );
        if (shimmerChild?.textContent?.trim()) {
          return shimmerChild.textContent.trim();
        }
        return text.trim();
      }
    }
    return null;
  })()`;
}
