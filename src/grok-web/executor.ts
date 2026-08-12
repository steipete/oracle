import { closeTab, connectWithNewTab } from "../browser/chromeLifecycle.js";
import { resolveAttachRunningConnection } from "../browser/attachRunning.js";
import { runProviderDomFlow } from "../browser/providerDomFlow.js";
import { grokDomProvider, GROK_SELECTORS } from "../browser/providers/grokDomProvider.js";
import type { BrowserLogger, BrowserRunOptions, BrowserRunResult } from "../browser/types.js";
import { delay } from "../browser/utils.js";
import path from "node:path";

const GROK_URL = "https://grok.com/";

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createGrokWebExecutor(): (options: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (options) => {
    const startedAt = Date.now();
    const config = options.config;
    const logger: BrowserLogger = options.log ?? (() => {});
    if (!config?.remoteChrome && !config?.attachRunning) {
      throw new Error(
        "Grok web mode currently requires --remote-chrome or --browser-attach-running with a Chrome profile.",
      );
    }

    const attached = config.attachRunning
      ? await resolveAttachRunningConnection(
          {
            chromePath: config.chromePath ?? null,
            remoteChrome: config.remoteChrome ?? null,
          },
          logger,
        )
      : null;
    const remoteChrome = config.remoteChrome ?? attached;
    if (!remoteChrome) throw new Error("Unable to resolve the attached Chrome endpoint.");
    const { host, port } = remoteChrome;
    logger("[grok-web] Opening an isolated Grok tab in the attached Chrome session.");
    const connection = await connectWithNewTab(port, logger, GROK_URL, host, {
      fallbackToDefault: false,
      retries: 2,
      retryDelayMs: 500,
    });
    const { client, targetId } = connection;
    const keepBrowser = config.keepBrowser ?? true;

    try {
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();
      const evaluate = async <T>(expression: string): Promise<T | undefined> => {
        const { result } = await client.Runtime.evaluate({ expression, returnByValue: true });
        if (result?.subtype === "error") {
          throw new Error(result.description ?? "Grok page evaluation failed.");
        }
        return result?.value as T | undefined;
      };
      const responseSelector = JSON.stringify(GROK_SELECTORS.response.join(", "));
      const responseCount = async (): Promise<number> => {
        const count = await evaluate<number>(
          `document.querySelectorAll(${responseSelector}).length`,
        );
        return count ?? 0;
      };
      const uploadAttachments = async (attachments: Array<{ path: string; name: string }>) => {
        const documentNode = await client.DOM.getDocument();
        const result = await client.DOM.querySelector({
          nodeId: documentNode.root.nodeId,
          selector: 'input[type="file"]',
        });
        if (!result.nodeId) throw new Error("Unable to locate Grok file upload input.");
        await client.DOM.setFileInputFiles({
          nodeId: result.nodeId,
          files: attachments.map((attachment) => attachment.path),
        });
        const names = attachments.map((attachment) => attachment.name.toLowerCase());
        const deadline = Date.now() + (config.attachmentTimeoutMs ?? 45_000);
        while (Date.now() < deadline) {
          const ready = await evaluate<boolean>(`(() => {
            const text = (document.body?.innerText || '').toLowerCase();
            const chips = Array.from(document.querySelectorAll('[data-testid*="attachment"], [data-testid*="file"], [aria-label*="Remove"]'))
              .map((node) => (node.textContent || node.getAttribute('aria-label') || '').toLowerCase())
              .join(' ');
            return ${JSON.stringify(names)}.every((name) => text.includes(name) || chips.includes(name));
          })()`);
          if (ready) return;
          await delay(500);
        }
        throw new Error(`Timed out waiting for Grok attachments: ${names.join(", ")}`);
      };
      const runPrompt = async (prompt: string, includeAttachments: boolean) =>
        runProviderDomFlow(grokDomProvider, {
          prompt,
          evaluate,
          delay,
          log: logger,
          state: {
            inputTimeoutMs: config.inputTimeoutMs,
            timeoutMs: config.timeoutMs,
            responseCountBeforeSubmit: await responseCount(),
            attachments: includeAttachments
              ? (options.attachments ?? []).map((attachment) => ({
                  path: attachment.path,
                  name: path.basename(attachment.path),
                }))
              : [],
          },
          uploadAttachments,
        });

      let result = await runPrompt(options.prompt, true);
      for (const followUp of options.followUpPrompts ?? []) {
        logger("[grok-web] Sending follow-up prompt in the same conversation.");
        result = await runPrompt(followUp, false);
      }

      const tookMs = Date.now() - startedAt;
      return {
        answerText: result.text,
        answerMarkdown: result.text,
        answerHtml: result.html,
        tookMs,
        answerTokens: estimateTokenCount(result.text),
        answerChars: result.text.length,
        browserTransport: "cdp",
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: attached?.browserWSEndpoint,
        chromeProfileRoot: attached?.profileRoot,
        chromeTargetId: targetId,
        tabUrl: GROK_URL,
        promptSubmitted: true,
        controllerPid: process.pid,
      };
    } finally {
      await client.close().catch(() => undefined);
      if (!keepBrowser && targetId) {
        await closeTab(port, targetId, logger, host).catch(() => undefined);
      }
    }
  };
}
