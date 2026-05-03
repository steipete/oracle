import { describe, test, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { runBrowserMode } from "../../src/browser/index.js";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";
import { getCookies } from "@steipete/sweet-cookie";

const LIVE = process.env.ORACLE_LIVE_TEST === "1";
const FAST = process.env.ORACLE_LIVE_TEST_FAST === "1";

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
