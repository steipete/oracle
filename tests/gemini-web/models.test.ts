import { describe, expect, it, vi } from "vitest";
import {
  buildGeminiWebModelHeader,
  DEFAULT_GEMINI_WEB_MODEL,
  FALLBACK_GEMINI_WEB_MODEL,
  resolveGeminiWebModel,
} from "../../src/gemini-web/models.js";

describe("Gemini web model mapping", () => {
  it.each([
    ["gemini-3.1-flash-lite", '[1,null,null,null,"1d44b34bcaa1c04d",null,null,0,[4],null,null,2]'],
    ["gemini-3.5-flash", '[1,null,null,null,"56fdd199312815e2",null,null,0,[4],null,null,2]'],
    ["gemini-3.1-pro", '[1,null,null,null,"e6fa609c3fa255c0",null,null,0,[4],null,null,2]'],
    [
      "gemini-3-pro-deep-think",
      '[1,null,null,null,"e051ce1aa80aa576",null,null,0,[4],null,null,2]',
    ],
  ] as const)("builds the captured %s header", (model, expected) => {
    expect(buildGeminiWebModelHeader(model)).toBe(expected);
  });

  it("uses current defaults", () => {
    expect(DEFAULT_GEMINI_WEB_MODEL).toBe("gemini-3.1-pro");
    expect(FALLBACK_GEMINI_WEB_MODEL).toBe("gemini-3.1-flash-lite");
  });

  it.each([
    ["Gemini 3.1 Pro", "gemini-3.1-pro"],
    ["Gemini 3 Pro", "gemini-3.1-pro"],
    ["gemini-3.0-pro", "gemini-3.1-pro"],
    ["Gemini 3.5 Flash", "gemini-3.5-flash"],
    ["Gemini 3.1 Flash-Lite", "gemini-3.1-flash-lite"],
    ["gemini-2.5-pro", "gemini-3.1-pro"],
    ["gemini-2.5-flash", "gemini-3.1-flash-lite"],
    ["gemini-3-deep-think", "gemini-3-pro-deep-think"],
  ] as const)("resolves %s to %s", (input, expected) => {
    expect(resolveGeminiWebModel(input)).toBe(expected);
  });

  it("logs unsupported Gemini names and falls back to current Pro", () => {
    const log = vi.fn();

    expect(resolveGeminiWebModel("gemini-future", log)).toBe("gemini-3.1-pro");
    expect(log).toHaveBeenCalledWith(
      '[gemini-web] Unsupported Gemini web model "gemini-future". Falling back to gemini-3.1-pro.',
    );
  });
});
