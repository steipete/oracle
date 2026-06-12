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
  class FakeElement {
    parentElement: FakeElement | null = null;
    readonly children: FakeElement[];
    readonly dataset: Record<string, string>;
    readonly order: number;
    readonly tagName: string;

    constructor(
      tagName: string,
      private readonly attributes: Record<string, string>,
      order: number,
      children: FakeElement[] = [],
    ) {
      this.tagName = tagName.toUpperCase();
      this.order = order;
      this.children = children;
      this.dataset = {};
      for (const [key, value] of Object.entries(attributes)) {
        if (key.startsWith("data-")) {
          this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] =
            value;
        }
      }
      for (const child of children) {
        child.parentElement = this;
      }
    }

    get id(): string {
      return this.attributes.id ?? "";
    }

    get className(): string {
      return this.attributes.class ?? "";
    }

    get src(): string {
      return this.attributes.src ?? "";
    }

    get alt(): string {
      return this.attributes.alt ?? "";
    }

    get naturalWidth(): number {
      return Number(this.attributes.width ?? 0);
    }

    get naturalHeight(): number {
      return Number(this.attributes.height ?? 0);
    }

    getAttribute(name: string): string | null {
      return this.attributes[name] ?? null;
    }

    querySelector(selector: string): FakeElement | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
      return flattenElements(this.children).filter((element) => matchesSelector(element, selector));
    }

    compareDocumentPosition(other: FakeElement): number {
      return other.order > this.order ? 4 : 0;
    }
  }

  function flattenElements(elements: FakeElement[]): FakeElement[] {
    return elements.flatMap((element) => [element, ...flattenElements(element.children)]);
  }

  function matchesSelector(element: FakeElement, selector: string): boolean {
    if (selector === "img") return element.tagName === "IMG";
    if (selector.includes('data-testid^="conversation-turn"')) {
      return String(element.getAttribute("data-testid") ?? "").startsWith("conversation-turn");
    }
    if (selector.includes('data-message-author-role="assistant"')) {
      return element.getAttribute("data-message-author-role") === "assistant";
    }
    return false;
  }

  function evaluateImageExpression(expression: string, elements: FakeElement[]): unknown {
    const document = {
      querySelectorAll: (selector: string) =>
        flattenElements(elements).filter((element) => matchesSelector(element, selector)),
    };
    return Function(
      "document",
      "HTMLElement",
      "Node",
      "location",
      `return ${expression};`,
    )(
      document,
      FakeElement,
      {
        DOCUMENT_POSITION_FOLLOWING: 4,
      },
      {
        origin: "https://chatgpt.com",
      },
    );
  }

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

  test("ignores generated-image lookalikes from non-ChatGPT hosts", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://example.com/backend-api/estuary/content?id=file_fake",
              alt: "generated image",
              width: 1024,
              height: 1024,
            },
            {
              url: "https://chatgpt.com/backend-api/estuary/content?id=file_real",
              alt: "generated image",
              width: 1024,
              height: 1024,
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const images = await readAssistantGeneratedImages(runtime);

    expect(images).toHaveLength(1);
    expect(images[0]?.fileId).toBe("file_real");
  });

  test("finds generated images rendered outside assistant turn wrappers", async () => {
    const generatedImage = new FakeElement(
      "img",
      {
        src: "https://chatgpt.com/backend-api/estuary/content?id=file_detached",
        alt: "",
        width: "1254",
        height: "1254",
      },
      5,
    );
    const elements = [
      new FakeElement(
        "article",
        { "data-testid": "conversation-turn-1", "data-message-author-role": "user" },
        1,
      ),
      new FakeElement("div", { id: "image-detached" }, 4, [generatedImage]),
      new FakeElement(
        "article",
        { "data-testid": "conversation-turn-2", "data-message-author-role": "assistant" },
        8,
      ),
    ];
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: { value: evaluateImageExpression(expression, elements) },
      })),
    } as unknown as ChromeClient["Runtime"];

    const images = await readAssistantGeneratedImages(runtime, 0);

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      fileId: "file_detached",
      width: 1254,
      height: 1254,
    });
  });
});

describe("saveChatGptGeneratedImages", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("saves multiple generated images as real files with ChatGPT cookies", async () => {
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
    expect(result.savedImages[0]).toMatchObject({
      kind: "image",
      path: path.join(tmpDir, "generated.png"),
      mimeType: "image/png",
      sourceUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_1",
    });
    expect(result.savedImages[1]?.path).toBe(path.join(tmpDir, "generated.2.png"));
    await expect(fs.readFile(path.join(tmpDir, "generated.png"))).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  test("falls back to browser-context fetch when Node fetch cannot download the image", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-images-"));
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            status: 200,
            statusText: "OK",
            contentType: "image/png",
            finalUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_proxy",
            b64: Buffer.from([9, 8, 7, 6]).toString("base64"),
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const result = await saveChatGptGeneratedImages({
      Network: network,
      Runtime: runtime,
      images: [
        {
          url: "https://chatgpt.com/backend-api/estuary/content?id=file_proxy",
          fileId: "file_proxy",
        },
      ],
      outputPath: path.join(tmpDir, "generated.png"),
    });

    expect(result.saved).toBe(true);
    expect(runtime.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
      }),
    );
    await expect(fs.readFile(path.join(tmpDir, "generated.png"))).resolves.toEqual(
      Buffer.from([9, 8, 7, 6]),
    );
  });

  test("rejects non-ChatGPT image URLs before attaching cookies", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-images-"));
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn();

    const result = await saveChatGptGeneratedImages({
      Network: network,
      images: [
        {
          url: "https://example.com/backend-api/estuary/content?id=file_fake",
          fileId: "file_fake",
        },
      ],
      outputPath: path.join(tmpDir, "generated.png"),
    });

    expect(result.saved).toBe(false);
    expect(result.errors[0]).toContain("rejected non-ChatGPT generated image URL");
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  test("saves current-turn ChatGPT behavior button image downloads", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-image-button-"));
    const outputPath = path.join(tmpDir, "generated.png");
    const downloadedPath = path.join(tmpDir, "blue-circle.png");
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("behavior-btn")) {
          await fs.writeFile(downloadedPath, png);
          return {
            result: {
              value: [
                {
                  text: "Download the 1:1 blue circle image",
                  ariaLabel: "",
                  testId: "",
                },
              ],
            },
          };
        }
        return { result: { value: [] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const client = {
      send: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient;

    try {
      const result = await collectGeneratedImageArtifacts({
        Client: client,
        Runtime: runtime,
        Network: {} as ChromeClient["Network"],
        minTurnIndex: 0,
        generateImagePath: outputPath,
        answerText: "Here you go.",
        waitTimeoutMs: 15_000,
      });

      expect(result.imageCount).toBe(1);
      expect(result.savedImages[0]).toMatchObject({
        kind: "image",
        path: outputPath,
        mimeType: "image/png",
        sourceUrl: "browser-download",
      });
      await expect(fs.readFile(outputPath)).resolves.toEqual(png);
      expect(client.send).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: tmpDir,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("fails fast when a blocking UI warning appears before image artifacts", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: [] } }),
    } as unknown as ChromeClient["Runtime"];
    const warningError = new Error(
      "ChatGPT displayed a rate-limit warning while waiting for generated image artifacts.",
    );
    const checkBlockingUiWarning = vi.fn().mockRejectedValue(warningError);

    await expect(
      collectGeneratedImageArtifacts({
        Runtime: runtime,
        Network: {} as ChromeClient["Network"],
        generateImagePath: path.join(os.tmpdir(), "generated.png"),
        answerText: "Working on it.",
        waitTimeoutMs: 15_000,
        checkBlockingUiWarning,
      }),
    ).rejects.toBe(warningError);
    expect(checkBlockingUiWarning).toHaveBeenCalledTimes(1);
  });

  test("retries behavior button downloads after waiting for delayed image generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00Z"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-image-delayed-"));
    const outputPath = path.join(tmpDir, "generated.png");
    const downloadedPath = path.join(tmpDir, "delayed.png");
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const buttonAvailableAt = Date.now() + 10_000;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("behavior-btn")) {
          if (Date.now() < buttonAvailableAt) {
            return { result: { value: [] } };
          }
          await fs.writeFile(downloadedPath, png);
          return {
            result: {
              value: [
                {
                  text: "Download the delayed image",
                  ariaLabel: "",
                  testId: "",
                },
              ],
            },
          };
        }
        return { result: { value: [] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const client = {
      send: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient;

    try {
      const resultPromise = collectGeneratedImageArtifacts({
        Client: client,
        Runtime: runtime,
        Network: {} as ChromeClient["Network"],
        minTurnIndex: 0,
        generateImagePath: outputPath,
        answerText: "Working on it.",
        waitTimeoutMs: 15_000,
      });
      let settled = false;
      void resultPromise.finally(() => {
        settled = true;
      });
      for (let index = 0; index < 60 && !settled; index += 1) {
        await vi.advanceTimersByTimeAsync(500);
        await fs.readdir(tmpDir);
      }
      const result = await resultPromise;

      expect(result.imageCount).toBe(1);
      expect(result.savedImages[0]).toMatchObject({
        path: outputPath,
        mimeType: "image/png",
        sourceUrl: "browser-download",
      });
      await expect(fs.readFile(outputPath)).resolves.toEqual(png);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back to a behavior button when the rendered image URL fails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-image-404-"));
    const outputPath = path.join(tmpDir, "generated.png");
    const downloadedPath = path.join(tmpDir, "downloaded.png");
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("behavior-btn")) {
          await fs.writeFile(downloadedPath, png);
          return {
            result: {
              value: [
                {
                  text: "Download the generated PNG",
                  ariaLabel: "",
                  testId: "",
                },
              ],
            },
          };
        }
        if (expression.includes("/backend-api/estuary/content")) {
          return {
            result: {
              value: [
                {
                  url: "https://chatgpt.com/backend-api/estuary/content?id=file_expired",
                  alt: "generated image",
                  width: 1254,
                  height: 1254,
                },
              ],
            },
          };
        }
        return { result: { value: [] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    const client = {
      send: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      url: "https://chatgpt.com/backend-api/estuary/content?id=file_expired",
      headers: { get: () => null },
    } as unknown as Response);

    try {
      const result = await collectGeneratedImageArtifacts({
        Client: client,
        Runtime: runtime,
        Network: network,
        minTurnIndex: 0,
        generateImagePath: outputPath,
        answerText: "Preview",
        waitTimeoutMs: 15_000,
      });

      expect(result.imageCount).toBe(1);
      expect(result.savedImages[0]).toMatchObject({
        kind: "image",
        path: outputPath,
        mimeType: "image/png",
        sourceUrl: "browser-download",
      });
      await expect(fs.readFile(outputPath)).resolves.toEqual(png);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("auto-saves generated images to the session artifacts directory when no explicit path is provided", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("/backend-api/estuary/content")) {
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
      sessionId: "image-session",
      answerText: "Generated image",
      waitTimeoutMs: 15_000,
    });

    expect(result.imageCount).toBe(1);
    expect(result.savedImages).toHaveLength(1);
    expect(result.savedImages[0]?.path).toContain(
      path.join(tmpHome, "sessions", "image-session", "artifacts"),
    );
    expect(result.markdownSuffix).toContain("Saved to:");
    await expect(fs.readFile(result.savedImages[0]!.path)).resolves.toEqual(
      Buffer.from([4, 3, 2, 1]),
    );
  });

  test("uses unique paths for concurrent sessionless images with the same metadata", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("/backend-api/estuary/content")) {
          return {
            result: {
              value: [
                {
                  url: "https://chatgpt.com/backend-api/estuary/content?id=file_same",
                  alt: "generated image",
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
      url: "https://files.local/generated",
      headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as Response);

    try {
      const first = await collectGeneratedImageArtifacts({
        Runtime: runtime,
        Network: network,
        answerText: "Generated image",
      });
      const second = await collectGeneratedImageArtifacts({
        Runtime: runtime,
        Network: network,
        answerText: "Generated image",
      });

      expect(first.savedImages[0]?.path).not.toBe(second.savedImages[0]?.path);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
