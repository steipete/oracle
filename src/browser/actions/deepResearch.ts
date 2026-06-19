import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  DEEP_RESEARCH_PLUS_BUTTON,
  DEEP_RESEARCH_DROPDOWN_ITEM_TEXT,
  DEEP_RESEARCH_PILL_LABEL,
  DEEP_RESEARCH_POLL_INTERVAL_MS,
  DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
  DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { isDeepResearchIncompleteText } from "../deepResearchResult.js";
import { buildClickDispatcher } from "./domEvents.js";
import { captureAssistantMarkdown, readAssistantSnapshot } from "./assistantResponse.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

type ActivateOutcome =
  | { status: "activated" }
  | { status: "already-active" }
  | { status: "plus-button-missing" }
  | { status: "dropdown-item-missing"; available?: string[] }
  | { status: "pill-not-confirmed" };

/**
 * Activates Deep Research mode through ChatGPT's slash command, with the
 * composer tools menu as a fallback for older UI variants.
 */
export async function activateDeepResearch(
  Runtime: ChromeClient["Runtime"],
  _Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<void> {
  const expression = buildActivateDeepResearchExpression();
  const outcome = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = outcome.result?.value as ActivateOutcome | undefined;

  switch (result?.status) {
    case "activated":
      logger("Deep Research mode activated");
      return;
    case "already-active":
      logger("Deep Research mode already active");
      return;
    case "plus-button-missing":
      throw new BrowserAutomationError(
        "Could not find the composer plus button to activate Deep Research.",
        { stage: "deep-research-activate", code: "plus-button-missing" },
      );
    case "dropdown-item-missing": {
      const hint = result.available?.length
        ? ` Available options: ${result.available.join(", ")}`
        : "";
      throw new BrowserAutomationError(
        `"Deep research" option not found in composer dropdown.${hint} ` +
          "This feature may require a ChatGPT Plus or Pro subscription.",
        { stage: "deep-research-activate", code: "dropdown-item-missing" },
      );
    }
    case "pill-not-confirmed":
      throw new BrowserAutomationError(
        "Deep Research pill did not appear after selection. The UI may have changed.",
        { stage: "deep-research-activate", code: "pill-not-confirmed" },
      );
    default:
      throw new BrowserAutomationError("Unexpected result from Deep Research activation.", {
        stage: "deep-research-activate",
      });
  }
}

/**
 * After prompt submission, waits for the research plan to appear and
 * auto-confirm (~60s countdown + 10s safety margin).
 */
export async function waitForResearchPlanAutoConfirm(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  autoConfirmWaitMs: number = DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
): Promise<void> {
  // Phase A: Detect research plan appearance (up to 60s)
  const planDeadline = Date.now() + 60_000;
  let planDetected = false;

  while (Date.now() < planDeadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const iframes = document.querySelectorAll('iframe');
        const hasResearchIframe = Array.from(iframes).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        const assistantText = (document.querySelector('[data-message-author-role="assistant"]')?.textContent || '').toLowerCase();
        const hasResearchText = assistantText.includes('researching') ||
          assistantText.includes('research plan') ||
          assistantText.includes('survey') ||
          assistantText.includes('analyze');
        return { hasResearchIframe, hasResearchText };
      })()`,
      returnByValue: true,
    });

    const val = result?.value as
      | { hasResearchIframe?: boolean; hasResearchText?: boolean }
      | undefined;
    if (val?.hasResearchIframe || val?.hasResearchText) {
      planDetected = true;
      logger("Research plan detected, waiting for auto-confirm countdown...");
      break;
    }
    await delay(2_000);
  }

  if (!planDetected) {
    logger(
      "Warning: Research plan not detected within 60s; continuing (may have auto-confirmed already)",
    );
    return;
  }

  // Phase B: Wait for auto-confirm countdown
  const confirmStart = Date.now();
  while (Date.now() - confirmStart < autoConfirmWaitMs) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const iframes = document.querySelectorAll('iframe');
        const hasLargeIframe = Array.from(iframes).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        const text = (document.body?.innerText || '').toLowerCase();
        const isResearching = text.includes('researching...') ||
          text.includes('reading sources') ||
          text.includes('considering');
        return { hasLargeIframe, isResearching };
      })()`,
      returnByValue: true,
    });
    const val = result?.value as { hasLargeIframe?: boolean; isResearching?: boolean } | undefined;

    if (val?.isResearching) {
      logger("Research plan confirmed, execution started");
      return;
    }

    await delay(5_000);
  }

  logger("Auto-confirm wait complete, proceeding to monitor research progress");
}

/**
 * Polls for Deep Research completion over 5-30+ minutes.
 * Returns the full response text, optional HTML, and turn metadata.
 */
export async function waitForDeepResearchCompletion(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs: number = DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
  minTurnIndex?: number | null,
  Page?: ChromeClient["Page"],
  client?: ChromeClient,
  options?: {
    ignoredTargetKeys?: readonly string[];
    requireScopedTargetOwner?: boolean;
    targetBaselineCaptured?: boolean;
  },
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const start = Date.now();
  let lastLogTime = start;
  let lastTextLength = 0;
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const scopedToNewTurns = minTurnLiteral >= 0;
  const ignoredTargetKeys = new Set(options?.ignoredTargetKeys ?? []);
  const requireScopedTargetOwner =
    options?.requireScopedTargetOwner === true ||
    (scopedToNewTurns && options?.targetBaselineCaptured !== true);
  let observedResearchEvidence = false;
  let loggedIncompleteResult = false;

  logger(`Monitoring Deep Research (timeout: ${Math.round(timeoutMs / 60_000)}min)...`);

  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: buildDeepResearchCompletionPollExpression(minTurnLiteral),
      returnByValue: true,
    });

    const val = result?.value as
      | {
          finished?: boolean;
          stopVisible?: boolean;
          textLength?: number;
          hasIframe?: boolean;
          hasActiveScopedResearch?: boolean;
          incompleteResult?: boolean;
          researchActivity?: boolean;
          accountBlocked?: boolean;
        }
      | undefined;

    if (val?.accountBlocked) {
      throw new BrowserAutomationError(
        "ChatGPT account security block detected during Deep Research. Open chatgpt.com in Chrome, secure the account, then rerun Oracle.",
        { stage: "chatgpt-account-blocked", code: "chatgpt-account-blocked" },
      );
    }
    // ChatGPT renders the Deep Research report inside an out-of-process,
    // sandboxed iframe (connector_openai_deep_research.*.oaiusercontent.com),
    // doubly nested and same-origin. That OOPIF does NOT appear in the main
    // page's frame tree, so the in-page isolated-world path
    // (readDeepResearchFrameResult) can never see it. The target-attach path
    // (readDeepResearchTargetResult) attaches to the iframe's own CDP target and
    // walks its nested frames, so it CAN read the report. Prefer the target path
    // and fall back to the in-page frame path for legacy/inline rendering.
    const rawTargetResult = client
      ? ((
          await readDeepResearchTargetResult(
            client,
            ignoredTargetKeys,
            requireScopedTargetOwner ? minTurnLiteral : -1,
          ).catch(() => null)
        )?.read ?? null)
      : null;
    const targetResult = filterIncompleteDeepResearchRead(rawTargetResult);
    // A completed target read is authoritative. If the target read is missing or
    // only in-progress, still try the in-page frame path so an incomplete target
    // read does not suppress a completed report there (legacy/inline rendering).
    const inPageScan =
      !targetResult?.completed && Page
        ? await readDeepResearchFrameResult(
            Runtime,
            Page,
            client,
            scopedToNewTurns ? minTurnLiteral : -1,
          ).catch(() => null)
        : null;
    const rawInPageResult = inPageScan?.read ?? null;
    const inPageResult = filterIncompleteDeepResearchRead(rawInPageResult);
    const read = pickPreferredDeepResearchRead(targetResult, inPageResult);
    // Target keys captured before submission are ignored, so a target result is
    // tied to this run. Main-page iframes are not: old reports can remain in the
    // conversation and must never authorize a new normal-response fallback.
    observedResearchEvidence ||= Boolean(
      rawTargetResult ||
      (scopedToNewTurns && rawInPageResult) ||
      val?.researchActivity ||
      val?.hasActiveScopedResearch,
    );
    if (read?.completed && read.text) {
      logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      return {
        text: read.text,
        html: read.html,
        meta: { turnId: null, messageId: null },
      };
    }

    // Completion detected
    if (val?.finished) {
      if (!observedResearchEvidence) {
        throw new BrowserAutomationError(
          "ChatGPT returned a completed response without starting Deep Research. The Deep Research selection may have silently fallen back to a normal response.",
          { stage: "deep-research-not-started", code: "deep-research-not-started" },
        );
      }
      logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      return await extractDeepResearchResult(Runtime, logger, minTurnIndex ?? undefined);
    }

    const incompleteFrameResult = Boolean(
      (rawTargetResult?.completed && !targetResult?.completed) ||
      (rawInPageResult?.completed && !inPageResult?.completed),
    );
    if ((val?.incompleteResult || incompleteFrameResult) && !loggedIncompleteResult) {
      logger("Deep Research interim status detected; waiting for the final report");
      loggedIncompleteResult = true;
    }

    // Progress logging every 60 seconds
    const now = Date.now();
    if (now - lastLogTime >= 60_000) {
      const elapsed = Math.round((now - start) / 1000);
      const chars = Math.max(val?.textLength ?? 0, read?.textLength ?? 0);
      const phase =
        read?.inProgress || val?.hasIframe
          ? "researching"
          : val?.stopVisible
            ? "generating"
            : "waiting";
      logger(`Deep Research ${phase}... ${elapsed}s elapsed, ~${chars} chars`);
      lastLogTime = now;
    }

    lastTextLength = Math.max(val?.textLength ?? 0, read?.textLength ?? 0, lastTextLength);
    await delay(DEEP_RESEARCH_POLL_INTERVAL_MS);
  }

  // Timeout — throw with metadata for potential reattach
  const elapsed = Math.round((Date.now() - start) / 1000);
  throw new BrowserAutomationError(
    `Deep Research did not complete within ${Math.round(timeoutMs / 60_000)} minutes (${elapsed}s elapsed). ` +
      "Use 'oracle session <id>' to reattach later, or increase --timeout.",
    {
      stage: "deep-research-timeout",
      code: "deep-research-timeout",
      elapsedMs: Date.now() - start,
      lastTextLength,
    },
  );
}

/**
 * Extracts the Deep Research result using existing assistant response
 * extraction logic (readAssistantSnapshot + captureAssistantMarkdown).
 */
export async function extractDeepResearchResult(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
  const meta = {
    turnId: snapshot?.turnId ?? null,
    messageId: snapshot?.messageId ?? null,
  };

  // Try the copy-button approach first for clean markdown
  const markdown = await captureAssistantMarkdown(Runtime, meta, logger);
  if (markdown && !isDeepResearchIncompleteText(markdown)) {
    return { text: markdown, html: snapshot?.html ?? undefined, meta };
  }

  // Fall back to snapshot text
  if (snapshot?.text && !isDeepResearchIncompleteText(snapshot.text)) {
    return { text: snapshot.text, html: snapshot.html ?? undefined, meta };
  }

  throw new BrowserAutomationError(
    "Deep Research completed but failed to extract the response text.",
    { stage: "deep-research-extract", code: "extraction-failed" },
  );
}

export function isDeepResearchPlaceholderTextForTest(text: string): boolean {
  return isDeepResearchIncompleteText(text);
}

interface DeepResearchFrameTree {
  frame?: { id?: string; url?: string; name?: string };
  childFrames?: DeepResearchFrameTree[];
}

interface DeepResearchFrameStatus {
  completed: boolean;
  inProgress: boolean;
  textLength: number;
  text?: string;
  html?: string;
}

interface DeepResearchTargetScanResult {
  read: DeepResearchFrameStatus | null;
  targetKeys: string[];
}

interface DeepResearchTargetSessionResult {
  confirmed: boolean;
  read: DeepResearchFrameStatus | null;
  frameId?: string;
}

interface DeepResearchFrameReadResult {
  read: DeepResearchFrameStatus;
  ownerTurnIndex: number | null;
}

function filterIncompleteDeepResearchRead(
  result: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  if (!result?.completed || !result.text || !isDeepResearchIncompleteText(result.text)) {
    return result;
  }
  return { ...result, completed: false, inProgress: true };
}

export function filterIncompleteDeepResearchReadForTest(
  result: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  return filterIncompleteDeepResearchRead(result);
}

/**
 * Choose the authoritative Deep Research read between the target-attach result
 * and the in-page frame result. A completed read wins (target preferred, since
 * it reads the live OOPIF directly); otherwise the best in-progress/text-bearing
 * read is kept so progress logging still advances. This preserves the legacy
 * Page-first inline behaviour: when the target read is missing or incomplete,
 * a completed in-page result is still returned.
 */
function pickPreferredDeepResearchRead(
  targetResult: DeepResearchFrameStatus | null,
  inPageResult: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  if (targetResult?.completed) {
    return targetResult;
  }
  if (inPageResult?.completed) {
    return inPageResult;
  }
  return targetResult ?? inPageResult;
}

export function pickPreferredDeepResearchReadForTest(
  targetResult: DeepResearchFrameStatus | null,
  inPageResult: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  return pickPreferredDeepResearchRead(targetResult, inPageResult);
}

async function readDeepResearchFrameResult(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  client?: ChromeClient,
  minTurnIndex = -1,
): Promise<DeepResearchFrameReadResult | null> {
  const pageWithFrames = Page as ChromeClient["Page"] & {
    getFrameTree?: () => Promise<{ frameTree?: DeepResearchFrameTree }>;
    createIsolatedWorld?: (params: {
      frameId: string;
      worldName?: string;
      grantUniveralAccess?: boolean;
    }) => Promise<{ executionContextId?: number }>;
  };
  if (
    typeof pageWithFrames.getFrameTree !== "function" ||
    typeof pageWithFrames.createIsolatedWorld !== "function"
  ) {
    return null;
  }
  const frameTree = (await pageWithFrames.getFrameTree())?.frameTree;
  const frameIds = collectPageDeepResearchFrameIds(frameTree);
  if (frameIds.length === 0) {
    return null;
  }
  const rawClient = client as
    | (ChromeClient & {
        send?: (
          method: string,
          params?: Record<string, unknown>,
          sessionId?: string,
        ) => Promise<unknown>;
        oraclePageSessionId?: string;
      })
    | undefined;
  if (minTurnIndex >= 0) {
    if (typeof rawClient?.send !== "function") {
      return null;
    }
  }
  let best: DeepResearchFrameReadResult | null = null;
  for (const frameId of frameIds) {
    let ownerTurnIndex: number | null = null;
    if (minTurnIndex >= 0 && rawClient?.send) {
      ownerTurnIndex = await readDeepResearchTargetOwnerTurnIndex(
        rawClient as ChromeClient & { send: NonNullable<typeof rawClient.send> },
        frameId,
        rawClient.oraclePageSessionId,
      );
      if (ownerTurnIndex === null || ownerTurnIndex < minTurnIndex) {
        continue;
      }
    }
    const world = await pageWithFrames.createIsolatedWorld({
      frameId,
      worldName: "oracle-deep-research",
      grantUniveralAccess: true,
    });
    if (typeof world.executionContextId !== "number") {
      continue;
    }
    const { result } = await Runtime.evaluate({
      expression: buildDeepResearchFrameStatusExpression(),
      contextId: world.executionContextId,
      returnByValue: true,
    });
    const read = (result?.value as DeepResearchFrameStatus | undefined) ?? null;
    if (!read) {
      continue;
    }
    best = { read, ownerTurnIndex };
    if (read.completed) {
      return best;
    }
  }
  return best;
}

async function readDeepResearchTargetResult(
  client: ChromeClient,
  ignoredTargetKeys: ReadonlySet<string> = new Set(),
  minTurnIndex = -1,
): Promise<DeepResearchTargetScanResult | null> {
  const rawClient = client as ChromeClient & {
    send?: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
    oraclePageSessionId?: string;
  };
  if (typeof rawClient.send !== "function") {
    return null;
  }
  if (typeof client.on !== "function") {
    return null;
  }

  // On the browser-WSEndpoint path, `client` is a session-bound wrapper whose
  // domain methods target the page session but whose raw `send` is the
  // browser-level send. We must therefore pass the page session id explicitly so
  // Target.setAutoAttach binds to THIS page (not the whole browser). For a direct
  // tab client this is undefined and `send` already defaults to the page session.
  const pageSessionId = rawClient.oraclePageSessionId;

  const sessions = new Map<string, { targetId?: string; url: string }>();
  const ownedSessionIds = new Set<string>();
  const onAttached = (params: unknown, parentSessionId?: string) => {
    // chrome-remote-interface emits flattened target events both on the
    // session-specific event name and on the shared base event. The second
    // callback argument identifies the parent page session; ignore events from
    // other tabs when this client wraps a shared browser WebSocket.
    if (pageSessionId && parentSessionId !== pageSessionId) {
      return;
    }
    const targetInfo = (
      params as { targetInfo?: { targetId?: string; url?: string; type?: string } } | undefined
    )?.targetInfo;
    const eventSessionId =
      (params as { sessionId?: string } | undefined)?.sessionId ?? parentSessionId;
    const url = targetInfo?.url ?? "";
    const type = targetInfo?.type ?? "";
    if (eventSessionId && isDeepResearchTarget(url, type)) {
      sessions.set(eventSessionId, { targetId: targetInfo?.targetId, url });
      ownedSessionIds.add(eventSessionId);
    }
  };

  client.on("Target.attachedToTarget", onAttached as never);
  try {
    // Scope discovery to the current Oracle-controlled page. `client` is
    // connected to the conversation page target, so enabling auto-attach on this
    // session only attaches THIS page's related targets (its Deep Research OOPIF
    // subframe) and emits Target.attachedToTarget for them.
    //
    // We deliberately do NOT enumerate Target.getTargets / attachToTarget here:
    // that scan is browser-wide, and in a shared/persistent Chrome profile it
    // would surface another tab's completed Deep Research report and let it be
    // saved into the current session (cross-tab leak). Only auto-attached,
    // page-scoped sessions are treated as belonging to this run.
    const autoAttachEnabled = await rawClient
      .send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        pageSessionId,
      )
      .then(
        () => true,
        () => false,
      );
    if (!autoAttachEnabled) {
      return null;
    }
    await delay(100);

    if (minTurnIndex >= 0) {
      await rawClient.send("DOM.enable", {}, pageSessionId).catch(() => undefined);
      await rawClient.send("Runtime.enable", {}, pageSessionId).catch(() => undefined);
    }

    // Baseline targets and owner turns before the submitted prompt are removed
    // first. Among remaining targets, a completed report is authoritative;
    // otherwise retain the newest meaningful progress read for status logging.
    let completed: DeepResearchFrameStatus | null = null;
    let latestProgress: DeepResearchFrameStatus | null = null;
    const targetKeys: string[] = [];
    for (const [sessionId, target] of sessions) {
      const sessionResult = await readDeepResearchTargetSession(rawClient, sessionId, target.url);
      if (!sessionResult.confirmed) {
        continue;
      }
      if (target.targetId) {
        targetKeys.push(target.targetId);
      }
      if (target.targetId && ignoredTargetKeys.has(target.targetId)) {
        continue;
      }
      if (minTurnIndex >= 0) {
        const ownerTurnIndex = sessionResult.frameId
          ? await readDeepResearchTargetOwnerTurnIndex(
              rawClient,
              sessionResult.frameId,
              pageSessionId,
            )
          : null;
        if (ownerTurnIndex === null || ownerTurnIndex < minTurnIndex) {
          continue;
        }
      }
      const value = sessionResult.read;
      if (value?.completed) {
        completed = value;
      } else if (value && (value.inProgress || value.textLength > 0)) {
        latestProgress = value;
      }
    }
    return {
      read: completed ?? latestProgress,
      targetKeys,
    };
  } finally {
    await rawClient
      .send(
        "Target.setAutoAttach",
        {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        pageSessionId,
      )
      .catch(() => undefined);
    await Promise.all(
      Array.from(ownedSessionIds, (sessionId) =>
        rawClient.send("Target.detachFromTarget", { sessionId }).catch(() => undefined),
      ),
    );
    (
      client as ChromeClient & { removeListener?: (event: string, listener: unknown) => void }
    ).removeListener?.("Target.attachedToTarget", onAttached);
  }
}

export async function captureDeepResearchTargetKeys(client: ChromeClient): Promise<string[]> {
  const scan = await readDeepResearchTargetResult(client);
  if (!scan) {
    throw new Error("Deep Research target baseline capture unavailable");
  }
  return scan.targetKeys;
}

async function readDeepResearchTargetOwnerTurnIndex(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  frameId: string,
  pageSessionId?: string,
): Promise<number | null> {
  const owner = (await rawClient
    .send("DOM.getFrameOwner", { frameId }, pageSessionId)
    .catch(() => null)) as { backendNodeId?: number } | null;
  if (typeof owner?.backendNodeId !== "number") {
    return null;
  }
  const resolved = (await rawClient
    .send("DOM.resolveNode", { backendNodeId: owner.backendNodeId }, pageSessionId)
    .catch(() => null)) as { object?: { objectId?: string } } | null;
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    return null;
  }
  try {
    const response = (await rawClient
      .send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
            const selector = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
            const turn = this.closest(selector);
            return turn ? Array.from(document.querySelectorAll(selector)).indexOf(turn) : null;
          }`,
          returnByValue: true,
        },
        pageSessionId,
      )
      .catch(() => null)) as { result?: { value?: unknown } } | null;
    const value = response?.result?.value;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : null;
  } finally {
    await rawClient
      .send("Runtime.releaseObject", { objectId }, pageSessionId)
      .catch(() => undefined);
  }
}

async function readDeepResearchTargetSession(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  sessionId: string,
  targetUrl: string,
): Promise<DeepResearchTargetSessionResult> {
  await rawClient.send("Runtime.enable", {}, sessionId).catch(() => undefined);
  await rawClient.send("Page.enable", {}, sessionId).catch(() => undefined);

  const frameTree = (await rawClient
    .send("Page.getFrameTree", {}, sessionId)
    .catch(() => null)) as { frameTree?: DeepResearchFrameTree } | null;
  const ownerFrameId = frameTree?.frameTree?.frame?.id;
  if (!isConfirmedDeepResearchTarget(targetUrl, frameTree?.frameTree)) {
    return { confirmed: false, read: null };
  }
  const frameIds = collectDeepResearchFrameIds(frameTree?.frameTree);
  let best: DeepResearchFrameStatus | null = null;

  for (const frameId of frameIds) {
    const world = (await rawClient
      .send(
        "Page.createIsolatedWorld",
        {
          frameId,
          worldName: "oracle-deep-research",
          grantUniveralAccess: true,
        },
        sessionId,
      )
      .catch(() => null)) as { executionContextId?: number } | null;
    if (typeof world?.executionContextId !== "number") {
      continue;
    }
    const value = await evaluateDeepResearchFrameStatus(
      rawClient,
      sessionId,
      world.executionContextId,
    );
    if (value?.completed) {
      return { confirmed: true, read: value, frameId: ownerFrameId };
    }
    if ((value?.textLength ?? 0) > (best?.textLength ?? 0) || value?.inProgress) {
      best = value;
    }
  }

  const topFrameValue = await evaluateDeepResearchFrameStatus(rawClient, sessionId);
  if (topFrameValue?.completed) {
    return { confirmed: true, read: topFrameValue, frameId: ownerFrameId };
  }
  if ((topFrameValue?.textLength ?? 0) > (best?.textLength ?? 0) || topFrameValue?.inProgress) {
    best = topFrameValue;
  }

  return { confirmed: true, read: best, frameId: ownerFrameId };
}

async function evaluateDeepResearchFrameStatus(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  sessionId: string,
  contextId?: number,
): Promise<DeepResearchFrameStatus | null> {
  const response = (await rawClient
    .send(
      "Runtime.evaluate",
      {
        expression: buildDeepResearchFrameStatusExpression(),
        returnByValue: true,
        ...(typeof contextId === "number" ? { contextId } : {}),
      },
      sessionId,
    )
    .catch(() => null)) as { result?: { value?: DeepResearchFrameStatus } } | null;
  return response?.result?.value ?? null;
}

function isDeepResearchTarget(url: string, type: string): boolean {
  return type.toLowerCase() === "iframe" || isDeepResearchFrameDescriptor(url);
}

function isConfirmedDeepResearchTarget(
  targetUrl: string,
  tree: DeepResearchFrameTree | undefined,
): boolean {
  return isDeepResearchFrameDescriptor(targetUrl) || Boolean(findDeepResearchFrameId(tree));
}

function isDeepResearchFrameDescriptor(url: string, name = ""): boolean {
  const descriptor = `${url}\n${name}`.toLowerCase();
  return (
    descriptor.includes("connector_openai_deep_research") || descriptor.includes("deep-research")
  );
}

function findDeepResearchFrameId(tree: DeepResearchFrameTree | undefined): string | null {
  return collectPageDeepResearchFrameIds(tree)[0] ?? null;
}

function collectPageDeepResearchFrameIds(tree: DeepResearchFrameTree | undefined): string[] {
  if (!tree?.frame) {
    return [];
  }
  const ids: string[] = [];
  if (tree.frame.id && isDeepResearchFrameDescriptor(tree.frame.url ?? "", tree.frame.name ?? "")) {
    ids.push(tree.frame.id);
  }
  for (const child of tree.childFrames ?? []) {
    ids.push(...collectPageDeepResearchFrameIds(child));
  }
  return ids;
}

function collectDeepResearchFrameIds(tree: DeepResearchFrameTree | undefined): string[] {
  if (!tree?.frame) {
    return [];
  }
  const ids: string[] = [];
  const url = tree.frame.url ?? "";
  const name = tree.frame.name ?? "";
  if (
    url.includes("connector_openai_deep_research") ||
    url.includes("deep-research") ||
    name.includes("deep-research") ||
    name === "root"
  ) {
    if (tree.frame.id) {
      ids.push(tree.frame.id);
    }
  }
  for (const child of tree.childFrames ?? []) {
    ids.push(...collectDeepResearchFrameIds(child));
  }
  return ids;
}

function buildDeepResearchFrameStatusExpression(): string {
  return `(() => {
    const rawText = document.body?.innerText || '';
    const html = document.body?.innerHTML || '';
    const isPlaceholder = (line) => /^(called tool|used tool|użyto narzędzia|narzędzie wywołane)$/i.test(line);
    const isCompletionLine = (line) =>
      /^(research completed|badanie ukończone)\\b/i.test(line);
    const isCounterLine = (line) =>
      /^(\\d+\\s+)?(citation|citations|source|sources|search|searches|cytat|cytaty|cytatów|źródło|źródła|wyszukiwanie|wyszukiwania|wyszukiwań)\\b/i.test(line);
    const normalizeReport = (text) => {
      const lines = String(text || '')
        .split(/\\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^\\d+$/.test(line));
      const reportIndex = lines.findIndex((line) => /deep research report/i.test(line));
      const candidates = reportIndex >= 0 ? lines.slice(reportIndex + 1) : lines;
      let started = false;
      const reportLines = candidates.filter((line) => {
        if (!started) {
          if (
            /deep research report/i.test(line) ||
            isCompletionLine(line) ||
            isCounterLine(line) ||
            isPlaceholder(line)
          ) {
            return false;
          }
          started = true;
        }
        return true;
      });
      if (reportLines.length > 1 && reportLines[0] === reportLines[1]) {
        reportLines.shift();
      }
      return reportLines.join('\\n').trim();
    };
    const reportText = normalizeReport(rawText);
    const completed = /research completed|badanie ukończone/i.test(rawText) &&
      reportText.length >= 40 &&
      !isPlaceholder(reportText);
    const inProgress = /researching|badanie|searching|searches|wyszukiwa|citation|cytat|source|źród|reading|completed|ukończone/i.test(rawText);
    return {
      completed,
      inProgress,
      textLength: reportText.length || rawText.trim().length,
      text: completed ? reportText : undefined,
      html: completed ? html : undefined,
    };
  })()`;
}

export function findDeepResearchFrameIdForTest(
  tree: DeepResearchFrameTree | undefined,
): string | null {
  return findDeepResearchFrameId(tree);
}

export function isConfirmedDeepResearchTargetForTest(
  targetUrl: string,
  tree: DeepResearchFrameTree | undefined,
): boolean {
  return isConfirmedDeepResearchTarget(targetUrl, tree);
}

export function buildDeepResearchFrameStatusExpressionForTest(): string {
  return buildDeepResearchFrameStatusExpression();
}

/**
 * Quick status check for Deep Research — used during reattach to determine
 * whether research has completed, is still in progress, or is in an unknown state.
 */
export async function checkDeepResearchStatus(
  Runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
): Promise<{
  completed: boolean;
  inProgress: boolean;
  hasIframe: boolean;
  textLength: number;
  placeholderOnly: boolean;
}> {
  const { result } = await Runtime.evaluate({
    expression: buildDeepResearchStatusExpression(),
    returnByValue: true,
  });

  const val = result?.value as
    | {
        completed?: boolean;
        inProgress?: boolean;
        hasIframe?: boolean;
        textLength?: number;
        placeholderOnly?: boolean;
      }
    | undefined;

  return {
    completed: val?.completed ?? false,
    inProgress: val?.inProgress ?? false,
    hasIframe: val?.hasIframe ?? false,
    textLength: val?.textLength ?? 0,
    placeholderOnly: val?.placeholderOnly ?? false,
  };
}

// ---------------------------------------------------------------------------
// DOM expression builder
// ---------------------------------------------------------------------------

function buildDeepResearchStatusExpression(): string {
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);

  return `(() => {
    const stopVisible = Boolean(document.querySelector(${stopSelector}));
    const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
      const rect = f.getBoundingClientRect();
      return rect.width > 200 && rect.height > 200;
    });
    const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
    const lastTurn = turns[turns.length - 1];
    const finished = Boolean(lastTurn?.querySelector?.(${finishedSelector}));
    const text = (lastTurn?.textContent || '').trim();
    const normalized = text.toLowerCase().replace(/\\s+/g, ' ').trim();
    const placeholderOnly = /^(called tool|used tool|użyto narzędzia|narzędzie wywołane)$/.test(normalized);
    const textLength = text.length;
    return {
      completed: finished && !placeholderOnly && textLength >= 40,
      inProgress: stopVisible || iframes.length > 0,
      hasIframe: iframes.length > 0,
      textLength,
      placeholderOnly,
    };
  })()`;
}

function buildDeepResearchCompletionPollExpression(minTurnIndex: number): string {
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);
  const turnSelector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnIndex};
    const stopVisible = Boolean(document.querySelector(${stopSelector}));
    const scopedToNewTurns = MIN_TURN_INDEX >= 0;
    const pageText = String(document.body?.innerText || '').toLowerCase().replace(/\\s+/g, ' ');
    const accountBlocked = pageText.includes('suspicious activity detected') &&
      pageText.includes('secure your account') &&
      pageText.includes('regain access');
    const isAssistantTurn = (node) => {
      const attr = String(node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      return attr === 'assistant' ||
        Boolean(node.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]')) ||
        String(node.getAttribute('data-testid') || '').toLowerCase().includes('conversation-turn') &&
          /chatgpt\\s+said/i.test(node.innerText || node.textContent || '');
    };
    const conversationTurns = Array.from(document.querySelectorAll(${turnSelector}));
    const allAssistantTurns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]'));
    const scopedTurns = scopedToNewTurns
      ? conversationTurns.slice(MIN_TURN_INDEX).filter(isAssistantTurn)
      : allAssistantTurns;
    const lastTurn = scopedTurns[scopedTurns.length - 1] || (scopedToNewTurns ? null : allAssistantTurns[allAssistantTurns.length - 1]);
    const text = (lastTurn?.textContent || '').trim();
    const normalized = text.toLowerCase().replace(/\\s+/g, ' ').trim();
    const textLength = text.length;
    const lines = text.split(/\\n+/).map(line => line.trim()).filter(Boolean);
    const tailIsPlanningPanel = text.length <= 1500 &&
      lines.length >= 4 &&
      lines.length <= 20 &&
      /^update$/i.test(lines[1] || '') &&
      /^stop research$/i.test(lines[lines.length - 1] || '') &&
      /^determining steps for creating a report(?:\\.\\.\\.)?$/i.test(lines[lines.length - 2] || '');
    const isToolStub = normalized === 'called tool' ||
      normalized === 'used tool' ||
      normalized === 'użyto narzędzia' ||
      normalized === 'narzędzie wywołane';
    const incompleteResult = isToolStub ||
      normalized === 'planning' ||
      normalized === 'researching' ||
      normalized === 'searching the web' ||
      (text.trimStart().startsWith('<system-reminder>') &&
        /<system-reminder>[\\s\\S]*#\\s*plan mode\\b/i.test(text)) ||
      tailIsPlanningPanel;
    const finished = Boolean(lastTurn?.querySelector(${finishedSelector})) &&
      textLength >= 40 &&
      !incompleteResult;
    const hasIframe = Array.from(document.querySelectorAll('iframe')).some(f => {
      const rect = f.getBoundingClientRect();
      return rect.width > 200 && rect.height > 200;
    });
    const hasScopedDeepResearchIframe = Array.from(lastTurn?.querySelectorAll?.('iframe') || []).some(f => {
      const rect = f.getBoundingClientRect();
      const descriptor = String(f.getAttribute('src') || '') + ' ' + String(f.getAttribute('name') || '');
      return rect.width > 200 && rect.height > 200 &&
        /connector_openai_deep_research|deep-research/i.test(descriptor);
    });
    const hasActiveScopedResearch = scopedToNewTurns && Boolean(lastTurn) &&
      hasScopedDeepResearchIframe &&
      (textLength < 40 || isToolStub || tailIsPlanningPanel || /chatgpt\\s+said:?$/i.test(text));
    return { finished, stopVisible, textLength, hasIframe, isToolStub, incompleteResult, researchActivity: tailIsPlanningPanel || (isToolStub && hasScopedDeepResearchIframe), hasActiveScopedResearch, accountBlocked };
  })()`;
}

export function buildDeepResearchStatusExpressionForTest(): string {
  return buildDeepResearchStatusExpression();
}

export function buildDeepResearchCompletionPollExpressionForTest(minTurnIndex = -1): string {
  return buildDeepResearchCompletionPollExpression(minTurnIndex);
}

function buildActivateDeepResearchExpression(): string {
  const plusBtnSelector = JSON.stringify(DEEP_RESEARCH_PLUS_BUTTON);
  const targetText = JSON.stringify(DEEP_RESEARCH_DROPDOWN_ITEM_TEXT);
  const pillLabel = JSON.stringify(DEEP_RESEARCH_PILL_LABEL);

  // pillLabel is used inside the expression for verification
  void pillLabel;

  return `(async () => {
    ${buildClickDispatcher()}

    const findDeepResearchPill = () => {
      const pills = document.querySelectorAll('.__composer-pill-composite, .__composer-pill, [class*="composer-pill"]');
      for (const pill of pills) {
        const text = pill.textContent?.trim() || '';
        const aria = pill.getAttribute('aria-label') ||
          pill.querySelector('button')?.getAttribute('aria-label') ||
          '';
        if (text.toLowerCase().includes('deep research') ||
            aria.toLowerCase().includes('deep research')) {
          return pill;
        }
      }
      return null;
    };

    const waitForPill = () => new Promise((resolve) => {
      let elapsed = 0;
      const tick = () => {
        if (findDeepResearchPill()) {
          resolve(true); return;
        }
        elapsed += 200;
        if (elapsed > 5000) { resolve(false); return; }
        setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
    });

    const clearComposer = (composer) => {
      if (!composer) return;
      if ('value' in composer) composer.value = '';
      else composer.textContent = '';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    };

    const setComposerText = (composer, text) => {
      composer.focus?.();
      if ('value' in composer) composer.value = text;
      else composer.textContent = text;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    };

    const findDeepResearchItem = () => {
      const target = ${targetText}.toLowerCase();
      const candidates = Array.from(document.querySelectorAll('[data-radix-collection-item], [role="option"], [cmdk-item], button, [role="menuitem"], [role="menuitemradio"]'));
      return candidates.find(item => (item.textContent || '').trim().toLowerCase() === target) || null;
    };

    // Step 0: Check if already active
    if (findDeepResearchPill()) {
      return { status: 'already-active' };
    }

    // Step 1: Prefer the official slash command flow.
    const composer = document.querySelector('[contenteditable="true"], textarea');
    if (composer) {
      setComposerText(composer, '/Deepresearch');
      await new Promise(resolve => setTimeout(resolve, 600));
      const slashItem = findDeepResearchItem();
      if (slashItem) {
        dispatchClickSequence(slashItem);
        if (await waitForPill()) return { status: 'activated' };
      }
      clearComposer(composer);
    }

    // Step 2: Fall back to the composer tools menu.
    const plusBtn = document.querySelector(${plusBtnSelector}) ||
      Array.from(document.querySelectorAll('button')).find(
        b => (b.getAttribute('aria-label') || '').toLowerCase().includes('add files')
      );
    if (!plusBtn) return { status: 'plus-button-missing' };
    dispatchClickSequence(plusBtn);

    // Step 3: Wait for dropdown
    const waitForDropdown = () => new Promise((resolve) => {
      let elapsed = 0;
      const tick = () => {
        const items = document.querySelectorAll('[data-radix-collection-item], [role="menuitem"], [role="menuitemradio"], [role="option"], [cmdk-item]');
        if (items.length > 0) { resolve(items); return; }
        elapsed += 150;
        if (elapsed > 3000) { resolve(null); return; }
        setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    });
    const items = await waitForDropdown();
    if (!items) return { status: 'dropdown-item-missing', available: [] };

    // Step 4: Find "Deep research" item
    const target = ${targetText}.toLowerCase();
    let match = null;
    const available = [];
    for (const item of items) {
      const text = (item.textContent || '').trim();
      available.push(text);
      if (text.toLowerCase() === target) {
        match = item;
      }
    }
    if (!match) return { status: 'dropdown-item-missing', available };

    // Step 5: Click it
    dispatchClickSequence(match);

    // Step 6: Verify pill appeared
    const pillConfirmed = await waitForPill();
    return pillConfirmed ? { status: 'activated' } : { status: 'pill-not-confirmed' };
  })()`;
}

export function buildActivateDeepResearchExpressionForTest(): string {
  return buildActivateDeepResearchExpression();
}
