import fs from "node:fs/promises";
import path from "node:path";
import type {
  BrowserDownloadableFile,
  BrowserLogger,
  ChromeClient,
  SavedBrowserFile,
} from "./types.js";
import { ASSISTANT_ROLE_SELECTOR, CONVERSATION_TURN_SELECTOR } from "./constants.js";
import { resolveSessionArtifactsDir, writeBinaryBrowserArtifact } from "./artifacts.js";

const CHATGPT_DOWNLOAD_BASE_URL = "https://chatgpt.com/";
const DOWNLOAD_BUTTON_WAIT_MS = 15_000;
const DOWNLOAD_REDIRECT_LIMIT = 5;

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
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const CONVERSATION_SELECTOR = ${conversationLiteral};
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
    const serializeAnchor = (anchor) => {
      const hrefAttr = anchor.getAttribute('href') || '';
      const values = [hrefAttr, anchor.href || ''];
      for (const attribute of Array.from(anchor.attributes || [])) {
        values.push(String(attribute.value || ''));
      }
      const downloadUrl = values.find(isChatGptDownloadUrl) || '';
      const sandboxUrl = values.find(isSandboxUrl) || '';
      if (!downloadUrl && !sandboxUrl) return null;
      const label = (anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '').trim();
      const filename =
        anchor.getAttribute('download') ||
        basename(sandboxUrl) ||
        basename(downloadUrl) ||
        label ||
        '';
      return {
        url: downloadUrl || sandboxUrl || hrefAttr || anchor.href || '',
        downloadUrl,
        sandboxUrl,
        filename,
        label,
        mimeType: anchor.getAttribute('type') || '',
      };
    };
    const serializeFiles = (root) =>
      Array.from(root.querySelectorAll('a[href], a[download]'))
        .map(serializeAnchor)
        .filter(Boolean);
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
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
): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const expectedLabelsLiteral = JSON.stringify(expectedLabels);
  const allowGenericDownloadLabelsLiteral = JSON.stringify(allowGenericDownloadLabels);
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const EXPECTED_LABELS = ${expectedLabelsLiteral};
    const ALLOW_GENERIC_DOWNLOAD_LABELS = ${allowGenericDownloadLabelsLiteral};
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
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const selected = new Set();
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) continue;
      if (MIN_TURN_INDEX >= 0 && index < MIN_TURN_INDEX) continue;
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) || turn;
      const buttons = Array.from(messageRoot.querySelectorAll('button'));
      const primary = buttons.filter((button) => {
        const text = (button.textContent || '').trim().toLowerCase();
        const expectedFile = EXPECTED_LABELS.some(
          (label) => text === label || text.startsWith(label + ' ')
        );
        return String(button.className || '').includes('behavior-btn') &&
          (expectedFile || (ALLOW_GENERIC_DOWNLOAD_LABELS && /^download\\b/.test(text)));
      });
      const fallback = primary.length > 0 ? [] : buttons.filter((button) => {
        if (!ALLOW_GENERIC_DOWNLOAD_LABELS) return false;
        const text = (button.textContent || '').trim().toLowerCase();
        const aria = (button.getAttribute('aria-label') || '').trim().toLowerCase();
        const testId = (button.getAttribute('data-testid') || '').trim().toLowerCase();
        return text === 'download' || aria === 'download' || testId === 'download-files-turn-action-button';
      });
      [...primary, ...fallback].forEach((button) => selected.add(button));
    }
    const selectedButtons = Array.from(selected);
    selectedButtons.forEach((button) => button.click());
    return selectedButtons.map((button) => ({
      text: (button.textContent || '').trim(),
      ariaLabel: button.getAttribute('aria-label') || '',
      testId: button.getAttribute('data-testid') || '',
    }));
  })()`;
}

async function saveAssistantDownloadButtonArtifacts(params: {
  Browser?: ChromeClient["Browser"];
  Client?: ChromeClient;
  Page?: ChromeClient["Page"];
  Runtime: ChromeClient["Runtime"];
  logger?: BrowserLogger;
  files: BrowserDownloadableFile[];
  allowGenericDownloadLabels?: boolean;
  minTurnIndex?: number | null;
  sessionId?: string;
}): Promise<SavedBrowserFile[]> {
  if (!params.sessionId || (!params.Browser && !params.Page)) {
    return [];
  }
  const artifactsDir = resolveSessionArtifactsDir(params.sessionId);
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

  let clicked: unknown[] = [];
  const expression = buildClickAssistantDownloadButtonsExpression(
    params.minTurnIndex,
    resolveDownloadButtonLabels(params.files),
    params.allowGenericDownloadLabels,
  );
  const deadline = Date.now() + DOWNLOAD_BUTTON_WAIT_MS;
  while (Date.now() < deadline) {
    const { result } = await params.Runtime.evaluate({
      expression,
      returnByValue: true,
    });
    clicked = Array.isArray(result?.value) ? result.value : [];
    if (clicked.length > 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (clicked.length === 0) {
    params.logger?.("[browser] No assistant download buttons found for button fallback.");
    return [];
  }
  params.logger?.(`[browser] Clicked ${clicked.length} assistant download button(s).`);
  const downloaded = await waitForCompletedDownloadFiles(artifactsDir, before, clicked.length);
  return Promise.all(
    downloaded.map(async (filePath): Promise<SavedBrowserFile> => {
      const filename = path.basename(filePath);
      const stat = await fs.stat(filePath);
      return {
        kind: "file",
        path: filePath,
        label: filename,
        mimeType: mimeTypeFromFilename(filename),
        sizeBytes: stat.size,
        sourceUrl: "browser-download",
        url: "browser-download",
        finalUrl: "browser-download",
        filename,
      };
    }),
  );
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
        throw new Error("Missing ChatGPT cookies for file download.");
      }
      headers.cookie = cookieHeader;
    }
    const response = await fetch(currentUrl, {
      headers,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`download redirect missing location: ${response.status}`);
      }
      const redirectedUrl = new URL(location, currentUrl);
      if (redirectedUrl.protocol !== "https:") {
        throw new Error(`download redirect rejected: ${redirectedUrl.protocol}`);
      }
      currentUrl = redirectedUrl;
      continue;
    }
    if (!response.ok) {
      throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentDisposition: response.headers.get("content-disposition"),
      contentType: response.headers.get("content-type"),
      finalUrl: response.url,
    };
  }
  throw new Error(`download exceeded ${DOWNLOAD_REDIRECT_LIMIT} redirects`);
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
  if (!value.ok) {
    throw new Error(`download failed: ${value.status ?? "?"} ${value.statusText ?? ""}`.trim());
  }
  return {
    buffer: Buffer.from(String(value.base64 ?? ""), "base64"),
    contentDisposition:
      typeof value.contentDisposition === "string" ? value.contentDisposition : null,
    contentType: typeof value.contentType === "string" ? value.contentType : null,
    finalUrl: typeof value.url === "string" ? value.url : downloadUrl,
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
      const source = file.sandboxUrl ?? file.filename ?? file.url;
      errors.push(`${source}: no ChatGPT download URL found`);
      failedFiles.push(file);
      continue;
    }
    try {
      const downloaded =
        params.Runtime && sandboxDownloadUrl && !explicitDownloadUrl
          ? await fetchDownloadWithBrowser(params.Runtime, downloadUrl)
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
        sourceUrl: file.sandboxUrl ?? downloadUrl,
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
      errors.push(`${file.filename ?? file.downloadUrl ?? file.url}: ${message}`);
      failedFiles.push(file);
      logger?.(
        `[browser] Failed to save downloadable file ${index + 1}/${files.length}: ${message}`,
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
  ).catch(() => []);
  const textFiles = readTextDownloadableFiles(params.answerText);
  if (textFiles.length > 0) {
    params.logger?.(
      `[browser] Found ${textFiles.length} downloadable file link(s) in captured answer text.`,
    );
  }
  const allFiles = dedupeFiles([...files, ...textFiles]);
  if (allFiles.length === 0) {
    return { files: [], savedFiles: [], fileCount: 0 };
  }
  params.logger?.(`[browser] Found ${allFiles.length} downloadable file candidate(s).`);
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
