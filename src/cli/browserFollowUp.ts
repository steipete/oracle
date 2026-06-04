import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserSessionConfig, SessionMetadata, SessionStore } from "../sessionStore.js";
import { sessionStore, wait } from "../sessionStore.js";
import { DEFAULT_MODEL } from "../oracle/config.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { resolveRecoveryUrl } from "../browser/recoverConversation.js";
import { launchDetachedSessionFinalizer, launchDetachedSessionRunner } from "./detachedSession.js";
import { buildSessionLifecycle } from "./sessionLifecycle.js";

const DEFAULT_FOLLOW_UP_POLL_MS = 2_000;
const TERMINAL_STATUSES = new Set(["completed", "partial", "error", "cancelled"]);

export interface StartBrowserFollowUpOptions {
  prompt: string;
  slug?: string;
  wait?: boolean;
  recover?: boolean;
  files?: string[];
  cliEntrypoint?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface BrowserFollowUpDeps {
  sessionStore?: SessionStore;
  launchDetachedSessionRunner?: typeof launchDetachedSessionRunner;
  launchDetachedSessionFinalizer?: typeof launchDetachedSessionFinalizer;
}

export interface BrowserFollowUpSessionResult {
  parentSessionId: string;
  parentConversationUrl: string;
  session: SessionMetadata;
  detached: boolean;
  finalizerStarted: boolean;
  reattachCommand: string;
}

export interface WaitForFollowUpOptions {
  timeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

function resolveCliEntrypoint(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/oracle-cli.js");
}

function assertPromptOnly(files: string[] | undefined): void {
  if (files && files.length > 0) {
    throw new Error(
      "Browser follow-up is prompt-only in v1. Start a new `oracle consult` run to attach files.",
    );
  }
}

function cloneBrowserConfigForFollowUp(
  parentConfig: BrowserSessionConfig,
  conversationUrl: string,
  recover: boolean,
): BrowserSessionConfig {
  const base: BrowserSessionConfig = {
    ...parentConfig,
    browserTabRef: null,
    resumeConversationUrl: null,
    researchMode: "off",
    archiveConversations: "never",
  };
  if (!recover) {
    return {
      ...base,
      attachRunning: parentConfig.remoteChrome ? parentConfig.attachRunning : true,
      url: parentConfig.url ?? parentConfig.chatgptUrl ?? CHATGPT_URL,
      browserTabRef: conversationUrl,
      resumeConversationUrl: conversationUrl,
    };
  }
  return {
    ...base,
    url: parentConfig.chatgptUrl ?? CHATGPT_URL,
    chatgptUrl: parentConfig.chatgptUrl ?? CHATGPT_URL,
    resumeConversationUrl: conversationUrl,
  };
}

export function resolveBrowserFollowUpParent(
  parent: SessionMetadata | null,
  parentSessionId: string,
): {
  parent: SessionMetadata;
  conversationUrl: string;
  browserConfig: BrowserSessionConfig;
} {
  if (!parent) {
    throw new Error(`No parent session found with ID ${parentSessionId}.`);
  }
  if (parent.mode !== "browser") {
    throw new Error(`Parent session ${parent.id} is not a browser session.`);
  }
  const browserConfig = parent.browser?.config;
  if (!browserConfig) {
    throw new Error(`Parent session ${parent.id} is missing browser configuration.`);
  }
  const conversationUrl = resolveRecoveryUrl(parent);
  if (!conversationUrl) {
    throw new Error(
      `Parent session ${parent.id} has no recoverable ChatGPT conversation URL. Run ` +
        `\`oracle session ${parent.id} --harvest\` first, or start a new consult.`,
    );
  }
  return { parent, conversationUrl, browserConfig };
}

export async function startBrowserFollowUpSession(
  parentSessionId: string,
  options: StartBrowserFollowUpOptions,
  deps: BrowserFollowUpDeps = {},
): Promise<BrowserFollowUpSessionResult> {
  const store = deps.sessionStore ?? sessionStore;
  const launchRunner = deps.launchDetachedSessionRunner ?? launchDetachedSessionRunner;
  const launchFinalizer = deps.launchDetachedSessionFinalizer ?? launchDetachedSessionFinalizer;
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required for browser follow-up.");
  }
  assertPromptOnly(options.files);

  await store.ensureStorage();
  const { parent, conversationUrl, browserConfig } = resolveBrowserFollowUpParent(
    await store.readSession(parentSessionId),
    parentSessionId,
  );
  const recover = options.recover !== false;
  const childBrowserConfig = cloneBrowserConfigForFollowUp(browserConfig, conversationUrl, recover);
  const waitPreference = options.wait ?? parent.options?.waitPreference ?? false;
  const model = parent.options?.model ?? parent.model ?? DEFAULT_MODEL;
  const cwd = parent.cwd ?? process.cwd();
  const child = await store.createSession(
    {
      prompt,
      model,
      mode: "browser",
      browserConfig: childBrowserConfig,
      parentSessionId: parent.id,
      followUpOfSessionId: parent.id,
      waitPreference,
      verbose: parent.options?.verbose,
      heartbeatIntervalMs: parent.options?.heartbeatIntervalMs,
      browserAttachments: "never",
      slug: options.slug,
    },
    cwd,
    parent.notifications,
    options.slug ? undefined : `${parent.id}-follow-up`,
  );

  const cliEntrypoint = options.cliEntrypoint ?? resolveCliEntrypoint();
  const launchOptions = { cliEntrypoint, env: options.env };
  const detached = await launchRunner(child.id, launchOptions);
  const finalizerStarted = await launchFinalizer(child.id, launchOptions).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`[follow-up] Unable to launch detached finalizer: ${message}`);
    return false;
  });
  const lifecycle = buildSessionLifecycle({
    engine: "browser",
    detached,
    reattachCommand: `oracle session ${child.id}`,
  });
  const session = await store.updateSession(child.id, {
    lifecycle,
    parentSessionId: parent.id,
    followUpOfSessionId: parent.id,
  });
  return {
    parentSessionId: parent.id,
    parentConversationUrl: conversationUrl,
    session,
    detached,
    finalizerStarted,
    reattachCommand: `oracle session ${child.id} --render`,
  };
}

export async function waitForFollowUpSession(
  sessionId: string,
  options: WaitForFollowUpOptions = {},
): Promise<SessionMetadata | null> {
  const pollMs = options.pollMs ?? DEFAULT_FOLLOW_UP_POLL_MS;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
  const deadline = Number.isFinite(timeoutMs) ? now() + timeoutMs : Number.POSITIVE_INFINITY;
  let lastStatus = "";
  while (now() < deadline) {
    const metadata = await sessionStore.readSession(sessionId);
    if (!metadata) {
      return null;
    }
    if (metadata.status !== lastStatus) {
      lastStatus = metadata.status;
      options.log?.(`[follow-up] Session ${sessionId} status: ${metadata.status}`);
    }
    if (TERMINAL_STATUSES.has(metadata.status)) {
      return metadata;
    }
    await wait(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  return sessionStore.readSession(sessionId);
}

export async function readFollowUpLogTail(
  sessionId: string,
  maxBytes = 4000,
): Promise<string | undefined> {
  try {
    const log = await sessionStore.readLog(sessionId);
    return log.length > maxBytes ? log.slice(-maxBytes) : log;
  } catch {
    return undefined;
  }
}
