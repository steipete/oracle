import type {
  BrowserRecoveryTarget,
  BrowserRuntimeMetadata,
  SessionMetadata,
} from "../sessionStore.js";
import { randomUUID } from "node:crypto";
import { sessionStore } from "../sessionStore.js";
import { connectToRemoteChromeTarget } from "./chromeLifecycle.js";
import { resolveBrowserApprovalWait } from "./config.js";
import { extractConversationIdFromUrl } from "./reattachHelpers.js";
import { STOP_BUTTON_SELECTORS } from "./constants.js";
import type { BrowserLogger } from "./types.js";
import { hasActiveBrowserTargetLease } from "./tabLeaseRegistry.js";
import {
  buildTargetRetirementExpression,
  buildTargetRetirementRollbackExpression,
  normalizeChromeHost,
} from "./targetClaim.js";

function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface BrowserRecoveryCapture extends BrowserRecoveryTarget {
  conversationId?: string;
}

export function hasOtherLiveBrowserController(metadata: SessionMetadata): boolean {
  for (const pid of [metadata.browser?.runtime?.controllerPid, metadata.lifecycle?.workerPid]) {
    if (!pid || pid === process.pid) continue;
    if (processMayBeAlive(pid)) return true;
  }
  return false;
}

async function targetHasActiveController(
  metadata: SessionMetadata,
  capture: BrowserRecoveryCapture,
): Promise<boolean> {
  for (const other of await sessionStore.listSessions()) {
    if (other.id === metadata.id) continue;
    const runtime = other.browser?.runtime;
    if (
      runtime?.chromeTargetId !== capture.targetId ||
      runtime.chromePort !== capture.port ||
      normalizeChromeHost(runtime.chromeHost ?? "127.0.0.1") !== normalizeChromeHost(capture.host)
    )
      continue;
    if (
      [runtime.controllerPid, other.lifecycle?.workerPid].some(
        (pid) => pid && processMayBeAlive(pid),
      )
    )
      return true;
  }
  const runtime = metadata.browser?.runtime;
  const profileDirs = new Set(
    [
      runtime?.userDataDir,
      runtime?.chromeProfileRoot,
      metadata.browser?.config?.manualLoginProfileDir,
    ].filter((dir): dir is string => Boolean(dir)),
  );
  for (const dir of profileDirs) {
    if (await hasActiveBrowserTargetLease(dir, capture)) return true;
  }
  return false;
}

export function matchesOwnedRecoveryTarget(
  metadata: SessionMetadata,
  capture: BrowserRecoveryCapture | undefined,
): boolean {
  const runtime = metadata.browser?.runtime;
  const owned = runtime?.ownedRecoveryTarget;
  const conversationId =
    runtime?.conversationId ?? extractConversationIdFromUrl(runtime?.tabUrl ?? "");
  return Boolean(
    owned &&
    capture &&
    conversationId &&
    capture.conversationId === conversationId &&
    owned.targetId === capture.targetId &&
    normalizeChromeHost(owned.host) === normalizeChromeHost(capture.host) &&
    owned.port === capture.port &&
    owned.browserWSEndpoint === capture.browserWSEndpoint,
  );
}

export function recoveryCaptureFromRuntime(
  runtime: BrowserRuntimeMetadata | undefined,
): BrowserRecoveryCapture | undefined {
  const owned = runtime?.ownedRecoveryTarget;
  const conversationId =
    runtime?.conversationId ?? extractConversationIdFromUrl(runtime?.tabUrl ?? "");
  return owned && conversationId ? { ...owned, conversationId } : undefined;
}

/** Call only after the full recovered answer and completed session have been saved. */
export async function retireRecoveredBrowserTarget(
  sessionId: string,
  capture: BrowserRecoveryCapture | undefined,
  logger: BrowserLogger,
  deps: { connect?: typeof connectToRemoteChromeTarget } = {},
): Promise<void> {
  await retireOwnedBrowserTarget(sessionId, capture, logger, {
    ...deps,
    terminalStatus: "completed",
    requireIdle: true,
  });
}

/** Call only after cancellation has been persisted for the owning session. */
export async function retireCancelledBrowserTarget(
  sessionId: string,
  capture: BrowserRecoveryCapture | undefined,
  logger: BrowserLogger,
  deps: { connect?: typeof connectToRemoteChromeTarget } = {},
): Promise<void> {
  await retireOwnedBrowserTarget(sessionId, capture, logger, {
    ...deps,
    terminalStatus: "cancelled",
    requireIdle: false,
  });
}

async function retireOwnedBrowserTarget(
  sessionId: string,
  capture: BrowserRecoveryCapture | undefined,
  logger: BrowserLogger,
  options: {
    connect?: typeof connectToRemoteChromeTarget;
    terminalStatus: "completed" | "cancelled";
    requireIdle: boolean;
  },
): Promise<void> {
  if (!capture) return;
  let connection: Awaited<ReturnType<typeof connectToRemoteChromeTarget>> | undefined;
  let lockedClaim: string | undefined;
  const reservationId = randomUUID();
  let retired = false;
  try {
    const metadata = await sessionStore.readSession(sessionId);
    if (
      !metadata ||
      metadata.status !== options.terminalStatus ||
      metadata.browser?.config?.keepBrowser === true ||
      hasOtherLiveBrowserController(metadata) ||
      !matchesOwnedRecoveryTarget(metadata, capture)
    )
      return;
    const claimId = metadata.browser?.runtime?.ownedRecoveryTarget?.claimId;
    if (!claimId) return;
    const connect = options.connect ?? connectToRemoteChromeTarget;
    connection = await connect(capture.host, capture.port, logger, {
      targetId: capture.targetId,
      browserWSEndpoint: capture.browserWSEndpoint,
      closeTargetOnDispose: false,
      approvalWaitMs: resolveBrowserApprovalWait(metadata.browser?.config?.approvalWaitMs),
    });
    const { Runtime, Target } = connection.client;
    const state = await Runtime.evaluate({
      expression: `(() => ({ url: location.href, generating: Array.from(document.querySelectorAll(${JSON.stringify(STOP_BUTTON_SELECTORS.join(","))})).some(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0) }))()`,
      returnByValue: true,
    });
    const value = state.result?.value as { url?: string; generating?: boolean } | undefined;
    if (
      !value ||
      (options.requireIdle && value.generating !== false) ||
      extractConversationIdFromUrl(value.url ?? "") !== capture.conversationId
    )
      return;
    const { targetInfos } = await Target.getTargets();
    if (
      !targetInfos.some((target) => target.type === "page" && target.targetId !== capture.targetId)
    ) {
      const replacement = await Target.createTarget({ url: "about:blank" });
      if (!replacement.targetId) return;
    }
    if (await targetHasActiveController(metadata, capture)) return;
    lockedClaim = claimId;
    const locked = await Runtime.evaluate({
      expression: buildTargetRetirementExpression(claimId, capture.conversationId!, reservationId, {
        allowGenerating: !options.requireIdle,
      }),
      returnByValue: true,
    });
    if (locked.exceptionDetails || locked.result?.value !== true) return;
    const result = await Target.closeTarget({ targetId: capture.targetId });
    if (!result.success) throw new Error("Chrome refused target retirement");
    retired = true;
    logger(
      options.terminalStatus === "completed"
        ? "Retired Oracle-owned browser tab after saving the recovered answer."
        : "Retired Oracle-owned browser tab after cancellation.",
    );
  } catch (error) {
    logger(
      `${options.terminalStatus === "completed" ? "Recovered answer is saved" : "Cancellation is saved"}; browser tab cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (connection && lockedClaim && !retired) {
      await connection.client.Runtime.evaluate({
        expression: buildTargetRetirementRollbackExpression(lockedClaim, reservationId),
      }).catch(() => undefined);
    }
    await connection?.close().catch(() => undefined);
  }
}
