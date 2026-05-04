import { describe, expect, test } from "vitest";
import { mapConsultToRunOptions } from "../../src/mcp/utils.js";

describe("mapConsultToRunOptions", () => {
  test("passes multi-model selections through to run options", () => {
    const env: NodeJS.ProcessEnv = {};
    env.OPENAI_API_KEY = "sk-test";
    const { runOptions } = mapConsultToRunOptions({
      prompt: "multi",
      files: [],
      model: "gpt-5.2-pro",
      models: ["gemini-3-pro"],
      userConfig: undefined,
      env,
    });
    expect(runOptions.model).toBe("gpt-5.2-pro");
    expect(runOptions.models).toEqual(["gpt-5.2-pro", "gemini-3-pro"]);
  });

  test("maps browser follow-ups into run options", () => {
    const env: NodeJS.ProcessEnv = {};
    const { runOptions, resolvedEngine } = mapConsultToRunOptions({
      prompt: "review",
      files: [],
      model: "gpt-5.5-pro",
      engine: "browser",
      browserFollowUps: [" challenge previous answer ", "", "final concise decision"],
      userConfig: undefined,
      env,
    });

    expect(resolvedEngine).toBe("browser");
    expect(runOptions.browserFollowUps).toEqual([
      "challenge previous answer",
      "final concise decision",
    ]);
  });
});
