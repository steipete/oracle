import { describe, expect, test } from "vitest";
import { isChatGptProjectUrl, recommendConversationMode } from "../../src/cli/conversationMode.js";
import type { RunOracleOptions } from "../../src/oracle.js";

const baseRunOptions: RunOracleOptions = {
  prompt: "Review this failing unit test",
  model: "gpt-5.5-pro",
  file: [],
};

describe("recommendConversationMode", () => {
  test("recommends one-shot for isolated browser prompts", () => {
    expect(recommendConversationMode({ runOptions: baseRunOptions })).toMatchObject({
      mode: "one-shot",
    });
  });

  test("recommends multi-turn when explicit follow-ups are present", () => {
    expect(
      recommendConversationMode({
        runOptions: { ...baseRunOptions, browserFollowUps: ["challenge it"] },
      }),
    ).toMatchObject({
      mode: "multi-turn",
    });
  });

  test("recommends Deep Research when research mode is active", () => {
    expect(
      recommendConversationMode({
        runOptions: baseRunOptions,
        browserConfig: { researchMode: "deep" },
      }),
    ).toMatchObject({
      mode: "deep-research",
    });
  });

  test("recommends project for ChatGPT Project URLs", () => {
    expect(
      recommendConversationMode({
        runOptions: baseRunOptions,
        browserConfig: { chatgptUrl: "https://chatgpt.com/g/g-p-example/project?tab=sources" },
      }),
    ).toMatchObject({
      mode: "project",
    });
  });

  test("recommends project for conservative ongoing project prompt signals", () => {
    expect(
      recommendConversationMode({
        runOptions: {
          ...baseRunOptions,
          prompt: "Review this ongoing architecture stream for the platform roadmap.",
        },
      }),
    ).toMatchObject({
      mode: "project",
    });
  });
});

describe("isChatGptProjectUrl", () => {
  test("detects ChatGPT Project URLs without matching ordinary chats", () => {
    expect(isChatGptProjectUrl("https://chatgpt.com/g/g-p-123/project")).toBe(true);
    expect(isChatGptProjectUrl("https://chatgpt.com/c/abc123")).toBe(false);
    expect(isChatGptProjectUrl("https://example.com/g/g-p-123/project")).toBe(false);
  });
});
