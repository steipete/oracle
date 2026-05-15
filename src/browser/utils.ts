export { parseDuration } from "../duration.js";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  const estimate = Math.max(words.length * 0.75, text.length / 4);
  return Math.max(1, Math.round(estimate));
}

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function withRetries<T>(
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 2, delayMs = 250, onRetry } = options;
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await task();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      attempt += 1;
      onRetry?.(attempt, error);
      await delay(delayMs * attempt);
    }
  }
  throw new Error("withRetries exhausted without result");
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return "n/a";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Normalizes a ChatGPT URL, ensuring it is absolute, uses http/https, and trims whitespace.
 * Falls back to the provided default when input is empty/undefined.
 */
export function normalizeChatgptUrl(raw: string | null | undefined, fallback: string): string {
  const candidate = raw?.trim();
  if (!candidate) {
    return fallback;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
  const withScheme = hasScheme ? candidate : `https://${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid ChatGPT URL: "${raw}". Provide an absolute http(s) URL.`);
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error(`Invalid ChatGPT URL protocol: "${parsed.protocol}". Use http or https.`);
  }
  // Preserve user-provided path/query; URL#toString will normalize trailing slashes appropriately.
  return parsed.toString();
}

export function isTemporaryChatUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const value = (parsed.searchParams.get("temporary-chat") ?? "").trim().toLowerCase();
    return value === "true" || value === "1" || value === "yes";
  } catch {
    return false;
  }
}
