export function parseDuration(input: string, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }
  const lowercase = trimmed.toLowerCase();
  if (/^[0-9]+$/.test(lowercase)) {
    return Number(lowercase);
  }
  const normalized = lowercase.replace(/\s+/g, "");
  const singleMatch = /^([0-9]+)(ms|s|m|h)$/i.exec(normalized);
  if (singleMatch && singleMatch[0].length === normalized.length) {
    const value = Number(singleMatch[1]);
    return convertUnit(value, singleMatch[2]);
  }
  const multiDuration = /([0-9]+)(ms|h|m|s)/g;
  let total = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null = multiDuration.exec(normalized);
  while (match !== null) {
    if (match.index !== lastIndex) {
      return fallback;
    }
    total += convertUnit(Number(match[1]), match[2]);
    lastIndex = multiDuration.lastIndex;
    match = multiDuration.exec(normalized);
  }
  if (lastIndex > 0 && lastIndex === normalized.length) {
    return total;
  }
  return fallback;
}

function convertUnit(value: number, unitRaw: string | undefined): number {
  const unit = unitRaw?.toLowerCase();
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return value;
  }
}

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
  if (/[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new Error(`Invalid ChatGPT URL: "${raw}". Control characters are not allowed.`);
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
  const withScheme = hasScheme ? candidate : `https://${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid ChatGPT URL: "${raw}". Provide an absolute http(s) URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid ChatGPT URL protocol: "${parsed.protocol}". Use https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid ChatGPT URL: "${raw}". Credentials are not allowed.`);
  }
  if (parsed.port) {
    throw new Error(`Invalid ChatGPT URL: "${raw}". Custom ports are not allowed.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "chatgpt.com" && hostname !== "chat.openai.com") {
    throw new Error(`Invalid ChatGPT URL host: "${hostname}". Use chatgpt.com or chat.openai.com.`);
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
