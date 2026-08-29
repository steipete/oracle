import { describe, it, expect, vi } from "vitest";
import {
  resolveModelConfig,
  safeModelSlug,
  isOrcaRouterBaseUrl,
  defaultOrcaRouterBaseUrl,
  normalizeOrcaRouterBaseUrl,
  resetOpenRouterCatalogCacheForTest,
} from "../src/oracle/modelResolver.js";

describe("OrcaRouter helpers", () => {
  it("detects OrcaRouter base URLs", () => {
    expect(isOrcaRouterBaseUrl("https://api.orcarouter.ai/v1")).toBe(true);
    expect(isOrcaRouterBaseUrl("https://api.orcarouter.ai/v1/responses")).toBe(true);
    expect(isOrcaRouterBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isOrcaRouterBaseUrl("https://api.openai.com")).toBe(false);
  });

  it("rejects lookalike OrcaRouter hostnames", () => {
    // The hostname classifier must not send OrcaRouter credentials to a lookalike
    // domain (mirrors the trust-boundary finding from the Requesty review).
    expect(isOrcaRouterBaseUrl("https://notorcarouter.ai/v1")).toBe(false);
    expect(isOrcaRouterBaseUrl("https://orcarouter.ai.evil.com/v1")).toBe(false);
    expect(isOrcaRouterBaseUrl("https://api.orcarouter.ai.evil.com/v1")).toBe(false);
    expect(isOrcaRouterBaseUrl("https://orcarouter.ai")).toBe(false);
    expect(isOrcaRouterBaseUrl("https://www.orcarouter.ai")).toBe(false);
  });

  it("returns the default OrcaRouter base URL", () => {
    expect(defaultOrcaRouterBaseUrl()).toBe("https://api.orcarouter.ai/v1");
  });

  it("normalizes a trailing /responses segment", () => {
    expect(normalizeOrcaRouterBaseUrl("https://api.orcarouter.ai/v1/responses")).toBe(
      "https://api.orcarouter.ai/v1",
    );
    expect(normalizeOrcaRouterBaseUrl("https://api.orcarouter.ai/v1/")).toBe(
      "https://api.orcarouter.ai/v1",
    );
  });

  it("hydrates config from the OrcaRouter catalog", async () => {
    resetOpenRouterCatalogCacheForTest();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "orcarouter/auto",
              context_length: 1_000_000,
              supported_endpoint_types: ["openai"],
            },
          ],
        }),
      })
      // The pricing endpoint is fetched in parallel; return an empty payload so the
      // models list is used as-is.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      }) as unknown as typeof fetch;

    const config = await resolveModelConfig("orcarouter/auto", {
      orcaRouterApiKey: "sk-orca-dummy",
      fetcher,
    });

    expect(config.apiModel).toBe("orcarouter/auto");
    expect(config.inputLimit).toBe(1_000_000);
    expect(config.provider).toBe("other");
  });

  it("keeps first-party model ids unprefixed when OrcaRouter is inactive", async () => {
    const claude = await resolveModelConfig("claude-4.6-sonnet");
    expect(claude.apiModel ?? claude.model).toBe("claude-sonnet-4-6");
  });

  it("slugifies OrcaRouter model ids with slashes", () => {
    expect(safeModelSlug("orcarouter/auto")).toBe("orcarouter__auto");
  });
});
