import type { BrowserRunOptions, BrowserLogger, ChromeClient } from "../browser/types.js";
import { openWebBrowserSession } from "../browser/webSessionManager.js";

export interface GeminiBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId?: string;
  close: () => Promise<void>;
}

export interface OpenGeminiBrowserSessionInput {
  browserConfig: BrowserRunOptions["config"];
  keepBrowserDefault: boolean;
  purpose: string;
  log?: BrowserLogger;
}

export async function openGeminiBrowserSession(
  input: OpenGeminiBrowserSessionInput,
): Promise<GeminiBrowserSession> {
  return openWebBrowserSession({ ...input, logPrefix: "gemini-web" });
}
