import { describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import { runBrowserMode } from "../../src/browser/index.js";
import { resumeBrowserSession } from "../../src/browser/reattach.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import { getCookies } from "@steipete/sweet-cookie";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";

const LIVE = process.env.ORACLE_LIVE_TEST === "1";
const DEFAULT_PROJECT_URLS = [
  "https://chatgpt.com/g/g-p-69505ed97e3081918a275477a647a682/project",
  "https://chatgpt.com/g/g-p-691edc9fec088191b553a35093da1ea8-oracle/project",
];
const PROJECT_URLS = process.env.ORACLE_CHATGPT_PROJECT_URL
  ? [process.env.ORACLE_CHATGPT_PROJECT_URL]
  : DEFAULT_PROJECT_URLS;

async function hasChatGptCookies(): Promise<boolean> {
  const { cookies } = await getCookies({
    url: "https://chatgpt.com",
    origins: ["https://chatgpt.com", "https://chat.openai.com", "https://atlas.openai.com"],
    browsers: ["chrome"],
    mode: "merge",
    chromeProfile: "Default",
    timeoutMs: 5_000,
  });
  // Learned: reuse the same session cookie check as other live browser tests.
  const hasSession = cookies.some((cookie) =>
    cookie.name.startsWith("__Secure-next-auth.session-token"),
  );
  if (!hasSession) {
    console.warn(
      "Skipping ChatGPT browser live tests (missing __Secure-next-auth.session-token). Open chatgpt.com in Chrome and retry.",
    );
    return false;
  }
  return true;
}

function createLogger(): BrowserLogger {
  return (() => {}) as BrowserLogger;
}

(LIVE ? describe : describe.skip)("ChatGPT browser live reattach", () => {
  test(
    "reattaches from project list after closing Chrome (pro request)",
    async () => {
      if (!(await hasChatGptCookies())) return;
      // Learned: reattach needs exclusive access to the profile to avoid target mismatch.
      await acquireLiveTestLock("chatgpt-browser");
      try {
        if (!PROJECT_URLS.some((url) => url.includes("/g/"))) {
          console.warn("Skipping live reattach test (project URL missing).");
          return;
        }

        // Learned: keep Pro here; it exercises long-running "thinking" + reattach timing.
        const promptToken = `live reattach pro ${Date.now()}`;
        const prompt = `${promptToken}\nRepeat the first line exactly. No other text.`;
        const log = createLogger();
        let runtime: {
          chromePid?: number;
          chromePort?: number;
          chromeHost?: string;
          userDataDir?: string;
          chromeTargetId?: string;
          tabUrl?: string;
          controllerPid?: number;
          conversationId?: string;
        } = {};

        let result: Awaited<ReturnType<typeof runBrowserMode>> | null = null;
        let lastErrorMessage = "";
        let selectedProjectUrl: string | undefined;
        for (const projectUrl of PROJECT_URLS) {
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              // Learned: keepBrowser keeps the chrome instance alive so we can explicitly kill it and reattach.
              result = await runBrowserMode({
                prompt,
                config: {
                  chromeProfile: "Default",
                  url: projectUrl,
                  keepBrowser: true,
                  desiredModel: "Extended Pro",
                  timeoutMs: 1_200_000,
                },
                log,
              });
              selectedProjectUrl = projectUrl;
              break;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              lastErrorMessage = message;
              if (/Unable to find model option/i.test(message)) {
                console.warn(`Skipping live reattach (pro model unavailable): ${message}`);
                return;
              }
              const missingProject =
                message.includes("Unable to locate prior ChatGPT conversation in sidebar") ||
                message.includes("project URL missing");
              const transient =
                message.includes("Prompt did not appear in conversation before timeout") ||
                message.includes("Chrome window closed before oracle finished") ||
                message.includes("Reattach target did not respond");
              if (missingProject) {
                console.warn(`Project URL unavailable (${projectUrl}); trying fallback.`);
                break;
              }
              if (transient && attempt < 3) {
                console.warn(`Retrying live reattach run (attempt ${attempt + 1}/3): ${message}`);
                await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
                continue;
              }
              throw error;
            }
          }
          if (result) {
            break;
          }
        }
        if (!result) {
          throw new Error(
            `Live reattach run did not return a result: ${lastErrorMessage || "unknown error"}`,
          );
        }
        if (!selectedProjectUrl) {
          throw new Error("Live reattach run succeeded but no project URL was selected.");
        }

        expect(result.answerText.toLowerCase()).toContain(promptToken.toLowerCase());
        const tabUrl = result.tabUrl ?? selectedProjectUrl;
        const conversationId = (() => {
          const marker = "/c/";
          const idx = tabUrl.indexOf(marker);
          if (idx === -1) return undefined;
          const rest = tabUrl.slice(idx + marker.length);
          return rest.split(/[/?#]/)[0] || undefined;
        })();

        runtime = {
          chromePid: result.chromePid,
          chromePort: result.chromePort,
          chromeHost: result.chromeHost ?? "127.0.0.1",
          chromeTargetId: result.chromeTargetId,
          tabUrl,
          userDataDir: result.userDataDir,
          controllerPid: result.controllerPid,
          conversationId,
        };

        if (runtime.chromePid) {
          try {
            process.kill(runtime.chromePid);
          } catch {
            // ignore kill failures
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        // Open a new browser and reattach via project list + prompt preview.
        const reattached = await resumeBrowserSession(
          {
            ...runtime,
            chromePort: undefined,
            chromeTargetId: undefined,
          },
          { chromeProfile: "Default", url: selectedProjectUrl, timeoutMs: 1_200_000 },
          Object.assign(createLogger(), { verbose: true }),
          { promptPreview: promptToken },
        );

        expect(reattached.answerText.toLowerCase()).toContain(promptToken.toLowerCase());

        if (runtime.userDataDir) {
          await fs.rm(runtime.userDataDir, { recursive: true, force: true });
        }
      } finally {
        await releaseLiveTestLock("chatgpt-browser");
      }
    },
    15 * 60 * 1000,
  );
});
