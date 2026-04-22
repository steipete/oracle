import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readAssistantGeneratedImages,
  saveChatGptGeneratedImages,
} from "../../src/browser/chatgptImages.js";
import type { ChromeClient } from "../../src/browser/types.js";

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
