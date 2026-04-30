import { describe, expect, test } from "vitest";
import { InvalidArgumentError } from "commander";
import {
  collectPaths,
  parseFloatOption,
  parseIntOption,
  parseSearchOption,
  resolvePreviewMode,
  resolveApiModel,
  inferModelFromLabel,
  normalizeModelOption,
  parseHeartbeatOption,
  mergePathLikeOptions,
  dedupePathInputs,
} from "../../src/cli/options.ts";

describe("collectPaths", () => {
  test("merges repeated flags and splits comma-separated values", () => {
    const result = collectPaths(["src/a", "src/b,src/c"], ["existing"]);
    expect(result).toEqual(["existing", "src/a", "src/b", "src/c"]);
  });

  test("returns previous list when value is undefined", () => {
    expect(collectPaths(undefined, ["keep"])).toEqual(["keep"]);
  });
});

describe("mergePathLikeOptions", () => {
  test("merges aliases in the documented order and splits commas", () => {
    const result = mergePathLikeOptions(["a", "b,c"], ["d"], ["e,f"], ["g"], ["h,i"]);
    expect(result).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  });

  test("returns empty array when everything is undefined", () => {
    expect(mergePathLikeOptions(undefined, undefined, undefined, undefined, undefined)).toEqual([]);
  });

  test("trims entries and preserves exclusions/ordering across aliases", () => {
    const result = mergePathLikeOptions(
      ["  src/**/*.ts , !src/**/*.test.ts  "],
      [" docs/guide.md "],
      [" assets/**/* "],
      ["  README.md  ,  !dist/** "],
      undefined,
    );
    expect(result).toEqual([
      "src/**/*.ts",
      "!src/**/*.test.ts",
      "docs/guide.md",
      "assets/**/*",
      "README.md",
      "!dist/**",
    ]);
  });

  test("ignores empty strings inside alias arrays", () => {
    const result = mergePathLikeOptions(["", "src"], [""], [""], ["lib,"], [" ,tests"]);
    expect(result).toEqual(["src", "lib", "tests"]);
  });
});

describe("dedupePathInputs", () => {
  test("dedupes literal paths after resolving against cwd", () => {
    const { deduped, duplicates } = dedupePathInputs(
      ["src/a.ts", "./src/a.ts", "src/b.ts", "src/a.ts"],
      {
        cwd: "/repo",
      },
    );
    expect(deduped).toEqual(["src/a.ts", "src/b.ts"]);
    expect(duplicates).toEqual(["./src/a.ts", "src/a.ts"]);
  });

  test("dedupes repeated globs/exclusions by literal string", () => {
    const { deduped, duplicates } = dedupePathInputs(
      ["src/**/*.ts", "src/**/*.ts", "!dist/**", "!dist/**"],
      {
        cwd: "/repo",
      },
    );
    expect(deduped).toEqual(["src/**/*.ts", "!dist/**"]);
    expect(duplicates).toEqual(["src/**/*.ts", "!dist/**"]);
  });
});

describe("parseFloatOption", () => {
  test("parses numeric strings", () => {
    expect(parseFloatOption("12.5")).toBeCloseTo(12.5);
  });

  test("throws for NaN input", () => {
    expect(() => parseFloatOption("nope")).toThrow(InvalidArgumentError);
  });
});

describe("parseIntOption", () => {
  test("parses integers and allows undefined", () => {
    expect(parseIntOption(undefined)).toBeUndefined();
    expect(parseIntOption("42")).toBe(42);
  });

  test("throws for invalid integers", () => {
    expect(() => parseIntOption("not-a-number")).toThrow(InvalidArgumentError);
  });
});

describe("resolvePreviewMode", () => {
  test("returns explicit mode", () => {
    expect(resolvePreviewMode("json")).toBe("json");
  });

  test("defaults boolean true to summary", () => {
    expect(resolvePreviewMode(true)).toBe("summary");
  });

  test("returns undefined for falsey values", () => {
    expect(resolvePreviewMode(undefined)).toBeUndefined();
    expect(resolvePreviewMode(false)).toBeUndefined();
  });
});

describe("parseHeartbeatOption", () => {
  test("parses numeric values and defaults to 30 when omitted", () => {
    expect(parseHeartbeatOption("45")).toBe(45);
    expect(parseHeartbeatOption(undefined)).toBe(30);
  });

  test("accepts 0 or false/off to disable heartbeats", () => {
    expect(parseHeartbeatOption("0")).toBe(0);
    expect(parseHeartbeatOption("false")).toBe(0);
    expect(parseHeartbeatOption("off")).toBe(0);
  });

  test("rejects negative or non-numeric values", () => {
    expect(() => parseHeartbeatOption("-5")).toThrow(InvalidArgumentError);
    expect(() => parseHeartbeatOption("nope")).toThrow(InvalidArgumentError);
  });
});

describe("parseSearchOption", () => {
  test("accepts on/off variants", () => {
    expect(parseSearchOption("on")).toBe(true);
    expect(parseSearchOption("OFF")).toBe(false);
    expect(parseSearchOption("Yes")).toBe(true);
    expect(parseSearchOption("0")).toBe(false);
  });

  test("throws on invalid input", () => {
    expect(() => parseSearchOption("maybe")).toThrow(InvalidArgumentError);
  });
});

describe("normalizeModelOption", () => {
  test("trims whitespace safely", () => {
    expect(normalizeModelOption("  gpt-5.4-pro  ")).toBe("gpt-5.4-pro");
    expect(normalizeModelOption("  gpt-5.2-pro  ")).toBe("gpt-5.2-pro");
    expect(normalizeModelOption(undefined)).toBe("");
  });
});

describe("resolveApiModel", () => {
  test("accepts canonical names regardless of case", () => {
    expect(resolveApiModel("gpt-5.4-pro")).toBe("gpt-5.4-pro");
    expect(resolveApiModel("GPT-5.4")).toBe("gpt-5.4");
    expect(resolveApiModel("gpt-5.2-pro")).toBe("gpt-5.2-pro");
    expect(resolveApiModel("GPT-5.0-PRO")).toBe("gpt-5-pro");
    expect(resolveApiModel("gpt-5-pro")).toBe("gpt-5-pro");
    expect(resolveApiModel("GPT-5.1")).toBe("gpt-5.1");
    expect(resolveApiModel("GPT-5.1-CODEX")).toBe("gpt-5.1-codex");
    expect(resolveApiModel("claude-4.5-sonnet")).toBe("claude-4.5-sonnet");
    expect(resolveApiModel("Claude Opus 4.1")).toBe("claude-4.1-opus");
    expect(resolveApiModel("sonnet")).toBe("claude-4.5-sonnet");
    expect(resolveApiModel("opus")).toBe("claude-4.1-opus");
    expect(resolveApiModel("CLAUDE")).toBe("claude-4.5-sonnet");
    expect(resolveApiModel("Gemini")).toBe("gemini-3-pro");
    expect(resolveApiModel("gemini-3.1-pro")).toBe("gemini-3.1-pro");
    expect(resolveApiModel("Gemini 3.1 Pro")).toBe("gemini-3.1-pro");
    expect(resolveApiModel("grok")).toBe("grok-4.1");
    expect(resolveApiModel("Grok 4.1")).toBe("grok-4.1");
  });

  test("rejects codex max until API is available", () => {
    expect(() => resolveApiModel("gpt-5.1-codex-max")).toThrow(
      "gpt-5.1-codex-max is not available yet",
    );
  });

  test("rejects Gemini deep-think aliases in API mode", () => {
    expect(() => resolveApiModel("gemini-3-deep-think")).toThrow(
      "Gemini Deep Think is browser-only today",
    );
    expect(() => resolveApiModel("Gemini Deep Think")).toThrow(
      "Gemini Deep Think is browser-only today",
    );
  });

  test("passes through unknown names (OpenRouter/custom)", () => {
    expect(resolveApiModel("instant")).toBe("instant");
    expect(resolveApiModel("openai/gpt-5.4")).toBe("openai/gpt-5.4");
    expect(resolveApiModel("anthropic/claude-sonnet-4.5")).toBe("anthropic/claude-sonnet-4.5");
    expect(resolveApiModel("google/gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
  });
});

describe("inferModelFromLabel", () => {
  test("returns canonical names when label already matches", () => {
    expect(inferModelFromLabel("gpt-5.4-pro")).toBe("gpt-5.4-pro");
    expect(inferModelFromLabel("gpt-5.4")).toBe("gpt-5.4");
    expect(inferModelFromLabel("gpt-5.2-pro")).toBe("gpt-5.2-pro");
    expect(inferModelFromLabel("gpt-5-pro")).toBe("gpt-5-pro");
    expect(inferModelFromLabel("gpt-5.1")).toBe("gpt-5.1");
    expect(inferModelFromLabel("gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(inferModelFromLabel("gemini-3.1-pro")).toBe("gemini-3.1-pro");
  });

  test("preserves provider-qualified ids instead of remapping them to built-ins", () => {
    expect(inferModelFromLabel("openai/gpt-5.4")).toBe("openai/gpt-5.4");
    expect(inferModelFromLabel("anthropic/claude-sonnet-4.5")).toBe("anthropic/claude-sonnet-4.5");
  });

  test("infers 5.4 variants", () => {
    expect(inferModelFromLabel("ChatGPT 5.4")).toBe("gpt-5.4");
    expect(inferModelFromLabel("GPT-5.4 Pro")).toBe("gpt-5.4-pro");
    expect(inferModelFromLabel("5_4 PRO")).toBe("gpt-5.4-pro");
  });

  test("infers browser-only 5.5 variants", () => {
    expect(inferModelFromLabel("ChatGPT 5.5")).toBe("gpt-5.5");
    expect(inferModelFromLabel("GPT-5.5 Pro")).toBe("gpt-5.5-pro");
    expect(inferModelFromLabel("5_5 PRO")).toBe("gpt-5.5-pro");
  });

  test("infers 5.1 variants as gpt-5.1", () => {
    expect(inferModelFromLabel("ChatGPT 5.1 Instant")).toBe("gpt-5.1");
    expect(inferModelFromLabel("5.1 thinking")).toBe("gpt-5.1");
    expect(inferModelFromLabel(" 5.1 FAST ")).toBe("gpt-5.1");
  });

  test("infers 5.2 thinking/instant variants", () => {
    expect(inferModelFromLabel("ChatGPT 5.2 Instant")).toBe("gpt-5.2-instant");
    expect(inferModelFromLabel("5.2 thinking")).toBe("gpt-5.2-thinking");
    expect(inferModelFromLabel("5_2 FAST")).toBe("gpt-5.2-instant");
  });

  test("preserves Gemini 3.1 labels", () => {
    expect(inferModelFromLabel("Gemini 3.1 Pro")).toBe("gemini-3.1-pro");
  });

  test("infers Codex labels", () => {
    expect(inferModelFromLabel("ChatGPT Codex")).toBe("gpt-5.1-codex");
    expect(inferModelFromLabel("Codex Max Studio")).toBe("gpt-5.1-codex");
  });

  test("falls back to pro when the label references pro", () => {
    expect(inferModelFromLabel("ChatGPT Pro")).toBe("gpt-5.5-pro");
    expect(inferModelFromLabel("GPT-5.2 Pro")).toBe("gpt-5.2-pro");
    expect(inferModelFromLabel("GPT-5 Pro (Classic)")).toBe("gpt-5-pro");
  });

  test("infers Claude family labels", () => {
    expect(inferModelFromLabel("Claude Sonnet 4.5")).toBe("claude-4.5-sonnet");
    expect(inferModelFromLabel("Claude Opus 4.1")).toBe("claude-4.1-opus");
  });

  test("infers Grok aliases", () => {
    expect(inferModelFromLabel("grok")).toBe("grok-4.1");
    expect(inferModelFromLabel("Grok 4.1")).toBe("grok-4.1");
    expect(inferModelFromLabel("Grok-4-1")).toBe("grok-4.1");
  });

  test("falls back to gpt-5.4-pro when label empty and to gpt-5.2 for other ambiguous strings", () => {
    expect(inferModelFromLabel("")).toBe("gpt-5.4-pro");
    expect(inferModelFromLabel("something else")).toBe("gpt-5.2");
  });
});
