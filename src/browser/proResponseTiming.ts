import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { BrowserRuntimeMetadata, ProResponseTimingReceipt } from "../sessionStore.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { normalizeThinkingTimeLevel } from "../oracle/thinkingTime.js";
import type { BrowserAttachment, BrowserAutomationConfig } from "./types.js";

type ProResponseTimingConfig = Pick<BrowserAutomationConfig, "modelStrategy" | "thinkingTime">;

const TERMINAL_CODES = new Set([
  "dispatch-timestamp-missing",
  "pro-attachment-size-invalid",
  "pro-attachment-size-unavailable",
  "pro-response-timing-indeterminate",
  "pro-turn-identity-mismatch",
  "pro-turn-identity-missing",
  "pro-turn-not-committed",
  "pro-workload-receipt-invalid",
  "pro-workload-receipt-missing",
]);

export function isTerminalProResponseTimingCode(code: unknown): boolean {
  return typeof code === "string" && TERMINAL_CODES.has(code);
}

export function requiresProResponseTiming(config: ProResponseTimingConfig): boolean {
  return (
    config.modelStrategy !== "ignore" && normalizeThinkingTimeLevel(config.thinkingTime) === "pro"
  );
}

function isValidElapsed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidWorkload(value: unknown): value is number {
  return isValidElapsed(value) && Number.isSafeInteger(value);
}

export function elapsedSinceDispatch(
  dispatchAt: string | undefined,
  capturedAt: Date,
): number | undefined {
  if (!dispatchAt) return undefined;
  const elapsedMs = capturedAt.getTime() - Date.parse(dispatchAt);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
}

export function recordProResponseTiming(
  runtime: BrowserRuntimeMetadata,
  capturedAt: Date,
  options: { requireTimestamp?: boolean } = {},
): BrowserRuntimeMetadata {
  const elapsedFromDispatch = elapsedSinceDispatch(runtime.proDispatchAt, capturedAt);
  const responseElapsedMs =
    runtime.proResponseElapsedMs === undefined
      ? elapsedFromDispatch
      : isValidElapsed(runtime.proResponseElapsedMs)
        ? runtime.proResponseElapsedMs
        : undefined;
  const enrichedRuntime = { ...runtime, proResponseElapsedMs: responseElapsedMs };

  if (options.requireTimestamp && elapsedFromDispatch === undefined) {
    throw new BrowserAutomationError(
      "Browser returned an answer without a valid Pro dispatch timestamp.",
      {
        stage: "response-timing",
        code: "dispatch-timestamp-missing",
        runtime: enrichedRuntime,
      },
    );
  }
  return enrichedRuntime;
}

export function normalizeProPromptIdentity(prompt: string): string {
  let text = prompt.toLowerCase();
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/gu, " $1 ");
  text = text.replace(/```/gu, " ");
  text = text.replace(/`([^`]*)`/gu, "$1");
  return text.replace(/\s+/gu, " ").trim();
}

export function hashProPromptIdentity(prompt: string): string {
  return createHash("sha256").update(normalizeProPromptIdentity(prompt)).digest("hex");
}

export async function resolveProAttachmentBytes(attachments: BrowserAttachment[]): Promise<number> {
  let total = 0;
  for (const attachment of attachments) {
    let sizeBytes = attachment.sizeBytes;
    if (sizeBytes === undefined) {
      try {
        sizeBytes = (await stat(attachment.path)).size;
      } catch (error) {
        throw new BrowserAutomationError(
          "Oracle could not establish an attachment size before Pro dispatch.",
          {
            stage: "response-timing",
            code: "pro-attachment-size-unavailable",
            attachment: attachment.displayPath,
          },
          error,
        );
      }
    }
    if (!isValidWorkload(sizeBytes) || !Number.isSafeInteger(total + sizeBytes)) {
      throw new BrowserAutomationError(
        "Oracle received an invalid attachment size before Pro dispatch.",
        {
          stage: "response-timing",
          code: "pro-attachment-size-invalid",
          attachment: attachment.displayPath,
        },
      );
    }
    total += sizeBytes;
  }
  return total;
}

export function beginProResponseTimingTurn(
  runtime: BrowserRuntimeMetadata,
  workload: { inputTokens: number; attachmentBytes: number; prompt: string },
): BrowserRuntimeMetadata {
  if (!isValidWorkload(workload.inputTokens) || !isValidWorkload(workload.attachmentBytes)) {
    throw new BrowserAutomationError("Oracle could not establish the Pro turn workload.", {
      stage: "response-timing",
      code: "pro-workload-receipt-invalid",
      runtime,
    });
  }
  return {
    ...runtime,
    proDispatchAt: undefined,
    proResponseElapsedMs: undefined,
    proInputTokens: workload.inputTokens,
    proAttachmentBytes: workload.attachmentBytes,
    proTurnIndex: runtime.proResponseTimingReceipts?.length ?? 0,
    proTurnCommitted: false,
    proPromptSha256: hashProPromptIdentity(workload.prompt),
    proCommittedTurnIndex: undefined,
  };
}

export function markProPromptDispatched(
  runtime: BrowserRuntimeMetadata,
  dispatchedAt = new Date(),
): BrowserRuntimeMetadata {
  return runtime.proDispatchAt
    ? runtime
    : { ...runtime, proDispatchAt: dispatchedAt.toISOString() };
}

export function markProPromptCommitted(
  runtime: BrowserRuntimeMetadata,
  committedUserTurnIndex: number | null,
): BrowserRuntimeMetadata {
  const index =
    typeof committedUserTurnIndex === "number" &&
    Number.isSafeInteger(committedUserTurnIndex) &&
    committedUserTurnIndex >= 0
      ? committedUserTurnIndex
      : undefined;
  return { ...runtime, proTurnCommitted: true, proCommittedTurnIndex: index };
}

export function hasProResponseTimingMarker(runtime: BrowserRuntimeMetadata): boolean {
  return (
    runtime.proDispatchAt !== undefined ||
    runtime.proResponseElapsedMs !== undefined ||
    runtime.proInputTokens !== undefined ||
    runtime.proAttachmentBytes !== undefined ||
    runtime.proTurnIndex !== undefined ||
    runtime.proTurnCommitted !== undefined ||
    runtime.proPromptSha256 !== undefined ||
    runtime.proCommittedTurnIndex !== undefined ||
    runtime.proResponseTimingReceipts !== undefined
  );
}

function throwIndeterminate(runtime: BrowserRuntimeMetadata): never {
  throw new BrowserAutomationError(
    "Oracle found a Pro timing marker but could not establish a valid response elapsed time.",
    { stage: "response-timing", code: "pro-response-timing-indeterminate", runtime },
  );
}

export function assertCompleteProResponseTimingReceipt(runtime: BrowserRuntimeMetadata): void {
  if (!hasProResponseTimingMarker(runtime)) return;
  if (runtime.proTurnCommitted !== true) {
    throw new BrowserAutomationError(
      "Oracle found Pro response metadata without a verified committed user turn.",
      { stage: "response-timing", code: "pro-turn-not-committed", runtime },
    );
  }
  if (
    !isValidWorkload(runtime.proTurnIndex) ||
    !/^[a-f0-9]{64}$/u.test(runtime.proPromptSha256 ?? "") ||
    !isValidWorkload(runtime.proCommittedTurnIndex)
  ) {
    throw new BrowserAutomationError(
      "Oracle found Pro response metadata without the committed turn identity required for recovery.",
      { stage: "response-timing", code: "pro-turn-identity-missing", runtime },
    );
  }
  if (!isValidWorkload(runtime.proInputTokens) || !isValidWorkload(runtime.proAttachmentBytes)) {
    throw new BrowserAutomationError(
      "Oracle found Pro response metadata without a complete workload receipt.",
      { stage: "response-timing", code: "pro-workload-receipt-missing", runtime },
    );
  }
  if (
    typeof runtime.proDispatchAt !== "string" ||
    !Number.isFinite(Date.parse(runtime.proDispatchAt))
  ) {
    throw new BrowserAutomationError(
      "Oracle found Pro response metadata without a valid dispatch timestamp.",
      { stage: "response-timing", code: "dispatch-timestamp-missing", runtime },
    );
  }
  if (!isValidElapsed(runtime.proResponseElapsedMs)) throwIndeterminate(runtime);
}

function appendReceipt(runtime: BrowserRuntimeMetadata): BrowserRuntimeMetadata {
  const receipt: ProResponseTimingReceipt = {
    turnIndex: runtime.proTurnIndex as number,
    dispatchAt: runtime.proDispatchAt as string,
    responseElapsedMs: runtime.proResponseElapsedMs as number,
    inputTokens: runtime.proInputTokens as number,
    attachmentBytes: runtime.proAttachmentBytes as number,
  };
  const receipts = (runtime.proResponseTimingReceipts ?? []).filter(
    (entry) => entry.turnIndex !== receipt.turnIndex,
  );
  return {
    ...runtime,
    proResponseTimingReceipts: [...receipts, receipt].sort(
      (left, right) => left.turnIndex - right.turnIndex,
    ),
  };
}

export function completeProResponseTimingTurn(args: {
  runtime: BrowserRuntimeMetadata;
  capturedAt?: Date;
}): BrowserRuntimeMetadata {
  const runtime = recordProResponseTiming(args.runtime, args.capturedAt ?? new Date(), {
    requireTimestamp: true,
  });
  assertCompleteProResponseTimingReceipt(runtime);
  return appendReceipt(runtime);
}

export function verifyStoredProResponseWorkloadTiming(args: {
  runtime: BrowserRuntimeMetadata;
  capturedAt: Date;
}): BrowserRuntimeMetadata {
  if (!hasProResponseTimingMarker(args.runtime)) return args.runtime;
  const runtime = recordProResponseTiming(args.runtime, args.capturedAt, {
    requireTimestamp: true,
  });
  assertCompleteProResponseTimingReceipt(runtime);
  return appendReceipt(runtime);
}
