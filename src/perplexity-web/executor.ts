import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  SavedBrowserImage,
} from "../browser/types.js";
import { runProviderDomFlow } from "../browser/providerDomFlow.js";
import { formatBrowserTurnTranscript, type BrowserConversationTurn } from "../browser/index.js";
import { openWebBrowserSession } from "../browser/webSessionManager.js";
import { delay } from "../browser/utils.js";
import {
  perplexityDomProvider,
  extractPerplexitySources,
  extractPerplexityImages,
  type PerplexitySource,
  type PerplexityImage,
} from "../browser/providers/perplexityDomProvider.js";
import { perplexityModeForModel, resolvePerplexityWebModel } from "./models.js";
import type { PerplexityWebOptions } from "./types.js";

const PERPLEXITY_URL = "https://www.perplexity.ai/";

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractConversationId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /\/search\/([0-9a-f-]{8,})/i.exec(url);
  return match?.[1];
}

function appendSources(answer: string, sources: PerplexitySource[]): string {
  if (sources.length === 0) return answer;
  const lines = sources.map((source, index) => `${index + 1}. [${source.title}](${source.url})`);
  return `${answer}\n\n## Sources\n\n${lines.join("\n")}`;
}

function renderImages(images: PerplexityImage[]): string {
  return images.map((image) => `![${image.alt ?? "Generated image"}](${image.url})`).join("\n\n");
}

function resolveInvocationPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

/** Perplexity serves generated images from a public bucket, so no auth is needed. */
async function saveGeneratedImage(
  image: PerplexityImage,
  destination: string,
  log?: BrowserLogger,
): Promise<SavedBrowserImage | null> {
  try {
    const response = await fetch(image.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    log?.(`[perplexity-web] Saved generated image to ${destination}`);
    return {
      kind: "image",
      path: destination,
      url: image.url,
      alt: image.alt,
      width: image.width,
      height: image.height,
      sizeBytes: bytes.byteLength,
    } as SavedBrowserImage;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.(`[perplexity-web] Could not save generated image: ${message}`);
    return null;
  }
}

export function createPerplexityWebExecutor(
  perplexityOptions: PerplexityWebOptions,
): (runOptions: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (runOptions: BrowserRunOptions): Promise<BrowserRunResult> => {
    const startTime = Date.now();
    const log: BrowserLogger | undefined = runOptions.log;

    log?.("[perplexity-web] Starting Perplexity web executor");

    const attachments = runOptions.attachments ?? [];
    const model = resolvePerplexityWebModel(runOptions.config?.desiredModel, log);
    const mode = perplexityModeForModel(model);
    const includeSources = perplexityOptions.includeSources ?? true;

    const session = await openWebBrowserSession({
      browserConfig: runOptions.config,
      keepBrowserDefault: true,
      purpose: `Perplexity (${model})`,
      logPrefix: "perplexity-web",
      log,
    });

    try {
      const { Runtime, Page, Input, DOM } = session.client;
      if (
        !Runtime ||
        typeof Runtime.enable !== "function" ||
        typeof Runtime.evaluate !== "function"
      ) {
        throw new Error("Chrome Runtime domain unavailable for Perplexity DOM automation.");
      }
      if (!Page || typeof Page.enable !== "function" || typeof Page.navigate !== "function") {
        throw new Error("Chrome Page domain unavailable for Perplexity DOM automation.");
      }
      await Runtime.enable();
      await Page.enable();
      // Required before DOM.getDocument/setFileInputFiles when attaching files.
      if (attachments.length > 0 && DOM && typeof DOM.enable === "function") {
        await DOM.enable();
      }

      const evaluate = async <T>(expression: string): Promise<T | undefined> => {
        const { result } = await Runtime.evaluate({ expression, returnByValue: true });
        return result?.value as T | undefined;
      };

      log?.(`[perplexity-web] Navigating to ${PERPLEXITY_URL}...`);
      await Page.navigate({ url: PERPLEXITY_URL });
      await delay(3_000);

      const ctx = {
        prompt: runOptions.prompt,
        evaluate,
        delay,
        log,
        state: {
          runtime: Runtime,
          input: Input,
          page: Page,
          dom: DOM,
          mode,
          attachments,
          timeoutMs: runOptions.config?.timeoutMs,
          inputTimeoutMs: runOptions.config?.inputTimeoutMs,
          attachmentTimeoutMs: runOptions.config?.attachmentTimeoutMs,
        },
      };

      const domResult = await runProviderDomFlow(perplexityDomProvider, ctx);

      // Follow-ups reuse the same conversation. They must not re-run selectMode (the
      // mode is already set) and must not re-upload the attachments, so only the
      // compose/submit/wait steps are repeated against a refreshed turn baseline.
      const followUps = (runOptions.followUpPrompts ?? [])
        .map((entry) => entry?.trim())
        .filter((entry): entry is string => Boolean(entry));
      const turns: BrowserConversationTurn[] = [
        {
          label: "Initial",
          prompt: runOptions.prompt,
          answerText: domResult.text,
          answerMarkdown: domResult.text,
        },
      ];

      for (const [index, followUpPrompt] of followUps.entries()) {
        log?.(`[perplexity-web] Sending follow-up ${index + 1}/${followUps.length}`);
        const turnCount = await evaluate<number>("document.querySelectorAll('.prose').length");
        const followUpCtx = {
          ...ctx,
          prompt: followUpPrompt,
          state: {
            ...ctx.state,
            attachments: [],
            baselineTurns: typeof turnCount === "number" ? turnCount : turns.length,
          },
        };
        await perplexityDomProvider.typePrompt(followUpCtx);
        await perplexityDomProvider.submitPrompt(followUpCtx);
        const followUpResult = await perplexityDomProvider.waitForResponse(followUpCtx);
        turns.push({
          label: `Follow-up ${index + 1}`,
          prompt: followUpPrompt,
          answerText: followUpResult.text,
          answerMarkdown: followUpResult.text,
        });
      }

      const transcript = formatBrowserTurnTranscript(turns);

      const sources = includeSources ? await extractPerplexitySources(ctx) : [];
      const images = await extractPerplexityImages(ctx);
      const tabUrl = await evaluate<string>("location.href");

      // Image answers carry no prose, so fall back to the rendered image markdown
      // rather than returning an empty answer.
      const answerText = transcript.answerText || (images.length > 0 ? renderImages(images) : "");
      let answerMarkdown = transcript.answerMarkdown
        ? images.length > 0
          ? `${transcript.answerMarkdown}\n\n${renderImages(images)}`
          : transcript.answerMarkdown
        : renderImages(images);
      answerMarkdown = includeSources ? appendSources(answerMarkdown, sources) : answerMarkdown;

      const imageDestination = resolveInvocationPath(
        perplexityOptions.outputPath ?? perplexityOptions.generateImage,
      );
      const savedImages: SavedBrowserImage[] = [];
      if (imageDestination && images[0]) {
        const saved = await saveGeneratedImage(images[0], imageDestination, log);
        if (saved) savedImages.push(saved);
      }

      const tookMs = Date.now() - startTime;

      log?.(
        `[perplexity-web] Completed in ${tookMs}ms (${answerText.length} chars, ${sources.length} sources, ${images.length} images).`,
      );

      return {
        answerText,
        answerMarkdown,
        generatedImages: images.length > 0 ? images : undefined,
        savedImages: savedImages.length > 0 ? savedImages : undefined,
        tookMs,
        answerTokens: estimateTokenCount(answerText),
        answerChars: answerText.length,
        browserTransport: "cdp",
        chromePort: session.port,
        chromeTargetId: session.targetId,
        userDataDir: session.profileDir,
        tabUrl,
        conversationId: extractConversationId(tabUrl),
        promptSubmitted: true,
      };
    } finally {
      await session.close();
    }
  };
}
