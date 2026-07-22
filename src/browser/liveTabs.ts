import CDP from "chrome-remote-interface";
import { createHash } from "node:crypto";
import type { SessionMetadata, BrowserHarvestState } from "../sessionStore.js";
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  INPUT_SELECTORS,
  MODEL_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTOR,
} from "./constants.js";
import { captureAssistantMarkdown, readAssistantSnapshot } from "./actions/assistantResponse.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
import { extractStableConversationIdFromUrl } from "./conversationUrl.js";
import { delay } from "./utils.js";

export const DEFAULT_REMOTE_CHROME_HOST = "127.0.0.1";
export const DEFAULT_REMOTE_CHROME_PORT = 9222;

const LOGIN_CTA_PATTERN =
  /\b(log in|login|sign up|sign in|continue with google|continue with microsoft)\b/i;

interface ChromeTarget {
  id?: string;
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
}

interface HostPort {
  host?: string;
  port?: number;
}

export interface ChatGptTabSummary {
  host?: string;
  port?: number;
  targetId: string;
  title: string;
  url: string;
  currentModelLabel: string;
  stopExists: boolean;
  sendExists: boolean;
  promptReady: boolean;
  loginButtonExists: boolean;
  authenticated: boolean;
  assistantCount: number;
  lastAssistantText: string;
  assistantFollowsLatestUser?: boolean;
  lastAssistantTurnIndex?: number;
  lastUserTurnIndex?: number;
  lastAssistantSnippet: string;
  lastUserText: string;
  lastUserSnippet: string;
  focused: boolean;
  visibilityState: string;
  conversationId?: string;
  fingerprint: string;
  state: BrowserHarvestState;
  error?: string;
  lastAssistantMarkdown: string | null;
  lastAssistantMessageId?: string;
  lastAssistantTurnId?: string;
}

interface ResolveChatGptTabOptions extends HostPort {
  ref?: string;
}

interface InspectChatGptTabOptions extends HostPort {
  target: ChromeTarget;
}

interface HarvestChatGptTabOptions extends ResolveChatGptTabOptions {
  target?: ChromeTarget;
  stallWindowMs?: number;
}

const noopLogger = Object.assign((_message: string) => {}, {}) as ((message: string) => void) & {
  verbose?: boolean;
};

function trimToSnippet(text: string, max = 140): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeHostPort(input: HostPort = {}): Required<HostPort> {
  return {
    host: input.host ?? DEFAULT_REMOTE_CHROME_HOST,
    port: input.port ?? DEFAULT_REMOTE_CHROME_PORT,
  };
}

function normalizeUrl(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeTitle(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTargetFingerprint(
  summary: Pick<ChatGptTabSummary, "targetId" | "url" | "lastAssistantText">,
): string {
  return createHash("sha1")
    .update(`${summary.targetId ?? ""}|${summary.url ?? ""}|${summary.lastAssistantText ?? ""}`)
    .digest("hex");
}

function isChatGptUrl(url: string): boolean {
  const normalized = normalizeUrl(url).toLowerCase();
  return (
    normalized.startsWith("https://chatgpt.com") || normalized.startsWith("https://chat.openai.com")
  );
}

function isChatGptConversationUrl(url: string): boolean {
  return /\/c\//.test(normalizeUrl(url));
}

function isChatGptTarget(target: ChromeTarget): boolean {
  if (!target || target.type !== "page") {
    return false;
  }
  return isChatGptUrl(target.url ?? "") || /chatgpt/i.test(target.title ?? "");
}

function extractTargetId(target: ChromeTarget | undefined | null): string | null {
  return target?.targetId ?? target?.id ?? null;
}

function escapeLiteral(value: string): string {
  return JSON.stringify(value);
}

function buildTabInspectionExpression(): string {
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const sendSelectorsLiteral = JSON.stringify(SEND_BUTTON_SELECTORS);
  const answerSelectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const assistantRoleLiteral = escapeLiteral(ASSISTANT_ROLE_SELECTOR);
  const modelButtonSelectorLiteral = escapeLiteral(MODEL_BUTTON_SELECTOR);
  const stopSelectorLiteral = escapeLiteral(STOP_BUTTON_SELECTOR);
  return `(() => {
      const INPUT_SELECTORS = ${inputSelectorsLiteral};
      const SEND_SELECTORS = ${sendSelectorsLiteral};
      const ANSWER_SELECTORS = ${answerSelectorsLiteral};
      const ASSISTANT_ROLE_SELECTOR = ${assistantRoleLiteral};
      const MODEL_BUTTON_SELECTOR = ${modelButtonSelectorLiteral};
      const STOP_BUTTON_SELECTOR = ${stopSelectorLiteral};
      const LOGIN_CTA = ${LOGIN_CTA_PATTERN.toString()};
      const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const isVisible = (node) => {
        if (!(node instanceof Element)) return false;
        const style = window.getComputedStyle(node);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const firstVisible = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && isVisible(node)) return node;
        }
        return null;
      };
      const loginButtonExists = Array.from(document.querySelectorAll('button,a,[role="button"]')).some((node) => {
        const label = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'));
        return LOGIN_CTA.test(label);
      });
      const stopButton = document.querySelector(STOP_BUTTON_SELECTOR);
      const stopExists = Boolean(stopButton && isVisible(stopButton));
      const sendButton = firstVisible(SEND_SELECTORS);
      const sendExists = Boolean(sendButton);
      const promptNode = firstVisible(INPUT_SELECTORS);
      const promptReady = Boolean(promptNode);
      const turns = ${buildConversationTurnListExpression()};
      const assistantTurns = turns.filter((turn) => {
        const role = normalize(turn.getAttribute('data-message-author-role') || turn.getAttribute('data-turn')).toLowerCase();
        if (role === 'assistant') return true;
        return Boolean(turn.querySelector(ASSISTANT_ROLE_SELECTOR));
      });
      const fallbackUserTurns = Array.from(
        document.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'),
      );
      const userTurns = turns.filter((turn) => {
        const role = normalize(turn.getAttribute('data-message-author-role') || turn.getAttribute('data-turn')).toLowerCase();
        if (role === 'user') return true;
        return Boolean(
          turn.querySelector('[data-message-author-role="user"], [data-turn="user"]'),
        );
      });
      const answerNode = ANSWER_SELECTORS
        .map((selector) => document.querySelectorAll(selector))
        .find((matches) => matches && matches.length > 0);
      const currentModelButton = document.querySelector(MODEL_BUTTON_SELECTOR);
      const hasProPill = Boolean(document.querySelector('button.__composer-pill, button[aria-label="Pro, click to remove"]'));
      let currentModelLabel = normalize(currentModelButton?.textContent || currentModelButton?.getAttribute?.('aria-label') || '');
      if (currentModelLabel === 'ChatGPT' && hasProPill) {
        currentModelLabel = 'ChatGPT + Pro';
      }
      const rawAnswerNodes = Array.from(answerNode || []);
      const userCandidates = Array.from(new Set([...userTurns, ...fallbackUserTurns]));
      const lastUserTurn = userCandidates.reduce((latest, candidate) => {
        if (!latest) return candidate;
        return latest.compareDocumentPosition(candidate) & 4 ? candidate : latest;
      }, null);
      const lastUserContainer = lastUserTurn
        ? turns.find((turn) => turn === lastUserTurn || turn.contains?.(lastUserTurn))
        : null;
      const answerNodes = rawAnswerNodes.filter(
        (node) =>
          !lastUserTurn ||
          (node !== lastUserTurn &&
            !lastUserTurn.contains?.(node) &&
            !node.contains?.(lastUserTurn)),
      );
      const answerTexts = answerNodes.map((node) => normalize(node.textContent)).filter(Boolean);
      const assistantCandidates = Array.from(new Set([...assistantTurns, ...answerNodes]));
      const lastAssistantNode = assistantCandidates.reduce((latest, candidate) => {
        if (!latest) return candidate;
        return latest.compareDocumentPosition(candidate) & 4 ? candidate : latest;
      }, null);
      const lastAssistantContainer = lastAssistantNode
        ? turns.find((turn) => turn === lastAssistantNode || turn.contains?.(lastAssistantNode))
        : null;
      const assistantFollowsLatestUser = Boolean(
        lastAssistantNode &&
        lastUserTurn &&
        lastAssistantNode !== lastUserTurn &&
        (lastUserTurn.compareDocumentPosition(lastAssistantNode) & 4),
      );
      const lastAssistantTurnIndex = lastAssistantContainer
        ? turns.indexOf(lastAssistantContainer)
        : -1;
      const lastUserTurnIndex = lastUserContainer ? turns.indexOf(lastUserContainer) : -1;
      const assistantOwners = assistantCandidates.map(
        (node) => turns.find((turn) => turn === node || turn.contains?.(node)) || node,
      );
      const assistantCount = new Set(assistantOwners).size;
      const lastAssistantText = normalize(lastAssistantNode?.textContent);
      const lastUserText = normalize(lastUserTurn?.textContent);
      const authenticated = !loginButtonExists && (promptReady || sendExists || stopExists || assistantCount > 0);
      return {
        title: normalize(document.title),
        url: location.href,
        currentModelLabel,
        stopExists,
        sendExists,
        promptReady,
        loginButtonExists,
        authenticated,
        assistantCount,
        lastAssistantText,
        assistantFollowsLatestUser,
        lastAssistantTurnIndex,
        lastUserTurnIndex,
        lastUserText,
        visibilityState: document.visibilityState,
        focused: Boolean(document.hasFocus?.()),
      };
    })()`;
}

export function buildTabInspectionExpressionForTest(): string {
  return buildTabInspectionExpression();
}

export async function listChatGptTargets(options: HostPort = {}): Promise<ChromeTarget[]> {
  const { host, port } = normalizeHostPort(options);
  const targets = (await CDP.List({ host, port })) as ChromeTarget[];
  return targets.filter(isChatGptTarget);
}

export async function openChatGptTarget(
  options: HostPort & { url?: string } = {},
): Promise<string> {
  const { host, port } = normalizeHostPort(options);
  const url = options.url ?? "https://chatgpt.com/";
  const target = await CDP.New({ host, port, url });
  return target.id;
}

async function connectToTarget(host: string, port: number, targetId: string) {
  const client = await CDP({ host, port, target: targetId });
  const { Runtime, DOM } = client;
  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM?.enable) {
    await DOM.enable();
  }
  return client;
}

export async function inspectChatGptTab(
  options: InspectChatGptTabOptions,
): Promise<ChatGptTabSummary> {
  const { host, port } = normalizeHostPort(options);
  const target = options.target;
  const targetId = extractTargetId(target);
  if (!targetId) {
    throw new Error("inspectChatGptTab requires a target with targetId.");
  }

  const client = await connectToTarget(host, port, targetId);
  try {
    const { Runtime } = client;
    const evaluation = await Runtime.evaluate({
      expression: buildTabInspectionExpression(),
      returnByValue: true,
      awaitPromise: true,
    });
    const info = (evaluation.result?.value ?? {}) as {
      title?: string;
      url?: string;
      currentModelLabel?: string;
      stopExists?: boolean;
      sendExists?: boolean;
      promptReady?: boolean;
      loginButtonExists?: boolean;
      authenticated?: boolean;
      assistantCount?: number;
      lastAssistantText?: string;
      assistantFollowsLatestUser?: boolean;
      lastAssistantTurnIndex?: number;
      lastUserTurnIndex?: number;
      lastUserText?: string;
      visibilityState?: string;
      focused?: boolean;
    };
    const snapshot = await readAssistantSnapshot(Runtime).catch(() => null);
    const inspectedAssistantTurnIndex =
      typeof info.lastAssistantTurnIndex === "number" && info.lastAssistantTurnIndex >= 0
        ? info.lastAssistantTurnIndex
        : undefined;
    const normalizedSnapshotText = normalizeTitle(snapshot?.text ?? "").toLowerCase();
    const normalizedInspectedText = normalizeTitle(info.lastAssistantText ?? "").toLowerCase();
    const snapshotMatchesInspectedTurn =
      (typeof snapshot?.turnIndex === "number" &&
        snapshot.turnIndex === inspectedAssistantTurnIndex) ||
      (snapshot?.turnIndex == null &&
        inspectedAssistantTurnIndex === undefined &&
        normalizedSnapshotText.length > 0 &&
        normalizedSnapshotText === normalizedInspectedText);
    const lastAssistantText =
      snapshotMatchesInspectedTurn &&
      typeof snapshot?.text === "string" &&
      snapshot.text.trim().length > 0
        ? snapshot.text.trim()
        : String(info.lastAssistantText ?? "").trim();
    const lastUserText = String(info.lastUserText ?? "").trim();
    const summary: ChatGptTabSummary = {
      host,
      port,
      targetId,
      title: normalizeTitle(info.title ?? target.title ?? ""),
      url: normalizeUrl(info.url ?? target.url ?? ""),
      currentModelLabel: normalizeTitle(info.currentModelLabel ?? ""),
      stopExists: Boolean(info.stopExists),
      sendExists: Boolean(info.sendExists),
      promptReady: Boolean(info.promptReady),
      loginButtonExists: Boolean(info.loginButtonExists),
      authenticated: Boolean(info.authenticated),
      assistantCount: Number.isFinite(info.assistantCount) ? Number(info.assistantCount) : 0,
      lastAssistantText,
      assistantFollowsLatestUser: Boolean(info.assistantFollowsLatestUser),
      lastAssistantTurnIndex: inspectedAssistantTurnIndex,
      lastUserTurnIndex:
        typeof info.lastUserTurnIndex === "number" && info.lastUserTurnIndex >= 0
          ? info.lastUserTurnIndex
          : undefined,
      lastAssistantSnippet: trimToSnippet(lastAssistantText),
      lastUserText,
      lastUserSnippet: trimToSnippet(lastUserText),
      focused: Boolean(info.focused),
      visibilityState: typeof info.visibilityState === "string" ? info.visibilityState : "",
      conversationId: extractConversationIdFromUrl(info.url ?? target.url ?? ""),
      fingerprint: "",
      state: "detached",
      lastAssistantMarkdown: null,
      lastAssistantMessageId:
        snapshotMatchesInspectedTurn && typeof snapshot?.messageId === "string"
          ? snapshot.messageId
          : undefined,
      lastAssistantTurnId:
        snapshotMatchesInspectedTurn && typeof snapshot?.turnId === "string"
          ? snapshot.turnId
          : undefined,
    };
    summary.state = classifyTabState(summary);
    summary.fingerprint = buildTargetFingerprint(summary);
    return summary;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function classifyTabState(
  summary: Pick<
    ChatGptTabSummary,
    "authenticated" | "stopExists" | "sendExists" | "promptReady" | "assistantCount"
  >,
): BrowserHarvestState {
  if (!summary?.authenticated) {
    return "detached";
  }
  if (summary.stopExists) {
    return "running";
  }
  if (summary.sendExists || summary.promptReady || summary.assistantCount > 0) {
    return "completed";
  }
  return "detached";
}

export async function collectChatGptTabs(options: HostPort = {}): Promise<ChatGptTabSummary[]> {
  const { host, port } = normalizeHostPort(options);
  const targets = await listChatGptTargets({ host, port });
  const summaries: ChatGptTabSummary[] = [];
  for (const target of targets) {
    try {
      const summary = await inspectChatGptTab({ host, port, target });
      summaries.push(summary);
    } catch (error) {
      summaries.push({
        host,
        port,
        targetId: extractTargetId(target) ?? "",
        title: normalizeTitle(target.title ?? ""),
        url: normalizeUrl(target.url ?? ""),
        currentModelLabel: "",
        stopExists: false,
        sendExists: false,
        promptReady: false,
        loginButtonExists: false,
        authenticated: false,
        assistantCount: 0,
        lastAssistantText: "",
        lastAssistantSnippet: "",
        lastUserText: "",
        lastUserSnippet: "",
        focused: false,
        visibilityState: "",
        conversationId: extractConversationIdFromUrl(target.url ?? ""),
        fingerprint: "",
        state: "detached",
        error: error instanceof Error ? error.message : String(error),
        lastAssistantMarkdown: null,
      });
    }
  }
  return summaries.sort((left, right) => {
    const leftScore = (left.focused ? 100 : 0) + (isChatGptConversationUrl(left.url) ? 10 : 0);
    const rightScore = (right.focused ? 100 : 0) + (isChatGptConversationUrl(right.url) ? 10 : 0);
    return rightScore - leftScore;
  });
}

function resolveChatGptTabFromSummaries(
  summaries: ChatGptTabSummary[],
  ref?: string,
): ChatGptTabSummary {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    throw new Error("No live ChatGPT tabs found on the configured Chrome DevTools endpoint.");
  }
  const trimmedRef = String(ref ?? "").trim();
  if (!trimmedRef || trimmedRef.toLowerCase() === "current") {
    return summaries[0] as ChatGptTabSummary;
  }
  const exactId = summaries.find((tab) => tab.targetId === trimmedRef);
  if (exactId) {
    return exactId;
  }
  const exactUrl = summaries.find((tab) => tab.url === trimmedRef);
  if (exactUrl) {
    return exactUrl;
  }
  const exactConversationId = summaries.find((tab) => tab.conversationId === trimmedRef);
  if (exactConversationId) {
    return exactConversationId;
  }
  const lower = trimmedRef.toLowerCase();
  const titleMatches = summaries.filter((tab) => tab.title.toLowerCase().includes(lower));
  if (titleMatches.length === 1) {
    return titleMatches[0] as ChatGptTabSummary;
  }
  if (titleMatches.length > 1) {
    const details = titleMatches
      .map((tab) => `${tab.targetId}: ${tab.title || "(untitled)"} — ${tab.url}`)
      .join("\n");
    throw new Error(`Multiple ChatGPT tabs match "${trimmedRef}":\n${details}`);
  }
  throw new Error(
    `No ChatGPT tab matched "${trimmedRef}". Use "oracle-tabs" or "oracle status --browser-tabs" to inspect live targets.`,
  );
}

export function resolveChatGptTabFromSummariesForTest(
  summaries: ChatGptTabSummary[],
  ref?: string,
): ChatGptTabSummary {
  return resolveChatGptTabFromSummaries(summaries, ref);
}

export async function resolveChatGptTab(
  options: ResolveChatGptTabOptions = {},
): Promise<ChatGptTabSummary> {
  const { host, port } = normalizeHostPort(options);
  const summaries = await collectChatGptTabs({ host, port });
  return resolveChatGptTabFromSummaries(summaries, options.ref);
}

export async function connectToExistingChatGptTab(
  options: ResolveChatGptTabOptions = {},
): Promise<{ client: Awaited<ReturnType<typeof CDP>>; targetId: string; tab: ChatGptTabSummary }> {
  const { host, port } = normalizeHostPort(options);
  const tab = await resolveChatGptTab({ host, port, ref: options.ref });
  const client = await connectToTarget(host, port, tab.targetId);
  return { client, targetId: tab.targetId, tab };
}

export async function harvestChatGptTab(
  options: HarvestChatGptTabOptions = {},
): Promise<ChatGptTabSummary> {
  const { host, port } = normalizeHostPort(options);
  const resolved = options.target
    ? await inspectChatGptTab({ host, port, target: options.target })
    : await resolveChatGptTab({ host, port, ref: options.ref });
  const client = await connectToTarget(host, port, resolved.targetId);
  try {
    const { Runtime } = client;
    const snapshot = await readAssistantSnapshot(Runtime).catch(() => null);
    const nowSummary = await inspectChatGptTab({
      host,
      port,
      target: {
        targetId: resolved.targetId,
        title: resolved.title,
        url: resolved.url,
        type: "page",
      },
    });
    const normalizedSnapshotText = normalizeTitle(snapshot?.text ?? "").toLowerCase();
    const normalizedInspectedText = normalizeTitle(nowSummary.lastAssistantText).toLowerCase();
    const snapshotMatchesLatestTurn =
      (typeof snapshot?.turnIndex === "number" &&
        snapshot.turnIndex === nowSummary.lastAssistantTurnIndex) ||
      (snapshot?.turnIndex == null &&
        nowSummary.lastAssistantTurnIndex === undefined &&
        normalizedSnapshotText.length > 0 &&
        normalizedSnapshotText === normalizedInspectedText);
    let assistantMarkdown: string | null = null;
    if (snapshotMatchesLatestTurn && (snapshot?.messageId || snapshot?.turnId)) {
      assistantMarkdown = await captureAssistantMarkdown(
        Runtime,
        {
          messageId: snapshot.messageId,
          turnId: snapshot.turnId,
        },
        noopLogger,
      ).catch(() => null);
    }
    const lastAssistantText =
      snapshotMatchesLatestTurn &&
      typeof snapshot?.text === "string" &&
      snapshot.text.trim().length > 0
        ? snapshot.text.trim()
        : nowSummary.lastAssistantText;
    const harvested: ChatGptTabSummary = {
      ...nowSummary,
      lastAssistantText,
      lastAssistantSnippet: trimToSnippet(lastAssistantText),
      lastAssistantMarkdown: assistantMarkdown ?? (lastAssistantText || null),
      lastAssistantMessageId:
        snapshotMatchesLatestTurn && typeof snapshot?.messageId === "string"
          ? snapshot.messageId
          : nowSummary.lastAssistantMessageId,
      lastAssistantTurnId:
        snapshotMatchesLatestTurn && typeof snapshot?.turnId === "string"
          ? snapshot.turnId
          : nowSummary.lastAssistantTurnId,
    };
    if (harvested.stopExists && options.stallWindowMs && options.stallWindowMs > 0) {
      const firstFingerprint = harvested.fingerprint;
      await delay(options.stallWindowMs);
      const followup = await inspectChatGptTab({
        host,
        port,
        target: {
          targetId: harvested.targetId,
          title: harvested.title,
          url: harvested.url,
          type: "page",
        },
      });
      harvested.stopExists = followup.stopExists;
      harvested.sendExists = followup.sendExists;
      harvested.promptReady = followup.promptReady;
      harvested.currentModelLabel = followup.currentModelLabel;
      harvested.focused = followup.focused;
      harvested.visibilityState = followup.visibilityState;
      harvested.assistantCount = followup.assistantCount;
      harvested.authenticated = followup.authenticated;
      harvested.loginButtonExists = followup.loginButtonExists;
      harvested.lastUserText = followup.lastUserText;
      harvested.lastUserSnippet = followup.lastUserSnippet;
      harvested.assistantFollowsLatestUser = followup.assistantFollowsLatestUser;
      harvested.lastAssistantTurnIndex = followup.lastAssistantTurnIndex;
      harvested.lastUserTurnIndex = followup.lastUserTurnIndex;
      harvested.fingerprint = followup.fingerprint;
      harvested.state =
        harvested.stopExists && firstFingerprint === followup.fingerprint
          ? "stalled"
          : classifyTabState(harvested);
    } else {
      harvested.state = classifyTabState(harvested);
    }
    return harvested;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  return extractStableConversationIdFromUrl(normalizeUrl(url));
}

export function formatBrowserTabState(
  tab: Pick<
    ChatGptTabSummary,
    "state" | "authenticated" | "stopExists" | "sendExists" | "promptReady" | "assistantCount"
  >,
): BrowserHarvestState {
  return tab.state ?? classifyTabState(tab);
}

export function sessionMatchesTab(meta: SessionMetadata, tab: Partial<ChatGptTabSummary>): boolean {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  const conversationId = tab.conversationId ?? extractConversationIdFromUrl(tab.url ?? "");
  const portMatches = [runtime.chromePort, meta?.browser?.config?.remoteChrome?.port]
    .filter(Boolean)
    .some(
      (port) =>
        Number(port) === Number(DEFAULT_REMOTE_CHROME_PORT) ||
        Number(port) === Number(tab.port ?? port),
    );
  const hostMatches = [runtime.chromeHost, meta?.browser?.config?.remoteChrome?.host]
    .filter(Boolean)
    .every((host) => !host || host === (tab.host ?? host));
  if (!hostMatches) {
    return false;
  }
  const matches = [
    runtime.chromeTargetId && runtime.chromeTargetId === tab.targetId,
    harvest.targetId && harvest.targetId === tab.targetId,
    runtime.tabUrl && runtime.tabUrl === tab.url,
    harvest.url && harvest.url === tab.url,
    conversationId && runtime.conversationId && runtime.conversationId === conversationId,
    conversationId && harvest.conversationId && harvest.conversationId === conversationId,
  ].some(Boolean);
  return Boolean(
    matches ||
    (portMatches &&
      conversationId &&
      (runtime.conversationId === conversationId || harvest.conversationId === conversationId)),
  );
}
