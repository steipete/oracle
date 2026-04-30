import type { ConsultInput } from "./types.js";

const CHATGPT_PRO_HEAVY_MODEL = "gpt-5-pro";

export function applyConsultPreset(input: ConsultInput): ConsultInput {
  if (!input.preset) {
    return input;
  }
  if (input.preset === "chatgpt-pro-heavy") {
    if (input.models && input.models.length > 0) {
      throw new Error('MCP consult preset "chatgpt-pro-heavy" cannot be combined with models.');
    }
    return {
      ...input,
      engine: input.engine ?? "browser",
      model: input.model ?? CHATGPT_PRO_HEAVY_MODEL,
      browserThinkingTime: input.browserThinkingTime ?? "heavy",
    };
  }
  return input;
}
