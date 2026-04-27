import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectGeneratedImageArtifacts,
  readAssistantGeneratedImages,
  resolveGeneratedImageWaitTimeoutMsForTest,
  saveChatGptGeneratedImages,
} from "../../src/browser/chatgptImages.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("readAssistantGeneratedImages", () => {
  test("dedupes duplicate image urls by file id and keeps the largest candidate", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://chatgpt.com/backend-api/estuary/content?id=file_a",
              alt: "one",
              width: 512,
              height: 512,
            },
            {
              url: "https://chatgpt.com/backend-api/estuary/content?id=file_a",
              alt: "one-large",
              width: 1024,
              height: 1024,
            },
            {
              url: "https://chatgpt.com/backend-api/estuary/content?id=file_b",
              alt: "two",
              width: 640,
              height: 480,
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const images = await readAssistantGeneratedImages(runtime);
    expect(images).toHaveLength(2);
    expect(images[0]?.fileId).toBe("file_a");
    expect(images[0]?.width).toBe(1024);
    expect(images[1]?.fileId).toBe("file_b");
  });
});

describe("saveChatGptGeneratedImages", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("saves multiple generated images as real files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-images-"));
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [
          { name: "__Secure-next-auth.session-token", value: "abc" },
          { name: "oai-did", value: "def" },
        ],
      }),
    } as unknown as ChromeClient["Network"];

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://files.local/1",
        headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://files.local/2",
        headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => Uint8Array.from([5, 6, 7, 8]).buffer,
      } as Response);

    const result = await saveChatGptGeneratedImages({
      Network: network,
      images: [
        { url: "https://chatgpt.com/backend-api/estuary/content?id=file_1", fileId: "file_1" },
        { url: "https://chatgpt.com/backend-api/estuary/content?id=file_2", fileId: "file_2" },
      ],
      outputPath: path.join(tmpDir, "generated.png"),
    });

    expect(result.saved).toBe(true);
    expect(result.imageCount).toBe(2);
    expect(result.savedImages).toHaveLength(2);
    expect(result.savedImages[0]?.path).toBe(path.join(tmpDir, "generated.png"));
    expect(result.savedImages[1]?.path).toBe(path.join(tmpDir, "generated.2.png"));
    await expect(fs.readFile(path.join(tmpDir, "generated.png"))).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    await expect(fs.readFile(path.join(tmpDir, "generated.2.png"))).resolves.toEqual(
      Buffer.from([5, 6, 7, 8]),
    );
  });
});

describe("resolveGeneratedImageWaitTimeoutMsForTest", () => {
  test("defaults to a 15 minute wait window when no timeout is provided", () => {
    expect(resolveGeneratedImageWaitTimeoutMsForTest()).toBe(15 * 60_000);
  });

  test("caps image waits at 15 minutes even when a longer timeout is requested", () => {
    expect(resolveGeneratedImageWaitTimeoutMsForTest(20 * 60_000)).toBe(15 * 60_000);
  });
});

describe("collectGeneratedImageArtifacts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
    setOracleHomeDirOverrideForTest(null);
  });

  test("keeps waiting for generated images after the answer text stops changing", async () => {
    vi.useFakeTimers();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-artifacts-"));
    let imagePolls = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("/backend-api/estuary/content?id=file_")) {
          imagePolls += 1;
          if (imagePolls < 6) {
            return { result: { value: [] } };
          }
          return {
            result: {
              value: [
                {
                  url: "https://chatgpt.com/backend-api/estuary/content?id=file_waited",
                  alt: "waited",
                  width: 1024,
                  height: 1024,
                },
              ],
            },
          };
        }
        if (expression.includes("extractAssistantTurn")) {
          return {
            result: {
              value: {
                text: "Still rendering image",
                html: "<p>Still rendering image</p>",
                messageId: "m1",
                turnId: "t1",
                turnIndex: 0,
              },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://files.local/waited",
      headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as Response);

    const resultPromise = collectGeneratedImageArtifacts({
      Runtime: runtime,
      Network: network,
      outputPath: path.join(tmpDir, "waited.png"),
      answerText: "Still rendering image",
      waitTimeoutMs: 15_000,
    });

    await vi.advanceTimersByTimeAsync(7_600);
    const result = await resultPromise;

    expect(imagePolls).toBe(6);
    expect(result.imageCount).toBe(1);
    expect(result.savedImages[0]?.path).toBe(path.join(tmpDir, "waited.png"));
  });

  test("falls back to the last assistant image turn when minTurnIndex is one step ahead", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-fallback-"));
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("/backend-api/estuary/content?id=file_")) {
          const withMinTurn = expression.includes("MIN_TURN_INDEX = 2");
          if (withMinTurn) {
            return { result: { value: [] } };
          }
          return {
            result: {
              value: [
                {
                  url: "https://chatgpt.com/backend-api/estuary/content?id=file_fallback",
                  alt: "fallback",
                  width: 1024,
                  height: 1024,
                },
              ],
            },
          };
        }
        if (expression.includes("extractAssistantTurn")) {
          const withMinTurn = expression.includes("const MIN_TURN_INDEX = 2");
          if (withMinTurn) {
            return { result: { value: null } };
          }
          return {
            result: {
              value: {
                text: "Stopped thinking\nEdit",
                html: "<div><img src=\"https://chatgpt.com/backend-api/estuary/content?id=file_fallback\"></div>",
                messageId: "m1",
                turnId: "t1",
                turnIndex: 1,
              },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://files.local/fallback",
      headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => Uint8Array.from([9, 8, 7]).buffer,
    } as Response);

    const result = await collectGeneratedImageArtifacts({
      Runtime: runtime,
      Network: network,
      outputPath: path.join(tmpDir, "fallback.png"),
      answerText: "Stopped thinking\nEdit",
      minTurnIndex: 2,
      waitTimeoutMs: 15_000,
    });

    expect(result.imageCount).toBe(1);
    expect(result.savedImages[0]?.path).toBe(path.join(tmpDir, "fallback.png"));
  });

  test("auto-saves generated images to the default oracle temp directory when no path is provided", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("/backend-api/estuary/content?id=file_")) {
          return {
            result: {
              value: [
                {
                  url: "https://chatgpt.com/backend-api/estuary/content?id=file_auto_saved",
                  alt: "auto-saved",
                  width: 1024,
                  height: 1024,
                },
              ],
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://files.local/auto-saved",
      headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => Uint8Array.from([4, 3, 2, 1]).buffer,
    } as Response);

    const result = await collectGeneratedImageArtifacts({
      Runtime: runtime,
      Network: network,
      answerText: "Stopped thinking\nEdit",
      waitTimeoutMs: 15_000,
    });

    expect(result.imageCount).toBe(1);
    expect(result.savedImages).toHaveLength(1);
    expect(result.savedImages[0]?.path).toContain(path.join(tmpHome, ".temp"));
    expect(result.markdownSuffix).toContain("Saved to:");
    await expect(fs.readFile(result.savedImages[0]!.path)).resolves.toEqual(Buffer.from([4, 3, 2, 1]));
  });
});
