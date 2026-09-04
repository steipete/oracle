import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SessionMetadata } from "../../sessionStore.js";
import { sessionStore } from "../../sessionStore.js";
import { waitInputSchema } from "../types.js";
import {
  consultArtifactSummaryShape,
  consultImageSummaryShape,
  consultModelSummaryShape,
  readSessionLogTail,
  summarizeArtifactsForConsult,
  summarizeImageArtifactsForConsult,
  summarizeModelRunsForConsult,
} from "./consult.js";

const TERMINAL_SESSION_STATUSES = new Set(["completed", "partial", "error", "cancelled"]);
const DEFAULT_FALLBACK_INTERVAL_MS = 1_000;

const waitInputShape = {
  id: z.string().min(1, "Session id is required.").describe("Oracle session id or slug."),
  timeoutMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "How long to wait for a terminal session state. Omit to wait indefinitely; 0 returns an immediate snapshot. A wait timeout never cancels the Oracle session.",
    ),
} satisfies z.ZodRawShape;

const waitOutputShape = {
  sessionId: z.string(),
  status: z.string(),
  waitStatus: z.enum(["terminal", "timed_out"]),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  output: z.string(),
  models: z.array(consultModelSummaryShape).optional(),
  artifacts: z.array(consultArtifactSummaryShape).optional(),
  images: z.array(consultImageSummaryShape).optional(),
} satisfies z.ZodRawShape;

export interface SessionChangeSource {
  wait(delayMs: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface WaitForSessionDeps {
  readSession: (id: string) => Promise<SessionMetadata | null>;
  getSessionDir: (id: string) => Promise<string>;
  createChangeSource: (directory: string) => SessionChangeSource;
  now: () => number;
}

export interface WaitForSessionResult {
  metadata: SessionMetadata;
  waitStatus: "terminal" | "timed_out";
  timedOut: boolean;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Oracle session wait was cancelled.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

export function isTerminalSessionStatus(status: string): boolean {
  return TERMINAL_SESSION_STATUSES.has(status);
}

export function createSessionChangeSource(directory: string): SessionChangeSource {
  let watcher: FSWatcher | undefined;
  let notified = false;
  let pendingWake: (() => void) | undefined;

  const onWake = (): void => {
    if (!pendingWake) {
      notified = true;
      return;
    }
    const wake = pendingWake;
    pendingWake = undefined;
    wake();
  };
  const onError = (): void => {
    const failedWatcher = watcher;
    watcher = undefined;
    failedWatcher?.off("change", onWake);
    failedWatcher?.off("error", onError);
    failedWatcher?.close();
    onWake();
  };

  try {
    watcher = watch(directory);
    watcher.on("change", onWake);
    watcher.on("error", onError);
  } catch {
    // A timer fallback below keeps waits correct when filesystem notifications
    // are unavailable or the session directory is on an unsupported volume.
  }

  return {
    wait(delayMs, signal) {
      throwIfAborted(signal);
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (pendingWake === wake) pendingWake = undefined;
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const wake = (): void => finish();
        const onAbort = (): void => finish(abortReason(signal!));
        const timer = setTimeout(wake, delayMs);
        pendingWake = wake;
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        if (notified) {
          notified = false;
          queueMicrotask(wake);
        }
      });
    },
    close() {
      watcher?.off("change", onWake);
      watcher?.off("error", onError);
      watcher?.close();
      watcher = undefined;
    },
  };
}

const defaultWaitDeps: WaitForSessionDeps = {
  readSession: (id) => sessionStore.readSession(id),
  getSessionDir: async (id) => (await sessionStore.getPaths(id)).dir,
  createChangeSource: createSessionChangeSource,
  now: Date.now,
};

export async function waitForSessionTerminal(
  {
    id,
    timeoutMs,
    signal,
    fallbackIntervalMs = DEFAULT_FALLBACK_INTERVAL_MS,
  }: {
    id: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    fallbackIntervalMs?: number;
  },
  deps: WaitForSessionDeps = defaultWaitDeps,
): Promise<WaitForSessionResult> {
  throwIfAborted(signal);
  const deadline = timeoutMs === undefined ? undefined : deps.now() + timeoutMs;
  let metadata = await deps.readSession(id);
  if (!metadata) {
    throw new Error(`Session "${id}" not found.`);
  }
  if (isTerminalSessionStatus(metadata.status)) {
    return { metadata, waitStatus: "terminal", timedOut: false };
  }
  if (timeoutMs === 0) {
    return { metadata, waitStatus: "timed_out", timedOut: true };
  }

  const directory = await deps.getSessionDir(id);
  const changes = deps.createChangeSource(directory);
  try {
    // Close the read/watch race: the session may have completed while the
    // filesystem watcher was being installed.
    metadata = (await deps.readSession(id)) ?? metadata;
    while (!isTerminalSessionStatus(metadata.status)) {
      throwIfAborted(signal);
      const remaining = deadline === undefined ? undefined : deadline - deps.now();
      if (remaining !== undefined && remaining <= 0) {
        return { metadata, waitStatus: "timed_out", timedOut: true };
      }
      const delayMs = Math.max(1, Math.min(fallbackIntervalMs, remaining ?? fallbackIntervalMs));
      await changes.wait(delayMs, signal);
      metadata = (await deps.readSession(id)) ?? metadata;
    }
    return { metadata, waitStatus: "terminal", timedOut: false };
  } finally {
    changes.close();
  }
}

type McpToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export async function runWaitTool(input: unknown, extra?: Pick<McpToolExtra, "signal">) {
  const { id, timeoutMs } = waitInputSchema.parse(input);
  const result = await waitForSessionTerminal({ id, timeoutMs, signal: extra?.signal });
  const { metadata } = result;
  const logTail = (await readSessionLogTail(metadata.id, 4_000)) ?? "";
  const summary = `Session ${metadata.id} (${metadata.status}; wait=${result.waitStatus})`;
  return {
    content: [{ type: "text" as const, text: [summary, logTail || "(log empty)"].join("\n") }],
    structuredContent: {
      sessionId: metadata.id,
      status: metadata.status,
      waitStatus: result.waitStatus,
      timedOut: result.timedOut,
      cancelled: metadata.status === "cancelled",
      output: logTail,
      models: summarizeModelRunsForConsult(metadata.models),
      artifacts: summarizeArtifactsForConsult(metadata.artifacts),
      images: summarizeImageArtifactsForConsult(metadata.artifacts),
    },
  };
}

export function registerWaitTool(server: McpServer): void {
  server.registerTool(
    "wait",
    {
      title: "Wait for an oracle session",
      description:
        "Wait for an existing Oracle session to reach a terminal state without agent-side polling. Omit timeoutMs to wait indefinitely, or set a bounded caller wait. Wait timeout or request cancellation never cancels the Oracle session; call wait again with the same id to continue waiting.",
      inputSchema: waitInputShape,
      outputSchema: waitOutputShape,
    },
    async (input: unknown, extra: McpToolExtra) => runWaitTool(input, extra),
  );
}
