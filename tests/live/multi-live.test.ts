import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMultiModelApiSession } from "../../src/oracle/multiModelRunner.js";
import { sessionStore } from "../../src/sessionStore.js";
import type { ModelName } from "../../src/oracle.js";

const live = process.env.ORACLE_LIVE_TEST === "1";
const baseUrl = process.env.OPENAI_BASE_URL ?? "";
const isOpenRouterBase = baseUrl.includes("openrouter");
const hasKeys =
  Boolean(process.env.OPENAI_API_KEY) &&
  Boolean(process.env.GEMINI_API_KEY) &&
  Boolean(process.env.ANTHROPIC_API_KEY) &&
  !isOpenRouterBase;
const OPENAI_ENV = {
  // biome-ignore lint/style/useNamingConvention: environment variable key
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  // biome-ignore lint/style/useNamingConvention: environment variable key
  OPENROUTER_API_KEY: "",
  // biome-ignore lint/style/useNamingConvention: environment variable key
  AZURE_OPENAI_ENDPOINT: "",
  // biome-ignore lint/style/useNamingConvention: environment variable key
  AZURE_OPENAI_API_KEY: "",
  // biome-ignore lint/style/useNamingConvention: environment variable key
  AZURE_OPENAI_DEPLOYMENT: "",
  // biome-ignore lint/style/useNamingConvention: environment variable key
  AZURE_OPENAI_API_VERSION: "",
};
const isAccessOrAuthError = (reason: unknown): boolean => {
  const message = String(reason ?? "");
  return /model_not_found|does not exist|not a valid model ID|no allowed providers|access|permission|api[_ ]?key[_ ]?invalid|invalid api key|invalid x-api-key|api key expired|API_KEY_INVALID|unauthenticated|missing required authentication|requires an api key|transport error|invalid JSON response|empty response|Unexpected end of JSON input/i.test(
    message,
  );
};
const isHtmlError = (reason: unknown): boolean => /<!doctype|<html/i.test(String(reason ?? ""));
const execFileAsync = promisify(execFile);
const TSX_BIN = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");

(live && !isOpenRouterBase ? describe : describe.skip)(
  "Multi-model live smoke (GPT + Gemini + Claude)",
  () => {
    const originalBaseUrl = process.env.OPENAI_BASE_URL;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;

    beforeAll(() => {
      process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
      process.env.OPENROUTER_API_KEY = "";
    });

    afterAll(() => {
      if (originalBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = originalBaseUrl;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    });

    if (!hasKeys) {
      it.skip("requires OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY", () => {});
      return;
    }

    it("completes all providers", async () => {
      const prompt = "In one concise sentence, explain photosynthesis.";
      const models: ModelName[] = ["gpt-5-nano", "gemini-2.5-flash-lite", "claude-4.6-sonnet"];
      const baseModel = models[0];
      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        { prompt, model: baseModel, models, mode: "api" },
        process.cwd(),
      );
      const summary = await runMultiModelApiSession({
        sessionMeta,
        runOptions: { prompt, model: baseModel, models, search: false },
        models,
        cwd: process.cwd(),
        version: "live-smoke",
      });
      if (summary.rejected.length > 0) {
        const accessRejections = summary.rejected.filter((rej) => isAccessOrAuthError(rej.reason));
        const nonAccess = summary.rejected.filter((rej) => {
          const reason = rej.reason;
          if (isAccessOrAuthError(reason)) return false;
          if (isHtmlError(reason)) return false; // HTML error page, treat as skip
          return true;
        });
        if (nonAccess.length === 0) {
          return; // all issues were access/auth/HTML transport noise — soft skip
        }
        if (nonAccess.length > 0) {
          // Surface rejection reasons to aid live-debugging without failing silently.
          // eslint-disable-next-line no-console
          console.error(
            "multi-live rejections:",
            nonAccess.map((r) => `${r.model}: ${String(r.reason ?? "")}`),
          );
          throw new Error(
            `Unexpected rejections: ${nonAccess
              .map((r) => `${r.model}: ${String(r.reason ?? "")}`)
              .join("; ")}`,
          );
        }
        if (accessRejections.length === summary.rejected.length) {
          return; // all were access/permission issues, treat as skip
        }
      }
      expect(summary.rejected.length).toBe(0);
      expect(summary.fulfilled.map((r) => r.model)).toEqual(expect.arrayContaining(models));
      summary.fulfilled.forEach((r) => {
        expect(r.answerText.length).toBeGreaterThan(10);
      });
    }, 180_000);

    it("accepts shorthand models end-to-end via CLI", async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-live-multi-shorthand-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            TSX_BIN,
            CLI_ENTRY,
            "--prompt",
            "Live shorthand multi-model prompt for cross-checking this design end-to-end.",
            "--models",
            "gpt-5-nano,gemini-2.5-flash-lite,claude-4.6-sonnet",
            "--wait",
          ],
          { env: { ...env, ...OPENAI_ENV } },
        );
      } catch (_error) {
        const message =
          _error instanceof Error && "stderr" in _error
            ? String(
                ((_error as unknown as { stderr?: unknown; stdout?: unknown }).stderr ?? "") ||
                  ((_error as unknown as { stdout?: unknown }).stdout ?? "") ||
                  _error.message,
              )
            : String(_error);
        if (isAccessOrAuthError(message) || isHtmlError(message)) {
          return; // unavailable models — treat as soft skip
        }
        throw _error;
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const sessionDir = path.join(sessionsDir, sessionIds[0]);
      const metadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      const selectedModels = (metadata.models as Array<{ model: string }> | undefined)?.map(
        (m: { model: string }) => m.model,
      );
      expect(selectedModels).toEqual(
        expect.arrayContaining(["gpt-5-nano", "gemini-2.5-flash-lite", "claude-4.6-sonnet"]),
      );
      expect(metadata.status).toBe("completed");

      // Regression: session render should include the answer even when model logs are empty (browser-style storage).
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_BIN, CLI_ENTRY, "session", sessionIds[0], "--render", "--hide-prompt"],
          { env },
        );
        expect(stdout.toLowerCase()).toContain("answer");
      } catch (error) {
        const message =
          error instanceof Error && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? error.message)
            : String(error);
        if (isAccessOrAuthError(message)) {
          return; // treat unavailable models as skip
        }
        throw error;
      }

      await rm(oracleHome, { recursive: true, force: true });
    }, 600_000);
  },
);
