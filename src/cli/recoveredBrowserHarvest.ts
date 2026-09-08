import fs from "node:fs/promises";
import { sessionStore } from "../sessionStore.js";
import type { BrowserHarvestIntegrity } from "../sessionManager.js";
import type { ChatGptTabSummary } from "../browser/liveTabs.js";
import type { BrowserLogger } from "../browser/types.js";
import { isRecoveredConversationHarvestReady } from "../browser/recoverConversation.js";
import {
  hasOtherLiveBrowserController,
  matchesOwnedRecoveryTarget,
  retireRecoveredBrowserTarget,
} from "../browser/recoveryTarget.js";
import { extractConversationIdFromUrl } from "../browser/reattachHelpers.js";
import { estimateTokenCount } from "../browser/utils.js";

export async function completeOwnedBrowserHarvest(
  sessionId: string,
  harvested: ChatGptTabSummary,
  integrity: BrowserHarvestIntegrity,
  logger: BrowserLogger,
): Promise<void> {
  if (
    harvested.state !== "completed" ||
    harvested.stopExists ||
    integrity.status !== "matched" ||
    integrity.explicitTarget
  )
    return;
  const metadata = await sessionStore.readSession(sessionId);
  if (
    !metadata?.browser?.runtime?.ownedRecoveryTarget ||
    !isRecoveredConversationHarvestReady(harvested)
  )
    return;
  const runtime = metadata.browser?.runtime;
  const capture = {
    host: harvested.host ?? "",
    port: harvested.port ?? 0,
    targetId: harvested.targetId,
    browserWSEndpoint: runtime?.chromeBrowserWSEndpoint,
    conversationId: harvested.conversationId ?? extractConversationIdFromUrl(harvested.url),
  };
  if (hasOtherLiveBrowserController(metadata) || !matchesOwnedRecoveryTarget(metadata, capture))
    return;
  // Harvest previously persisted only a snippet/hash. Save the full answer before retirement.
  const answer = harvested.lastAssistantMarkdown || harvested.lastAssistantText;
  const paths = await sessionStore.getPaths(sessionId);
  await fs.appendFile(
    paths.log,
    `[reattach] harvested assistant response from existing Chrome tab\nAnswer:\n${answer}\n`,
    "utf8",
  );
  const outputTokens = estimateTokenCount(answer);
  const usage = { inputTokens: 0, outputTokens, reasoningTokens: 0, totalTokens: outputTokens };
  if (metadata.model) {
    await sessionStore.updateModelRun(sessionId, metadata.model, {
      status: "completed",
      completedAt: new Date().toISOString(),
      usage,
    });
  }
  await sessionStore.updateSession(sessionId, {
    status: "completed",
    completedAt: new Date().toISOString(),
    usage,
    errorMessage: undefined,
    error: undefined,
    transport: undefined,
    response: { status: "completed" },
  });
  await retireRecoveredBrowserTarget(sessionId, capture, logger);
}
