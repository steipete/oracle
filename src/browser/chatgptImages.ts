import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BrowserGeneratedImage,
  BrowserLogger,
  ChromeClient,
  SavedBrowserImage,
} from "./types.js";
import { ASSISTANT_ROLE_SELECTOR, CONVERSATION_TURN_SELECTOR } from "./constants.js";
import { delay } from "./utils.js";
import { readAssistantSnapshot } from "./pageActions.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { resolveSessionArtifactsDir } from "./artifacts.js";
import { saveAssistantDownloadButtonArtifacts } from "./chatgptFiles.js";

const GENERATED_IMAGE_WAIT_MIN_MS = 15_000;
const GENERATED_IMAGE_WAIT_MAX_MS = 15 * 60_000;
const CHATGPT_GENERATED_IMAGE_BASE_URL = "https://chatgpt.com/";

function isAllowedChatGptHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "chatgpt.com" || value === "chat.openai.com";
}

function normalizeGeneratedImageUrl(value?: string | null): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw, CHATGPT_GENERATED_IMAGE_BASE_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.port || !isAllowedChatGptHost(url.hostname)) {
    return undefined;
  }
  if (url.pathname !== "/backend-api/estuary/content") {
    return undefined;
  }
  if (!(url.searchParams.get("id") ?? "").startsWith("file_")) {
    return undefined;
  }
  return url.href;
}

function extractFileId(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("id") ?? undefined;
  } catch {
    return undefined;
  }
}

function dedupeImages(images: BrowserGeneratedImage[]): BrowserGeneratedImage[] {
  const best = new Map<string, BrowserGeneratedImage>();
  for (const image of images) {
    const key = image.fileId ?? image.url;
    const currentArea = (image.width ?? 0) * (image.height ?? 0);
    const existing = best.get(key);
    const existingArea = existing ? (existing.width ?? 0) * (existing.height ?? 0) : -1;
    if (!existing || currentArea >= existingArea) {
      best.set(key, image);
    }
  }
  return [...best.values()];
}

function buildAssistantImageExpression(minTurnIndex?: number): string {
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
    const isGeneratedImage = (img) => {
      const url = new URL(img?.src || '', location.origin || 'https://chatgpt.com');
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.port) return false;
      if (host !== 'chatgpt.com' && host !== 'chat.openai.com') return false;
      if (url.pathname !== '/backend-api/estuary/content') return false;
      if (!String(url.searchParams.get('id') || '').startsWith('file_')) return false;
      const alt = String(img.alt || '').toLowerCase();
      if (alt.includes('generated image')) return true;
      let node = img;
      while (node instanceof HTMLElement) {
        if (String(node.id || '').startsWith('image-')) return true;
        if (String(node.className || '').includes('imagegen-image')) return true;
        node = node.parentElement;
      }
      return false;
    };
    const serializeImages = (root) =>
      Array.from(root.querySelectorAll('img')).filter(isGeneratedImage).map((img) => ({
        url: img.src || '',
        alt: img.alt || '',
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
      }));
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
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) continue;
      if (MIN_TURN_INDEX >= 0 && index < MIN_TURN_INDEX) continue;
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) || turn;
      const images = serializeImages(messageRoot);
      if (images.length > 0) return images;
    }
    const boundary =
      MIN_TURN_INDEX > 0 && turns.length > 0
        ? turns[Math.min(MIN_TURN_INDEX - 1, turns.length - 1)]
        : null;
    return Array.from(document.querySelectorAll('img'))
      .filter(isGeneratedImage)
      .filter((img) => {
        if (!boundary) return true;
        return Boolean(boundary.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING);
      })
      .map((img) => ({
        url: img.src || '',
        alt: img.alt || '',
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
      }));
  })()`;
}

export async function readAssistantGeneratedImages(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
): Promise<BrowserGeneratedImage[]> {
  const { result } = await Runtime.evaluate({
    expression: buildAssistantImageExpression(minTurnIndex),
    returnByValue: true,
  });
  const raw = Array.isArray(result?.value) ? result.value : [];
  const normalized = raw
    .map((item) => {
      const url = normalizeGeneratedImageUrl(typeof item?.url === "string" ? item.url : "");
      return {
        url: url ?? "",
        alt: typeof item?.alt === "string" ? item.alt : undefined,
        width: typeof item?.width === "number" ? item.width : undefined,
        height: typeof item?.height === "number" ? item.height : undefined,
        fileId: url ? extractFileId(url) : undefined,
      };
    })
    .filter((item) => item.url.length > 0);
  return dedupeImages(normalized);
}

async function readAssistantGeneratedImagesWithFallback(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number | null,
): Promise<BrowserGeneratedImage[]> {
  const filteredImages = await readAssistantGeneratedImages(
    Runtime,
    minTurnIndex ?? undefined,
  ).catch(() => []);
  if (
    filteredImages.length > 0 ||
    typeof minTurnIndex !== "number" ||
    !Number.isFinite(minTurnIndex)
  ) {
    return filteredImages;
  }

  const [fallbackImages, fallbackSnapshot] = await Promise.all([
    readAssistantGeneratedImages(Runtime).catch(() => []),
    readAssistantSnapshot(Runtime).catch(() => null),
  ]);
  const fallbackTurnIndex =
    typeof fallbackSnapshot?.turnIndex === "number" ? fallbackSnapshot.turnIndex : null;
  const nearBoundary =
    fallbackTurnIndex !== null && fallbackTurnIndex + 1 >= Math.floor(minTurnIndex);
  return fallbackImages.length > 0 && nearBoundary ? fallbackImages : [];
}

function resolveGeneratedImageWaitTimeoutMs(waitTimeoutMs?: number): number {
  const requestedTimeout =
    typeof waitTimeoutMs === "number" && Number.isFinite(waitTimeoutMs)
      ? waitTimeoutMs
      : GENERATED_IMAGE_WAIT_MAX_MS;
  return Math.max(
    GENERATED_IMAGE_WAIT_MIN_MS,
    Math.min(requestedTimeout, GENERATED_IMAGE_WAIT_MAX_MS),
  );
}

export function resolveGeneratedImageWaitTimeoutMsForTest(waitTimeoutMs?: number): number {
  return resolveGeneratedImageWaitTimeoutMs(waitTimeoutMs);
}

function contentTypeToExtension(contentType: string | null): string {
  const value = String(contentType ?? "").toLowerCase();
  if (value.includes("png")) return "png";
  if (value.includes("jpeg") || value.includes("jpg")) return "jpg";
  if (value.includes("webp")) return "webp";
  if (value.includes("gif")) return "gif";
  if (value.includes("svg")) return "svg";
  return "bin";
}

function detectImageFile(buffer: Buffer): { extension: string; mimeType: string } | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: "webp", mimeType: "image/webp" };
  }
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") {
    return { extension: "gif", mimeType: "image/gif" };
  }
  const text = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("utf8").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    return { extension: "svg", mimeType: "image/svg+xml" };
  }
  return null;
}

function resolveSiblingImagePath(basePath: string, index: number, extension: string): string {
  const ext = path.extname(basePath);
  const dir = path.dirname(basePath);
  const stem = ext ? path.basename(basePath, ext) : path.basename(basePath);
  if (index === 0) {
    return ext ? basePath : path.join(dir, `${stem}.${extension}`);
  }
  const suffix = ext ? `${stem}.${index + 1}${ext}` : `${stem}.${index + 1}.${extension}`;
  return path.join(dir, suffix);
}

function sanitizeGeneratedImageStem(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function resolveDefaultGeneratedImagePath(
  images: BrowserGeneratedImage[],
  sessionId?: string,
): string {
  const primary = images[0];
  const stemSource = primary?.fileId || primary?.alt || primary?.url || "generated";
  const stem = sanitizeGeneratedImageStem(stemSource) || "generated";
  const baseDir = sessionId
    ? resolveSessionArtifactsDir(sessionId)
    : path.join(getOracleHomeDir(), ".temp");
  const uniqueSuffix = sessionId ? "" : `-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  return path.join(baseDir, `${stem}${uniqueSuffix}.png`);
}

async function buildCookieHeader(Network: ChromeClient["Network"]): Promise<string> {
  const response = await Network.getCookies({ urls: ["https://chatgpt.com/"] });
  return (response.cookies ?? [])
    .filter((cookie) => cookie.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function fetchGeneratedImageInBrowserContext(
  Runtime: ChromeClient["Runtime"],
  url: string,
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string }> {
  const expression = `
    (async () => {
      const url = ${JSON.stringify(url)};
      const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
      const contentType = response.headers.get('content-type') || '';
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        contentType,
        finalUrl: response.url,
        b64: btoa(binary),
      };
    })()
  `;
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120_000,
  });
  if (exceptionDetails) {
    throw new Error("browser-context fetch threw an exception");
  }
  const value = result?.value as
    | {
        ok?: boolean;
        status?: number;
        statusText?: string;
        contentType?: string;
        finalUrl?: string;
        b64?: string;
      }
    | undefined;
  if (!value?.ok || typeof value.b64 !== "string") {
    const status = typeof value?.status === "number" ? value.status : "unknown";
    const statusText = typeof value?.statusText === "string" ? value.statusText : "";
    throw new Error(`browser-context fetch failed: ${status} ${statusText}`.trim());
  }
  return {
    buffer: Buffer.from(value.b64, "base64"),
    contentType: typeof value.contentType === "string" ? value.contentType : null,
    finalUrl: typeof value.finalUrl === "string" && value.finalUrl ? value.finalUrl : url,
  };
}

export async function saveChatGptGeneratedImages(params: {
  Network: ChromeClient["Network"];
  Runtime?: ChromeClient["Runtime"];
  images: BrowserGeneratedImage[];
  outputPath: string;
  logger?: BrowserLogger;
}): Promise<{
  saved: boolean;
  imageCount: number;
  savedImages: SavedBrowserImage[];
  errors: string[];
}> {
  const { Network, Runtime, images, outputPath, logger } = params;
  if (!images.length) return { saved: false, imageCount: 0, savedImages: [], errors: [] };

  const cookieHeader = await buildCookieHeader(Network);
  if (!cookieHeader) {
    return {
      saved: false,
      imageCount: images.length,
      savedImages: [],
      errors: ["Missing ChatGPT cookies for image download."],
    };
  }

  const savedImages: SavedBrowserImage[] = [];
  const errors: string[] = [];
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    try {
      const imageUrl = normalizeGeneratedImageUrl(image.url);
      if (!imageUrl) {
        throw new Error("rejected non-ChatGPT generated image URL");
      }
      let contentType: string | null = null;
      let finalUrl = imageUrl;
      let buffer: Buffer;

      try {
        const response = await fetch(imageUrl, {
          headers: {
            cookie: cookieHeader,
            "user-agent": "Mozilla/5.0",
          },
          redirect: "follow",
        });
        if (!response.ok) {
          throw new Error(`download failed: ${response.status} ${response.statusText}`);
        }
        contentType = response.headers.get("content-type");
        finalUrl = response.url;
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (downloadError) {
        if (!Runtime) {
          throw downloadError;
        }
        const message =
          downloadError instanceof Error ? downloadError.message : String(downloadError);
        logger?.(
          `[browser] ChatGPT generated image download failed via Node fetch; retrying in browser context (${image.fileId ?? imageUrl}: ${message}).`,
        );
        const browserFetch = await fetchGeneratedImageInBrowserContext(Runtime, imageUrl);
        contentType = browserFetch.contentType;
        finalUrl = browserFetch.finalUrl;
        buffer = browserFetch.buffer;
      }

      const extension = contentTypeToExtension(contentType);
      const targetPath = resolveSiblingImagePath(path.resolve(outputPath), index, extension);
      await fs.writeFile(targetPath, buffer);
      savedImages.push({
        kind: "image",
        path: targetPath,
        label: index === 0 ? "Generated image" : `Generated image ${index + 1}`,
        mimeType: contentType ?? undefined,
        sizeBytes: buffer.length,
        sourceUrl: imageUrl,
        url: imageUrl,
        finalUrl,
        alt: image.alt,
        width: image.width,
        height: image.height,
        fileId: image.fileId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${image.fileId ?? image.url}: ${message}`);
      logger?.(
        `[browser] Failed to save generated image ${index + 1}/${images.length}: ${message}`,
      );
    }
  }

  return {
    saved: savedImages.length > 0,
    imageCount: images.length,
    savedImages,
    errors,
  };
}

async function saveGeneratedImageButtonArtifacts(params: {
  Browser?: ChromeClient["Browser"];
  Client?: ChromeClient;
  Page?: ChromeClient["Page"];
  Runtime: ChromeClient["Runtime"];
  logger?: BrowserLogger;
  minTurnIndex?: number | null;
  targetPath: string;
}): Promise<SavedBrowserImage[]> {
  const buttonDownloads = await saveAssistantDownloadButtonArtifacts({
    Browser: params.Browser,
    Client: params.Client,
    Page: params.Page,
    Runtime: params.Runtime,
    logger: params.logger,
    files: [],
    allowGenericDownloadLabels: true,
    downloadPath: path.dirname(params.targetPath),
    minTurnIndex: params.minTurnIndex,
  });
  const buttonImages: SavedBrowserImage[] = [];
  for (const download of buttonDownloads) {
    const contents = await fs.readFile(download.path);
    const detected = detectImageFile(contents);
    if (!detected) {
      await fs.unlink(download.path).catch(() => undefined);
      params.logger?.(`[browser] Ignored non-image assistant download: ${download.label}`);
      continue;
    }
    const index = buttonImages.length;
    const resolvedPath = resolveSiblingImagePath(params.targetPath, index, detected.extension);
    if (path.resolve(download.path) !== resolvedPath) {
      await fs.copyFile(download.path, resolvedPath);
      await fs.unlink(download.path);
    }
    const stat = await fs.stat(resolvedPath);
    buttonImages.push({
      kind: "image",
      path: resolvedPath,
      label: index === 0 ? "Generated image" : `Generated image ${index + 1}`,
      mimeType: detected.mimeType,
      sizeBytes: stat.size,
      sourceUrl: "browser-download",
      url: "browser-download",
      finalUrl: "browser-download",
      alt: download.label,
    });
  }
  if (buttonImages.length > 0) {
    params.logger?.(`[browser] Saved ${buttonImages.length} generated image download artifact(s).`);
  }
  return buttonImages;
}

function formatButtonImageArtifacts(
  buttonImages: SavedBrowserImage[],
  answerText: string,
): {
  generatedImages: BrowserGeneratedImage[];
  savedImages: SavedBrowserImage[];
  imageCount: number;
  markdownSuffix: string;
  answerText: string;
} {
  const primaryPath = buttonImages[0]?.path ?? "";
  return {
    generatedImages: buttonImages.map((image) => ({
      url: image.url,
      alt: image.alt,
    })),
    savedImages: buttonImages,
    imageCount: buttonImages.length,
    markdownSuffix:
      buttonImages.length > 1
        ? `\n\n*Generated ${buttonImages.length} image(s). Saved ${buttonImages.length} file(s) starting at: ${primaryPath}*`
        : `\n\n*Generated 1 image(s). Saved to: ${primaryPath}*`,
    answerText,
  };
}

export async function collectGeneratedImageArtifacts(params: {
  Browser?: ChromeClient["Browser"];
  Client?: ChromeClient;
  Page?: ChromeClient["Page"];
  Runtime: ChromeClient["Runtime"];
  Network: ChromeClient["Network"];
  logger?: BrowserLogger;
  minTurnIndex?: number | null;
  sessionId?: string;
  generateImagePath?: string;
  outputPath?: string;
  answerText: string;
  waitTimeoutMs?: number;
  checkBlockingUiWarning?: () => Promise<void>;
}): Promise<{
  generatedImages: BrowserGeneratedImage[];
  savedImages: SavedBrowserImage[];
  imageCount: number;
  markdownSuffix: string;
  answerText: string;
}> {
  const explicitTargetPath = params.generateImagePath ?? params.outputPath;
  let generatedImages = await readAssistantGeneratedImagesWithFallback(
    params.Runtime,
    params.minTurnIndex ?? undefined,
  );
  let latestAnswerText = params.answerText;

  if (explicitTargetPath && generatedImages.length === 0) {
    await params.checkBlockingUiWarning?.();
    const targetPath = path.resolve(explicitTargetPath);
    const buttonImages = await saveGeneratedImageButtonArtifacts({
      Browser: params.Browser,
      Client: params.Client,
      Page: params.Page,
      Runtime: params.Runtime,
      logger: params.logger,
      minTurnIndex: params.minTurnIndex,
      targetPath,
    });
    if (buttonImages.length > 0) {
      return formatButtonImageArtifacts(buttonImages, latestAnswerText);
    }
    const deadline = Date.now() + resolveGeneratedImageWaitTimeoutMs(params.waitTimeoutMs);
    while (Date.now() < deadline) {
      await delay(1500);
      await params.checkBlockingUiWarning?.();
      generatedImages = await readAssistantGeneratedImagesWithFallback(
        params.Runtime,
        params.minTurnIndex ?? undefined,
      );
      if (generatedImages.length > 0) {
        break;
      }
      const latestSnapshot = await readAssistantSnapshot(
        params.Runtime,
        params.minTurnIndex ?? undefined,
      ).catch(() => null);
      const snapshotText =
        typeof latestSnapshot?.text === "string" ? latestSnapshot.text.trim() : "";
      if (snapshotText) {
        latestAnswerText = snapshotText;
      }
    }
    if (generatedImages.length === 0) {
      await params.checkBlockingUiWarning?.();
      const delayedButtonImages = await saveGeneratedImageButtonArtifacts({
        Browser: params.Browser,
        Client: params.Client,
        Page: params.Page,
        Runtime: params.Runtime,
        logger: params.logger,
        minTurnIndex: params.minTurnIndex,
        targetPath,
      });
      if (delayedButtonImages.length > 0) {
        return formatButtonImageArtifacts(delayedButtonImages, latestAnswerText);
      }
    }
  }

  const imageCount = generatedImages.length;
  if (explicitTargetPath && imageCount === 0) {
    throw new Error(
      `No images generated. Response text:\n${latestAnswerText || "(empty response)"}`,
    );
  }
  if (imageCount === 0) {
    return {
      generatedImages,
      savedImages: [],
      imageCount,
      markdownSuffix: "",
      answerText: latestAnswerText,
    };
  }

  const targetPath =
    explicitTargetPath ?? resolveDefaultGeneratedImagePath(generatedImages, params.sessionId);
  if (!explicitTargetPath) {
    params.logger?.(`[browser] Auto-saving generated images to ${targetPath}`);
  }

  const saved = await saveChatGptGeneratedImages({
    Network: params.Network,
    Runtime: params.Runtime,
    images: generatedImages,
    outputPath: targetPath,
    logger: params.logger,
  });
  if (!saved.saved) {
    if (explicitTargetPath) {
      const buttonImages = await saveGeneratedImageButtonArtifacts({
        Browser: params.Browser,
        Client: params.Client,
        Page: params.Page,
        Runtime: params.Runtime,
        logger: params.logger,
        minTurnIndex: params.minTurnIndex,
        targetPath: path.resolve(explicitTargetPath),
      });
      if (buttonImages.length > 0) {
        return formatButtonImageArtifacts(buttonImages, latestAnswerText);
      }
    }
    const detail = saved.errors.length > 0 ? `\n${saved.errors.join("\n")}` : "";
    if (explicitTargetPath) {
      throw new Error(
        `No images generated. Response text:\n${latestAnswerText || "(empty response)"}${detail}`,
      );
    }
    params.logger?.(
      `[browser] Auto-save for generated images failed; returning metadata only.${detail}`,
    );
    return {
      generatedImages,
      savedImages: [],
      imageCount,
      markdownSuffix: `\n\n*Generated ${imageCount} image(s).*`,
      answerText: latestAnswerText,
    };
  }

  const primaryPath = saved.savedImages[0]?.path ?? targetPath;
  const suffix =
    saved.savedImages.length > 1
      ? `\n\n*Generated ${saved.imageCount} image(s). Saved ${saved.savedImages.length} file(s) starting at: ${primaryPath}*`
      : `\n\n*Generated ${saved.imageCount} image(s). Saved to: ${primaryPath}*`;
  return {
    generatedImages,
    savedImages: saved.savedImages,
    imageCount: saved.imageCount,
    markdownSuffix: suffix,
    answerText: latestAnswerText,
  };
}
