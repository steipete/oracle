export function resolveBrowserProvider(model: unknown): "chatgpt" | "gemini" | undefined {
  if (typeof model !== "string") return undefined;
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("gpt-")) return "chatgpt";
  return undefined;
}

export const REMOTE_GEMINI_UNSUPPORTED_MESSAGE =
  "Gemini browser runs are supported locally; remote browser services support ChatGPT only.";
