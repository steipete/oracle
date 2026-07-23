import { describe, expect, it } from "vitest";
import {
  applyModelOverride,
  resolveModelConfig,
  resolveOverriddenApiModel,
} from "../../src/oracle/modelResolver.js";
import { MODEL_CONFIGS } from "../../src/oracle/config.js";
import type { ModelConfig, ModelOverridesConfig } from "../../src/oracle/types.js";

const KNOWN_MODEL = "gpt-5.5";
const baseConfig = MODEL_CONFIGS[KNOWN_MODEL] as ModelConfig;

describe("applyModelOverride", () => {
  it("returns base unchanged when no overrides provided", () => {
    expect(applyModelOverride(baseConfig, KNOWN_MODEL, undefined)).toBe(baseConfig);
  });

  it("overrides apiModel + reasoning effort while inheriting tokenizer", () => {
    const result = applyModelOverride(baseConfig, KNOWN_MODEL, {
      [KNOWN_MODEL]: { apiModel: "gateway-model", reasoning: { effort: "high" } },
    });
    expect(result.apiModel).toBe("gateway-model");
    expect(result.reasoning).toEqual({ effort: "high" });
    // Tokenizer and other fields inherited from the known config.
    expect(result.tokenizer).toBe(baseConfig.tokenizer);
    expect(result.inputLimit).toBe(baseConfig.inputLimit);
    // Base config is not mutated.
    expect(baseConfig.apiModel).not.toBe("gateway-model");
  });

  it("accepts GPT-5.6 max reasoning effort", () => {
    const model = "gpt-5.6-sol";
    const config = MODEL_CONFIGS[model] as ModelConfig;
    const result = applyModelOverride(config, model, {
      [model]: { reasoning: { effort: "max" } },
    });
    expect(result.reasoning).toEqual({ effort: "max" });
  });

  it("clears reasoning when override sets reasoning: null", () => {
    const withReasoning: ModelConfig = { ...baseConfig, reasoning: { effort: "xhigh" } };
    const result = applyModelOverride(withReasoning, KNOWN_MODEL, {
      [KNOWN_MODEL]: { reasoning: null },
    });
    expect(result.reasoning).toBeNull();
  });

  it("overrides inputLimit and pricing", () => {
    const result = applyModelOverride(baseConfig, KNOWN_MODEL, {
      [KNOWN_MODEL]: {
        inputLimit: 1_050_000,
        pricing: { inputPerToken: 0.000005, outputPerToken: 0.00003 },
      },
    });
    expect(result.inputLimit).toBe(1_050_000);
    expect(result.pricing).toEqual({ inputPerToken: 0.000005, outputPerToken: 0.00003 });
  });

  it("ignores malformed reasoning effort (preserves base)", () => {
    const withReasoning: ModelConfig = { ...baseConfig, reasoning: { effort: "high" } };
    const result = applyModelOverride(withReasoning, KNOWN_MODEL, {
      [KNOWN_MODEL]: { reasoning: { effort: "ludicrous" } },
    } as unknown as ModelOverridesConfig);
    expect(result.reasoning).toEqual({ effort: "high" });
  });

  it("ignores invalid inputLimit / pricing values (preserves base)", () => {
    const result = applyModelOverride(baseConfig, KNOWN_MODEL, {
      [KNOWN_MODEL]: {
        inputLimit: -5,
        pricing: { inputPerToken: "free", outputPerToken: 1 },
      },
    } as unknown as ModelOverridesConfig);
    expect(result.inputLimit).toBe(baseConfig.inputLimit);
    expect(result.pricing ?? null).toEqual(baseConfig.pricing ?? null);
  });

  it("rejects non-integer / non-finite inputLimit (preserves base)", () => {
    for (const bad of [0, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = applyModelOverride(baseConfig, KNOWN_MODEL, {
        [KNOWN_MODEL]: { inputLimit: bad },
      } as unknown as ModelOverridesConfig);
      expect(result.inputLimit).toBe(baseConfig.inputLimit);
    }
  });

  it("does not override unknown models", () => {
    const synthetic: ModelConfig = {
      model: "some-custom-model",
      tokenizer: baseConfig.tokenizer,
      inputLimit: 200_000,
      reasoning: null,
    };
    const result = applyModelOverride(synthetic, "some-custom-model", {
      "some-custom-model": { apiModel: "should-be-ignored" },
    } as unknown as ModelOverridesConfig);
    expect(result.apiModel).toBeUndefined();
    expect(result).toBe(synthetic);
  });

  it("ignores an empty / whitespace apiModel", () => {
    const result = applyModelOverride(baseConfig, KNOWN_MODEL, {
      [KNOWN_MODEL]: { apiModel: "   " },
    });
    expect(result.apiModel).toBe(baseConfig.apiModel);
  });
});

describe("resolveModelConfig with modelOverrides", () => {
  it("applies overrides for a known model on a custom (non-OpenRouter) endpoint", async () => {
    const config = await resolveModelConfig(KNOWN_MODEL, {
      baseUrl: "https://my-gateway.example/v1",
      modelOverrides: {
        [KNOWN_MODEL]: { apiModel: "gateway-model", reasoning: { effort: "xhigh" } },
      },
    });
    expect(config.apiModel).toBe("gateway-model");
    expect(config.reasoning).toEqual({ effort: "xhigh" });
  });

  it("leaves config untouched when no override matches the model", async () => {
    const config = await resolveModelConfig(KNOWN_MODEL, {
      baseUrl: "https://my-gateway.example/v1",
      modelOverrides: { "gpt-5.4": { apiModel: "other" } },
    });
    expect(config.apiModel).toBe(baseConfig.apiModel);
  });
});

describe("resolveOverriddenApiModel", () => {
  it("returns the override apiModel for a known model", () => {
    expect(
      resolveOverriddenApiModel(KNOWN_MODEL, {
        [KNOWN_MODEL]: { apiModel: "gateway-model" },
      }),
    ).toBe("gateway-model");
  });

  it("returns undefined for unknown models, empty apiModel, or no overrides", () => {
    expect(resolveOverriddenApiModel(KNOWN_MODEL, undefined)).toBeUndefined();
    expect(
      resolveOverriddenApiModel("some-custom-model", {
        "some-custom-model": { apiModel: "x" },
      } as unknown as ModelOverridesConfig),
    ).toBeUndefined();
    expect(
      resolveOverriddenApiModel(KNOWN_MODEL, { [KNOWN_MODEL]: { apiModel: "   " } }),
    ).toBeUndefined();
    expect(
      resolveOverriddenApiModel(KNOWN_MODEL, { [KNOWN_MODEL]: { reasoning: null } }),
    ).toBeUndefined();
  });
});
