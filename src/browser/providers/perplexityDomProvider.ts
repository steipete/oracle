import path from "node:path";
import type { BrowserAttachment, ChromeClient } from "../types.js";
import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { joinSelectors } from "../providerDomFlow.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 2_000;
// Perplexity clears its Stop button slightly before the answer text settles, so a
// completed turn must also hold a steady length across consecutive polls.
const STABLE_POLLS_REQUIRED = 2;
// The sources pane fills in after the answer settles, so re-read it until it stops
// growing instead of trusting a single immediate read.
const SOURCE_POLL_ATTEMPTS = 5;
const SOURCE_POLL_INTERVAL_MS = 800;
// Consecutive polls showing Cloudflare's challenge before giving up, so a brief
// interstitial that clears on its own does not fail the run.
const BOT_CHECK_POLLS_BEFORE_FAILING = 3;

export type PerplexityMode = "search" | "research";

export const PERPLEXITY_MODE_LABELS: Record<PerplexityMode, string> = {
  search: "Search",
  research: "Deep research",
};

/**
 * Every label the composer's mode toggle can display. Used to identify the toggle
 * when the scoped selector misses, and to keep the separate "Computer" toggle —
 * which is not a chat mode — from being mistaken for it.
 */
const MODE_TOGGLE_LABELS = ["search", "deep research", "model council", "learn step by step"];

interface PerplexityDomProviderState {
  runtime?: ChromeClient["Runtime"];
  input?: ChromeClient["Input"];
  page?: ChromeClient["Page"];
  dom?: ChromeClient["DOM"];
  mode?: PerplexityMode;
  timeoutMs?: number;
  inputTimeoutMs?: number;
  attachmentTimeoutMs?: number;
  attachments?: BrowserAttachment[];
  baselineTurns?: number | null;
}

export const PERPLEXITY_SELECTORS = {
  input: ["#ask-input", 'div[role="textbox"][contenteditable="true"]'],
  submit: ['button[aria-label="Submit"]'],
  stop: ['button[aria-label="Stop"]'],
  consentDialog: ['[data-testid="consent-dialog"]'],
  // Scope to the composer's mode toggle: the page has several menu triggers
  // ("Filter projects", "Apps and more", "Model") and the first visible one is
  // not the mode switch.
  modeTrigger: ['[data-testid="ask-input-mode-toggle-width-wrapper"] button[aria-haspopup="menu"]'],
  menuItem: ['[role="menuitemradio"]', '[role="menuitem"]'],
  answerTurn: [".prose"],
  // Tightest ancestor that holds both the answer body and its action footer.
  turnWrapper: ['[class*="group/final-text"]'],
  doneFooter: ['button[aria-label="Helpful"]'],
  contextPane: ['div[data-context-pane="true"]'],
  fileInput: ['input[type="file"]'],
  addFilesButton: ['button[aria-label="Add files or tools"]'],
  // Region holding the composer and its attachment chips; scoping the upload
  // confirmation here avoids matching old session titles in the sidebar.
  composerRegion: ['div[class*="rounded"]'],
  // Source cards stack domain / title / description; the middle line is the title.
  sourceTitle: ['[class*="line-clamp-2"]'],
} as const;

function asSelectorLiteral(selectors: readonly string[]): string {
  return JSON.stringify(joinSelectors(selectors));
}

/**
 * Collects generated images as `{ url, width, height, alt }`. Perplexity serves
 * them from its user-generated media bucket; the size floor is a fallback that
 * keeps avatars, favicons and source thumbnails out.
 */
const IMAGE_COLLECTOR_EXPRESSION = `(() => {
  // A text answer renders article thumbnails that must not be mistaken for output,
  // so the size heuristic only applies to image-only answers (which have no prose).
  const hasProse = document.querySelectorAll(${JSON.stringify(joinSelectors([".prose"]))}).length > 0;
  return Array.from(document.querySelectorAll('img'))
    .filter((img) => {
      const src = img.currentSrc || img.src || '';
      if (!src.startsWith('http')) return false;
      if (/avatar|favicon|profile|logo|icon/i.test(src)) return false;
      const generated = /user-gen-media-assets|user-images/i.test(src);
      return generated || (!hasProse && img.naturalWidth >= 384);
    })
    .map((img) => ({
      url: img.currentSrc || img.src,
      width: img.naturalWidth || undefined,
      height: img.naturalHeight || undefined,
      alt: (img.alt || '').trim().slice(0, 200) || undefined,
    }));
})()`;

function readState(ctx: ProviderDomFlowContext): PerplexityDomProviderState {
  return (ctx.state ?? {}) as PerplexityDomProviderState;
}

function readTimeouts(ctx: ProviderDomFlowContext): {
  uiTimeoutMs: number;
  responseTimeoutMs: number;
} {
  const state = readState(ctx);
  const uiTimeoutMs =
    typeof state.inputTimeoutMs === "number" && Number.isFinite(state.inputTimeoutMs)
      ? Math.max(1_000, state.inputTimeoutMs)
      : UI_TIMEOUT_MS;
  const responseTimeoutMs =
    typeof state.timeoutMs === "number" && Number.isFinite(state.timeoutMs)
      ? Math.max(1_000, state.timeoutMs)
      : RESPONSE_TIMEOUT_MS;
  return { uiTimeoutMs, responseTimeoutMs };
}

/**
 * Perplexity's mode menu is a Radix popup that opens on pointer events, so a
 * synthetic `element.click()` never opens it. Resolve the element's centre and
 * dispatch real CDP mouse events, falling back to a synthetic click only when
 * the Input domain is unavailable.
 */
async function clickTrusted(
  ctx: ProviderDomFlowContext,
  elementExpression: string,
): Promise<boolean> {
  const point = await ctx.evaluate<{ x: number; y: number } | null>(
    `(() => {
      const el = ${elementExpression};
      if (!(el instanceof HTMLElement)) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (!point) return false;

  const { input } = readState(ctx);
  if (input && typeof input.dispatchMouseEvent === "function") {
    const { x, y } = point;
    await input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return true;
  }

  const clicked = await ctx.evaluate<boolean>(
    `(() => {
      const el = ${elementExpression};
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`,
  );
  return Boolean(clicked);
}

async function dismissConsentDialog(ctx: ProviderDomFlowContext): Promise<void> {
  const consentSel = asSelectorLiteral(PERPLEXITY_SELECTORS.consentDialog);
  const dismissed = await ctx.evaluate<string>(
    `(() => {
      const dialog = document.querySelector(${consentSel});
      if (!dialog) return 'absent';
      const buttons = Array.from(dialog.querySelectorAll('button'));
      const preferred =
        buttons.find((b) => /only necessary/i.test(b.textContent || '')) ??
        buttons.find((b) => /accept|allow/i.test(b.textContent || ''));
      if (!(preferred instanceof HTMLElement)) return 'no-button';
      preferred.click();
      return 'dismissed';
    })()`,
  );
  if (dismissed === "dismissed") {
    ctx.log?.("[perplexity-web] Dismissed cookie consent dialog.");
    await ctx.delay(500);
  }
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[perplexity-web] Waiting for Perplexity UI to load...");
  const inputSelector = asSelectorLiteral(PERPLEXITY_SELECTORS.input);
  const { uiTimeoutMs } = readTimeouts(ctx);
  const deadline = Date.now() + uiTimeoutMs;
  let ready = false;
  let sawSignIn = false;
  let sawBotCheck = false;

  while (Date.now() < deadline) {
    await dismissConsentDialog(ctx);
    const state = await ctx.evaluate<{
      ready?: boolean;
      signedOut?: boolean;
      botCheck?: boolean;
    }>(
      `(() => {
        const editor = document.querySelector(${inputSelector});
        const href = location.href || '';
        const text = document.body?.innerText || '';
        // Cloudflare's managed challenge replaces the app shell; it often clears on
        // its own, so this only reports the state and lets the caller keep waiting.
        const botCheck =
          !editor &&
          /security verification|verifying you are not a bot|needs to review the security/i.test(text);
        const signedOut =
          !botCheck &&
          (href.includes('/auth/') ||
            href.includes('accounts.google.com') ||
            (!editor && /sign ?in|log ?in/i.test(text)));
        return { ready: Boolean(editor), signedOut, botCheck };
      })()`,
    );
    if (state?.ready) {
      ready = true;
      break;
    }
    if (state?.botCheck) {
      sawBotCheck = true;
    }
    if (state?.signedOut) {
      sawSignIn = true;
    }
    await ctx.delay(1_000);
  }

  if (!ready) {
    if (sawBotCheck) {
      throw new Error(
        "Perplexity is showing a Cloudflare bot check that did not clear. Open the Oracle Chrome window and complete the verification, then retry. Frequent automated runs make this more likely.",
      );
    }
    if (sawSignIn) {
      throw new Error(
        "Perplexity is showing a sign-in flow. Sign in with --browser-manual-login and retry.",
      );
    }
    throw new Error("Timed out waiting for the Perplexity prompt input to become ready.");
  }

  // Snapshot the turn count before submitting so waitForResponse can tell the new
  // answer apart from any answers already on the page.
  const turnSelector = asSelectorLiteral(PERPLEXITY_SELECTORS.answerTurn);
  const turns = await ctx.evaluate<number>(`document.querySelectorAll(${turnSelector}).length`);
  const state = readState(ctx);
  state.baselineTurns = typeof turns === "number" && Number.isFinite(turns) ? turns : 0;
  if (ctx.state) {
    (ctx.state as PerplexityDomProviderState).baselineTurns = state.baselineTurns;
  }
}

async function selectMode(ctx: ProviderDomFlowContext): Promise<void> {
  const mode = readState(ctx).mode ?? "search";
  const label = PERPLEXITY_MODE_LABELS[mode];
  const triggerSel = asSelectorLiteral(PERPLEXITY_SELECTORS.modeTrigger);
  const menuItemSel = asSelectorLiteral(PERPLEXITY_SELECTORS.menuItem);
  const toggleLabels = JSON.stringify(MODE_TOGGLE_LABELS);

  // Resolve the mode toggle, preferring the scoped selector and falling back to a
  // menu trigger whose label is one of the known chat modes.
  const triggerExpression = `(() => {
    const visible = (el) => el instanceof HTMLElement && el.offsetParent !== null;
    const scoped = Array.from(document.querySelectorAll(${triggerSel})).filter(visible);
    const labels = ${toggleLabels};
    const byLabel = (list) =>
      list.find((b) => labels.some((l) => (b.textContent || '').trim().toLowerCase().startsWith(l)));
    return (
      byLabel(scoped) ??
      scoped[0] ??
      byLabel(Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).filter(visible))
    );
  })()`;

  const alreadyActive = await ctx.evaluate<boolean>(
    `(() => {
      const trigger = ${triggerExpression};
      if (!trigger) return false;
      return (trigger.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())});
    })()`,
  );
  if (alreadyActive) {
    ctx.log?.(`[perplexity-web] Mode "${label}" already active.`);
    return;
  }

  ctx.log?.(`[perplexity-web] Selecting mode "${label}"...`);
  const opened = await clickTrusted(ctx, triggerExpression);
  if (!opened) {
    throw new Error("Unable to open the Perplexity mode menu.");
  }
  await ctx.delay(800);

  const picked = await clickTrusted(
    ctx,
    `Array.from(document.querySelectorAll(${menuItemSel})).find((item) => {
      if (!(item instanceof HTMLElement) || item.offsetParent === null) return false;
      return (item.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())});
    })`,
  );
  if (!picked) {
    throw new Error(
      `Unable to select "${label}" from the Perplexity mode menu. Your account may not have access to it.`,
    );
  }
  await ctx.delay(1_000);
}

/**
 * Attaches files by intercepting the native file chooser.
 *
 * Setting `input.files` directly does not work here: the composer mounts more than
 * one file input depending on UI state, and Perplexity's uploader does not read the
 * element's `files` list. Intercepting the chooser and answering it with
 * `DOM.setFileInputFiles({ backendNodeId })` hands files to the input the app itself
 * opened, which is the only approach that registers.
 */
export async function uploadPerplexityAttachments(ctx: ProviderDomFlowContext): Promise<void> {
  const state = readState(ctx);
  const attachments = state.attachments ?? [];
  if (attachments.length === 0) return;

  const { dom, page } = state;
  if (!dom || typeof dom.setFileInputFiles !== "function" || !page) {
    throw new Error("Chrome DOM/Page domains unavailable, so attachments cannot be uploaded.");
  }
  if (typeof page.setInterceptFileChooserDialog !== "function") {
    throw new Error("This Chrome build cannot intercept file chooser dialogs for uploads.");
  }

  ctx.log?.(`[perplexity-web] Attaching ${attachments.length} file(s)...`);
  const files = attachments.map((attachment) => attachment.path);

  await page.setInterceptFileChooserDialog({ enabled: true });
  let supplyError: unknown;
  // The chooser opens once and accepts the whole set (mode: selectMultiple).
  const unsubscribe = page.fileChooserOpened(async (event: { backendNodeId?: number }) => {
    if (!event?.backendNodeId) return;
    try {
      await dom.setFileInputFiles({ backendNodeId: event.backendNodeId, files });
    } catch (error) {
      supplyError = error;
    }
  });

  try {
    const opened = await clickTrusted(
      ctx,
      `document.querySelector(${asSelectorLiteral(PERPLEXITY_SELECTORS.addFilesButton)})`,
    );
    if (!opened) {
      throw new Error('Could not open the Perplexity "Add files or tools" menu.');
    }
    await ctx.delay(1_000);

    const chose = await clickTrusted(
      ctx,
      `Array.from(document.querySelectorAll(${asSelectorLiteral(PERPLEXITY_SELECTORS.menuItem)}))
        .find((item) => item instanceof HTMLElement && item.offsetParent !== null && /upload files/i.test(item.textContent || ''))`,
    );
    if (!chose) {
      throw new Error('Could not find the "Upload files or images" menu item.');
    }

    await waitForAttachmentChips(ctx, attachments, state.attachmentTimeoutMs);
    if (supplyError) {
      const message = supplyError instanceof Error ? supplyError.message : String(supplyError);
      throw new Error(`Failed to hand files to Perplexity's uploader: ${message}`);
    }
    ctx.log?.(`[perplexity-web] Attached ${attachments.length} file(s).`);
  } finally {
    unsubscribe?.();
    await page.setInterceptFileChooserDialog({ enabled: false }).catch(() => undefined);
  }
}

/**
 * Waits for each attachment to show up as a composer chip. Perplexity may transcode
 * an upload (a .png can come back as "name.jpg"), so chips are matched on the file
 * name stem rather than the full basename.
 */
async function waitForAttachmentChips(
  ctx: ProviderDomFlowContext,
  attachments: BrowserAttachment[],
  attachmentTimeoutMs?: number,
): Promise<void> {
  const stems = attachments.map((attachment) =>
    path.basename(attachment.path, path.extname(attachment.path)).toLowerCase(),
  );
  const regionSel = asSelectorLiteral(PERPLEXITY_SELECTORS.composerRegion);
  const inputSel = asSelectorLiteral(PERPLEXITY_SELECTORS.input);
  const timeoutMs = Math.max(1_000, attachmentTimeoutMs ?? 120_000);
  const deadline = Date.now() + timeoutMs;
  let missing = stems;

  while (Date.now() < deadline) {
    const regionText = await ctx.evaluate<string>(
      `(() => {
        const editor = document.querySelector(${inputSel});
        const region = editor ? editor.closest(${regionSel}) : null;
        return ((region ?? document.body)?.innerText || '').toLowerCase();
      })()`,
    );
    const text = regionText ?? "";
    missing = stems.filter((stem) => !text.includes(stem));
    if (missing.length === 0) return;
    await ctx.delay(1_000);
  }

  throw new Error(
    `Timed out waiting for Perplexity to accept ${missing.length} attachment(s): ${missing.join(", ")}.`,
  );
}

async function typePrompt(ctx: ProviderDomFlowContext): Promise<void> {
  await uploadPerplexityAttachments(ctx);

  ctx.log?.("[perplexity-web] Typing prompt...");
  const inputSelector = asSelectorLiteral(PERPLEXITY_SELECTORS.input);

  // Focus through a real click so React registers the composer as active.
  await clickTrusted(ctx, `document.querySelector(${inputSelector})`);
  await ctx.delay(200);

  // Focus the editor and select any existing text so the insert replaces it.
  const focused = await ctx.evaluate<string>(
    `(() => {
      const editor = document.querySelector(${inputSelector});
      if (!(editor instanceof HTMLElement)) return 'no-editor';
      editor.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return 'focused';
    })()`,
  );
  if (focused !== "focused") {
    throw new Error(`Failed to focus the Perplexity composer (status=${focused ?? "unknown"}).`);
  }

  // Perplexity's composer is a rich-text editor that ignores execCommand, so
  // insert through the CDP Input domain and only fall back to DOM writes.
  const { input } = readState(ctx);
  if (input && typeof input.insertText === "function") {
    await input.insertText({ text: ctx.prompt });
    await ctx.delay(300);
  }

  let typed = await ctx.evaluate<string>(
    `(() => {
      const editor = document.querySelector(${inputSelector});
      if (!(editor instanceof HTMLElement)) return 'no-editor';
      return (editor.innerText || '').trim().length > 0 ? 'typed' : 'empty';
    })()`,
  );

  if (typed !== "typed") {
    typed = await ctx.evaluate<string>(
      `(() => {
        const editor = document.querySelector(${inputSelector});
        if (!(editor instanceof HTMLElement)) return 'no-editor';
        editor.focus();
        if (typeof document.execCommand === 'function') {
          document.execCommand('insertText', false, ${JSON.stringify(ctx.prompt)});
        }
        if ((editor.innerText || '').trim().length === 0) {
          editor.textContent = ${JSON.stringify(ctx.prompt)};
          editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        return (editor.innerText || '').trim().length > 0 ? 'typed' : 'empty';
      })()`,
    );
  }

  if (typed !== "typed") {
    throw new Error(`Failed to type the Perplexity prompt (status=${typed ?? "unknown"}).`);
  }
  await ctx.delay(400);
}

/** True once the composer has actually produced a new answer turn or conversation. */
async function hasSubmitted(ctx: ProviderDomFlowContext, baselineTurns: number): Promise<boolean> {
  const turnSel = asSelectorLiteral(PERPLEXITY_SELECTORS.answerTurn);
  const submitted = await ctx.evaluate<boolean>(
    `(() => {
      const turns = document.querySelectorAll(${turnSel}).length;
      const onConversation = /\\/search\\//.test(location.pathname);
      const generating = Array.from(document.querySelectorAll('button[aria-label="Stop"]'))
        .some((b) => b instanceof HTMLElement && b.offsetParent !== null);
      return turns > ${baselineTurns} || onConversation || generating;
    })()`,
  );
  return Boolean(submitted);
}

async function submitPrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[perplexity-web] Sending prompt...");
  const submitSel = asSelectorLiteral(PERPLEXITY_SELECTORS.submit);
  const inputSelector = asSelectorLiteral(PERPLEXITY_SELECTORS.input);
  const state = readState(ctx);
  const baselineTurns = state.baselineTurns ?? 0;

  await clickTrusted(ctx, `document.querySelector(${submitSel})`);

  // Clicking Submit can be a no-op while the composer is still settling — notably
  // right after attachments are added — so confirm the send and retry with a real
  // Enter keypress rather than assuming it landed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (let poll = 0; poll < 6; poll += 1) {
      if (await hasSubmitted(ctx, baselineTurns)) return;
      await ctx.delay(1_000);
    }
    if (attempt === 0) {
      ctx.log?.("[perplexity-web] Submit did not register; retrying with Enter.");
      await clickTrusted(ctx, `document.querySelector(${inputSelector})`);
      await ctx.delay(200);
      const keyInput = state.input;
      if (keyInput && typeof keyInput.dispatchKeyEvent === "function") {
        await keyInput.dispatchKeyEvent({
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await keyInput.dispatchKeyEvent({
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      }
    }
  }

  throw new Error("Failed to submit the Perplexity prompt (the composer did not send).");
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{ text: string }> {
  ctx.log?.("[perplexity-web] Waiting for the Perplexity answer...");
  const turnSel = asSelectorLiteral(PERPLEXITY_SELECTORS.answerTurn);
  const wrapperSel = asSelectorLiteral(PERPLEXITY_SELECTORS.turnWrapper);
  const footerSel = asSelectorLiteral(PERPLEXITY_SELECTORS.doneFooter);
  const stopSel = asSelectorLiteral(PERPLEXITY_SELECTORS.stop);

  const baselineTurns = readState(ctx).baselineTurns ?? 0;
  const { responseTimeoutMs } = readTimeouts(ctx);
  const deadline = Date.now() + responseTimeoutMs;

  let answerText = "";
  let completed = false;
  let previousLength = -1;
  let previousImageCount = -1;
  let stablePolls = 0;
  let lastLog = 0;
  let consecutiveBotChecks = 0;

  while (Date.now() < deadline) {
    const payload = await ctx.evaluate<string>(
      `(() => {
        const turns = Array.from(document.querySelectorAll(${turnSel}));
        const generatingNow = Array.from(document.querySelectorAll(${stopSel}))
          .some((b) => b instanceof HTMLElement && b.offsetParent !== null);
        const imageCount = ${IMAGE_COLLECTOR_EXPRESSION}.length;

        if (turns.length === 0) {
          // Cloudflare can challenge the tab after the prompt is submitted, which
          // tears down the app shell; without this the poll spins until timeout.
          const pageText = document.body?.innerText || '';
          const botCheck =
            /security verification|verifying you are not a bot|needs to review the security/i.test(pageText);
          // An image-generation answer renders no prose turn at all, so completion
          // is keyed on the generated image instead.
          const status = generatingNow ? 'generating' : imageCount > 0 ? 'image-settling' : 'waiting';
          return JSON.stringify({ status, turns: 0, length: 0, imageCount, botCheck });
        }
        const last = turns[turns.length - 1];
        const text = (last.innerText || '').trim();
        // The previous turn's footer stays on the page, so scope the completion
        // check to the wrapper around this specific answer.
        const wrapper = last.closest(${wrapperSel});
        const footerDone = Boolean(wrapper && wrapper.querySelector(${footerSel}));
        return JSON.stringify({
          status: generatingNow ? 'generating' : footerDone ? 'settling' : 'streaming',
          turns: turns.length,
          length: text.length,
          imageCount,
          text,
        });
      })()`,
    );

    try {
      const parsed = JSON.parse(payload ?? "{}") as {
        status?: string;
        turns?: number;
        length?: number;
        text?: string;
        imageCount?: number;
        botCheck?: boolean;
      };
      const hasNewTurn = (parsed.turns ?? 0) > baselineTurns;

      // Recorded here but acted on outside the try, whose catch would otherwise
      // swallow the thrown error and leave the poll spinning.
      consecutiveBotChecks = parsed.botCheck && !hasNewTurn ? consecutiveBotChecks + 1 : 0;

      if (hasNewTurn && parsed.status === "settling") {
        if (parsed.length === previousLength) {
          stablePolls += 1;
        } else {
          stablePolls = 0;
        }
        previousLength = parsed.length ?? -1;
        if (stablePolls >= STABLE_POLLS_REQUIRED - 1 && (parsed.text ?? "").length > 0) {
          answerText = parsed.text ?? "";
          completed = true;
          break;
        }
      } else if (parsed.status === "image-settling") {
        // Image answers carry no prose, so settle on a steady image count.
        const imageCount = parsed.imageCount ?? 0;
        if (imageCount === previousImageCount) {
          stablePolls += 1;
        } else {
          stablePolls = 0;
        }
        previousImageCount = imageCount;
        if (stablePolls >= STABLE_POLLS_REQUIRED - 1 && imageCount > 0) {
          answerText = parsed.text ?? "";
          completed = true;
          break;
        }
      } else {
        stablePolls = 0;
        previousLength = parsed.length ?? -1;
      }

      const now = Date.now();
      if (now - lastLog > 15_000) {
        ctx.log?.(`[perplexity-web] Still generating... (${parsed.status ?? "unknown"})`);
        lastLog = now;
      }
    } catch {
      // Ignore transient parse failures while the page re-renders.
    }

    // Fail fast on a sustained challenge rather than burning the full timeout.
    if (consecutiveBotChecks >= BOT_CHECK_POLLS_BEFORE_FAILING) {
      throw new Error(
        "Perplexity showed a Cloudflare bot check after the prompt was submitted, so the answer could not be read. Open the Oracle Chrome window and complete the verification, then retry. Frequent automated runs make this more likely.",
      );
    }
    await ctx.delay(POLL_INTERVAL_MS);
  }

  // An image-only answer legitimately completes with empty text, so completion is
  // tracked separately from whether any prose was captured.
  if (!completed) {
    throw new Error(
      `Perplexity timed out waiting for a response (${Math.ceil(responseTimeoutMs / 1000)} seconds).`,
    );
  }
  return { text: answerText };
}

export interface PerplexitySource {
  title: string;
  url: string;
}

export interface PerplexityImage {
  url: string;
  width?: number;
  height?: number;
  alt?: string;
}

/**
 * Reads generated images from the answer. Perplexity generates images inline from
 * a descriptive prompt — there is no separate mode or button — and such answers
 * render no prose turn at all.
 */
export async function extractPerplexityImages(
  ctx: ProviderDomFlowContext,
): Promise<PerplexityImage[]> {
  const payload = await ctx.evaluate<string>(
    `JSON.stringify(${IMAGE_COLLECTOR_EXPRESSION}.slice(0, 10))`,
  );
  try {
    const parsed = JSON.parse(payload ?? "[]") as PerplexityImage[];
    return Array.isArray(parsed) ? parsed.filter((image) => Boolean(image?.url)) : [];
  } catch {
    return [];
  }
}

/**
 * Perplexity cites sources as inline anchors inside the answer body, and lists the
 * full set in the sources pane. Collect both and de-duplicate by URL.
 *
 * The pane is populated after the answer text settles — a Deep research answer can
 * finish with 3 inline citations and then fill in ~30 pane sources a beat later —
 * so poll briefly and keep the largest set rather than reading once.
 */
export async function extractPerplexitySources(
  ctx: ProviderDomFlowContext,
): Promise<PerplexitySource[]> {
  let best: PerplexitySource[] = [];

  for (let attempt = 0; attempt < SOURCE_POLL_ATTEMPTS; attempt += 1) {
    const found = await collectPerplexitySources(ctx);
    const grew = found.length > best.length;
    if (grew) {
      best = found;
    }
    // Stop once the set stops growing. An answer that cites nothing gets an extra
    // read before we accept the empty result, in case the pane is merely slow.
    const settled = !grew && (best.length > 0 ? attempt >= 1 : attempt >= 2);
    if (settled) {
      break;
    }
    if (attempt < SOURCE_POLL_ATTEMPTS - 1) {
      await ctx.delay(SOURCE_POLL_INTERVAL_MS);
    }
  }

  return best;
}

async function collectPerplexitySources(ctx: ProviderDomFlowContext): Promise<PerplexitySource[]> {
  const paneSel = asSelectorLiteral(PERPLEXITY_SELECTORS.contextPane);
  const turnSel = asSelectorLiteral(PERPLEXITY_SELECTORS.answerTurn);
  const payload = await ctx.evaluate<string>(
    `(() => {
      const scopes = [];
      const turns = Array.from(document.querySelectorAll(${turnSel}));
      if (turns.length > 0) scopes.push(turns[turns.length - 1]);
      const pane = document.querySelector(${paneSel});
      if (pane) scopes.push(pane);

      const seen = new Set();
      const sources = [];
      for (const scope of scopes) {
        for (const anchor of Array.from(scope.querySelectorAll('a[href^="http"]'))) {
          const url = anchor.href;
          if (!url || url.includes('perplexity.ai') || seen.has(url)) continue;
          seen.add(url);
          // Pane cards concatenate domain + title + description in textContent, so
          // prefer the card's dedicated title line and fall back progressively.
          const titleNode = anchor.querySelector(${asSelectorLiteral(PERPLEXITY_SELECTORS.sourceTitle)});
          const clean = (value) => (value || '').trim().replace(/\\s+/g, ' ');
          let title = clean(titleNode && titleNode.textContent).slice(0, 200);
          if (!title) {
            title = clean(anchor.textContent).slice(0, 120);
          }
          if (!title) {
            try { title = new URL(url).hostname; } catch { title = url; }
          }
          sources.push({ title, url });
        }
      }
      return JSON.stringify(sources.slice(0, 40));
    })()`,
  );
  try {
    const parsed = JSON.parse(payload ?? "[]") as PerplexitySource[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const perplexityDomProvider: ProviderDomAdapter = {
  providerName: "perplexity-web",
  waitForUi,
  selectMode,
  typePrompt,
  submitPrompt,
  waitForResponse,
};
