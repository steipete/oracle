import path from "node:path";
import fs from "node:fs/promises";
import type {
  ChromeClient,
  BrowserGeneratedImage,
  BrowserLogger,
  SavedBrowserImage,
} from "./types.js";
import { CONVERSATION_TURN_SELECTOR, ASSISTANT_ROLE_SELECTOR } from "./constants.js";
import { delay } from "./utils.js";
import { readAssistantSnapshot } from "./pageActions.js";
import { getOracleHomeDir } from "../oracleHome.js";

const GENERATED_IMAGE_WAIT_MIN_MS = 15_000;
const GENERATED_IMAGE_WAIT_MAX_MS = 15 * 60_000;

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

function resolveDefaultGeneratedImagePath(images: BrowserGeneratedImage[]): string {
  const primary = images[0];
  const stemSource =
    primary?.fileId ||
    primary?.alt ||
    primary?.url ||
    `generated-${Date.now().toString(36)}`;
  const stem = sanitizeGeneratedImageStem(stemSource) || `generated-${Date.now().toString(36)}`;
  return path.join(getOracleHomeDir(), ".temp", `${stem}.png`);
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

export async function collectGeneratedImageArtifacts(params: {
  Runtime: ChromeClient["Runtime"];
  Network: ChromeClient["Network"];
  logger?: BrowserLogger;
  minTurnIndex?: number | null;
  generateImagePath?: string;
  outputPath?: string;
  answerText: string;
  waitTimeoutMs?: number;
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
    const deadline = Date.now() + resolveGeneratedImageWaitTimeoutMs(params.waitTimeoutMs);
    while (Date.now() < deadline) {
      await delay(1500);
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
  }

  const imageCount = generatedImages.length;
  if (explicitTargetPath && imageCount === 0) {
    throw new Error(`No images generated. Response text:\n${latestAnswerText || "(empty response)"}`);
  }
  if (imageCount === 0) {
    return {
      generatedImages,
      savedImages: [],
      imageCount,
      markdownSuffix: imageCount > 0 ? `\n\n*Generated ${imageCount} image(s).*` : "",
      answerText: latestAnswerText,
    };
  }

  const targetPath = explicitTargetPath ?? resolveDefaultGeneratedImagePath(generatedImages);
  if (!explicitTargetPath) {
    params.logger?.(`[browser] Auto-saving generated images to ${targetPath}`);
  }

  const saved = await saveChatGptGeneratedImages({
    Network: params.Network,
    images: generatedImages,
    outputPath: targetPath,
    logger: params.logger,
  });
  if (!saved.saved) {
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
