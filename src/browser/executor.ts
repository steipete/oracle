import type { RunOracleOptions } from "../oracle/types.js";
import type { BrowserRunOptions, BrowserRunResult } from "./types.js";
import { resolveBrowserProvider } from "./provider.js";

export type BrowserExecutor = (options: BrowserRunOptions) => Promise<BrowserRunResult>;

export type BrowserExecutorOptions = Pick<
  RunOracleOptions,
  | "model"
  | "youtube"
  | "generateImage"
  | "editImage"
  | "outputPath"
  | "aspectRatio"
  | "geminiShowThoughts"
  | "geminiAllowModelFallback"
>;

export async function resolveBrowserExecutor(
  options: BrowserExecutorOptions,
  remote?: { host: string; token?: string },
): Promise<BrowserExecutor> {
  const provider = resolveBrowserProvider(options.model);
  if (!provider) {
    throw new Error(`Unsupported browser model: ${options.model}. Use a GPT or Gemini model.`);
  }
  if (remote) {
    const { createRemoteBrowserExecutor } = await import("../remote/client.js");
    return createRemoteBrowserExecutor({ ...remote, runOptions: options });
  }
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
  return (await import("../browserMode.js")).runBrowserMode;
}
