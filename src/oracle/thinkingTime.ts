import type { ThinkingTimeLevel } from "./types.js";

export const THINKING_TIME_LEVELS = ["light", "standard", "extended", "heavy"] as const;
export const THINKING_TIME_ALIASES = [
  "instant",
  "low",
  "medium",
  "high",
  "extra-high",
  "extra high",
  "extrahigh",
  "xhigh",
] as const;
export const THINKING_TIME_INPUT_VALUES = [
  ...THINKING_TIME_LEVELS,
  ...THINKING_TIME_ALIASES,
] as const;

export type ThinkingTimeInput = (typeof THINKING_TIME_INPUT_VALUES)[number];

export function normalizeThinkingTimeLevel(
  value: string | null | undefined,
): ThinkingTimeLevel | null {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  switch (normalized) {
    case "light":
    case "instant":
    case "low":
      return "light";
    case "standard":
    case "medium":
      return "standard";
    case "extended":
    case "high":
      return "extended";
    case "heavy":
    case "extra-high":
    case "extrahigh":
    case "xhigh":
      return "heavy";
    default:
      return null;
  }
}
