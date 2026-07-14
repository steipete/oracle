import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  buildChatGptImageConsultInput,
  registerChatGptImageTool,
} from "../../src/mcp/tools/chatgptImage.ts";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

function registerHandler(): (input: unknown) => Promise<unknown> {
  const handlers: Array<(input: unknown) => Promise<unknown>> = [];
  registerChatGptImageTool({
    registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
      handlers.push(fn);
    },
    server: {
      sendLoggingMessage: async () => undefined,
    },
  } as unknown as Parameters<typeof registerChatGptImageTool>[0]);
  const handler = handlers[0];
  if (!handler) throw new Error("handler not registered");
  return handler;
}

describe("chatgpt_image MCP tool", () => {
  afterEach(() => {
    setOracleHomeDirOverrideForTest(null);
  });

  test("builds an image-aware browser consult with uploaded references", () => {
    const input = buildChatGptImageConsultInput({
      prompt: "Create an App Store screenshot background.",
      files: ["reference.png"],
      outputPath: "/tmp/screenshot-bg.png",
      aspectRatio: "9:16",
      browserThinkingTime: "extended",
    });

    expect(input).toMatchObject({
      engine: "browser",
      generateImage: "/tmp/screenshot-bg.png",
      files: ["reference.png"],
      browserAttachments: "always",
      browserThinkingTime: "extended",
    });
    expect(input.prompt).toContain("aspect ratio 9:16");
  });

  test("keeps the registered input schema discoverable and normalizes thinking aliases", async () => {
    let inputSchema: z.ZodRawShape | undefined;
    let handler: ((input: unknown) => Promise<unknown>) | undefined;
    registerChatGptImageTool({
      registerTool: (
        _name: string,
        def: unknown,
        registeredHandler: (input: unknown) => Promise<unknown>,
      ) => {
        inputSchema = (def as { inputSchema: z.ZodRawShape }).inputSchema;
        handler = registeredHandler;
      },
      server: {
        sendLoggingMessage: async () => undefined,
      },
    } as unknown as Parameters<typeof registerChatGptImageTool>[0]);

    expect(inputSchema).toBeDefined();
    expect(() => z.toJSONSchema(z.object(inputSchema!))).not.toThrow();
    const result = (await handler?.({
      dryRun: true,
      prompt: "Create a small product mockup.",
      browserThinkingTime: "xhigh",
    })) as {
      structuredContent: { resolved: { browser?: { thinkingTime?: string } } };
    };
    expect(result.structuredContent.resolved.browser?.thinkingTime).toBe("heavy");
  });

  test("uses a unique default output path when agents only provide a prompt", () => {
    const first = buildChatGptImageConsultInput({ prompt: "Create a simple app icon.", files: [] });
    const second = buildChatGptImageConsultInput({
      prompt: "Create a simple app icon.",
      files: [],
    });

    expect(first.engine).toBe("browser");
    const generatedImage = first.generateImage ?? "";
    expect(path.basename(path.dirname(generatedImage))).toBe("generated");
    expect(path.basename(generatedImage)).toMatch(/^chatgpt-image-[a-z0-9-]+\.png$/);
    // Random suffix keeps concurrent default paths from colliding.
    expect(first.generateImage).not.toBe(second.generateImage);
    expect(first.browserAttachments).toBeUndefined();
  });

  test("returns resolved dry-run details from the registered tool", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const handler = registerHandler();
      const target = path.join(home, "generated", "product-mockup.png");
      const result = (await handler({
        dryRun: true,
        prompt: "Create a small product mockup.",
        outputPath: target,
        aspectRatio: "1:1",
      })) as {
        structuredContent: {
          requestedOutputPath: string;
          resolved: { browser?: { imageOutputPath?: string } };
        };
      };

      expect(result.structuredContent.requestedOutputPath).toBe(target);
      expect(result.structuredContent.resolved.browser?.imageOutputPath).toBe(
        path.join(realpathSync(home), "generated", "product-mockup.png"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an output path outside the generated output directory without malformed structured output", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const handler = registerHandler();
      const result = (await handler({
        dryRun: true,
        prompt: "Create a small product mockup.",
        outputPath: "/tmp/escape.png",
      })) as { isError?: boolean; structuredContent?: unknown };

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects non-ChatGPT model families", async () => {
    const handler = registerHandler();
    const result = (await handler({
      dryRun: true,
      prompt: "Create a small product mockup.",
      model: "gemini-3-pro",
    })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/requires a ChatGPT\/GPT model/);
  });
});
