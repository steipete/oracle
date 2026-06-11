import { formatFileSections } from "../oracle/markdown.js";
import type { BrowserAttachment } from "./types.js";
import type { BrowserSessionConfig } from "../sessionManager.js";

export interface AttachmentSection {
  displayPath: string;
  absolutePath: string;
  content: string;
}

export interface AttachmentPlan {
  mode: "inline" | "upload" | "bundle";
  inlineBlock: string;
  inlineFileCount: number;
  attachments: BrowserAttachment[];
  shouldBundle: boolean;
}

export function buildAttachmentPlan(
  sections: AttachmentSection[],
  {
    inlineFiles,
    bundleRequested,
    maxAttachments = 10,
  }: { inlineFiles: boolean; bundleRequested: boolean; maxAttachments?: number },
): AttachmentPlan {
  if (inlineFiles) {
    const inlineBlock = formatFileSections(sections);
    return {
      mode: "inline",
      inlineBlock,
      inlineFileCount: sections.length,
      attachments: [],
      shouldBundle: false,
    };
  }

  const attachments: BrowserAttachment[] = sections.map((section) => ({
    path: section.absolutePath,
    displayPath: section.displayPath,
    sizeBytes: Buffer.byteLength(section.content, "utf8"),
  }));
  const shouldBundle = bundleRequested || attachments.length > maxAttachments;

  return {
    mode: shouldBundle ? "bundle" : "upload",
    inlineBlock: "",
    inlineFileCount: 0,
    attachments,
    shouldBundle,
  };
}

export type CookiePlan =
  | { type: "inline"; description: string }
  | { type: "disabled"; description: string }
  | { type: "copy"; description: string };

export function buildCookiePlan(config?: BrowserSessionConfig): CookiePlan {
  if (config?.inlineCookies && config.inlineCookies.length > 0) {
    const source = config.inlineCookiesSource ?? "inline";
    return {
      type: "inline",
      description: `Cookies: inline payload (${config.inlineCookies.length}) via ${source}.`,
    };
  }
  if (config?.cookieSync === false) {
    return { type: "disabled", description: "Cookies: sync disabled (--browser-no-cookie-sync)." };
  }
  const allowlist =
    config?.cookieNames && config.cookieNames.length > 0
      ? config.cookieNames.join(", ")
      : "all from Chrome profile";
  return { type: "copy", description: `Cookies: copy from Chrome (${allowlist}).` };
}
