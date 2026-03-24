import type { ModelName } from "../oracle.js";
import { DEFAULT_MODEL_TARGET } from "./constants.js";

// Ordered array: most specific models first to ensure correct selection.
// The browser label is passed to the model picker which fuzzy-matches against ChatGPT's UI.
const BROWSER_MODEL_LABELS: [ModelName, string][] = [
  // Most specific first (e.g., "gpt-5.2-thinking" before "gpt-5.2")
  ["gpt-5.4-pro", "Extended Pro"],
  ["gpt-5.2-thinking", "GPT-5.2 Thinking"],
  ["gpt-5.2-instant", "GPT-5.2 Instant"],
  ["gpt-5.2-pro", "Extended Pro"],
  ["gpt-5.1-pro", "Extended Pro"],
  ["gpt-5-pro", "Extended Pro"],
  // Base models last (least specific)
  ["gpt-5.4", "Thinking 5.4"],
  ["gpt-5.2", "GPT-5.2"], // Selects "Auto" in ChatGPT UI
  ["gpt-5.1", "GPT-5.2"], // Legacy alias → Auto
  ["gemini-3-pro", "Gemini 3 Pro"],
  ["gemini-3-pro-deep-think", "gemini-3-deep-think"],
];

const NORMALIZED_BROWSER_LABELS = new Map<string, string>([
  ["extended pro", "Extended Pro"],
  ["gpt 5 4 pro", "Extended Pro"],
  ["gpt 5 2 pro", "Extended Pro"],
  ["gpt 5 1 pro", "Extended Pro"],
  ["gpt 5 pro", "Extended Pro"],
  ["thinking 5 4", "Thinking 5.4"],
  ["gpt 5 4", "Thinking 5.4"],
  ["gpt 5 2 thinking", "GPT-5.2 Thinking"],
  ["gpt 5 2 instant", "GPT-5.2 Instant"],
  ["gpt 5 2", "GPT-5.2"],
  ["gpt 5 1", "GPT-5.2"],
  ["gemini 3 pro", "Gemini 3 Pro"],
  ["gemini 3 pro deep think", "gemini-3-deep-think"],
  ["gemini 3 deep think", "gemini-3-deep-think"],
]);

function normalizeBrowserLabelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeBrowserModelLabel(value: string): string;
export function normalizeBrowserModelLabel(
  value: string | null | undefined,
): string | null | undefined;
export function normalizeBrowserModelLabel(
  value: string | null | undefined,
): string | null | undefined {
  if (value == null) {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  return NORMALIZED_BROWSER_LABELS.get(normalizeBrowserLabelKey(trimmed)) ?? trimmed;
}

export function normalizeChatGptModelForBrowser(model: ModelName): ModelName {
  const normalized = model.toLowerCase() as ModelName;
  if (!normalized.startsWith("gpt-") || normalized.includes("codex")) {
    return model;
  }

  if (normalized === "gpt-5.4-pro" || normalized === "gpt-5.4") {
    return normalized;
  }

  // Pro variants: resolve to the latest Pro model in ChatGPT.
  if (
    normalized === "gpt-5-pro" ||
    normalized === "gpt-5.1-pro" ||
    normalized === "gpt-5.2-pro"
  ) {
    return "gpt-5.4-pro";
  }

  // Explicit model variants: keep as-is (they have their own browser labels)
  if (normalized === "gpt-5.2-thinking" || normalized === "gpt-5.2-instant") {
    return normalized;
  }

  // Legacy aliases: map to base GPT-5.2 (Auto)
  if (normalized === "gpt-5.1") {
    return "gpt-5.2";
  }

  return model;
}

export function mapModelToBrowserLabel(model: ModelName): string {
  const normalized = normalizeChatGptModelForBrowser(model);
  for (const [key, label] of BROWSER_MODEL_LABELS) {
    if (key === normalized) {
      return label;
    }
  }
  return DEFAULT_MODEL_TARGET;
}

export function resolveBrowserModelLabel(input: string | undefined, model: ModelName): string {
  const trimmed = input?.trim?.() ?? "";
  if (!trimmed) {
    return mapModelToBrowserLabel(model);
  }
  const normalizedInput = trimmed.toLowerCase();
  if (normalizedInput === model.toLowerCase()) {
    return mapModelToBrowserLabel(model);
  }
  return normalizeBrowserModelLabel(trimmed) ?? trimmed;
}
