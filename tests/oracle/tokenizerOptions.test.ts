import { describe, expect, test } from "vitest";
import { MODEL_CONFIGS, TOKENIZER_OPTIONS } from "../../src/oracle/config.js";
import { resolveModelConfig } from "../../src/oracle/modelResolver.js";

describe("lazy tokenizer wrappers", () => {
  test("preserve tokenizer options for built-in models", () => {
    expect(MODEL_CONFIGS["gpt-5.1"].tokenizer("<|endoftext|>", TOKENIZER_OPTIONS)).toBeGreaterThan(
      0,
    );
  });

  test("preserve tokenizer options for synthesized model configs", async () => {
    const config = await resolveModelConfig("custom/model");
    expect(config.tokenizer("<|endoftext|>", TOKENIZER_OPTIONS)).toBeGreaterThan(0);
  });
});
