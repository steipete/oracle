import type { RunOracleOptions } from "../oracle/types.js";
import type { BrowserRunOptions, BrowserRunResult } from "./types.js";
import { resolveBrowserProvider } from "./provider.js";

export type BrowserExecutor = (options: BrowserRunOptions) => Promise<BrowserRunResult>;

export async function resolveLocalBrowserExecutor(
  options: RunOracleOptions,
): Promise<BrowserExecutor> {
  const provider = resolveBrowserProvider(options.model);
  if (provider === "gemini") {
    const { createGeminiWebExecutor } = await import("../gemini-web/index.js");
    return createGeminiWebExecutor({
      youtube: options.youtube,
      generateImage: options.generateImage,
      editImage: options.editImage,
      outputPath: options.outputPath,
      aspectRatio: options.aspectRatio,
      showThoughts: options.geminiShowThoughts,
      allowModelFallback: options.geminiAllowModelFallback,
    });
  }
  if (provider === "chatgpt") return (await import("../browserMode.js")).runBrowserMode;
  throw new Error(`Unsupported browser model: ${options.model}. Use a GPT or Gemini model.`);
}
