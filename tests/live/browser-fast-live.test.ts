import { describe, test, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { runBrowserMode } from "../../src/browser/index.js";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";
import { getCookies } from "@steipete/sweet-cookie";

const LIVE = process.env.ORACLE_LIVE_TEST === "1";
const FAST = process.env.ORACLE_LIVE_TEST_FAST === "1";
const LONG = process.env.ORACLE_LIVE_TEST_LONG === "1";
const LONG_MIN_MS = Number.parseInt(
  process.env.ORACLE_LIVE_TEST_LONG_MIN_MS ?? String(10 * 60_000),
  10,
);
const LONG_MODEL_LABEL = process.env.ORACLE_LIVE_TEST_FAST_MODEL_LABEL ?? "Thinking 5.5";
const LONG_THINKING_TIME =
  (process.env.ORACLE_LIVE_TEST_FAST_THINKING_TIME as
    | "light"
    | "standard"
    | "extended"
    | "heavy"
    | undefined) ?? "extended";

async function hasChatGptSession(): Promise<boolean> {
  try {
    const { cookies } = await getCookies({
      url: "https://chatgpt.com",
      origins: ["https://chatgpt.com", "https://chat.openai.com", "https://atlas.openai.com"],
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    return cookies.some((cookie) => cookie.name.startsWith("__Secure-next-auth.session-token"));
  } catch {
    return false;
  }
}

function isMissingChatGptSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ChatGPT session not detected|Login button detected|login appears missing/i.test(message);
}

(LIVE && FAST ? describe : describe.skip)("ChatGPT browser fast live", () => {
  test(
    "falls back when a project URL is missing",
    async () => {
      if (!(await hasChatGptSession())) {
        console.warn("Skipping fast live test (missing ChatGPT session cookie).");
        return;
      }
      await acquireLiveTestLock("chatgpt-browser");
      try {
        const promptToken = `fast fallback ${Date.now()}`;
        let result: Awaited<ReturnType<typeof runBrowserMode>>;
        try {
          result = await runBrowserMode({
            prompt: `${promptToken}\nReply with OK only.`,
            config: {
              url: "https://chatgpt.com/g/does-not-exist/project",
              timeoutMs: 180_000,
              inputTimeoutMs: 20_000,
            },
          });
        } catch (error) {
          if (isMissingChatGptSessionError(error)) {
            console.warn("Skipping fast live test (stale ChatGPT session cookie).");
            return;
          }
          throw error;
        }
        expect(result.answerText.toLowerCase()).toContain("ok");
      } finally {
        await releaseLiveTestLock("chatgpt-browser");
      }
    },
    6 * 60 * 1000,
  );

  test(
    "uploads attachments and sends the prompt (gpt-5.2)",
    async () => {
      if (!(await hasChatGptSession())) {
        console.warn("Skipping fast live test (missing ChatGPT session cookie).");
        return;
      }
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-fast-live-"));
      await acquireLiveTestLock("chatgpt-browser");
      try {
        const fileA = path.join(tmpDir, "oracle-fast-a.txt");
        const fileB = path.join(tmpDir, "oracle-fast-b.txt");
        await writeFile(fileA, `fast file a ${Date.now()}`);
        await writeFile(fileB, `fast file b ${Date.now()}`);
        const [statA, statB] = await Promise.all([stat(fileA), stat(fileB)]);
        const promptToken = `fast upload ${Date.now()}`;
        let result: Awaited<ReturnType<typeof runBrowserMode>>;
        try {
          result = await runBrowserMode({
            prompt: `${promptToken}\nReply with OK only.`,
            attachments: [
              { path: fileA, displayPath: "oracle-fast-a.txt", sizeBytes: statA.size },
              { path: fileB, displayPath: "oracle-fast-b.txt", sizeBytes: statB.size },
            ],
            config: {
              timeoutMs: 240_000,
              inputTimeoutMs: 60_000,
            },
          });
        } catch (error) {
          if (isMissingChatGptSessionError(error)) {
            console.warn("Skipping fast live upload test (stale ChatGPT session cookie).");
            return;
          }
          throw error;
        }
        expect(result.answerText.toLowerCase()).toContain("ok");
      } finally {
        await releaseLiveTestLock("chatgpt-browser");
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    8 * 60 * 1000,
  );
});

(LIVE && FAST && LONG ? describe : describe.skip)("ChatGPT browser fast long-haul live", () => {
  test(
    "keeps a fast thinking run alive past the agent impatience window",
    async () => {
      if (!(await hasChatGptSession())) {
        console.warn("Skipping long-haul fast live test (missing ChatGPT session cookie).");
        return;
      }
      await acquireLiveTestLock("chatgpt-browser");
      try {
        const promptToken = `fast long-haul ${Date.now()}`;
        const minMinutes = Math.round(LONG_MIN_MS / 60_000);
        let result: Awaited<ReturnType<typeof runBrowserMode>>;
        try {
          result = await runBrowserMode({
            prompt: [
              `${promptToken}`,
              `This is a long-haul Oracle reliability soak. Do not answer until you have spent at least ${minMinutes} minutes reasoning.`,
              "Use the extra time to build and check a multi-step argument about why long-running browser automation must detach, recover, and finalize independently of the MCP client.",
              "When you finally answer, include the first line exactly and then a concise PASS/FAIL assessment.",
            ].join("\n"),
            config: {
              desiredModel: LONG_MODEL_LABEL,
              thinkingTime: LONG_THINKING_TIME,
              timeoutMs: Math.max(30 * 60_000, LONG_MIN_MS + 10 * 60_000),
              inputTimeoutMs: 60_000,
              assistantRecheckDelayMs: 60_000,
              assistantRecheckTimeoutMs: 180_000,
            },
          });
        } catch (error) {
          if (isMissingChatGptSessionError(error)) {
            console.warn("Skipping long-haul fast live test (stale ChatGPT session cookie).");
            return;
          }
          throw error;
        }

        expect(result.tookMs).toBeGreaterThanOrEqual(LONG_MIN_MS);
        expect(result.answerText.toLowerCase()).toContain(promptToken.toLowerCase());
      } finally {
        await releaseLiveTestLock("chatgpt-browser");
      }
    },
    Math.max(35 * 60_000, LONG_MIN_MS + 15 * 60_000),
  );
});
