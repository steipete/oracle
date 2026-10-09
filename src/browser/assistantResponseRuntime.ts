// Shared assistant-response pipeline helpers used by both the local-browser and
// remote-Chrome run modes in ./index.ts. Each mode previously kept its own copy
// of these closures; they now live here and receive the mode-specific pieces
// (connection domains, conversation hint emitters, runtime diagnostics) as
// parameters so both modes run one implementation.
import { readAssistantSnapshot, throwIfAssistantUiError } from "./actions/assistantResponse.js";
import { waitForResumedConversationHydration } from "./actions/navigation.js";
import { isStableConversationUrl as isConversationUrl } from "./conversationUrl.js";
import { throwChatGptUiWarningIfPresent } from "./uiWarnings.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { formatElapsed } from "../oracle/format.js";
import { delay } from "./utils.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

export type AssistantAnswerSnapshot = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

export const normalizeForComparison = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, " ").trim();

export interface FreshAssistantResponseParams {
  baselineTurns?: number;
  expectedConversationId: () => string | undefined;
  baselineNormalized: string;
  timeoutMs: number;
}

export async function waitForFreshAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  params: FreshAssistantResponseParams,
): Promise<AssistantAnswerSnapshot | null> {
  const baselinePrefix =
    params.baselineNormalized.length >= 80
      ? params.baselineNormalized.slice(0, Math.min(200, params.baselineNormalized.length))
      : "";
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(
      Runtime,
      params.baselineTurns,
      params.expectedConversationId(),
    ).catch(() => null);
    throwIfAssistantUiError(snapshot);
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (text) {
      const normalized = normalizeForComparison(text);
      const isBaseline =
        normalized === params.baselineNormalized ||
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
}

export type RuntimeDiagnostics = Record<string, unknown>;

export interface BlockingUiWarningCheckParams {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  stage: string;
  waitTarget: string;
  buildRuntimeDiagnostics: () => RuntimeDiagnostics;
}

export function createBlockingUiWarningCheck(
  params: BlockingUiWarningCheckParams,
): () => Promise<void> {
  return () =>
    throwChatGptUiWarningIfPresent({
      Runtime: params.Runtime,
      logger: params.logger,
      stage: params.stage,
      waitTarget: params.waitTarget,
      runtime: params.buildRuntimeDiagnostics(),
    });
}

export interface AssistantRecheckEnv {
  Runtime: ChromeClient["Runtime"];
  Page: ChromeClient["Page"];
  logger: BrowserLogger;
  recheckDelayMs: number;
  recheckTimeoutMs: number;
  fallbackTimeoutMs: number;
  raceWithDisconnect: <T>(operation: Promise<T>) => Promise<T>;
  waitResponse: (timeoutMs: number) => Promise<AssistantAnswerSnapshot>;
  waitWithThinkingMonitor: <T>(operation: () => Promise<T>) => Promise<T>;
  onRecheckDelayElapsed?: () => Promise<unknown>;
  onConversationUrlResolved?: (url: string) => void;
  onSessionInvalid: () => Promise<unknown>;
  onRecheckReady?: () => Promise<unknown>;
  lastUrl: () => string | undefined;
  buildRuntimeDiagnostics: () => RuntimeDiagnostics;
  readConversationUrl: (Runtime: ChromeClient["Runtime"]) => Promise<string | null>;
  validateChatGPTSession: (
    Runtime: ChromeClient["Runtime"],
    logger: BrowserLogger,
  ) => Promise<{ valid: boolean; reason?: string }>;
}

export function createAttemptAssistantRecheck(
  env: AssistantRecheckEnv,
): () => Promise<AssistantAnswerSnapshot | null> {
  return async () => {
    if (!env.recheckDelayMs) return null;
    env.logger(
      `[browser] Assistant response timed out; waiting ${formatElapsed(env.recheckDelayMs)} before rechecking conversation.`,
    );
    await env.raceWithDisconnect(delay(env.recheckDelayMs));
    await env.onRecheckDelayElapsed?.();
    const conversationUrl = await env.readConversationUrl(env.Runtime);
    if (conversationUrl && isConversationUrl(conversationUrl)) {
      env.onConversationUrlResolved?.(conversationUrl);
      env.logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
      await env.raceWithDisconnect(env.Page.navigate({ url: conversationUrl }));
      await env.raceWithDisconnect(
        waitForResumedConversationHydration(
          env.Runtime,
          env.recheckTimeoutMs || 30_000,
          env.logger,
          {
            requirePriorTurns: true,
            requirePromptReady: false,
            expectedConversationUrl: conversationUrl,
          },
        ),
      );
    }
    // Validate session before attempting recheck - sessions can expire during the delay
    const sessionValid = await env.validateChatGPTSession(env.Runtime, env.logger);
    if (!sessionValid.valid) {
      env.logger(`[browser] Session validation failed: ${sessionValid.reason}`);
      // Update session metadata to indicate login is needed
      await env.onSessionInvalid();
      throw new BrowserAutomationError(
        `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
          `Conversation URL: ${conversationUrl || env.lastUrl() || "unknown"}. ` +
          `Please sign in and retry.`,
        {
          stage: "assistant-recheck",
          details: {
            conversationUrl: conversationUrl || env.lastUrl() || null,
            sessionStatus: "needs_login",
            validationReason: sessionValid.reason,
          },
          runtime: env.buildRuntimeDiagnostics(),
        },
      );
    }
    await env.onRecheckReady?.();
    const timeoutMs = env.recheckTimeoutMs > 0 ? env.recheckTimeoutMs : env.fallbackTimeoutMs;
    const rechecked = await env.waitWithThinkingMonitor(() => env.waitResponse(timeoutMs));
    env.logger("Recovered assistant response after delayed recheck");
    return rechecked;
  };
}
