import path from "node:path";
import fs from "node:fs/promises";
import type {
  ChromeClient,
  BrowserGeneratedImage,
  BrowserLogger,
  SavedBrowserImage,
} from "./types.js";
import { CONVERSATION_TURN_SELECTOR, ASSISTANT_ROLE_SELECTOR } from "./constants.js";

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
      const images = Array.from(messageRoot.querySelectorAll('img')).map((img) => ({
        url: img.src || '',
        alt: img.alt || '',
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
      })).filter((img) => img.url && img.url.includes('/backend-api/estuary/content?id=file_'));
      return images;
    }
    return [];
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
    .map((item) => ({
      url: typeof item?.url === "string" ? item.url : "",
      alt: typeof item?.alt === "string" ? item.alt : undefined,
      width: typeof item?.width === "number" ? item.width : undefined,
      height: typeof item?.height === "number" ? item.height : undefined,
      fileId: typeof item?.url === "string" ? extractFileId(item.url) : undefined,
    }))
    .filter((item) => item.url.length > 0);
  return dedupeImages(normalized);
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

async function buildCookieHeader(Network: ChromeClient["Network"]): Promise<string> {
  const response = await Network.getCookies({ urls: ["https://chatgpt.com/"] });
  return (response.cookies ?? [])
    .filter((cookie) => cookie.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export async function saveChatGptGeneratedImages(params: {
  Network: ChromeClient["Network"];
  images: BrowserGeneratedImage[];
  outputPath: string;
  logger?: BrowserLogger;
}): Promise<{
  saved: boolean;
  imageCount: number;
  savedImages: SavedBrowserImage[];
  errors: string[];
}> {
  const { Network, images, outputPath, logger } = params;
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
      const response = await fetch(image.url, {
        headers: {
          cookie: cookieHeader,
          "user-agent": "Mozilla/5.0",
        },
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error(`download failed: ${response.status} ${response.statusText}`);
      }
      const contentType = response.headers.get("content-type");
      const extension = contentTypeToExtension(contentType);
      const targetPath = resolveSiblingImagePath(path.resolve(outputPath), index, extension);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(targetPath, buffer);
      savedImages.push({
        path: targetPath,
        url: image.url,
        finalUrl: response.url,
        alt: image.alt,
        width: image.width,
        height: image.height,
        fileId: image.fileId,
        contentType: contentType ?? undefined,
        sizeBytes: buffer.length,
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
