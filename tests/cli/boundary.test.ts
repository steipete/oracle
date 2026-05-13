import { InvalidArgumentError } from "commander";
import { describe, expect, test } from "vitest";

import {
  inferModelFromLabel,
  isWorkflowProviderSlotName,
  resolveApiModel,
} from "../../src/cli/options.ts";

const V18_PROVIDER_SLOTS = [
  "chatgpt_pro_first_plan",
  "chatgpt_pro_synthesis",
  "claude_code_opus",
  "codex_intake",
  "codex_thinking_fast_draft",
  "deepseek_v4_pro_reasoning_search",
  "gemini_deep_think",
  "xai_grok_reasoning",
] as const;

describe("CLI provider boundary", () => {
  test.each(V18_PROVIDER_SLOTS)("rejects v18 provider slot %s as an API model", (slot) => {
    expect(isWorkflowProviderSlotName(slot)).toBe(true);
    expect(() => resolveApiModel(slot)).toThrow(InvalidArgumentError);
    expect(() => resolveApiModel(slot)).toThrow(/not a model name/i);
  });

  test("rejects provider-slot spellings before fuzzy alias matching can substitute providers", () => {
    expect(() => resolveApiModel("chatgpt-pro-first-plan")).toThrow(
      /will not satisfy workflow slots/i,
    );
    expect(() => resolveApiModel("claude-code-opus")).toThrow(/not a model name/i);
    expect(() => inferModelFromLabel("codex-thinking-fast-draft")).toThrow(
      /not a model name/i,
    );
  });

  test("keeps ordinary API aliases and custom provider ids available", () => {
    expect(resolveApiModel("ChatGPT Pro")).toBe("gpt-5.5-pro");
    expect(resolveApiModel("Claude Opus 4.1")).toBe("claude-4.1-opus");
    expect(resolveApiModel("Grok 4.1")).toBe("grok-4.1");
    expect(resolveApiModel("openai/gpt-5.5-pro")).toBe("openai/gpt-5.5-pro");
    expect(resolveApiModel("deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
  });

  test("keeps browser label inference general-purpose outside provider-slot identifiers", () => {
    expect(inferModelFromLabel("Pro Extended")).toBe("gpt-5.5-pro");
    expect(inferModelFromLabel("Gemini Deep Think")).toBe("gemini-3-pro-deep-think");
    expect(inferModelFromLabel("Grok-4-1")).toBe("grok-4.1");
  });
});
