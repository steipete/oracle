import fs from "node:fs/promises";
import path from "node:path";
import { sessionStore, wait } from "../sessionStore.js";
import type { SessionArtifact, SessionMetadata } from "../sessionStore.js";
import { formatElapsed } from "../oracle/format.js";
import { attachSession } from "./sessionDisplay.js";

export interface BrowserSessionFinalizerOptions {
  firstWaitMs?: number;
  intervalMs?: number;
  maxWaitMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

const DEFAULT_FIRST_WAIT_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 3 * 60_000;
const DEFAULT_MAX_WAIT_MS = 22 * 60_000;
const MIN_READY_TRANSCRIPT_BYTES = 20;

function mergeTranscriptArtifact(
  artifacts: SessionMetadata["artifacts"],
  transcript: SessionArtifact,
): SessionMetadata["artifacts"] {
  const merged = new Map<string, SessionArtifact>();
  for (const artifact of artifacts ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  merged.set(`${transcript.kind}:${transcript.path}`, transcript);
  return Array.from(merged.values());
}

async function findCapturedTranscript(
  sessionId: string,
  metadata: SessionMetadata,
): Promise<SessionArtifact | null> {
  const candidates = new Set<string>();
  for (const artifact of metadata.artifacts ?? []) {
    if (artifact.kind === "transcript" && artifact.path) {
      candidates.add(artifact.path);
    }
  }
  try {
    const paths = await sessionStore.getPaths(sessionId);
    candidates.add(path.join(paths.dir, "artifacts", "transcript.md"));
  } catch {
    // If the paths are unavailable the caller already has a missing/broken session.
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.size > MIN_READY_TRANSCRIPT_BYTES) {
        return {
          kind: "transcript",
          path: candidate,
          label: "Browser transcript",
          mimeType: "text/markdown",
          sizeBytes: stat.size,
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function finalizeCapturedTranscriptIfPresent(
  sessionId: string,
  metadata: SessionMetadata,
  log: (message: string) => void,
): Promise<boolean> {
  const transcript = await findCapturedTranscript(sessionId, metadata);
  if (!transcript) {
    return false;
  }
  log(
    `[finalizer] Session ${sessionId} has captured transcript (${transcript.sizeBytes} B) despite status ${metadata.status}; marking completed.`,
  );
  await sessionStore.updateSession(sessionId, {
    status: "completed",
    completedAt: metadata.completedAt ?? new Date().toISOString(),
    errorMessage: undefined,
    artifacts: mergeTranscriptArtifact(metadata.artifacts, transcript),
    response: { status: "completed" },
    error: undefined,
    transport: undefined,
  });
  return true;
}

export async function finalizeBrowserSessionUntilComplete(
  sessionId: string,
  options: BrowserSessionFinalizerOptions = {},
): Promise<"completed" | "error" | "timeout" | "missing"> {
  const firstWaitMs = Math.max(0, options.firstWaitMs ?? DEFAULT_FIRST_WAIT_MS);
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const maxWaitMs = Math.max(firstWaitMs, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const startedAt = now();
  const deadline = startedAt + maxWaitMs;

  const initial = await sessionStore.readSession(sessionId);
  if (!initial) {
    log(`[finalizer] Session ${sessionId} not found.`);
    return "missing";
  }
  if (initial.mode !== "browser") {
    log(`[finalizer] Session ${sessionId} is not a browser session; skipping.`);
    return initial.status === "completed" ? "completed" : "error";
  }
  if (initial.status === "completed") {
    log(`[finalizer] Session ${sessionId} already completed.`);
    return "completed";
  }
  if (initial.status === "error" || initial.status === "partial") {
    if (await finalizeCapturedTranscriptIfPresent(sessionId, initial, log)) {
      return "completed";
    }
    log(`[finalizer] Session ${sessionId} already ${initial.status}.`);
    return "error";
  }

  if (firstWaitMs > 0) {
    log(`[finalizer] Waiting ${formatElapsed(firstWaitMs)} before first recovery render.`);
    await wait(firstWaitMs);
  }

  let attempt = 0;
  while (now() <= deadline) {
    attempt += 1;
    const before = await sessionStore.readSession(sessionId);
    if (!before) {
      log(`[finalizer] Session ${sessionId} disappeared.`);
      return "missing";
    }
    if (before.status === "completed") {
      log(`[finalizer] Session ${sessionId} completed before attempt ${attempt}.`);
      return "completed";
    }
    if (before.status === "error" && before.response?.incompleteReason !== "incomplete-capture") {
      if (await finalizeCapturedTranscriptIfPresent(sessionId, before, log)) {
        return "completed";
      }
      log(`[finalizer] Session ${sessionId} is error; stopping.`);
      return "error";
    }

    log(`[finalizer] Recovery render attempt ${attempt} for ${sessionId} (${before.status}).`);
    await attachSession(sessionId, {
      renderMarkdown: false,
      renderPrompt: false,
      suppressMetadata: true,
    });

    const after = await sessionStore.readSession(sessionId);
    if (after?.status === "completed") {
      log(`[finalizer] Session ${sessionId} finalized as completed.`);
      return "completed";
    }
    if (after?.status === "error" && after.response?.incompleteReason !== "incomplete-capture") {
      if (await finalizeCapturedTranscriptIfPresent(sessionId, after, log)) {
        return "completed";
      }
      log(`[finalizer] Session ${sessionId} finalized as error.`);
      return "error";
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await wait(Math.min(intervalMs, remainingMs));
  }

  log(`[finalizer] Timed out after ${formatElapsed(maxWaitMs)} waiting for ${sessionId}.`);
  return "timeout";
}
