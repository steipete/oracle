import type { ChromeClient, BrowserLogger } from "./types.js";
import { CONVERSATION_TURN_SELECTOR } from "./constants.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionArtifactsDir } from "./artifacts.js";

export function buildConversationDebugExpression(): string {
  return `(() => {
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    return turns.map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText?.slice(0, 200),
      testid: node.getAttribute('data-testid'),
    }));
  })()`;
}

export async function logConversationSnapshot(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
) {
  const expression = buildConversationDebugExpression();
  const { result } = await Runtime.evaluate({ expression, returnByValue: true });
  if (Array.isArray(result.value)) {
    const recent = (result.value as Array<Record<string, unknown>>).slice(-3);
    logger(`Conversation snapshot: ${JSON.stringify(recent)}`);
  }
}

export async function logDomFailure(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  context: string,
) {
  if (!logger?.verbose) {
    return;
  }
  try {
    const entry = `Browser automation failure (${context}); capturing DOM snapshot for debugging...`;
    logger(entry);
    if (logger.sessionLog && logger.sessionLog !== logger) {
      logger.sessionLog(entry);
    }
    await logConversationSnapshot(Runtime, logger);
  } catch {
    // ignore snapshot failures
  }
}

export async function captureBrowserDiagnostics(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  context: string,
  options: {
    Page?: ChromeClient["Page"];
    sessionId?: string;
  } = {},
): Promise<{ domPath?: string; screenshotPath?: string }> {
  if (!options.sessionId) {
    await logConversationSnapshot(Runtime, logger).catch(() => undefined);
    return {};
  }
  const dir = resolveSessionArtifactsDir(options.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `${context}-${timestamp}`;
  const domPath = path.join(dir, `${baseName}.dom.json`);
  const expression = `(() => {
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR)).slice(-6).map((node) => ({
      role: node.getAttribute('data-message-author-role') || node.getAttribute('data-turn'),
      text: (node.innerText || node.textContent || '').slice(0, 2000),
      testid: node.getAttribute('data-testid'),
    }));
    return {
      url: location.href,
      title: document.title,
      turns,
      bodyText: (document.body?.innerText || '').slice(0, 5000),
    };
  })()`;
  const { result } = await Runtime.evaluate({ expression, returnByValue: true });
  await fs.writeFile(domPath, `${JSON.stringify(result?.value ?? null, null, 2)}\n`, "utf8");
  logger(`[browser] Saved DOM diagnostic snapshot to ${domPath}`);
  let screenshotPath: string | undefined;
  if (options.Page?.captureScreenshot) {
    try {
      const screenshot = await options.Page.captureScreenshot({
        format: "png",
        captureBeyondViewport: true,
      });
      if (screenshot?.data) {
        screenshotPath = path.join(dir, `${baseName}.png`);
        await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
        logger(`[browser] Saved screenshot diagnostic snapshot to ${screenshotPath}`);
      }
    } catch {
      // Screenshots are best-effort; the DOM snapshot above is the primary diagnostic.
    }
  }
  return { domPath, screenshotPath };
}
