import { createHash } from "node:crypto";
import { connectToExistingChatGptTab } from "./liveTabs.js";
import { extractStableConversationIdFromUrl } from "./conversationUrl.js";
import { delay } from "./utils.js";

export type ConversationRole = "user" | "assistant";

/** api engine only: one visible assistant content block within a turn. */
export interface ConversationSegment {
  messageId: string;
  contentType: string;
  text?: string;
  model?: string;
  createTime?: string;
  /** Non-text parts (e.g. an image) attached to this specific segment's message. */
  attachments?: ConversationAttachment[];
}

/** api engine only: a non-text part (e.g. an image) copied from backend-api content.parts. */
export interface ConversationAttachment {
  content_type?: string;
  asset_pointer?: string;
  size_bytes?: number;
  width?: number;
  height?: number;
}

/** A DOM-order record. `parentId`/`branchId` are evidence only: never infer pairs. */
export interface ConversationRecord {
  ordinal: number;
  role: ConversationRole;
  text?: string;
  /** Assistant only: markdown reconstructed from the live `.markdown` DOM (line breaks preserved). */
  markdown?: string;
  textHash: string;
  messageId?: string;
  turnId?: string;
  parentId?: string;
  branchId?: string;
  exchangeId?: string;
  domId?: string;
  domTestId?: string;
  /** Parsed from `data-testid="conversation-turn-N"` when present; drives completeness/order. */
  turnIndex?: number;
  html?: string;
  /** api engine only: every backend-api message id folded into this turn record. */
  messageIds?: string[];
  /** api engine only: visible assistant content blocks within this turn (text/multimodal/canvas). */
  segments?: ConversationSegment[];
  /** api engine only: `role:content_type[:recipient]` labels for skipped nodes (thoughts, tool calls, ...). */
  hiddenNodes?: string[];
  /** api engine only: non-text parts (images, ...) attached to this turn's message(s). */
  attachments?: ConversationAttachment[];
  /** api engine only: ISO-8601 UTC create_time of the turn's first message. */
  createTime?: string;
  /** api engine only: model_slug of the first visible assistant segment. */
  model?: string;
}

export interface ConversationExport {
  version: 1 | 2;
  /** Which exporter produced this: `api` (backend-api, default) or `dom` (legacy virtualized crawl). */
  engine?: "api" | "dom";
  source: { url: string; conversationId?: string; targetId: string; exportedAt: string };
  /** api engine only: conversation-level metadata from the backend-api body. */
  conversation?: {
    title?: string;
    createTime?: string;
    updateTime?: string;
    defaultModelSlug?: string;
    gizmoId?: string;
    nodeCount: number;
    branchNodesSkipped: number;
  };
  records: ConversationRecord[];
  fingerprint: string;
  /** false means the crawl never reached a settled bottom, or a turnIndex gap remains. Always true for the api engine. */
  complete: boolean;
  /**
   * Gaps in the observed turnIndex range (min..max) after the crawl settled.
   * Present (possibly empty) only when at least one record carried a
   * turnIndex; absent when completeness could not be gap-checked at all.
   * Always `[]` for the api engine.
   */
  missingTurnIndices?: number[];
  /** api engine only, when `includeRaw` was requested: the untouched backend-api response body. */
  raw?: unknown;
}

export interface ExportConversationOptions {
  host?: string;
  port?: number;
  ref?: string;
  /** Do not return message text; hashes and browser provenance remain. */
  redactText?: boolean;
  maxPasses?: number;
  stablePasses?: number;
  /** Test-only DI: override how the ChatGPT tab is attached to. */
  connect?: typeof connectToExistingChatGptTab;
  /** `api` (default): read the canonical backend-api conversation. `dom`: legacy virtualized DOM crawl. */
  engine?: "api" | "dom";
  /** api engine only: attach the untouched backend-api response body as `raw`. */
  includeRaw?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Stable testids/role attributes are primary. The outer article fallback is
 * deliberately guarded so project/workspace shell content cannot become turns.
 */
export function buildConversationExportExpression(expectedConversationId?: string): string {
  return `(() => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId ?? "")};
    const actualConversationId = location.pathname.match(/\\/c\\/([a-zA-Z0-9-]+)(?=[/?#]|$)/)?.[1] || '';
    if (!expectedConversationId || actualConversationId !== expectedConversationId) {
      return { scopeMismatch: true, url: location.href, records: [] };
    }
    const BACKTICK = String.fromCharCode(96);
    const FENCE = BACKTICK + BACKTICK + BACKTICK;
    const normalize = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
    const serializeMarkdown = (root) => {
      const walk = (node, ctx) => {
        if (node.nodeType === 3) return node.textContent || '';
        if (node.nodeType !== 1) return '';
        const tag = node.tagName.toLowerCase();
        const children = () => Array.from(node.childNodes).map((child) => walk(child, ctx)).join('');
        if (tag === 'br') return '\\n';
        if (tag === 'p') return children().trim() + '\\n\\n';
        if (/^h[1-6]$/.test(tag)) {
          const level = Number(tag.slice(1));
          return '#'.repeat(level) + ' ' + children().trim() + '\\n\\n';
        }
        if (tag === 'strong' || tag === 'b') return '**' + children() + '**';
        if (tag === 'em' || tag === 'i') return '*' + children() + '*';
        if (tag === 'a') {
          const href = node.getAttribute('href') || '';
          return '[' + children() + '](' + href + ')';
        }
        if (tag === 'hr') return '\\n---\\n\\n';
        if (tag === 'blockquote') {
          const inner = children().trim();
          return inner.split('\\n').map((line) => '> ' + line).join('\\n') + '\\n\\n';
        }
        if (tag === 'code') {
          if (node.closest && node.closest('pre')) return node.textContent || '';
          return BACKTICK + (node.textContent || '') + BACKTICK;
        }
        if (tag === 'pre') {
          const codeEl = node.querySelector ? node.querySelector('code') : null;
          const langMatch = codeEl && codeEl.className ? codeEl.className.match(/language-(\\S+)/) : null;
          const lang = langMatch ? langMatch[1] : '';
          const code = (codeEl ? codeEl.textContent : node.textContent) || '';
          return FENCE + lang + '\\n' + code.replace(/\\n+$/, '') + '\\n' + FENCE + '\\n\\n';
        }
        if (tag === 'ul' || tag === 'ol') {
          ctx.listStack.push({ type: tag, index: 0 });
          const items = Array.from(node.children || []).filter((child) => child.tagName && child.tagName.toLowerCase() === 'li');
          const out = items.map((item) => walk(item, ctx)).join('');
          ctx.listStack.pop();
          return out + (ctx.listStack.length === 0 ? '\\n' : '');
        }
        if (tag === 'li') {
          const depth = Math.max(ctx.listStack.length - 1, 0);
          const indent = '  '.repeat(depth);
          const top = ctx.listStack[ctx.listStack.length - 1];
          if (top) top.index += 1;
          const marker = top && top.type === 'ol' ? top.index + '. ' : '- ';
          let inline = '';
          let nested = '';
          for (const child of Array.from(node.childNodes)) {
            const isNestedList = child.nodeType === 1 && /^(ul|ol)$/i.test(child.tagName);
            if (isNestedList) nested += walk(child, ctx);
            else inline += walk(child, ctx);
          }
          inline = inline.trim();
          let body = indent + marker + inline.split('\\n').join('\\n' + indent + '  ') + '\\n';
          if (nested) body += nested;
          return body;
        }
        if (tag === 'table') {
          const rows = Array.from(node.querySelectorAll ? node.querySelectorAll('tr') : []);
          if (!rows.length) return '';
          const cellText = (cell) => walk(cell, ctx).trim().replace(/\\n+/g, ' ');
          const rowCells = (row) => Array.from(row.children || []).map(cellText);
          const header = rowCells(rows[0]);
          let out = '| ' + header.join(' | ') + ' |\\n';
          out += '| ' + header.map(() => '---').join(' | ') + ' |\\n';
          for (const row of rows.slice(1)) {
            out += '| ' + rowCells(row).join(' | ') + ' |\\n';
          }
          return out + '\\n';
        }
        return children();
      };
      const raw = walk(root, { listStack: [] });
      return raw.replace(/\\n{3,}/g, '\\n\\n').trim();
    };
    const transcript = document.querySelector('main, [role="main"]') || document.body;
    const candidates = Array.from(transcript.querySelectorAll(
      '[data-message-author-role], [data-turn], article[data-testid^="conversation-turn"]'
    ));
    const seen = new Set();
    const records = [];
    for (const node of candidates) {
      const nested = node.querySelector?.('[data-message-author-role], [data-turn]');
      const role = normalize(node.getAttribute?.('data-message-author-role') || node.getAttribute?.('data-turn') || nested?.getAttribute?.('data-message-author-role') || nested?.getAttribute?.('data-turn')).toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      const owner = node.closest?.('[data-testid^="conversation-turn"]') || node;
      if (seen.has(owner)) continue;
      seen.add(owner);
      const source = node.matches?.('[data-message-author-role], [data-turn]') ? node : nested || node;
      const copy = source.cloneNode?.(true);
      copy?.querySelectorAll?.('[data-testid="collapsible-user-message-toggle"], button[data-testid*="toggle" i], [data-testid*="turn-action" i], .sr-only, [class*="sr-only"]').forEach((control) => control.remove());
      const domTestId = owner.getAttribute?.('data-testid') || undefined;
      const turnIndexMatch = typeof domTestId === 'string' ? domTestId.match(/conversation-turn-(\\d+)/) : null;
      const turnIndex = turnIndexMatch ? Number(turnIndexMatch[1]) : undefined;
      const markdownRoot = role === 'assistant' ? copy?.querySelector?.('.markdown') : null;
      const textSource = markdownRoot || copy;
      const text = String(textSource?.innerText ?? textSource?.textContent ?? source.innerText ?? source.textContent ?? '').trim();
      if (!text && turnIndex === undefined) continue;
      const markdown = markdownRoot ? serializeMarkdown(markdownRoot) : '';
      records.push({
        role,
        text,
        markdown: markdown || undefined,
        messageId: owner.getAttribute?.('data-message-id') || source.getAttribute?.('data-message-id') || undefined,
        turnId: owner.getAttribute?.('data-turn-id') || source.getAttribute?.('data-turn-id') || undefined,
        parentId: owner.getAttribute?.('data-parent-message-id') || source.getAttribute?.('data-parent-message-id') || undefined,
        branchId: owner.getAttribute?.('data-branch-id') || source.getAttribute?.('data-branch-id') || undefined,
        exchangeId: owner.getAttribute?.('data-turn-exchange-id') || source.getAttribute?.('data-turn-exchange-id') || undefined,
        domId: owner.id || undefined,
        domTestId,
        turnIndex,
        html: role === 'assistant' ? source.querySelector?.('.markdown')?.innerHTML || undefined : undefined,
      });
    }
    return { scopeMismatch: false, url: location.href, records };
  })()`;
}

/** Resolves once the transcript container has been quiet for 120ms, capped at 1500ms total. */
function buildDomQuietWaitExpression(): string {
  return `(() => new Promise((resolve) => {
    try {
      const container = document.querySelector('main, [role="main"]') || document.body;
      let settled = false;
      let quietTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(hardCapTimer);
        resolve(undefined);
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 120);
      });
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      quietTimer = setTimeout(finish, 120);
      const hardCapTimer = setTimeout(finish, 1500);
    } catch (error) {
      setTimeout(resolve, 150);
    }
  }))()`;
}

interface ScrollAdvanceResult {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  bottomReached: boolean;
}

/**
 * Scrolls every scrollable node one step and reports the tallest scrollable
 * node's post-scroll metrics, so the crawl loop can detect the real bottom
 * (`scrollTop + clientHeight >= scrollHeight - 2`) instead of trusting a
 * repeated-viewport fingerprint match, which virtualized transcripts can
 * satisfy without ever reaching the end. `step` in pixels overrides the
 * default full-`clientHeight` stride for the finer repair-sweep pass.
 */
function buildScrollAdvanceExpression(resetToTop: boolean, step?: number): string {
  const stepExpr = step !== undefined ? String(Math.max(step, 1)) : "node.clientHeight";
  return `(() => {
    const nodes = [document.scrollingElement, ...document.querySelectorAll('*')];
    let best = null;
    for (const node of nodes) {
      if (!node || node.scrollHeight <= node.clientHeight) continue;
      if (node === document.scrollingElement || /(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
        if (!best || node.scrollHeight > best.scrollHeight) best = node;
        node.scrollTop = ${resetToTop} ? 0 : Math.min(node.scrollHeight, node.scrollTop + (${stepExpr}));
      }
    }
    if (!best) return { scrollHeight: 0, clientHeight: 0, scrollTop: 0, bottomReached: true };
    return {
      scrollHeight: best.scrollHeight,
      clientHeight: best.clientHeight,
      scrollTop: best.scrollTop,
      bottomReached: best.scrollTop + best.clientHeight >= best.scrollHeight - 2,
    };
  })()`;
}

type MergeableRecord = Omit<ConversationRecord, "ordinal" | "textHash">;

/**
 * Dedupes by messageId/turnId, falling back to role+text (or role+turnIndex+text
 * when a turnIndex is known, so two same-role empty-text records at different
 * turns — e.g. thinking-only turns with no visible copy — don't collide).
 * Keeps the first-seen (earliest DOM-order) copy.
 */
export function mergeConversationRecords(
  merged: Map<string, MergeableRecord>,
  records: MergeableRecord[],
): void {
  for (const record of records) {
    const key =
      record.messageId ??
      record.turnId ??
      (record.turnIndex !== undefined
        ? `${record.role}:${record.turnIndex}:${record.text}`
        : `${record.role}:${record.text}`);
    if (!merged.has(key)) merged.set(key, record);
  }
}

/**
 * Live ChatGPT tab URLs commonly carry a project prefix (e.g.
 * `/g/g-p-.../c/<id>`), while a user-supplied `ref` is often the bare
 * `https://chatgpt.com/c/<id>` URL shown in the address bar history. Reduce
 * any URL-shaped ref down to its stable conversation id so tab matching
 * isn't defeated by a prefix mismatch; pass non-URL refs (targetId, title
 * substrings) through unchanged.
 */
export function normalizeConversationRef(ref: string | undefined): string | undefined {
  if (!ref) return ref;
  return extractStableConversationIdFromUrl(ref) ?? ref;
}

export interface CompletenessResult {
  complete: boolean;
  missingTurnIndices?: number[];
}

/**
 * Fail-closed completeness check for a merged record set.
 *
 * When at least one record carries a `turnIndex`, completeness additionally
 * requires the observed turnIndex set to be gap-free across its own
 * min..max range (a repeated-viewport crawl can go "stable" while a whole
 * mid-conversation block was never scraped, e.g. turns 1,2,68-72 with 3-67
 * missing). `missingTurnIndices` is always present (possibly empty) in that
 * case. When no record carries a turnIndex (older ChatGPT UI), this falls
 * back to `crawlSettled` alone and leaves `missingTurnIndices` undefined so
 * callers can tell "gap-checked" apart from "unchecked".
 */
export function evaluateCompleteness(
  records: MergeableRecord[],
  crawlSettled: boolean,
): CompletenessResult {
  const turnIndices = records
    .map((record) => record.turnIndex)
    .filter((value): value is number => typeof value === "number");
  if (turnIndices.length === 0) {
    return { complete: crawlSettled };
  }
  const min = Math.min(...turnIndices);
  const max = Math.max(...turnIndices);
  const observed = new Set(turnIndices);
  const missingTurnIndices: number[] = [];
  for (let index = min; index <= max; index += 1) {
    if (!observed.has(index)) missingTurnIndices.push(index);
  }
  return { complete: crawlSettled && missingTurnIndices.length === 0, missingTurnIndices };
}

/**
 * Final record order: turnIndex ascending; records without a turnIndex keep
 * their merge (DOM-discovery) order, appended after the indexed ones.
 */
export function sortConversationRecords(records: MergeableRecord[]): MergeableRecord[] {
  const indexed: MergeableRecord[] = [];
  const unindexed: MergeableRecord[] = [];
  for (const record of records) {
    if (typeof record.turnIndex === "number") indexed.push(record);
    else unindexed.push(record);
  }
  indexed.sort((a, b) => (a.turnIndex as number) - (b.turnIndex as number));
  return [...indexed, ...unindexed];
}

/**
 * Dispatches to the backend-api engine (default) or the legacy DOM crawl.
 * The api engine is dynamically imported so the two engines stay decoupled
 * at module-load time (conversationApiExport.ts imports types from this
 * module, but never a value from it, at runtime).
 */
export async function exportChatGptConversation(
  options: ExportConversationOptions = {},
): Promise<ConversationExport> {
  if ((options.engine ?? "api") === "dom") {
    return exportChatGptConversationViaDom(options);
  }
  const { exportChatGptConversationViaApi } = await import("./conversationApiExport.js");
  return exportChatGptConversationViaApi(options);
}

/** Legacy engine: virtualized-scroll DOM crawl. Kept for `--engine dom` and for its own test coverage. */
export async function exportChatGptConversationViaDom(
  options: ExportConversationOptions = {},
): Promise<ConversationExport> {
  const connect = options.connect ?? connectToExistingChatGptTab;
  const { client, targetId, tab } = await connect({
    ...options,
    ref: normalizeConversationRef(options.ref),
  });
  try {
    const { Runtime } = client;
    const expectedConversationId = extractStableConversationIdFromUrl(tab.url);
    if (!expectedConversationId) {
      throw new Error("Conversation export requires a stable ChatGPT /c/<id> URL.");
    }
    const stablePasses = options.stablePasses ?? 2;
    const merged = new Map<string, MergeableRecord>();
    await Runtime.evaluate({
      expression: `(() => { window.__oracleConversationScroll = [document.scrollingElement, ...document.querySelectorAll('*')].filter((node) => node && node.scrollHeight > node.clientHeight).map((node) => ({ node, top: node.scrollTop })); })()`,
      awaitPromise: true,
    });

    let result: { scopeMismatch?: boolean; url?: string; records?: MergeableRecord[] } | undefined;

    const scrapeOnce = async (): Promise<MergeableRecord[]> => {
      await Runtime.evaluate({
        expression: buildDomQuietWaitExpression(),
        awaitPromise: true,
      }).catch(() => delay(150));
      const evaluation = await Runtime.evaluate({
        expression: buildConversationExportExpression(expectedConversationId),
        returnByValue: true,
        awaitPromise: true,
      });
      result = evaluation.result?.value as typeof result;
      if (result?.scopeMismatch) {
        throw new Error("ChatGPT conversation scope changed while exporting.");
      }
      if (!result?.records?.length) {
        throw new Error("No ChatGPT conversation records found in the active transcript.");
      }
      return result.records;
    };

    let latestScrollHeight = 0;
    let latestClientHeight = 0;
    let bottomReached = false;
    let noNewStableCount = 0;
    let pass = 0;
    for (;;) {
      const scrollEval = await Runtime.evaluate({
        expression: buildScrollAdvanceExpression(pass === 0),
        returnByValue: true,
        awaitPromise: true,
      });
      const scrollInfo = scrollEval.result?.value as Partial<ScrollAdvanceResult> | undefined;
      if (typeof scrollInfo?.scrollHeight === "number")
        latestScrollHeight = scrollInfo.scrollHeight;
      if (typeof scrollInfo?.clientHeight === "number")
        latestClientHeight = scrollInfo.clientHeight;
      bottomReached = Boolean(scrollInfo?.bottomReached);

      const records = await scrapeOnce();
      const sizeBefore = merged.size;
      mergeConversationRecords(merged, records);
      noNewStableCount = merged.size === sizeBefore ? noNewStableCount + 1 : 0;

      pass += 1;
      const scaledPasses =
        latestClientHeight > 0 ? Math.ceil(latestScrollHeight / latestClientHeight) + 4 : 0;
      const effectiveMaxPasses = Math.min(Math.max(options.maxPasses ?? 12, scaledPasses), 200);
      const crawlDone = bottomReached && noNewStableCount >= stablePasses;
      if (crawlDone || pass >= effectiveMaxPasses) break;
    }
    const crawlSettled = bottomReached && noNewStableCount >= stablePasses;

    let completeness = evaluateCompleteness(Array.from(merged.values()), crawlSettled);
    if (bottomReached) {
      for (
        let attempt = 0;
        attempt < 2 && (completeness.missingTurnIndices?.length ?? 0) > 0;
        attempt += 1
      ) {
        const stepPixels = Math.max(Math.floor(latestClientHeight / 2), 1);
        let sweepBottomReached = latestClientHeight <= 0;
        let resetDone = false;
        let steps = 0;
        while (!sweepBottomReached && steps < 200) {
          const stepEval = await Runtime.evaluate({
            expression: buildScrollAdvanceExpression(
              !resetDone,
              resetDone ? stepPixels : undefined,
            ),
            returnByValue: true,
            awaitPromise: true,
          });
          resetDone = true;
          const stepInfo = stepEval.result?.value as Partial<ScrollAdvanceResult> | undefined;
          sweepBottomReached = Boolean(stepInfo?.bottomReached);
          const records = await scrapeOnce();
          mergeConversationRecords(merged, records);
          steps += 1;
        }
        completeness = evaluateCompleteness(Array.from(merged.values()), crawlSettled);
      }
    }

    const sorted = sortConversationRecords(Array.from(merged.values()));
    const records = sorted.map((record, ordinal) => {
      const text = String(record.text ?? "");
      return {
        ...record,
        ordinal,
        ...(options.redactText
          ? { text: undefined, markdown: undefined, html: undefined }
          : { text }),
        textHash: sha256(text),
      };
    });
    const provenance = records.map((record) => {
      const { text: _text, markdown: _markdown, html: _html, ...metadata } = record;
      return metadata;
    });
    return {
      version: 1,
      engine: "dom",
      source: {
        url: String(result?.url ?? tab.url),
        conversationId: expectedConversationId,
        targetId,
        exportedAt: new Date().toISOString(),
      },
      records,
      fingerprint: sha256(JSON.stringify(provenance)),
      complete: completeness.complete,
      ...(completeness.missingTurnIndices
        ? { missingTurnIndices: completeness.missingTurnIndices }
        : {}),
    };
  } finally {
    await client.Runtime?.evaluate?.({
      expression: `(() => { for (const entry of window.__oracleConversationScroll || []) entry.node.scrollTop = entry.top; delete window.__oracleConversationScroll; })()`,
      awaitPromise: true,
    }).catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
