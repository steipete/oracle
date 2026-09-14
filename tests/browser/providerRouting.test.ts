import { beforeEach, describe, expect, test, vi } from "vitest";
import { runBrowserSessionExecution } from "../../src/browser/sessionRunner.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import { createRemoteServer } from "../../src/remote/server.js";
import { resolveBrowserExecutor } from "../../src/browser/executor.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const providers = vi.hoisted(() => {
  const reply = (text: string) => ({
    answerText: text,
    answerMarkdown: text,
    tookMs: 1,
    answerTokens: 1,
    answerChars: text.length,
  });
  const chatgpt = vi.fn(async (_options: import("../../src/browser/types.js").BrowserRunOptions) =>
    reply("CHATGPT_FIXTURE"),
  );
  const gemini = vi.fn(async (_options: import("../../src/browser/types.js").BrowserRunOptions) =>
    reply("GEMINI_FIXTURE"),
  );
  return { chatgpt, gemini, createGemini: vi.fn(() => gemini) };
});
vi.mock("../../src/browserMode.js", () => ({ runBrowserMode: providers.chatgpt }));
vi.mock("../../src/gemini-web/index.js", () => ({
  createGeminiWebExecutor: providers.createGemini,
}));

const assemblePrompt = async () => ({
  markdown: "fixture",
  composerText: "fixture",
  estimatedInputTokens: 1,
  attachments: [],
  inlineFileCount: 0,
  tokenEstimateIncludesInlineFiles: false,
  attachmentsPolicy: "auto" as const,
  attachmentMode: "inline" as const,
  fallback: null,
});

beforeEach(() => vi.clearAllMocks());

describe("browser provider routing", () => {
  test("rejects unknown local providers without running ChatGPT", async () => {
    await expect(
      runBrowserSessionExecution(
        {
          runOptions: { prompt: "fixture", model: "unknown-provider" },
          browserConfig: {},
          cwd: process.cwd(),
          log: vi.fn(),
        },
        { assemblePrompt },
      ),
    ).rejects.toThrow(/Unsupported browser model/);
    expect(providers.chatgpt).not.toHaveBeenCalled();
    expect(providers.createGemini).not.toHaveBeenCalled();
  });

  test("rejects unknown canonical remote models before reading attachments", async () => {
    const execute = createRemoteBrowserExecutor({ host: "127.0.0.1:1", token: "synthetic" });
    await expect(
      execute({
        model: "unknown-provider",
        prompt: "fixture",
        attachments: [{ path: "/must-not-be-read", displayPath: "context.txt" }],
      }),
    ).rejects.toThrow(/Unsupported browser model/);
  });

  test("selects Gemini at the shared session boundary and forwards its options", async () => {
    const runOptions = {
      prompt: "fixture",
      model: "gemini-3.1-pro",
      youtube: "https://example.test/video",
      editImage: "input.png",
      generateImage: "generated.png",
      outputPath: "output.png",
      aspectRatio: "1:1",
      geminiShowThoughts: true,
      geminiAllowModelFallback: false,
    };
    const result = await runBrowserSessionExecution(
      {
        runOptions,
        browserConfig: { desiredModel: "Unrelated UI label" },
        cwd: process.cwd(),
        log: vi.fn(),
      },
      { assemblePrompt },
    );
    expect(result.answerText).toBe("GEMINI_FIXTURE");
    expect(providers.chatgpt).not.toHaveBeenCalled();
    expect(providers.createGemini).toHaveBeenCalledWith({
      youtube: runOptions.youtube,
      editImage: "input.png",
      generateImage: "generated.png",
      outputPath: "output.png",
      aspectRatio: "1:1",
      showThoughts: true,
      allowModelFallback: false,
    });
    expect(providers.gemini).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3.1-pro" }),
    );
  });

  test("keeps ChatGPT as the default for GPT models", async () => {
    const result = await runBrowserSessionExecution(
      {
        runOptions: { prompt: "fixture", model: "gpt-5.5" },
        browserConfig: {},
        cwd: process.cwd(),
        log: vi.fn(),
      },
      { assemblePrompt },
    );
    expect(result.answerText).toBe("CHATGPT_FIXTURE");
    expect(providers.createGemini).not.toHaveBeenCalled();
  });

  test("preserves an explicitly supplied executor", async () => {
    const executeBrowser = vi.fn(async () => ({
      answerText: "CUSTOM_FIXTURE",
      answerMarkdown: "CUSTOM_FIXTURE",
      tookMs: 1,
      answerTokens: 1,
      answerChars: 14,
    }));
    const result = await runBrowserSessionExecution(
      {
        runOptions: { prompt: "fixture", model: "gemini-3.1-pro" },
        browserConfig: {},
        cwd: process.cwd(),
        log: vi.fn(),
      },
      { assemblePrompt, executeBrowser },
    );
    expect(result.answerText).toBe("CUSTOM_FIXTURE");
    expect(providers.createGemini).not.toHaveBeenCalled();
  });

  test.each([
    { model: "gpt-5.5", remote: false, answer: "CHATGPT_FIXTURE" },
    { model: "gpt-5.5", remote: true, answer: "CHATGPT_FIXTURE" },
    { model: "gemini-3.1-pro", remote: false, answer: "GEMINI_FIXTURE" },
    { model: "gemini-3.1-pro", remote: true, answer: "GEMINI_FIXTURE" },
  ])(
    "routes $model with remote=$remote through the default provider",
    async ({ model, remote, answer }) => {
      const server = remote
        ? await createRemoteServer({ host: "127.0.0.1", logger: () => {} })
        : undefined;
      try {
        const runOptions = {
          prompt: "fixture",
          model,
          geminiAllowModelFallback: false,
          geminiShowThoughts: true,
          youtube: "https://example.test/video",
        };
        const executeBrowser = await resolveBrowserExecutor(
          runOptions,
          server ? { host: `127.0.0.1:${server.port}`, token: server.token } : undefined,
        );
        const result = await runBrowserSessionExecution(
          {
            runOptions,
            browserConfig: {
              desiredModel: "Unrelated UI label",
              inlineCookies: [
                { name: "__Secure-1PSID", value: "synthetic-client-cookie", domain: ".google.com" },
              ],
            },
            cwd: process.cwd(),
            log: vi.fn(),
          },
          { assemblePrompt, executeBrowser },
        );
        expect(result.answerText).toBe(answer);
        const provider = model.startsWith("gemini") ? providers.gemini : providers.chatgpt;
        const other = model.startsWith("gemini") ? providers.chatgpt : providers.gemini;
        expect(provider).toHaveBeenCalledOnce();
        expect(other).not.toHaveBeenCalled();
        expect(provider).toHaveBeenCalledWith(expect.objectContaining({ model }));
        if (remote)
          expect(provider).toHaveBeenCalledWith(
            expect.objectContaining({
              config: expect.objectContaining({ inlineCookies: null, inlineCookiesSource: null }),
            }),
          );
        if (model.startsWith("gemini"))
          expect(providers.createGemini).toHaveBeenCalledWith(
            expect.objectContaining({
              allowModelFallback: false,
              showThoughts: true,
              youtube: runOptions.youtube,
            }),
          );
      } finally {
        await server?.close();
      }
    },
  );

  test("accepts legacy Gemini payloads and discards injected host settings and cookies", async () => {
    const server = await createRemoteServer({
      host: "127.0.0.1",
      logger: () => {},
      manualLoginDefault: true,
      manualLoginProfileDir: "/host-owned-profile",
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/runs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "fixture",
          attachments: [],
          browserConfig: {
            desiredModel: "gemini-3.1-pro",
            inlineCookies: [{ name: "__Secure-1PSID", value: "synthetic-client-cookie" }],
            inlineCookiesSource: "/client-cookies",
            manualLoginProfileDir: "/client-profile",
            remoteChrome: { host: "untrusted.invalid", port: 1 },
          },
          options: {},
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("GEMINI_FIXTURE");
      expect(providers.chatgpt).not.toHaveBeenCalled();
      expect(providers.gemini).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            manualLogin: true,
            manualLoginProfileDir: "/host-owned-profile",
            inlineCookies: null,
            inlineCookiesSource: null,
          }),
        }),
      );
      expect(providers.gemini.mock.calls[0]?.[0]?.config?.remoteChrome).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test.each(["gpt-5.5", "gemini-3.1-pro"])(
    "CLI new runs and restarts dispatch %s on the remote host",
    async (model) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-cli-"));
      const server = await createRemoteServer({ host: "127.0.0.1", logger: () => {} });
      try {
        const remoteArgs = [
          "--remote-host",
          `127.0.0.1:${server.port}`,
          "--remote-token",
          server.token,
          "--wait",
        ];
        const env = {
          ...process.env,
          ORACLE_HOME_DIR: home,
          ORACLE_NO_DETACH: "1",
          ORACLE_NOTIFY: "0",
        };
        const cli = (...args: string[]) =>
          promisify(execFile)(
            process.execPath,
            ["--import", "tsx", path.resolve("bin/oracle-cli.ts"), ...args],
            { env, timeout: 60_000 },
          ).catch((error) => {
            throw new Error(`CLI failed: ${error.stdout} ${error.stderr}`);
          });
        const geminiArgs = model.startsWith("gemini") ? ["--no-gemini-fallback"] : [];
        const first = await cli(
          "--engine",
          "browser",
          "--model",
          model,
          "--browser-chrome-path",
          path.join(home, "must-not-launch-chrome"),
          "--browser-no-cookie-sync",
          "--prompt",
          "Reply with the routing fixture.",
          ...geminiArgs,
          ...remoteArgs,
        );
        const expected = model.startsWith("gemini") ? "GEMINI_FIXTURE" : "CHATGPT_FIXTURE";
        expect(first.stdout).toContain(expected);
        const sessions = await readdir(path.join(home, "sessions"));
        expect(sessions).toHaveLength(1);
        const restarted = await cli("restart", sessions[0], ...remoteArgs);
        expect(restarted.stdout).toContain(expected);
        const provider = model.startsWith("gemini") ? providers.gemini : providers.chatgpt;
        expect(provider).toHaveBeenCalledTimes(2);
        for (const session of await readdir(path.join(home, "sessions"))) {
          const metadata = JSON.parse(
            await readFile(path.join(home, "sessions", session, "meta.json"), "utf8"),
          );
          expect(metadata.status).toBe("completed");
          expect(metadata.options.model).toBe(model);
        }
        if (model.startsWith("gemini")) {
          expect(providers.chatgpt).not.toHaveBeenCalled();
          expect(providers.createGemini).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ allowModelFallback: false }),
          );
        } else expect(providers.createGemini).not.toHaveBeenCalled();
      } finally {
        await server.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    130_000,
  );

  test("rejects remote Gemini image edits before reading client files", async () => {
    const execute = await resolveBrowserExecutor(
      { model: "gemini-3.1-pro", editImage: "/must-not-be-read" },
      { host: "127.0.0.1:1" },
    );
    await expect(execute({ prompt: "fixture" })).rejects.toThrow(/Remote Gemini image/);
  });
});
