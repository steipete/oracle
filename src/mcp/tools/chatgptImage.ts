import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getOracleHomeDir } from "../../oracleHome.js";
import {
  browserThinkingTimeInputSchema,
  browserThinkingTimeRawSchema,
  type ConsultInput,
} from "../types.js";
import { consultOutputShape, runConsultTool } from "./consult.js";

const chatGptImageInputShape = {
  prompt: z.string().min(1, "Prompt is required.").describe("Image generation prompt."),
  files: z
    .array(z.string())
    .default([])
    .describe("Optional reference image/file paths or globs to upload to ChatGPT."),
  outputPath: z
    .string()
    .optional()
    .describe(
      "Where to save the first generated image. Defaults to a unique file under ORACLE_HOME_DIR/generated/.",
    ),
  aspectRatio: z
    .string()
    .optional()
    .describe('Optional requested image aspect ratio, e.g. "1:1", "9:16", or "16:9".'),
  model: z
    .string()
    .refine((value) => !/^(claude|gemini|grok)(?:[-\s]|$)/i.test(value.trim()), {
      message: "chatgpt_image requires a ChatGPT/GPT model.",
    })
    .optional()
    .describe("Optional ChatGPT/browser model label or alias. Defaults follow Oracle config."),
  browserModelLabel: z.string().optional().describe("Explicit ChatGPT UI model label to select."),
  browserAttachments: z
    .enum(["auto", "never", "always"])
    .optional()
    .describe(
      'How to deliver files. Defaults to "always" when files are present so reference images are uploaded.',
    ),
  browserThinkingTime: browserThinkingTimeRawSchema
    .optional()
    .describe("Set ChatGPT thinking time when supported by the chosen model."),
  browserModelStrategy: z
    .enum(["select", "current", "ignore"])
    .optional()
    .describe("Model picker strategy. Mirrors the consult tool and CLI browser flag."),
  browserArchive: z
    .enum(["auto", "always", "never"])
    .optional()
    .describe("Archive completed ChatGPT conversations after local artifacts are saved."),
  browserKeepBrowser: z
    .boolean()
    .optional()
    .describe("Keep Chrome running after completion for debugging."),
  dryRun: z
    .boolean()
    .optional()
    .describe("Preview the resolved image run without touching the browser."),
  slug: z.string().optional().describe("Optional human-friendly session id."),
} satisfies z.ZodRawShape;

const chatGptImageOutputShape = {
  // Mirror the consult output contract so structuredContent stays consistent
  // (images/artifacts/resolved are typed by the shared consult shapes), plus the
  // image-specific echo of the requested path.
  ...consultOutputShape,
  requestedOutputPath: z.string(),
} satisfies z.ZodRawShape;

const chatGptImageInputSchema = z
  .object({
    ...chatGptImageInputShape,
    browserThinkingTime: browserThinkingTimeInputSchema.optional(),
  })
  .strict();

export type ChatGptImageInput = z.infer<typeof chatGptImageInputSchema>;

function resolveDefaultImageOutputPath(): string {
  // Include a random token so concurrent agent calls in the same millisecond do
  // not resolve to the same default path and overwrite each other.
  const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  return path.join(getOracleHomeDir(), "generated", `chatgpt-image-${unique}.png`);
}

function appendAspectRatio(prompt: string, aspectRatio?: string): string {
  const requestedAspectRatio = aspectRatio?.trim();
  if (!requestedAspectRatio) {
    return prompt.trim();
  }
  return `${prompt.trim()}\n\nCreate the image with aspect ratio ${requestedAspectRatio}.`;
}

export function buildChatGptImageConsultInput(input: ChatGptImageInput): ConsultInput {
  const files = input.files ?? [];
  const outputPath = input.outputPath?.trim() || resolveDefaultImageOutputPath();
  const browserAttachments =
    input.browserAttachments ?? (files.length > 0 ? ("always" as const) : undefined);
  return {
    prompt: appendAspectRatio(input.prompt, input.aspectRatio),
    files,
    model: input.model,
    engine: "browser",
    browserModelLabel: input.browserModelLabel,
    browserAttachments,
    browserThinkingTime: input.browserThinkingTime,
    browserModelStrategy: input.browserModelStrategy,
    browserArchive: input.browserArchive,
    browserKeepBrowser: input.browserKeepBrowser,
    generateImage: outputPath,
    dryRun: input.dryRun,
    slug: input.slug,
  };
}

export function registerChatGptImageTool(server: McpServer): void {
  server.registerTool(
    "chatgpt_image",
    {
      title: "Generate an image with ChatGPT",
      description:
        "Agent-friendly wrapper for ChatGPT browser image generation. It selects browser mode, enables the image-aware wait/download path, uploads reference files when provided, and returns saved image paths in structuredContent.images.",
      inputSchema: chatGptImageInputShape,
      outputSchema: chatGptImageOutputShape,
    },
    async (input: unknown): Promise<CallToolResult> => {
      const textContent = (text: string) => [{ type: "text" as const, text }];
      let parsed;
      try {
        parsed = chatGptImageInputSchema.parse(input);
      } catch (error) {
        return {
          isError: true,
          content: textContent(error instanceof Error ? error.message : String(error)),
        };
      }
      const consultInput = buildChatGptImageConsultInput(parsed);
      const result = await runConsultTool(consultInput, { server: server.server });
      if (result.isError || !result.structuredContent) {
        return result;
      }
      const structuredContent = {
        ...result.structuredContent,
        requestedOutputPath: consultInput.generateImage,
      };
      return {
        ...result,
        structuredContent,
      };
    },
  );
}
