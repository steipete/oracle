import type { ThinkingTimeLevel } from "./types.js";

export const THINKING_TIME_LEVELS = ["light", "standard", "extended", "heavy", "pro"] as const;
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
    case "pro":
      return "pro";
    default:
      return null;
  }
}

export function assertProThinkingTimeTarget(
  level: ThinkingTimeLevel | null | undefined,
  desiredModel: string | null | undefined,
): void {
  if (level !== "pro") return;
  const normalizedModel = (desiredModel ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const isGpt56Sol =
    /(?:^| )5 6(?: |$)/.test(normalizedModel) && normalizedModel.split(" ").includes("sol");
  if (!isGpt56Sol) {
    throw new Error(
      'Browser thinking time "pro" requires GPT-5.6 Sol with model strategy "select".',
    );
  }
}
