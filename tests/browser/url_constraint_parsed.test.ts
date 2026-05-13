import { describe, expect, test } from "vitest";

import { detectBrowserLeaseProvider } from "../../src/browser/runLive.js";
import { wrapBrowserExecutorWithV18Emit } from "../../src/browser/runLive_emit_artifacts.js";
import { urlHostnameMatchesAllowedHost } from "../../src/browser/url_constraint.js";
import type { BrowserExecutor } from "../../src/browser/leaseIntegration.js";
import type { BrowserRunOptions, BrowserRunResult } from "../../src/browser/types.js";

const PROMPT_MANIFEST = `sha256:${"a".repeat(64)}` as const;
const SOURCE_BASELINE = `sha256:${"b".repeat(64)}` as const;

const fakeResult: BrowserRunResult = {
  answerText: "ok",
  answerMarkdown: "ok",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 2,
};

const fakeExecutor: BrowserExecutor = async () => fakeResult;

function runOptions(url: string): BrowserRunOptions {
  return {
    prompt: "hello",
    config: { chatgptUrl: url },
  };
}

async function v18EmitOutcomeFor(url: string) {
  const wrapped = wrapBrowserExecutorWithV18Emit(fakeExecutor, {
    promptManifestSha256: PROMPT_MANIFEST,
    sourceBaselineSha256: SOURCE_BASELINE,
  });
  const result = await wrapped(runOptions(url));
  return result.v18Emit;
}

describe("parsed protected-route hostname matching", () => {
  test("matches only parsed exact hostnames", () => {
    const allowed = ["chatgpt.com", "chat.openai.com"] as const;

    expect(urlHostnameMatchesAllowedHost("https://chatgpt.com/c/abc", allowed)).toBe(true);
    expect(
      urlHostnameMatchesAllowedHost("https://chat.openai.com/c/abc?next=evilchatgpt.com", allowed),
    ).toBe(true);

    expect(urlHostnameMatchesAllowedHost("https://evilchatgpt.com/", allowed)).toBe(false);
    expect(urlHostnameMatchesAllowedHost("https://example.com/?next=chatgpt.com", allowed)).toBe(
      false,
    );
    expect(urlHostnameMatchesAllowedHost("https://example.com/path/chatgpt.com", allowed)).toBe(
      false,
    );
    expect(urlHostnameMatchesAllowedHost("https://chatgpt.com@evil.example/c/abc", allowed)).toBe(
      false,
    );
    expect(urlHostnameMatchesAllowedHost("not a url chatgpt.com", allowed)).toBe(false);
  });

  test("lease provider detection ignores host substrings outside URL.hostname", () => {
    expect(detectBrowserLeaseProvider(runOptions("https://chatgpt.com/c/abc"))).toBe("chatgpt");
    expect(detectBrowserLeaseProvider(runOptions("https://chat.openai.com/c/abc"))).toBe("chatgpt");
    expect(detectBrowserLeaseProvider(runOptions("https://gemini.google.com/app"))).toBe("gemini");
    expect(detectBrowserLeaseProvider(runOptions("https://ai.google.dev/app"))).toBe("gemini");

    expect(detectBrowserLeaseProvider(runOptions("https://evilchatgpt.com/"))).toBeNull();
    expect(
      detectBrowserLeaseProvider(runOptions("https://example.com/?next=chatgpt.com")),
    ).toBeNull();
    expect(
      detectBrowserLeaseProvider(runOptions("https://example.com/path/gemini.google.com")),
    ).toBeNull();
    expect(
      detectBrowserLeaseProvider(runOptions("https://chatgpt.com@evil.example/c/abc")),
    ).toBeNull();
  });

  test("v18 emit route detection ignores host substrings outside URL.hostname", async () => {
    await expect(v18EmitOutcomeFor("https://chatgpt.com/c/abc")).resolves.toMatchObject({
      attempted: false,
      skippedReason: "missing sessionId — cannot anchor evidence to a session",
    });

    await expect(v18EmitOutcomeFor("https://evilchatgpt.com/")).resolves.toMatchObject({
      attempted: false,
      skippedReason: "non-v18 route (no ChatGPT host detected)",
    });
    await expect(v18EmitOutcomeFor("https://example.com/?next=chatgpt.com")).resolves.toMatchObject(
      {
        attempted: false,
        skippedReason: "non-v18 route (no ChatGPT host detected)",
      },
    );
    await expect(
      v18EmitOutcomeFor("https://example.com/path/chat.openai.com"),
    ).resolves.toMatchObject({
      attempted: false,
      skippedReason: "non-v18 route (no ChatGPT host detected)",
    });
  });
});
