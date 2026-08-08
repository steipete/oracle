import type { ThinkingTimeLevel } from "./types.js";

export const THINKING_TIME_LEVELS = [
  "light",
  "standard",
  "extended",
  "extra-high",
  // ChatGPT's unified Intelligence picker exposes Pro as the top effort tier of
  // the active model rather than a separate model row, so it is a level here.
  // Kept distinct from "heavy": requesting Pro must be deliberate.
  "pro",
  "heavy",
] as const;
export const THINKING_TIME_ALIASES = [
  "instant",
  "low",
  "medium",
  "high",
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
    case "extra-high":
    case "extrahigh":
    case "xhigh":
      return "extra-high";
    case "pro":
      return "pro";
    case "heavy":
      return "heavy";
    default:
      return null;
  }
}
