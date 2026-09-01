import { describe, it, expect, vi } from "vitest";
import {
  resolvePerplexityWebModel,
  perplexityModeForModel,
  isPerplexityModel,
  DEFAULT_PERPLEXITY_WEB_MODEL,
} from "../../src/perplexity-web/models.js";

describe("resolvePerplexityWebModel", () => {
  it("resolves the canonical model ids", () => {
    expect(resolvePerplexityWebModel("perplexity")).toBe("perplexity");
    expect(resolvePerplexityWebModel("perplexity-research")).toBe("perplexity-research");
  });

  it("resolves the browser picker labels that arrive as config.desiredModel", () => {
    // BROWSER_MODEL_LABELS maps model ids to UI labels, and the executor receives
    // the label rather than the id, so both must resolve without a warning.
    const log = vi.fn();
    expect(resolvePerplexityWebModel("Search", log)).toBe("perplexity");
    expect(resolvePerplexityWebModel("Deep research", log)).toBe("perplexity-research");
    expect(log).not.toHaveBeenCalled();
  });

  it("accepts common aliases and spacing variants", () => {
    expect(resolvePerplexityWebModel("pplx")).toBe("perplexity");
    expect(resolvePerplexityWebModel("perplexity_deep_research")).toBe("perplexity-research");
    expect(resolvePerplexityWebModel("  perplexity-search  ")).toBe("perplexity");
  });

  it("defaults when the model is missing", () => {
    expect(resolvePerplexityWebModel(undefined)).toBe(DEFAULT_PERPLEXITY_WEB_MODEL);
    expect(resolvePerplexityWebModel("")).toBe(DEFAULT_PERPLEXITY_WEB_MODEL);
  });

  it("warns and falls back for unknown models", () => {
    const log = vi.fn();
    expect(resolvePerplexityWebModel("perplexity-labs", log)).toBe(DEFAULT_PERPLEXITY_WEB_MODEL);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("perplexity-labs"));
  });
});

describe("perplexityModeForModel", () => {
  it("maps model ids onto composer modes", () => {
    expect(perplexityModeForModel("perplexity")).toBe("search");
    expect(perplexityModeForModel("perplexity-research")).toBe("research");
  });
});

describe("isPerplexityModel", () => {
  it("matches bare perplexity ids", () => {
    expect(isPerplexityModel("perplexity")).toBe(true);
    expect(isPerplexityModel("perplexity-research")).toBe(true);
  });

  it("does not match other providers", () => {
    expect(isPerplexityModel("gpt-5.5-pro")).toBe(false);
    expect(isPerplexityModel(undefined)).toBe(false);
    expect(isPerplexityModel(null)).toBe(false);
  });
});
