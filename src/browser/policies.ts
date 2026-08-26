import { formatFileSections } from "../oracle/markdown.js";
import type { BrowserAttachment, ResolvedBrowserConfig } from "./types.js";
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
  { inlineFiles, bundleRequested }: { inlineFiles: boolean; bundleRequested: boolean },
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
  // Multiple text files are one ordered, labelled corpus. Uploading that corpus as one
  // text bundle preserves its semantics while avoiding one asynchronous readiness state
  // per source file. A single file stays a direct attachment so its original filename is
  // retained in the composer.
  const shouldBundle = bundleRequested || attachments.length > 1;

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

export const CHROME_COOKIE_SYNC_WARNING =
  "Warning: copying cookies from a live Chrome profile can invalidate that browser's ChatGPT session when tokens rotate. Prefer --browser-manual-login or inline cookies when possible.";

export function shouldSyncBrowserCookies(
  config: Pick<ResolvedBrowserConfig, "cookieSync" | "manualLoginCookieSync">,
  {
    manualLogin,
    profileIsPreSigned = manualLogin,
  }: { manualLogin: boolean; profileIsPreSigned?: boolean },
): boolean {
  const explicitManualLoginSync = manualLogin && config.manualLoginCookieSync === true;
  return config.cookieSync && (!profileIsPreSigned || explicitManualLoginSync);
}

export function buildCookiePlan(config?: BrowserSessionConfig): CookiePlan {
  if (config?.inlineCookies && config.inlineCookies.length > 0) {
    const source = config.inlineCookiesSource ?? "inline";
    return {
      type: "inline",
      description: `Cookies: inline payload (${config.inlineCookies.length}) via ${source}.`,
    };
  }
  if (config?.cookieSync !== true) {
    return {
      type: "disabled",
      description:
        "Cookies: Chrome copy disabled (use --browser-manual-login, inline cookies, or --browser-cookie-sync).",
    };
  }
  const allowlist =
    config?.cookieNames && config.cookieNames.length > 0
      ? config.cookieNames.join(", ")
      : "all from Chrome profile";
  return { type: "copy", description: `Cookies: copy from Chrome (${allowlist}).` };
}
