import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sessionStore } from "../sessionStore.js";
import type { BrowserHarvestIntegrity } from "../sessionManager.js";
import { extractConversationIdFromUrl, type ChatGptTabSummary } from "../browser/liveTabs.js";
import { BrowserAutomationError } from "../oracle/errors.js";

const INTEGRITY_WARNING = "browser-harvest-integrity";
const INTEGRITY_MESSAGE =
  "Harvested conversation differs from the saved capture. Original artifacts were preserved; inspect browser.harvest.integrity before using the answer.";

async function readTranscriptConversation(filename: string): Promise<string | undefined> {
  let file;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await file.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(2_048);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const match = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .match(/^# Oracle Browser Transcript\r?\n\r?\nConversation: ([^\r\n]+)\r?\n/);
    return match ? extractConversationIdFromUrl(match[1]) : undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

export async function persistBrowserHarvest(
  sessionId: string,
  harvested: ChatGptTabSummary,
  explicitTarget = false,
): Promise<BrowserHarvestIntegrity> {
  // Harvesting can take time; compare against the latest saved capture, not the initial read.
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) throw new Error(`No session found with ID ${sessionId}.`);
  const captured: BrowserHarvestIntegrity["captured"] = [];
  const unverifiedSources: string[] = [];
  const add = (source: string, id: string | undefined) => {
    if (id) captured.push({ source, conversationId: id });
  };
  const addUrl = (source: string, url: string | undefined, expectsConversation = true) => {
    if (!url) return;
    const id = extractConversationIdFromUrl(url);
    add(source, id);
    if (!id && expectsConversation) unverifiedSources.push(source);
  };
  add("runtime", meta.browser?.runtime?.conversationId);
  addUrl("runtime-url", meta.browser?.runtime?.tabUrl);
  addUrl("archive", meta.browser?.archive?.conversationUrl);
  for (const [index, artifact] of (meta.artifacts ?? []).entries()) {
    addUrl(
      `artifact:${index}`,
      artifact.sourceUrl,
      artifact.kind === "transcript" || artifact.kind === "deep-research-report",
    );
  }

  const artifactDir = path.join((await sessionStore.getPaths(sessionId)).dir, "artifacts");
  const directoryStat = await fs.lstat(artifactDir).catch(() => null);
  if (directoryStat?.isDirectory() && !directoryStat.isSymbolicLink()) {
    const transcripts = new Map([[path.join(artifactDir, "transcript.md"), false]]);
    for (const artifact of meta.artifacts ?? []) {
      if (artifact.kind !== "transcript") continue;
      const candidate = path.isAbsolute(artifact.path)
        ? artifact.path
        : path.resolve(artifactDir, "..", artifact.path);
      // Stored paths must remain direct children of this session's artifact directory.
      if (path.dirname(candidate) === artifactDir) transcripts.set(candidate, true);
      else unverifiedSources.push("external-transcript-path");
    }
    for (const [filename, expected] of transcripts) {
      const source = `transcript:${path.basename(filename)}`;
      const id = await readTranscriptConversation(filename);
      add(source, id);
      if (!id && (expected || (await fs.lstat(filename).catch(() => null)))) {
        unverifiedSources.push(source);
      }
    }
  } else if (directoryStat || meta.artifacts?.some((artifact) => artifact.kind === "transcript")) {
    unverifiedSources.push("artifact-directory");
  }

  const observedConversationId =
    harvested.conversationId ?? extractConversationIdFromUrl(harvested.url);
  const mismatch = Boolean(
    observedConversationId &&
    captured.some((entry) => entry.conversationId !== observedConversationId),
  );
  const integrity: BrowserHarvestIntegrity = {
    status: mismatch
      ? "mismatch"
      : observedConversationId && captured.length && unverifiedSources.length === 0
        ? "matched"
        : "unverified",
    observedConversationId,
    captured,
    unverifiedSources,
    explicitTarget,
    previousHarvestConversationId: meta.browser?.harvest?.conversationId,
  };
  const warnings = (meta.browser?.warnings ?? []).filter(
    (warning) => warning.code !== INTEGRITY_WARNING,
  );
  if (mismatch) {
    warnings.push({ code: INTEGRITY_WARNING, severity: "warning", message: INTEGRITY_MESSAGE });
  }
  await sessionStore.updateSession(sessionId, {
    browser: {
      ...meta.browser,
      warnings,
      harvest: {
        targetId: harvested.targetId,
        url: harvested.url,
        conversationId: observedConversationId,
        harvestedAt: new Date().toISOString(),
        assistantHash: createHash("sha1")
          .update(harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "")
          .digest("hex"),
        state: harvested.state,
        stopExists: harvested.stopExists,
        sendExists: harvested.sendExists,
        assistantCount: harvested.assistantCount,
        currentModelLabel: harvested.currentModelLabel,
        lastAssistantSnippet: harvested.lastAssistantSnippet,
        integrity,
      },
    },
  });
  if (mismatch && !explicitTarget) {
    throw new BrowserAutomationError(INTEGRITY_MESSAGE, {
      stage: "harvest-integrity",
      code: "conversation-identity-mismatch",
      integrity,
    });
  }
  return integrity;
}
