import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { sessionStore } from "../sessionStore.js";
import type { SessionMetadata } from "../sessionStore.js";
import {
  collectChatGptTabs,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  extractConversationIdFromUrl,
  formatBrowserTabState,
  harvestChatGptTab,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../browser/liveTabs.js";
import { resolveOutputPath } from "./writeOutputPath.js";

const LIVE_POLL_MS = 2000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;

export interface BrowserHarvestOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallWindowMs?: number;
  quietOutput?: boolean;
}

export interface BrowserLiveTailOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallThresholdMs?: number;
}

function sessionBrowserEndpoint(
  meta: SessionMetadata | null | undefined,
): { host: string; port: number } | null {
  const runtime = meta?.browser?.runtime ?? {};
  const remote: { host?: string; port?: number } = meta?.browser?.config?.remoteChrome ?? {};
  const host = runtime.chromeHost ?? remote.host;
  const port = runtime.chromePort ?? remote.port;
  if (!host || !port) {
    return null;
  }
  return { host, port };
}

function collectUniqueEndpoints(metas: SessionMetadata[]): Array<{ host: string; port: number }> {
  const entries = new Map<string, { host: string; port: number }>();
  entries.set(`${DEFAULT_REMOTE_CHROME_HOST}:${DEFAULT_REMOTE_CHROME_PORT}`, {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  });
  for (const meta of metas) {
    const endpoint = sessionBrowserEndpoint(meta);
    if (!endpoint) {
      continue;
    }
    entries.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  }
  return Array.from(entries.values());
}

function buildSessionIndex(metas: SessionMetadata[]): SessionMetadata[] {
  return metas
    .filter((meta) => meta?.mode === "browser")
    .sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
    );
}

function resolveLinkedSession(
  tab: ChatGptTabSummary,
  metas: SessionMetadata[],
): SessionMetadata | null {
  return buildSessionIndex(metas).find((meta) => sessionMatchesTab(meta, tab)) ?? null;
}

function snippet(text: string, max = 120): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function resolveSessionTabRef(meta: SessionMetadata): string {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  return (
    harvest.targetId ??
    runtime.chromeTargetId ??
    harvest.url ??
    runtime.tabUrl ??
    harvest.conversationId ??
    runtime.conversationId ??
    "current"
  );
}

async function persistHarvest(
  sessionId: string,
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
): Promise<void> {
  const hash = createHash("sha1")
    .update(harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "")
    .digest("hex");
  const browser = {
    ...(meta.browser ?? {}),
    harvest: {
      targetId: harvested.targetId,
      url: harvested.url,
      conversationId: harvested.conversationId ?? extractConversationIdFromUrl(harvested.url),
      harvestedAt: new Date().toISOString(),
      assistantHash: hash,
      state: harvested.state,
      stopExists: harvested.stopExists,
      sendExists: harvested.sendExists,
      assistantCount: harvested.assistantCount,
      currentModelLabel: harvested.currentModelLabel,
      lastAssistantSnippet: harvested.lastAssistantSnippet,
    },
  };
  await sessionStore.updateSession(sessionId, { browser });
}

function printHarvestSummary(sessionId: string, harvested: ChatGptTabSummary): void {
  console.log(chalk.bold(`Session: ${sessionId}`));
  console.log(`Target: ${harvested.targetId}`);
  console.log(`State: ${formatBrowserTabState(harvested)}`);
  console.log(`Model: ${harvested.currentModelLabel || "(unknown)"}`);
  console.log(`URL: ${harvested.url}`);
  console.log(`Assistant turns: ${harvested.assistantCount}`);
  console.log(
    `Signals: stop=${harvested.stopExists ? "yes" : "no"} send=${harvested.sendExists ? "yes" : "no"}`,
  );
  if (harvested.lastUserSnippet) {
    console.log(`Last user: ${harvested.lastUserSnippet}`);
  }
  console.log(chalk.dim("---"));
}

async function maybeWriteHarvestOutput(
  pathInput: string | undefined,
  cwd: string,
  content: string,
): Promise<void> {
  const resolved = resolveOutputPath(pathInput, cwd);
  if (!resolved) {
    return;
  }
  const payload = content ?? "";
  if (resolved === "-" || resolved === "/dev/stdout") {
    process.stdout.write(`${payload}${payload.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  await fs.writeFile(resolved, payload, "utf8");
  console.log(chalk.dim(`Wrote harvested assistant output to ${resolved}`));
}

export async function showBrowserTabsStatus(): Promise<void> {
  const metas = await sessionStore.listSessions().catch(() => [] as SessionMetadata[]);
  const endpoints = collectUniqueEndpoints(metas);
  let printedAny = false;
  for (const endpoint of endpoints) {
    let tabs: ChatGptTabSummary[];
    try {
      tabs = await collectChatGptTabs(endpoint);
    } catch {
      continue;
    }
    if (tabs.length === 0) {
      continue;
    }
    printedAny = true;
    console.log(chalk.bold(`Browser Tabs ${endpoint.host}:${endpoint.port}`));
    for (const tab of tabs) {
      const linkedSession = resolveLinkedSession(
        { ...tab, host: endpoint.host, port: endpoint.port },
        metas,
      );
      console.log(
        `- ${tab.targetId} ${formatBrowserTabState(tab)} model=${tab.currentModelLabel || "(unknown)"} turns=${tab.assistantCount} stop=${tab.stopExists ? "yes" : "no"} send=${tab.sendExists ? "yes" : "no"}`,
      );
      console.log(`  title=${tab.title || "(untitled)"}`);
      console.log(`  url=${tab.url}`);
      if (linkedSession) {
        console.log(`  session=${linkedSession.id}`);
      }
      if (tab.lastAssistantSnippet) {
        console.log(`  last=${snippet(tab.lastAssistantSnippet)}`);
      }
    }
  }
  if (!printedAny) {
    console.log("No live ChatGPT tabs found on known Chrome DevTools endpoints.");
  }
}

export async function harvestSessionBrowserOutput(
  sessionId: string,
  options: BrowserHarvestOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  const endpoint = sessionBrowserEndpoint(meta) ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  const harvested = await harvestChatGptTab({
    host: endpoint.host,
    port: endpoint.port,
    ref: options.browserTabRef ?? resolveSessionTabRef(meta),
    stallWindowMs: options.stallWindowMs,
  });
  await persistHarvest(sessionId, meta, harvested);
  printHarvestSummary(sessionId, harvested);
  const output = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
  if (options.writeOutputPath) {
    await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
  }
  if (!options.quietOutput && output) {
    process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
  }
  return harvested;
}

export async function liveTailSessionBrowserOutput(
  sessionId: string,
  options: BrowserLiveTailOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  const endpoint = sessionBrowserEndpoint(meta) ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  const browserTabRef = options.browserTabRef ?? resolveSessionTabRef(meta);
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  let lastHash: string | null = null;
  let unchangedSince = Date.now();

  while (true) {
    const harvested = await harvestChatGptTab({
      host: endpoint.host,
      port: endpoint.port,
      ref: browserTabRef,
    });
    const fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
    const hash = createHash("sha1").update(fullText).digest("hex");
    if (hash !== lastHash) {
      lastHash = hash;
      unchangedSince = Date.now();
      const statusLine =
        `[${new Date().toISOString()}] state=${harvested.state} stop=${harvested.stopExists ? "yes" : "no"} ` +
        `send=${harvested.sendExists ? "yes" : "no"} model=${harvested.currentModelLabel || "(unknown)"} ` +
        `snippet=${snippet(harvested.lastAssistantSnippet || fullText, 160)}`;
      console.log(statusLine);
      await persistHarvest(sessionId, meta, harvested);
    }

    const derivedState = harvested.stopExists
      ? Date.now() - unchangedSince >= stallThresholdMs
        ? "stalled"
        : "running"
      : harvested.authenticated
        ? "completed"
        : "detached";

    if (derivedState === "completed" || derivedState === "stalled" || derivedState === "detached") {
      const finalHarvest: ChatGptTabSummary = {
        ...harvested,
        state: derivedState,
      };
      await persistHarvest(sessionId, meta, finalHarvest);
      printHarvestSummary(sessionId, finalHarvest);
      const output = finalHarvest.lastAssistantMarkdown ?? finalHarvest.lastAssistantText ?? "";
      if (options.writeOutputPath) {
        await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
      }
      if (output) {
        process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
      }
      return finalHarvest;
    }

    await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
  }
}
