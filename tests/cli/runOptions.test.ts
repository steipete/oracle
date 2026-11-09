import { describe, expect, test } from "vitest";
import { resolveRunOptionsFromConfig } from "../../src/cli/runOptions.js";

describe("shared provider model resolution", () => {
  test.each([
    ["sonnet", "claude-4.6-sonnet"],
    ["opus", "claude-4.1-opus"],
  ])("preserves %s API identity even when the default engine is browser", (model, expected) => {
    const resolved = resolveRunOptionsFromConfig({
      prompt: "test",
      model,
      env: { ANTHROPIC_API_KEY: "test-placeholder" },
    });

    expect(resolved.resolvedEngine).toBe("api");
    expect(resolved.runOptions.model).toBe(expected);
  });

  test.each([
    ["gemini-3-deep-think", "gemini-3-pro-deep-think"],
    ["gemini-4-argon-thinking", "gemini-4-argon-high"],
  ])("keeps browser-only %s in the browser lane", (model, expected) => {
    const resolved = resolveRunOptionsFromConfig({
      prompt: "test",
      model,
      engine: "browser",
      env: {},
    });

    expect(resolved.resolvedEngine).toBe("browser");
    expect(resolved.runOptions.model).toBe(expected);
  });
});
