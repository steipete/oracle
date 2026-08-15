import type { BrowserLogger } from "../browser/types.js";

export type GeminiWebModelId =
  | "gemini-3.1-flash-lite"
  | "gemini-3.5-flash"
  | "gemini-3.1-pro"
  | "gemini-3-pro-deep-think";

export const DEFAULT_GEMINI_WEB_MODEL: GeminiWebModelId = "gemini-3.1-pro";
export const FALLBACK_GEMINI_WEB_MODEL: GeminiWebModelId = "gemini-3.1-flash-lite";

interface GeminiWebModelSpec {
  hash: string;
  modelCode: number;
  thinkingCode: number;
  capacity: number;
}

const MODEL_SPECS: Record<GeminiWebModelId, GeminiWebModelSpec> = {
  "gemini-3.1-flash-lite": {
    hash: "1d44b34bcaa1c04d",
    modelCode: 6,
    thinkingCode: 1,
    capacity: 2,
  },
  "gemini-3.5-flash": {
    hash: "56fdd199312815e2",
    modelCode: 1,
    thinkingCode: 1,
    capacity: 2,
  },
  "gemini-3.1-pro": {
    hash: "e6fa609c3fa255c0",
    modelCode: 3,
    thinkingCode: 1,
    capacity: 2,
  },
  "gemini-3-pro-deep-think": {
    hash: "e051ce1aa80aa576",
    modelCode: 5,
    thinkingCode: 2,
    capacity: 2,
  },
};

export function buildGeminiWebModelHeader(model: GeminiWebModelId): string {
  const spec = MODEL_SPECS[model];
  return JSON.stringify([
    1,
    null,
    null,
    null,
    spec.hash,
    null,
    null,
    0,
    [4],
    null,
    null,
    spec.capacity,
  ]);
}

export function getGeminiWebModelSelection(model: GeminiWebModelId): {
  modelCode: number;
  thinkingCode: number;
} {
  const { modelCode, thinkingCode } = MODEL_SPECS[model];
  return { modelCode, thinkingCode };
}

export function resolveGeminiWebModel(
  desiredModel: string | null | undefined,
  log?: BrowserLogger,
): GeminiWebModelId {
  const desired = typeof desiredModel === "string" ? desiredModel.trim() : "";
  if (!desired) return DEFAULT_GEMINI_WEB_MODEL;
  const normalized = desired.toLowerCase().replace(/[_\s]+/g, "-");

  switch (normalized) {
    case "gemini-3.1-pro":
    case "gemini-3-pro":
    case "gemini-3.0-pro":
      return "gemini-3.1-pro";
    case "gemini-3.5-flash":
      return "gemini-3.5-flash";
    case "gemini-3.1-flash-lite":
    case "gemini-3.1-flashlite":
      return "gemini-3.1-flash-lite";
    case "gemini-3-deep-think":
    case "gemini-3-pro-deep-think":
    case "gemini-3-pro-deepthink":
    case "gemini-3.1-pro-deep-think":
      return "gemini-3-pro-deep-think";
    case "gemini-2.5-pro":
      return "gemini-3.1-pro";
    case "gemini-2.5-flash":
      return "gemini-3.1-flash-lite";
    default:
      if (normalized.startsWith("gemini-") || normalized.includes("gemini")) {
        log?.(
          `[gemini-web] Unsupported Gemini web model "${desired}". Falling back to ${DEFAULT_GEMINI_WEB_MODEL}.`,
        );
      }
      return DEFAULT_GEMINI_WEB_MODEL;
  }
}
