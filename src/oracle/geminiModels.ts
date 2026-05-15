import type { ModelName } from "./types.js";

const MODEL_ID_MAP: Record<ModelName, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gpt-5.5": "gpt-5.5",
  "gpt-5.5-pro": "gpt-5.5-pro",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-pro": "gpt-5.4-pro",
  "gpt-5.1-pro": "gpt-5.1-pro",
  "gpt-5-pro": "gpt-5-pro",
  "gpt-5.1": "gpt-5.1",
  "gpt-5.1-codex": "gpt-5.1-codex",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-instant": "gpt-5.2-instant",
  "gpt-5.2-pro": "gpt-5.2-pro",
  "claude-4.6-sonnet": "claude-4.6-sonnet",
  "claude-4.1-opus": "claude-4.1-opus",
  "grok-4.1": "grok-4.1",
};

export function resolveGeminiModelId(modelName: ModelName): string {
  return MODEL_ID_MAP[modelName] ?? modelName;
}
