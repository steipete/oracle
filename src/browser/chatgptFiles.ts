import fs from "node:fs/promises";
import path from "node:path";
import type {
  BrowserDownloadableFile,
  BrowserLogger,
  ChromeClient,
  SavedBrowserFile,
} from "./types.js";
import { ASSISTANT_ROLE_SELECTOR } from "./constants.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
import {
  computeFileSha256,
  resolveSessionArtifactsDir,
  sanitizeArtifactFilename,
  validateArtifactFile,
  writeBinaryBrowserArtifact,
} from "./artifacts.js";

const CHATGPT_DOWNLOAD_BASE_URL = "https://chatgpt.com/";
const DOWNLOAD_BUTTON_WAIT_MS = 15_000;
const DOWNLOAD_REDIRECT_LIMIT = 5;
const DIAGNOSTIC_BODY_SNIPPET_BYTES = 180;

type DownloadSourceKind = "sandbox" | "chatgpt-file-endpoint" | "browser-download";
type DirectDownloadStrategy = "browser-fetch" | "node-fetch";

interface ClickDownloadControlsResult {
  clicked: Array<{
    text?: string;
    ariaLabel?: string;
    title?: string;
    testId?: string;
    tagName?: string;
    role?: string;
    hrefKind?: string;
    category?: string;
  }>;
  inspectedCount: number;
  selectedCategory?: string;
}

class ChatGptDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptDownloadError";
  }
}

function safeDiagnosticText(value: string, maxLength = DIAGNOSTIC_BODY_SNIPPET_BYTES): string {
  const compact = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
      try {
        const url = new URL(match);
        return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(
      /("?(?:access_token|authorization|bearer|cookie|id_token|key|secret|session|signature|sig|token)"?\s*[:=]\s*)"?[^,"'\s}]+"?/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(access[_ -]?token|authorization|bearer|cookie|id[_ -]?token|api[_ -]?key|secret|session|signature|sig|token)\b\s+["']?[a-z0-9._~+/=-]{4,}/gi,
      "$1 [redacted]",
    )
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function classifyResponseBodyKind(
  contentType?: string | null,
): "json" | "html" | "text" | "binary" {
  const value = String(contentType ?? "").toLowerCase();
  if (value.includes("json")) return "json";
  if (value.includes("html")) return "html";
  if (value.startsWith("text/") || value.includes("xml")) return "text";
  return "binary";
}

function decodeDiagnosticBodySnippet(
  body: Buffer,
  contentType?: string | null,
): { bodyKind: string; bodySnippet?: string } {
  const bodyKind = classifyResponseBodyKind(contentType);
  if (body.length === 0 || bodyKind === "binary") {
    return { bodyKind };
  }
  let text = body.subarray(0, DIAGNOSTIC_BODY_SNIPPET_BYTES * 4).toString("utf8");
  if (bodyKind === "html") {
    text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  }
  return { bodyKind, bodySnippet: safeDiagnosticText(text) };
}

async function readDiagnosticResponseBody(
  response: Response,
  contentType?: string | null,
): Promise<{ bodyKind: string; bodySnippet?: string }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { bodyKind: classifyResponseBodyKind(contentType) };
  }
  const limit = DIAGNOSTIC_BODY_SNIPPET_BYTES * 4;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - total;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      total += chunk.length;
      if (total >= limit) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    return decodeDiagnosticBodySnippet(Buffer.concat(chunks), contentType);
  } catch {
    return { bodyKind: classifyResponseBodyKind(contentType) };
  } finally {
    reader.releaseLock();
  }
}

function classifyUrlKind(value?: string | null): string {
  const raw = String(value ?? "");
  if (!raw) return "unknown";
  if (raw.startsWith("sandbox:")) return "sandbox";
  if (raw === "browser-download") return "browser-download";
  try {
    const url = new URL(raw, CHATGPT_DOWNLOAD_BASE_URL);
    if (!isAllowedChatGptHost(url.hostname)) return "external-https";
    const pathName = url.pathname.toLowerCase();
    if (pathName === "/backend-api/sandbox/download") return "chatgpt-sandbox-download";
    if (/^\/backend-api\/files\/[^/]+\/(?:download|content)\/?$/.test(pathName)) {
      return "chatgpt-file-endpoint";
    }
    if (pathName === "/backend-api/estuary/content") return "chatgpt-estuary-content";
    return "chatgpt-other";
  } catch {
    return "unknown";
  }
}

function formatDownloadFailure(params: {
  strategy: DirectDownloadStrategy;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  finalUrl?: string | null;
  bodyKind?: string;
  bodySnippet?: string;
  message?: string;
}): ChatGptDownloadError {
  const parts = [`download failed via ${params.strategy}`];
  if (params.status !== undefined) parts.push(`status=${params.status}`);
  if (params.statusText) parts.push(`statusText=${safeDiagnosticText(params.statusText, 80)}`);
  if (params.contentType) parts.push(`contentType=${safeDiagnosticText(params.contentType, 80)}`);
  parts.push(`finalUrlKind=${classifyUrlKind(params.finalUrl)}`);
  if (params.bodyKind) parts.push(`bodyKind=${params.bodyKind}`);
  if (params.bodySnippet) parts.push(`bodySnippet=${JSON.stringify(params.bodySnippet)}`);
  if (params.message) parts.push(`reason=${safeDiagnosticText(params.message, 140)}`);
  return new ChatGptDownloadError(parts.join(" "));
}

function sanitizeCandidateFilename(value?: string | null): string {
  return sanitizeArtifactFilename(String(value ?? ""), "artifact.bin");
}

function isAllowedChatGptHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "chatgpt.com" || value === "chat.openai.com";
}

function isSafeSandboxPath(value?: string | null): boolean {
  const pathName = String(value ?? "");
  if (!pathName.startsWith("/mnt/data/")) {
    return false;
  }
  if (pathName.includes("\\") || pathName.includes("\0")) {
    return false;
  }
  return !pathName.split("/").includes("..");
}

function isKnownChatGptFileDownloadUrl(url: URL): boolean {
  const pathName = url.pathname.toLowerCase();
  if (pathName === "/backend-api/sandbox/download") {
    return isSafeSandboxPath(url.searchParams.get("path"));
  }
  if (/^\/backend-api\/files\/[^/]+\/(?:download|content)\/?$/.test(pathName)) {
    return true;
  }
  if (pathName === "/backend-api/estuary/content") {
    return (url.searchParams.get("id") ?? "").startsWith("file_");
  }
  return false;
}

function normalizeChatGptDownloadUrl(value?: string | null): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw || raw.startsWith("sandbox:") || raw.startsWith("blob:")) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw, CHATGPT_DOWNLOAD_BASE_URL);
  } catch {
    return undefined;
  }
  if (!isAllowedChatGptHost(url.hostname)) {
    return undefined;
  }
  if (url.protocol !== "https:" || url.port) {
    return undefined;
  }
  if (!isKnownChatGptFileDownloadUrl(url)) {
    return undefined;
  }
  return url.href;
}

function normalizeSandboxPath(value?: string | null): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("sandbox:/mnt/data/")) {
    return undefined;
  }
  let pathName: string;
  try {
    pathName = decodeURI(new URL(raw).pathname);
  } catch {
    pathName = raw.slice("sandbox:".length);
  }
  return isSafeSandboxPath(pathName) ? pathName : undefined;
}

function normalizeSandboxUrl(value?: string | null): string | undefined {
  const pathName = normalizeSandboxPath(value);
  return pathName ? `sandbox:${pathName}` : undefined;
}

function downloadUrlFromSandboxUrl(value?: string | null): string | undefined {
  const pathName = normalizeSandboxPath(value);
  if (!pathName) {
    return undefined;
  }
  const url = new URL("/backend-api/sandbox/download", CHATGPT_DOWNLOAD_BASE_URL);
  url.searchParams.set("path", pathName);
  return url.href;
}

function dedupeFiles(files: BrowserDownloadableFile[]): BrowserDownloadableFile[] {
  const deduped: BrowserDownloadableFile[] = [];
  const aliases = new Map<string, number>();
  for (const file of files) {
    const fileAliases = [file.downloadUrl, file.sandboxUrl, file.url].filter(
      (value): value is string => Boolean(value),
    );
    const existingIndex = fileAliases
      .map((alias) => aliases.get(alias))
      .find((index): index is number => index !== undefined);
    if (existingIndex === undefined) {
      const index = deduped.length;
      deduped.push(file);
      for (const alias of fileAliases) {
        aliases.set(alias, index);
      }
      continue;
    }
    const existing = deduped[existingIndex];
    deduped[existingIndex] = {
      ...file,
      ...existing,
      downloadUrl: existing.downloadUrl ?? file.downloadUrl,
      sandboxUrl: existing.sandboxUrl ?? file.sandboxUrl,
      filename: existing.filename ?? file.filename,
      label: existing.label ?? file.label,
      mimeType: existing.mimeType ?? file.mimeType,
      url:
        existing.downloadUrl ??
        file.downloadUrl ??
        existing.sandboxUrl ??
        file.sandboxUrl ??
        existing.url ??
        file.url,
    };
    for (const alias of fileAliases) {
      aliases.set(alias, existingIndex);
    }
  }
  return deduped;
}

function readTextDownloadableFiles(value?: string | null): BrowserDownloadableFile[] {
  const text = String(value ?? "");
  if (!text) {
    return [];
  }
  const matches = text.match(/(?:https:\/\/[^\s)\]'"<>]+|sandbox:\/mnt\/data\/[^\s)\]'"<>]+)/g);
  if (!matches) {
    return [];
  }
  const files: BrowserDownloadableFile[] = [];
  for (const candidate of matches) {
    const downloadUrl = normalizeChatGptDownloadUrl(candidate);
    const sandboxUrl = normalizeSandboxUrl(candidate);
    if (!downloadUrl && !sandboxUrl) {
      continue;
    }
    files.push({
      url: downloadUrl ?? sandboxUrl ?? candidate,
      downloadUrl,
      sandboxUrl,
      filename: filenameFromUrl(sandboxUrl ?? downloadUrl ?? candidate),
    });
  }
  return dedupeFiles(files);
}

function buildAssistantDownloadableFilesExpression(minTurnIndex?: number): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };
    const isChatGptDownloadUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('sandbox:') || raw.startsWith('blob:')) return false;
      const isSafeSandboxPath = (path) => {
        const value = String(path || '');
        return value.startsWith('/mnt/data/') &&
          !value.includes('\\\\') &&
          !value.includes('\\0') &&
          !value.split('/').includes('..');
      };
      try {
        const url = new URL(raw, location.origin || 'https://chatgpt.com');
        const host = url.hostname.toLowerCase();
        const allowedHost = host === 'chatgpt.com' || host === 'chat.openai.com';
        const pathName = url.pathname.toLowerCase();
        const isKnownFileDownload =
          (pathName === '/backend-api/sandbox/download' && isSafeSandboxPath(url.searchParams.get('path') || '')) ||
          /^\\/backend-api\\/files\\/[^/]+\\/(?:download|content)\\/?$/.test(pathName) ||
          (pathName === '/backend-api/estuary/content' && String(url.searchParams.get('id') || '').startsWith('file_'));
        return allowedHost && url.protocol === 'https:' && !url.port && isKnownFileDownload;
      } catch {
        return false;
      }
    };
    const isSandboxUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw.startsWith('sandbox:/mnt/data/')) return false;
      try {
        return decodeURI(new URL(raw).pathname).startsWith('/mnt/data/') &&
          !decodeURI(new URL(raw).pathname).includes('\\\\') &&
          !decodeURI(new URL(raw).pathname).includes('\\0') &&
          !decodeURI(new URL(raw).pathname).split('/').includes('..');
      } catch {
        return false;
      }
    };
    const basename = (value) => {
      const raw = String(value || '').split(/[?#]/)[0].replace(/\\/+$/g, '');
      const part = raw.slice(raw.lastIndexOf('/') + 1);
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    const hrefKind = (value) => {
      if (!value) return '';
      if (isSandboxUrl(value)) return 'sandbox';
      if (isChatGptDownloadUrl(value)) return 'chatgpt-file-endpoint';
      return '';
    };
    const collectValues = (node) => {
      const values = [];
      if (String(node.tagName || '').toLowerCase() === 'a') {
        values.push(node.getAttribute('href') || '', node.href || '', node.getAttribute('download') || '');
      }
      for (const attribute of Array.from(node.attributes || [])) {
        values.push(String(attribute.value || ''));
      }
      for (const anchor of Array.from(node.querySelectorAll?.('a[href], a[download]') || [])) {
        values.push(anchor.getAttribute('href') || '', anchor.href || '', anchor.getAttribute('download') || '');
        for (const attribute of Array.from(anchor.attributes || [])) {
          values.push(String(attribute.value || ''));
        }
      }
      return values;
    };
    const serializeCandidate = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const values = collectValues(node);
      const downloadUrl = values.find(isChatGptDownloadUrl) || '';
      const sandboxUrl = values.find(isSandboxUrl) || '';
      if (!downloadUrl && !sandboxUrl) return null;
      const label = (node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '').trim();
      const downloadAttr = String(node.tagName || '').toLowerCase() === 'a' ? node.getAttribute('download') || '' : '';
      const filename = downloadAttr || basename(sandboxUrl) || basename(downloadUrl) || label || '';
      return {
        url: downloadUrl || sandboxUrl || values.find(hrefKind) || '',
        downloadUrl,
        sandboxUrl,
        filename,
        label,
        mimeType: node.getAttribute('type') || '',
      };
    };
    const serializeFiles = (root) =>
      Array.from(root.querySelectorAll([
        'a[href]',
        'a[download]',
        'button',
        '[role="button"]',
        '[data-testid]',
        '[aria-label]',
        '[title]',
      ].join(',')))
        .map(serializeCandidate)
        .filter(Boolean);
    const turns = ${buildConversationTurnListExpression()};
    const files = [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) continue;
      if (MIN_TURN_INDEX >= 0 && index < MIN_TURN_INDEX) continue;
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) || turn;
      files.push(...serializeFiles(messageRoot));
    }
    return files;
  })()`;
}

export async function readAssistantDownloadableFiles(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
): Promise<BrowserDownloadableFile[]> {
  const { result } = await Runtime.evaluate({
    expression: buildAssistantDownloadableFilesExpression(minTurnIndex),
    returnByValue: true,
  });
  const raw = Array.isArray(result?.value) ? result.value : [];
  const normalized: BrowserDownloadableFile[] = [];
  for (const item of raw) {
    const downloadUrl = normalizeChatGptDownloadUrl(
      typeof item?.downloadUrl === "string" ? item.downloadUrl : item?.url,
    );
    const sandboxUrl = normalizeSandboxUrl(
      typeof item?.sandboxUrl === "string" ? item.sandboxUrl : item?.url,
    );
    if (!downloadUrl && !sandboxUrl) {
      continue;
    }
    normalized.push({
      url: downloadUrl ?? sandboxUrl ?? "",
      downloadUrl,
      sandboxUrl,
      filename: typeof item?.filename === "string" ? item.filename : undefined,
      label: typeof item?.label === "string" ? item.label : undefined,
      mimeType: typeof item?.mimeType === "string" ? item.mimeType : undefined,
    });
  }
  return dedupeFiles(normalized);
}

async function buildCookieHeader(
  Network: ChromeClient["Network"],
  downloadUrl: string,
): Promise<string> {
  const url = new URL(downloadUrl);
  const response = await Network.getCookies({ urls: [`${url.origin}/`] });
  return (response.cookies ?? [])
    .filter((cookie) => cookie.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  const header = String(value ?? "");
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ""));
    } catch {
      return encoded.trim().replace(/^"|"$/g, "");
    }
  }
  return /filename="?([^";]+)"?/i.exec(header)?.[1]?.trim();
}

function classifyDownloadableFileSourceKind(
  file: BrowserDownloadableFile,
  downloadUrl?: string,
): DownloadSourceKind {
  if (file.sandboxUrl || file.url.startsWith("sandbox:")) {
    return "sandbox";
  }
  if ((downloadUrl ?? file.downloadUrl ?? file.url) === "browser-download") {
    return "browser-download";
  }
  return "chatgpt-file-endpoint";
}

function describeDownloadableCandidate(
  file: BrowserDownloadableFile,
  downloadUrl?: string,
): string {
  const filename = sanitizeCandidateFilename(
    file.filename ??
      file.label ??
      filenameFromUrl(file.sandboxUrl) ??
      filenameFromUrl(file.downloadUrl) ??
      filenameFromUrl(file.url),
  );
  return `filename=${filename} source=${classifyDownloadableFileSourceKind(
    file,
    downloadUrl,
  )} urlKind=${classifyUrlKind(downloadUrl ?? file.downloadUrl ?? file.sandboxUrl ?? file.url)}`;
}

function filenameFromUrl(value?: string): string | undefined {
  const raw = String(value ?? "")
    .split(/[?#]/)[0]
    .replace(/\/+$/g, "");
  if (!raw) return undefined;
  const part = raw.slice(raw.lastIndexOf("/") + 1);
  if (!part) return undefined;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function fallbackExtensionFromContentType(contentType?: string | null): string {
  const value = String(contentType ?? "").toLowerCase();
  if (value.includes("zip")) return "zip";
  if (value.includes("json")) return "json";
  if (value.includes("csv")) return "csv";
  if (value.includes("markdown")) return "md";
  if (value.includes("html")) return "html";
  if (value.includes("pdf")) return "pdf";
  if (value.startsWith("text/")) return "txt";
  return "bin";
}

function mimeTypeFromFilename(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".csv") return "text/csv";
  if (ext === ".json") return "application/json";
  if (ext === ".zip") return "application/zip";
  if (ext === ".md") return "text/markdown";
  if (ext === ".html") return "text/html";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  return undefined;
}

function resolveDownloadButtonLabels(files: BrowserDownloadableFile[]): string[] {
  const labels = new Set<string>();
  for (const file of files) {
    for (const value of [
      file.filename,
      file.label,
      filenameFromUrl(file.sandboxUrl),
      filenameFromUrl(file.downloadUrl),
      filenameFromUrl(file.url),
    ]) {
      const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
      if (normalized) {
        labels.add(normalized);
      }
    }
  }
  return [...labels];
}

function resolveDownloadedFilename(params: {
  file: BrowserDownloadableFile;
  contentDisposition: string | null;
  contentType: string | null;
  index: number;
}): string {
  const filename =
    filenameFromContentDisposition(params.contentDisposition) ??
    params.file.filename ??
    filenameFromUrl(params.file.sandboxUrl) ??
    filenameFromUrl(params.file.downloadUrl) ??
    filenameFromUrl(params.file.url);
  if (filename && path.extname(filename)) {
    return filename;
  }
  const fallback = filename || `chatgpt-file-${params.index + 1}`;
  return `${fallback}.${fallbackExtensionFromContentType(params.contentType)}`;
}

async function listCompletedDownloadFiles(dir: string, before: Set<string>): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (before.has(entry) || entry.endsWith(".crdownload")) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile() && stat.size > 0) {
      files.push(filePath);
    }
  }
  return files;
}

async function waitForCompletedDownloadFiles(
  dir: string,
  before: Set<string>,
  expectedCount: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let latest: string[] = [];
  let stableSignature = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    latest = await listCompletedDownloadFiles(dir, before);
    if (latest.length >= expectedCount) {
      const signature = [...latest].sort().join("\n");
      if (signature !== stableSignature) {
        stableSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 500) {
        return latest;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return latest;
}

async function configureBrowserDownloadPath(params: {
  Browser?: ChromeClient["Browser"];
  Client?: ChromeClient;
  Page?: ChromeClient["Page"];
  logger?: BrowserLogger;
  downloadPath: string;
}): Promise<boolean> {
  if (params.Client?.send) {
    try {
      await params.Client.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: params.downloadPath,
        eventsEnabled: true,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logger?.(`[browser] Browser.setDownloadBehavior unavailable: ${message}`);
    }
  }
  const BrowserWithDownloads = params.Browser as
    | (ChromeClient["Browser"] & {
        setDownloadBehavior?: (options: {
          behavior: "allow";
          downloadPath: string;
        }) => Promise<unknown>;
      })
    | undefined;
  if (BrowserWithDownloads?.setDownloadBehavior) {
    await BrowserWithDownloads.setDownloadBehavior({
      behavior: "allow",
      downloadPath: params.downloadPath,
    });
    return true;
  }
  const PageWithDownloads = params.Page as ChromeClient["Page"] & {
    setDownloadBehavior?: (options: {
      behavior: "allow";
      downloadPath: string;
    }) => Promise<unknown>;
  };
  if (PageWithDownloads?.setDownloadBehavior) {
    await PageWithDownloads.setDownloadBehavior({
      behavior: "allow",
      downloadPath: params.downloadPath,
    });
    return true;
  }
  return false;
}

function buildClickAssistantDownloadButtonsExpression(
  minTurnIndex?: number | null,
  expectedLabels: string[] = [],
  allowGenericDownloadLabels = true,
  options: { markClicked?: boolean; maxClicks?: number; returnDiagnostics?: boolean } = {},
): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const expectedLabelsLiteral = JSON.stringify(expectedLabels);
  const allowGenericDownloadLabelsLiteral = JSON.stringify(allowGenericDownloadLabels);
  const markClickedLiteral = JSON.stringify(options.markClicked === true);
  const returnDiagnosticsLiteral = JSON.stringify(options.returnDiagnostics === true);
  const maxClicksLiteral =
    typeof options.maxClicks === "number" &&
    Number.isFinite(options.maxClicks) &&
    options.maxClicks > 0
      ? Math.floor(options.maxClicks)
      : 0;
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const EXPECTED_LABELS = ${expectedLabelsLiteral};
    const ALLOW_GENERIC_DOWNLOAD_LABELS = ${allowGenericDownloadLabelsLiteral};
    const MARK_CLICKED = ${markClickedLiteral};
    const RETURN_DIAGNOSTICS = ${returnDiagnosticsLiteral};
    const MAX_CLICKS = ${maxClicksLiteral};
    const HAS_EXPECTED_LABELS = EXPECTED_LABELS.length > 0;
    const CLICKED_ATTRIBUTE = 'data-oracle-download-clicked';
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };
    const basename = (value) => {
      const raw = String(value || '').split(/[?#]/)[0].replace(/\\/+$/g, '');
      const part = raw.slice(raw.lastIndexOf('/') + 1);
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    const isSafeSandboxUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw.startsWith('sandbox:/mnt/data/')) return false;
      try {
        const pathName = decodeURI(new URL(raw).pathname);
        return pathName.startsWith('/mnt/data/') &&
          !pathName.includes('\\\\') &&
          !pathName.includes('\\0') &&
          !pathName.split('/').includes('..');
      } catch {
        return false;
      }
    };
    const isChatGptDownloadUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('sandbox:') || raw.startsWith('blob:')) return false;
      const isSafeSandboxPath = (pathName) => {
        const normalized = String(pathName || '');
        return normalized.startsWith('/mnt/data/') &&
          !normalized.includes('\\\\') &&
          !normalized.includes('\\0') &&
          !normalized.split('/').includes('..');
      };
      try {
        const url = new URL(raw, 'https://chatgpt.com');
        const host = url.hostname.toLowerCase();
        const allowedHost = host === 'chatgpt.com' || host === 'chat.openai.com';
        const pathName = url.pathname.toLowerCase();
        const isKnownFileDownload =
          (pathName === '/backend-api/sandbox/download' && isSafeSandboxPath(url.searchParams.get('path') || '')) ||
          /^\\/backend-api\\/files\\/[^/]+\\/(?:download|content)\\/?$/.test(pathName) ||
          (pathName === '/backend-api/estuary/content' && String(url.searchParams.get('id') || '').startsWith('file_'));
        return allowedHost && url.protocol === 'https:' && !url.port && isKnownFileDownload;
      } catch {
        return false;
      }
    };
    const safeLower = (value) => String(value || '').trim().toLowerCase();
    const controlInfo = (control) => {
      const href = String(control.tagName || '').toLowerCase() === 'a' ? (control.getAttribute('href') || control.href || '') : '';
      const text = (control.textContent || '').trim();
      const ariaLabel = control.getAttribute('aria-label') || '';
      const title = control.getAttribute('title') || '';
      const testId = control.getAttribute('data-testid') || '';
      const role = control.getAttribute('role') || '';
      const download = String(control.tagName || '').toLowerCase() === 'a' ? (control.getAttribute('download') || '') : '';
      const className = String(control.className || '');
      const attributeValues = Array.from(control.attributes || []).map((attribute) => String(attribute.value || ''));
      return {
        control,
        tagName: control.tagName || '',
        text,
        ariaLabel,
        title,
        testId,
        role,
        href,
        download,
        className,
        attributeValues,
        haystack: [text, ariaLabel, title, testId, role, href, download, basename(href), ...attributeValues]
          .map(safeLower)
          .filter(Boolean),
      };
    };
    const safeClickableControl = (info) =>
      safeLower(info.tagName) !== 'a' || isSafeSandboxUrl(info.href) || isChatGptDownloadUrl(info.href);
    const expectedFileControl = (info) => {
      return EXPECTED_LABELS.some((rawLabel) => {
        const label = safeLower(rawLabel);
        if (!label) return false;
        const downloadLabel = 'download ' + label;
        return info.haystack.some((value) =>
          value === label ||
          value.startsWith(label + ' ') ||
          value === downloadLabel ||
          value.startsWith(downloadLabel + ' ') ||
          value.endsWith('/' + label) ||
          value.includes('/' + label + '?') ||
          value.includes('/' + label + '#') ||
          value.includes('path=%2fmnt%2fdata%2f' + encodeURIComponent(label).toLowerCase()) ||
          value.includes('sandbox:/mnt/data/' + label)
        );
      });
    };
    const hasDownloadIntent = (info) =>
      info.haystack.some((value) =>
        value === 'download' ||
        /^download\\b/.test(value) ||
        value.includes('download') ||
        value === 'download-files-turn-action-button'
      );
    const genericBehaviorButton = (info) =>
      ALLOW_GENERIC_DOWNLOAD_LABELS && info.className.includes('behavior-btn') && hasDownloadIntent(info);
    const genericFallbackButton = (info) => ALLOW_GENERIC_DOWNLOAD_LABELS && hasDownloadIntent(info);
    const turns = ${buildConversationTurnListExpression()};
    const expectedMatches = new Set();
    const genericBehaviorMatches = new Set();
    const genericFallbackMatches = new Set();
    const genericAllMatches = new Set();
    let inspectedCount = 0;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) continue;
      if (MIN_TURN_INDEX >= 0 && index < MIN_TURN_INDEX) continue;
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) || turn;
      const controls = Array.from(messageRoot.querySelectorAll([
        'button',
        'a[href]',
        'a[download]',
        '[role="button"]',
      ].join(',')))
        .filter((control) => control instanceof HTMLElement)
        .filter((control) => !(MARK_CLICKED && control.getAttribute(CLICKED_ATTRIBUTE) === 'true'))
        .map(controlInfo)
        .filter(safeClickableControl);
      inspectedCount += controls.length;
      controls.filter(expectedFileControl).forEach((info) => expectedMatches.add(info));
      const genericBehavior = controls.filter(genericBehaviorButton);
      genericBehavior.forEach((info) => {
        genericBehaviorMatches.add(info);
        genericAllMatches.add(info);
      });
      if (genericBehavior.length === 0) {
        controls.filter(genericFallbackButton).forEach((info) => {
          genericFallbackMatches.add(info);
          genericAllMatches.add(info);
        });
      }
    }
    const selectedCategory = expectedMatches.size > 0
      ? 'expected-label'
      : HAS_EXPECTED_LABELS
        ? genericBehaviorMatches.size > 0
          ? 'generic-behavior'
          : 'generic-fallback'
        : 'generic-all';
    const selected = expectedMatches.size > 0
      ? expectedMatches
      : HAS_EXPECTED_LABELS
        ? genericBehaviorMatches.size > 0
          ? genericBehaviorMatches
          : genericFallbackMatches
        : genericAllMatches;
    const selectedControls = Array.from(selected).slice(0, MAX_CLICKS > 0 ? MAX_CLICKS : undefined);
    selectedControls.forEach((info) => {
      if (MARK_CLICKED) info.control.setAttribute(CLICKED_ATTRIBUTE, 'true');
      info.control.click();
    });
    const clickedDiagnostics = selectedControls.map((info) => ({
      text: info.text,
      ariaLabel: info.ariaLabel,
      title: info.title,
      testId: info.testId,
      tagName: info.tagName,
      role: info.role,
      hrefKind: info.href ? (info.href.startsWith('sandbox:') ? 'sandbox' : 'link') : '',
      category: selectedCategory,
    }));
    const clicked = clickedDiagnostics.map(({ text, ariaLabel, testId }) => ({ text, ariaLabel, testId }));
    return RETURN_DIAGNOSTICS ? { inspectedCount, selectedCategory, clicked: clickedDiagnostics } : clicked;
  })()`;
}

function describeDownloadableFile(file: BrowserDownloadableFile): string {
  return (
    file.filename ??
    file.label ??
    filenameFromUrl(file.sandboxUrl) ??
    filenameFromUrl(file.downloadUrl) ??
    filenameFromUrl(file.url) ??
    file.sandboxUrl ??
    file.downloadUrl ??
    file.url
  );
}

function expectedDownloadedFilename(file: BrowserDownloadableFile): string | undefined {
  const filename =
    file.filename ??
    filenameFromUrl(file.sandboxUrl) ??
    filenameFromUrl(file.downloadUrl) ??
    filenameFromUrl(file.url);
  const basename = path.basename(String(filename ?? "").trim());
  return basename && basename !== "." ? basename : undefined;
}

async function moveDownloadedFileToExpectedName(
  filePath: string,
  file: BrowserDownloadableFile,
): Promise<string> {
  const filename = expectedDownloadedFilename(file);
  if (!filename) {
    return filePath;
  }
  const targetPath = path.join(path.dirname(filePath), filename);
  if (path.resolve(targetPath) === path.resolve(filePath)) {
    return filePath;
  }
  const expected = path.parse(filename);
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const duplicatePattern = new RegExp(
    `^${escapeRegExp(expected.name)} ?\\(\\d+\\)${escapeRegExp(expected.ext)}$`,
  );
  if (!duplicatePattern.test(path.basename(filePath))) {
    return filePath;
  }
  const targetExists = await fs
    .stat(targetPath)
    .then((stat) => stat.isFile())
    .catch(() => false);
  if (targetExists) {
    return filePath;
  }
  await fs.rename(filePath, targetPath);
  return targetPath;
}

async function clickAssistantDownloadButtons(params: {
  Runtime: ChromeClient["Runtime"];
  minTurnIndex?: number | null;
  expectedLabels?: string[];
  allowGenericDownloadLabels?: boolean;
  markClicked?: boolean;
  maxClicks?: number;
  timeoutMs?: number;
  logger?: BrowserLogger;
}): Promise<ClickDownloadControlsResult> {
  const expression = buildClickAssistantDownloadButtonsExpression(
    params.minTurnIndex,
    params.expectedLabels ?? [],
    params.allowGenericDownloadLabels,
    { markClicked: params.markClicked, maxClicks: params.maxClicks, returnDiagnostics: true },
  );
  const deadline = Date.now() + (params.timeoutMs ?? DOWNLOAD_BUTTON_WAIT_MS);
  let lastInspectedCount = 0;
  let lastSelectedCategory: string | undefined;
  while (Date.now() < deadline) {
    const { result } = await params.Runtime.evaluate({
      expression,
      returnByValue: true,
    });
    const value = result?.value as unknown;
    const diagnosticValue =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as ClickDownloadControlsResult)
        : undefined;
    const clicked = Array.isArray(value)
      ? (value as ClickDownloadControlsResult["clicked"])
      : Array.isArray(diagnosticValue?.clicked)
        ? diagnosticValue.clicked
        : [];
    if (diagnosticValue) {
      lastInspectedCount = Number(diagnosticValue.inspectedCount ?? lastInspectedCount);
      lastSelectedCategory = diagnosticValue.selectedCategory ?? lastSelectedCategory;
    }
    if (clicked.length > 0) {
      return {
        clicked,
        inspectedCount: lastInspectedCount,
        selectedCategory: lastSelectedCategory,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    clicked: [],
    inspectedCount: lastInspectedCount,
    selectedCategory: lastSelectedCategory,
  };
}

function summarizeClickedControls(clicked: ClickDownloadControlsResult["clicked"]): string {
  return clicked
    .slice(0, 5)
    .map((control) => {
      const tag = control.tagName ? `tag=${safeDiagnosticText(control.tagName, 24)}` : "tag=?";
      const category = control.category
        ? `category=${safeDiagnosticText(control.category, 40)}`
        : "category=?";
      const testId = control.testId ? ` testId=${safeDiagnosticText(control.testId, 60)}` : "";
      const aria = control.ariaLabel ? ` aria=${safeDiagnosticText(control.ariaLabel, 60)}` : "";
      const text = control.text ? ` text=${safeDiagnosticText(control.text, 60)}` : "";
      const hrefKind = control.hrefKind
        ? ` hrefKind=${safeDiagnosticText(control.hrefKind, 40)}`
        : "";
      return `${tag} ${category}${testId}${aria}${text}${hrefKind}`;
    })
    .join("; ");
}

async function clickGeneratedDownloadUrl(params: {
  Runtime: ChromeClient["Runtime"];
  file: BrowserDownloadableFile;
  downloadUrl: string;
  logger?: BrowserLogger;
}): Promise<ClickDownloadControlsResult> {
  const filename = expectedDownloadedFilename(params.file) ?? "download";
  const expression = `(() => {
    const anchor = document.createElement('a');
    anchor.href = ${JSON.stringify(params.downloadUrl)};
    anchor.download = ${JSON.stringify(filename)};
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    anchor.setAttribute('data-oracle-generated-download-anchor', 'true');
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => anchor.remove(), 0);
    return {
      inspectedCount: 1,
      selectedCategory: 'generated-download-url',
      clicked: [{
        text: '',
        ariaLabel: '',
        title: '',
        testId: 'oracle-generated-download-anchor',
        tagName: 'A',
        role: '',
        hrefKind: ${JSON.stringify(classifyUrlKind(params.downloadUrl))},
        category: 'generated-download-url',
      }],
    };
  })()`;
  const { result } = await params.Runtime.evaluate({ expression, returnByValue: true });
  const value = result?.value as ClickDownloadControlsResult | undefined;
  return {
    clicked: Array.isArray(value?.clicked) ? value.clicked : [],
    inspectedCount: Number(value?.inspectedCount ?? 1),
    selectedCategory: value?.selectedCategory ?? "generated-download-url",
  };
}

async function savedBrowserFileFromPath(filePath: string): Promise<SavedBrowserFile> {
  const filename = path.basename(filePath);
  const stat = await fs.stat(filePath);
  const mimeType = mimeTypeFromFilename(filename);
  const validation = await validateArtifactFile({ path: filePath, filename, mimeType });
  return {
    kind: "file",
    path: filePath,
    label: filename,
    mimeType,
    sizeBytes: stat.size,
    sourceUrl: "browser-download",
    sha256: await computeFileSha256(filePath),
    validation,
    transfer: { status: "not-needed" },
    origin: { mode: "local" },
    url: "browser-download",
    finalUrl: "browser-download",
    filename,
  };
}

export async function saveAssistantDownloadButtonArtifacts(params: {
  Browser?: ChromeClient["Browser"];
  Client?: ChromeClient;
  Page?: ChromeClient["Page"];
  Runtime: ChromeClient["Runtime"];
  logger?: BrowserLogger;
  files?: BrowserDownloadableFile[];
  allowGenericDownloadLabels?: boolean;
  buttonWaitMs?: number;
  downloadPath?: string;
  downloadWaitMs?: number;
  minTurnIndex?: number | null;
  sessionId?: string;
}): Promise<SavedBrowserFile[]> {
  if (
    (!params.sessionId && !params.downloadPath) ||
    (!params.Client && !params.Browser && !params.Page)
  ) {
    return [];
  }
  const artifactsDir =
    params.downloadPath ?? resolveSessionArtifactsDir(params.sessionId as string);
  await fs.mkdir(artifactsDir, { recursive: true });
  const before = new Set(await fs.readdir(artifactsDir).catch(() => []));
  const configured = await configureBrowserDownloadPath({
    Browser: params.Browser,
    Client: params.Client,
    Page: params.Page,
    logger: params.logger,
    downloadPath: artifactsDir,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    params.logger?.(`[browser] Failed to configure browser download path: ${message}`);
    return false;
  });
  if (!configured) {
    params.logger?.(
      "[browser] Browser download path could not be configured; skipping button fallback.",
    );
    return [];
  }

  const buttonWaitMs = params.buttonWaitMs ?? DOWNLOAD_BUTTON_WAIT_MS;
  const downloadWaitMs = params.downloadWaitMs ?? DOWNLOAD_BUTTON_WAIT_MS;
  const expectedFiles = params.files ?? [];

  if (expectedFiles.length === 0) {
    const clickedResult = await clickAssistantDownloadButtons({
      Runtime: params.Runtime,
      minTurnIndex: params.minTurnIndex,
      expectedLabels: [],
      allowGenericDownloadLabels: params.allowGenericDownloadLabels,
      timeoutMs: buttonWaitMs,
      logger: params.logger,
    });
    if (clickedResult.clicked.length === 0) {
      params.logger?.(
        `[browser] No assistant download controls found for button fallback (inspected ${clickedResult.inspectedCount} control(s); category=${clickedResult.selectedCategory ?? "none"}).`,
      );
      return [];
    }
    params.logger?.(
      `[browser] Clicked ${clickedResult.clicked.length} assistant download control(s) ` +
        `(inspected ${clickedResult.inspectedCount}; category=${clickedResult.selectedCategory ?? "unknown"}; ` +
        `details=${summarizeClickedControls(clickedResult.clicked)}).`,
    );
    const downloaded = await waitForCompletedDownloadFiles(
      artifactsDir,
      before,
      clickedResult.clicked.length,
      downloadWaitMs,
    );
    return Promise.all(downloaded.map(savedBrowserFileFromPath));
  }

  let clickedCount = 0;
  let knownEntries = before;
  const downloadedPaths: string[] = [];
  const missingFiles: string[] = [];

  const unattemptedFiles: string[] = [];
  for (const [fileIndex, file] of expectedFiles.entries()) {
    const expectedLabels = resolveDownloadButtonLabels([file]);
    const displayName = describeDownloadableFile(file);
    let clickResult = await clickAssistantDownloadButtons({
      Runtime: params.Runtime,
      minTurnIndex: params.minTurnIndex,
      expectedLabels,
      allowGenericDownloadLabels: params.allowGenericDownloadLabels === true,
      markClicked: true,
      maxClicks: 1,
      timeoutMs: buttonWaitMs,
      logger: params.logger,
    });
    params.logger?.(
      `[browser] Button fallback inspected ${clickResult.inspectedCount} control(s) for ${sanitizeCandidateFilename(
        displayName,
      )}; category=${clickResult.selectedCategory ?? "none"}; clicked=${clickResult.clicked.length}.`,
    );
    if (clickResult.clicked.length > 0) {
      params.logger?.(
        `[browser] Button fallback clicked control detail(s): ${summarizeClickedControls(
          clickResult.clicked,
        )}`,
      );
    } else {
      const explicitDownloadUrl = normalizeChatGptDownloadUrl(file.downloadUrl ?? file.url);
      const sandboxDownloadUrl = downloadUrlFromSandboxUrl(file.sandboxUrl ?? file.url);
      const downloadUrl = explicitDownloadUrl ?? sandboxDownloadUrl;
      if (downloadUrl) {
        params.logger?.(
          `[browser] No matching assistant control for ${sanitizeCandidateFilename(
            displayName,
          )}; trying scoped generated browser download for urlKind=${classifyUrlKind(downloadUrl)}.`,
        );
        clickResult = await clickGeneratedDownloadUrl({
          Runtime: params.Runtime,
          file,
          downloadUrl,
          logger: params.logger,
        });
      }
    }
    if (clickResult.clicked.length === 0) {
      missingFiles.push(displayName);
      knownEntries = new Set(await fs.readdir(artifactsDir).catch(() => []));
      continue;
    }

    clickedCount += clickResult.clicked.length;
    const downloaded = await waitForCompletedDownloadFiles(
      artifactsDir,
      knownEntries,
      1,
      downloadWaitMs,
    );
    if (downloaded.length === 0) {
      missingFiles.push(displayName);
      unattemptedFiles.push(...expectedFiles.slice(fileIndex + 1).map(describeDownloadableFile));
      missingFiles.push(...unattemptedFiles);
      params.logger?.(
        `[browser] Download timed out for ${displayName}${
          unattemptedFiles.length > 0
            ? `; skipped remaining expected file(s) to avoid misassigning a late completion: ${unattemptedFiles.join(", ")}`
            : ""
        }`,
      );
      break;
    }

    const normalizedDownloads = await Promise.all(
      downloaded.map((filePath, index) =>
        index === 0 ? moveDownloadedFileToExpectedName(filePath, file) : filePath,
      ),
    );
    downloadedPaths.push(...normalizedDownloads);
    knownEntries = new Set(await fs.readdir(artifactsDir).catch(() => []));
  }

  if (clickedCount === 0) {
    params.logger?.("[browser] No assistant download controls found for button fallback.");
  } else {
    params.logger?.(`[browser] Clicked ${clickedCount} assistant download control(s).`);
  }
  if (missingFiles.length > 0) {
    params.logger?.(
      `[browser] Download button fallback did not save expected file(s): ${missingFiles.join(", ")}`,
    );
  }

  return Promise.all([...new Set(downloadedPaths)].map(savedBrowserFileFromPath));
}

interface DownloadedFilePayload {
  buffer: Buffer;
  contentDisposition: string | null;
  contentType: string | null;
  finalUrl: string;
}

async function fetchDownloadWithNode(
  downloadUrl: string,
  getCookieHeader: (url: string) => Promise<string>,
): Promise<DownloadedFilePayload> {
  let currentUrl = new URL(downloadUrl);
  for (let redirects = 0; redirects <= DOWNLOAD_REDIRECT_LIMIT; redirects += 1) {
    const headers: Record<string, string> = { "user-agent": "Mozilla/5.0" };
    if (
      currentUrl.protocol === "https:" &&
      !currentUrl.port &&
      isAllowedChatGptHost(currentUrl.hostname) &&
      isKnownChatGptFileDownloadUrl(currentUrl)
    ) {
      const cookieHeader = await getCookieHeader(currentUrl.href);
      if (!cookieHeader) {
        throw formatDownloadFailure({
          strategy: "node-fetch",
          finalUrl: currentUrl.href,
          message: "missing ChatGPT cookies for file download",
        });
      }
      headers.cookie = cookieHeader;
    }
    const response = await fetch(currentUrl, {
      headers,
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type");
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        const body = await readDiagnosticResponseBody(response, contentType);
        throw formatDownloadFailure({
          strategy: "node-fetch",
          status: response.status,
          statusText: response.statusText,
          contentType,
          finalUrl: currentUrl.href,
          ...body,
          message: "download redirect missing location",
        });
      }
      const redirectedUrl = new URL(location, currentUrl);
      if (redirectedUrl.protocol !== "https:") {
        throw formatDownloadFailure({
          strategy: "node-fetch",
          status: response.status,
          statusText: response.statusText,
          contentType,
          finalUrl: redirectedUrl.href,
          message: `download redirect rejected: ${redirectedUrl.protocol}`,
        });
      }
      currentUrl = redirectedUrl;
      continue;
    }
    if (!response.ok) {
      const body = await readDiagnosticResponseBody(response, contentType);
      throw formatDownloadFailure({
        strategy: "node-fetch",
        status: response.status,
        statusText: response.statusText,
        contentType,
        finalUrl: response.url || currentUrl.href,
        ...body,
      });
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentDisposition: response.headers.get("content-disposition"),
      contentType,
      finalUrl: response.url || currentUrl.href,
    };
  }
  throw formatDownloadFailure({
    strategy: "node-fetch",
    finalUrl: currentUrl.href,
    message: `download exceeded ${DOWNLOAD_REDIRECT_LIMIT} redirects`,
  });
}

async function fetchDownloadWithBrowser(
  Runtime: ChromeClient["Runtime"],
  downloadUrl: string,
): Promise<DownloadedFilePayload> {
  const expression = `(() => {
    const downloadUrl = ${JSON.stringify(downloadUrl)};
    const encodeBase64 = (bytes) => {
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    };
    return fetch(downloadUrl, { credentials: 'include' }).then(async (response) => {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        contentDisposition: response.headers.get('content-disposition'),
        contentType: response.headers.get('content-type'),
        base64: encodeBase64(bytes),
      };
    });
  })()`;
  const evaluated = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = evaluated.result?.value as
    | {
        base64?: string;
        contentDisposition?: string | null;
        contentType?: string | null;
        ok?: boolean;
        status?: number;
        statusText?: string;
        url?: string;
      }
    | undefined;
  if (!value) {
    throw new Error("browser download returned no value");
  }
  const contentType = typeof value.contentType === "string" ? value.contentType : null;
  const finalUrl = typeof value.url === "string" ? value.url : downloadUrl;
  if (!value.ok) {
    const body = decodeDiagnosticBodySnippet(
      Buffer.from(String(value.base64 ?? ""), "base64"),
      contentType,
    );
    throw formatDownloadFailure({
      strategy: "browser-fetch",
      status: value.status,
      statusText: value.statusText,
      contentType,
      finalUrl,
      ...body,
    });
  }
  return {
    buffer: Buffer.from(String(value.base64 ?? ""), "base64"),
    contentDisposition:
      typeof value.contentDisposition === "string" ? value.contentDisposition : null,
    contentType,
    finalUrl,
  };
}

export async function saveChatGptDownloadableFiles(params: {
  Network: ChromeClient["Network"];
  Runtime?: ChromeClient["Runtime"];
  files: BrowserDownloadableFile[];
  sessionId?: string;
  logger?: BrowserLogger;
}): Promise<{
  saved: boolean;
  fileCount: number;
  savedFiles: SavedBrowserFile[];
  failedFiles: BrowserDownloadableFile[];
  errors: string[];
}> {
  const { Network, files, sessionId, logger } = params;
  if (!files.length) {
    return { saved: false, fileCount: 0, savedFiles: [], failedFiles: [], errors: [] };
  }

  const cookieHeaders = new Map<string, string>();
  const getCookieHeader = async (downloadUrl: string) => {
    const origin = new URL(downloadUrl).origin;
    const cached = cookieHeaders.get(origin);
    if (cached !== undefined) {
      return cached;
    }
    const cookieHeader = await buildCookieHeader(Network, downloadUrl);
    cookieHeaders.set(origin, cookieHeader);
    return cookieHeader;
  };
  const savedFiles: SavedBrowserFile[] = [];
  const failedFiles: BrowserDownloadableFile[] = [];
  const errors: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const explicitDownloadUrl = normalizeChatGptDownloadUrl(file.downloadUrl ?? file.url);
    const sandboxDownloadUrl = downloadUrlFromSandboxUrl(file.sandboxUrl ?? file.url);
    const downloadUrl = explicitDownloadUrl ?? sandboxDownloadUrl;
    if (!downloadUrl) {
      const source = sanitizeCandidateFilename(file.sandboxUrl ?? file.filename ?? file.url);
      const message = `${source}: no ChatGPT download URL found`;
      errors.push(message);
      failedFiles.push(file);
      logger?.(`[browser] Skipping downloadable file ${index + 1}/${files.length}: ${message}`);
      continue;
    }
    const strategy: DirectDownloadStrategy =
      params.Runtime && sandboxDownloadUrl && !explicitDownloadUrl ? "browser-fetch" : "node-fetch";
    logger?.(
      `[browser] Download candidate ${index + 1}/${files.length}: ${describeDownloadableCandidate(
        file,
        downloadUrl,
      )} strategy=${strategy}`,
    );
    try {
      const downloaded =
        strategy === "browser-fetch"
          ? await fetchDownloadWithBrowser(params.Runtime as ChromeClient["Runtime"], downloadUrl)
          : await fetchDownloadWithNode(downloadUrl, getCookieHeader);
      const contentType = downloaded.contentType;
      const filename = resolveDownloadedFilename({
        file,
        contentDisposition: downloaded.contentDisposition,
        contentType,
        index,
      });
      const artifact = await writeBinaryBrowserArtifact({
        sessionId,
        kind: "file",
        filename,
        contents: downloaded.buffer,
        label: file.label || filename,
        mimeType: contentType ?? file.mimeType,
        sourceUrl: file.sandboxUrl ?? "chatgpt-file-endpoint",
        logger,
      });
      if (artifact) {
        savedFiles.push({
          ...artifact,
          kind: "file",
          url: downloadUrl,
          finalUrl: downloaded.finalUrl,
          sandboxUrl: file.sandboxUrl,
          filename,
        });
      } else {
        failedFiles.push(file);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = safeDiagnosticText(message, 500);
      const filename = sanitizeCandidateFilename(
        file.filename ??
          filenameFromUrl(file.sandboxUrl) ??
          filenameFromUrl(file.downloadUrl) ??
          file.url,
      );
      errors.push(`${filename}: ${safeMessage}`);
      failedFiles.push(file);
      logger?.(
        `[browser] Failed to save downloadable file ${index + 1}/${files.length} (${describeDownloadableCandidate(
          file,
          downloadUrl,
        )} strategy=${strategy}): ${safeMessage}`,
      );
    }
  }

  return {
    saved: savedFiles.length > 0,
    fileCount: files.length,
    savedFiles,
    failedFiles,
    errors,
  };
}

export async function collectChatGptFileArtifacts(params: {
  Browser?: ChromeClient["Browser"];
  Client?: ChromeClient;
  Page?: ChromeClient["Page"];
  Runtime: ChromeClient["Runtime"];
  Network: ChromeClient["Network"];
  answerText?: string | null;
  logger?: BrowserLogger;
  minTurnIndex?: number | null;
  sessionId?: string;
}): Promise<{
  files: BrowserDownloadableFile[];
  savedFiles: SavedBrowserFile[];
  fileCount: number;
}> {
  const files = await readAssistantDownloadableFiles(
    params.Runtime,
    params.minTurnIndex ?? undefined,
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    params.logger?.(
      `[browser] Failed to inspect assistant DOM file candidates: ${safeDiagnosticText(message, 180)}`,
    );
    return [];
  });
  const textFiles = readTextDownloadableFiles(params.answerText);
  params.logger?.(`[browser] Found ${files.length} DOM downloadable file candidate(s).`);
  params.logger?.(
    `[browser] Found ${textFiles.length} downloadable file link(s) in captured answer text.`,
  );
  const allFiles = dedupeFiles([...files, ...textFiles]);
  if (allFiles.length === 0) {
    return { files: [], savedFiles: [], fileCount: 0 };
  }
  params.logger?.(`[browser] Found ${allFiles.length} downloadable file candidate(s).`);
  allFiles.forEach((file, index) => {
    const explicitDownloadUrl = normalizeChatGptDownloadUrl(file.downloadUrl ?? file.url);
    const sandboxDownloadUrl = downloadUrlFromSandboxUrl(file.sandboxUrl ?? file.url);
    params.logger?.(
      `[browser] Candidate ${index + 1}/${allFiles.length}: ${describeDownloadableCandidate(
        file,
        explicitDownloadUrl ?? sandboxDownloadUrl,
      )}`,
    );
  });
  const saved = await saveChatGptDownloadableFiles({
    Network: params.Network,
    Runtime: params.Runtime,
    files: allFiles,
    sessionId: params.sessionId,
    logger: params.logger,
  });
  const buttonSavedFiles =
    saved.failedFiles.length > 0
      ? await saveAssistantDownloadButtonArtifacts({
          Browser: params.Browser,
          Client: params.Client,
          Page: params.Page,
          Runtime: params.Runtime,
          logger: params.logger,
          files: saved.failedFiles,
          allowGenericDownloadLabels: saved.savedFiles.length === 0,
          minTurnIndex: params.minTurnIndex,
          sessionId: params.sessionId,
        })
      : [];
  const savedFiles = [...saved.savedFiles, ...buttonSavedFiles];
  if (savedFiles.length === 0 && !saved.saved) {
    const detail = saved.errors.length > 0 ? `\n${saved.errors.join("\n")}` : "";
    params.logger?.(
      `[browser] Auto-save for downloadable files failed; returning metadata only.${detail}`,
    );
    params.logger?.(
      `[browser] WARNING: ${allFiles.length} downloadable candidate(s) existed, but no local browser-host artifact was saved; bridge artifact-ready will not be emitted until ChatGPT file capture succeeds.`,
    );
  } else {
    params.logger?.(`[browser] Saved ${savedFiles.length} downloadable file artifact(s).`);
  }
  return {
    files: allFiles,
    savedFiles,
    fileCount: allFiles.length,
  };
}

export const __test__ = {
  buildAssistantDownloadableFilesExpression,
  buildClickAssistantDownloadButtonsExpression,
  downloadUrlFromSandboxUrl,
  normalizeChatGptDownloadUrl,
  normalizeSandboxPath,
  normalizeSandboxUrl,
  readTextDownloadableFiles,
  resolveDownloadButtonLabels,
};
