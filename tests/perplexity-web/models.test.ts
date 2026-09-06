import { describe, it, expect, vi } from "vitest";
import {
  resolvePerplexityWebModel,
  perplexityModeForModel,
  isPerplexityModel,
  perplexityAliasToModelId,
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

  it('no longer coerces any string containing "research"', () => {
    const log = vi.fn();
    expect(resolvePerplexityWebModel("some-research-thing", log)).toBe(
      DEFAULT_PERPLEXITY_WEB_MODEL,
    );
    expect(log).toHaveBeenCalled();
  });
});

describe("perplexityAliasToModelId", () => {
  it("maps only the documented aliases", () => {
    expect(perplexityAliasToModelId("perplexity")).toBe("perplexity");
    expect(perplexityAliasToModelId("pplx")).toBe("perplexity");
    expect(perplexityAliasToModelId("perplexity_deep_research")).toBe("perplexity-research");
    expect(perplexityAliasToModelId("perplexity-labs")).toBeNull();
    expect(perplexityAliasToModelId("perplexity/sonar-pro")).toBeNull();
    expect(perplexityAliasToModelId(undefined)).toBeNull();
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

  it("rejects unrecognized perplexity-* ids so they stay custom models", () => {
    // A prefix match would swallow these, rejecting them on the API path and
    // silently running Search on the browser path.
    expect(isPerplexityModel("perplexity-labs")).toBe(false);
    expect(isPerplexityModel("perplexity-sonar-custom")).toBe(false);
  });

  it("rejects provider-qualified OpenRouter ids", () => {
    // `perplexity/sonar-pro` is an API model. Routing it to the browser provider
    // would open the signed-in web UI and answer in Search mode instead.
    expect(isPerplexityModel("perplexity/sonar-pro")).toBe(false);
    expect(isPerplexityModel("perplexity/sonar-reasoning")).toBe(false);
  });
});
