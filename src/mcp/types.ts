import { z } from "zod";
import { THINKING_TIME_INPUT_VALUES, normalizeThinkingTimeLevel } from "../oracle/thinkingTime.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";

export const CONSULT_PRESETS = ["chatgpt-pro-heavy"] as const;

export const browserThinkingTimeRawSchema = z.enum(THINKING_TIME_INPUT_VALUES);

export const browserThinkingTimeInputSchema = browserThinkingTimeRawSchema.transform(
  (value): ThinkingTimeLevel => {
    const normalized = normalizeThinkingTimeLevel(value);
    if (!normalized) {
      throw new Error(`Unknown browserThinkingTime value: ${value}`);
    }
    return normalized;
  },
);

export const consultInputSchema = z
  .object({
    preset: z.enum(CONSULT_PRESETS).optional(),
    prompt: z.string().min(1, "Prompt is required."),
    files: z.array(z.string()).default([]),
    model: z.string().optional(),
    models: z.array(z.string()).optional(),
    engine: z.enum(["api", "browser"]).optional(),
    browserModelLabel: z.string().optional(),
    browserAttachments: z.enum(["auto", "never", "always"]).optional(),
    browserBundleFiles: z.boolean().optional(),
    browserBundleFormat: z.enum(["auto", "text", "zip"]).optional(),
    browserThinkingTime: browserThinkingTimeInputSchema.optional(),
    browserModelStrategy: z.enum(["select", "current", "ignore"]).optional(),
    browserResearchMode: z.enum(["deep"]).optional(),
    browserArchive: z.enum(["auto", "always", "never"]).optional(),
    browserFollowUps: z.array(z.string()).optional(),
    browserKeepBrowser: z.boolean().optional(),
    generateImage: z.string().optional(),
    outputPath: z.string().optional(),
    dryRun: z.boolean().optional(),
    search: z.boolean().optional(),
    slug: z.string().optional(),
  })
  .strict();

export type ConsultInput = z.infer<typeof consultInputSchema>;

export const sessionsInputSchema = z.object({
  id: z.string().optional(),
  hours: z.number().optional(),
  limit: z.number().optional(),
  includeAll: z.boolean().optional(),
  detail: z.boolean().optional(),
});

export type SessionsInput = z.infer<typeof sessionsInputSchema>;
