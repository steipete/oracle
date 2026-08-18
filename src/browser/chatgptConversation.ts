import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { SessionArtifact } from "../sessionManager.js";
import { resolveSessionArtifactsDir, resolveUniqueArtifactPath } from "./artifacts.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

/**
 * Provider-native conversation capture.
 *
 * Oracle's answer capture is a rendering of what ChatGPT displayed: copy-button
 * Markdown when it works, DOM text when it does not. Neither is the provider's
 * own record of the conversation, and for notation-heavy answers the difference
 * is not cosmetic — rendered KaTeX loses the LaTeX source it was rendered from.
 *
 * This module fetches ChatGPT's own conversation document from
 * `/backend-api/conversation/<id>` inside the authenticated page, so a caller can
 * hold the provider's bytes rather than a re-rendering of them.
 *
 * Two properties make the result usable as evidence rather than as a second
 * opinion:
 *
 *   A. The document is materialized verbatim — the page returns `response.text()`
 *      and those exact bytes are what gets written and hashed. Nothing is parsed
 *      and re-serialized on the way to disk.
 *   B. A second, independent fetch is normalized and hashed *in the page*, and
 *      only the digests come back. A Node-side mistake therefore cannot make B
 *      agree with A by construction, because Node never sees B's body.
 *
 * Document-level hashes of A and B are expected to differ: the backend document
 * carries volatile nested metadata that changes between fetches at identical byte
 * length and turn count. That is recorded, never gated. The per-turn comparison is
 * the load-bearing one.
 *
 * Capture is best-effort by design and must never gate an answer. `/backend-api/*`
 * sits behind bot mitigation that can return 403 to an in-page fetch while the
 * user is perfectly well logged in, so every failure is typed and reported rather
 * than thrown.
 */

export type ProviderNativeFailureReason =
  | "no-conversation-id"
  | "auth-session-unavailable"
  | "challenged"
  | "http-error"
  | "empty-document"
  | "evaluate-failed"
  | "digest-unavailable";

export interface ProviderNativeTurnDigest {
  /** Position among non-system turns, in conversation order. */
  index: number;
  role: string;
  contentType: string;
  /** UTF-8 byte length of the normalized turn body. */
  bytes: number;
  /** SHA-256 of the normalized turn body, as decimal bytes. */
  sha256Decimal: number[];
}

export interface ProviderNativeCaptureFailure {
  reason: ProviderNativeFailureReason;
  detail?: string;
  httpStatus?: number;
}

export interface ProviderNativeCapture {
  conversationId: string;
  /** Verbatim bytes of fetch A. */
  rawText: string;
  rawSha256: string;
  rawBytes: number;
  /** Digests derived in-page from the independent fetch B. */
  evidence: {
    documentSha256Decimal: number[];
    documentBytes: number;
    perTurn: ProviderNativeTurnDigest[];
    fetchedAt: string;
  } | null;
  evidenceFailure?: ProviderNativeCaptureFailure;
  /** Recorded, never gated: the backend document mutates between fetches. */
  documentHashesMatch: boolean | null;
}

export type ProviderNativeCaptureOutcome =
  | { status: "captured"; capture: ProviderNativeCapture }
  | { status: "unavailable"; failure: ProviderNativeCaptureFailure };

const STASH_KEY = "__oracleConversationCapture";
const DRAIN_CHUNK_CHARS = 500_000;
/**
 * Ceilings, not guesses about what Chrome will tolerate. A conversation document
 * is normally well under a megabyte; anything past this is a sign the fetch
 * returned something other than a conversation (a challenge page, an error body),
 * and draining it would spend minutes proving that.
 */
const MAX_DOCUMENT_CHARS = 64 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 120_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Canonical turn normalization, ported from the downstream proof-grade
 * normalizer so digests computed here are directly comparable to digests
 * recomputed there from the same bytes.
 *
 * The JSON fallback branches must reproduce Python's
 * `json.dumps(sort_keys=True, ensure_ascii=False)` exactly, which is why numbers
 * carry their source literal through the parse: JSON `1.0` and `1` both become
 * the JS number 1, but Python renders them `1.0` and `1`. A literal-aware parser
 * keeps that distinction, and `pyNumber` applies Python's float repr rules on top
 * (integral floats gain a trailing `.0`; exponent forms are left alone).
 */
function buildNormalizerSource(): string {
  return `
    const PY_INT = Symbol.for('oracle.pyInt');
    const PY_FLOAT = Symbol.for('oracle.pyFloat');
    // Literal-preserving JSON parse: numbers become boxed values that remember
    // whether the source literal was an integer or a float.
    const parseJsonPreservingNumbers = (text) => {
      let i = 0;
      const err = (msg) => { throw new Error(msg + ' at ' + i); };
      const ws = () => { while (i < text.length && ' \\t\\n\\r'.includes(text[i])) i += 1; };
      const parseValue = () => {
        ws();
        const ch = text[i];
        if (ch === '{') return parseObject();
        if (ch === '[') return parseArray();
        if (ch === '"') return parseString();
        if (ch === 't') { i += 4; return true; }
        if (ch === 'f') { i += 5; return false; }
        if (ch === 'n') { i += 4; return null; }
        return parseNumber();
      };
      const parseObject = () => {
        const out = {}; i += 1; ws();
        if (text[i] === '}') { i += 1; return out; }
        for (;;) {
          ws();
          if (text[i] !== '"') err('expected key');
          const key = parseString();
          ws();
          if (text[i] !== ':') err('expected colon');
          i += 1;
          out[key] = parseValue();
          ws();
          if (text[i] === ',') { i += 1; continue; }
          if (text[i] === '}') { i += 1; return out; }
          err('expected , or }');
        }
      };
      const parseArray = () => {
        const out = []; i += 1; ws();
        if (text[i] === ']') { i += 1; return out; }
        for (;;) {
          out.push(parseValue());
          ws();
          if (text[i] === ',') { i += 1; continue; }
          if (text[i] === ']') { i += 1; return out; }
          err('expected , or ]');
        }
      };
      const parseString = () => {
        const start = i; i += 1;
        while (i < text.length) {
          const ch = text[i];
          if (ch === '\\\\') { i += 2; continue; }
          if (ch === '"') { i += 1; return JSON.parse(text.slice(start, i)); }
          i += 1;
        }
        err('unterminated string');
      };
      const parseNumber = () => {
        const start = i;
        while (i < text.length && '-+.eE0123456789'.includes(text[i])) i += 1;
        const literal = text.slice(start, i);
        if (!literal) err('expected value');
        const value = Number(literal);
        const isFloat = /[.eE]/.test(literal);
        return { [isFloat ? PY_FLOAT : PY_INT]: true, value, literal };
      };
      const result = parseValue();
      return result;
    };
    const isBoxedNumber = (v) => v !== null && typeof v === 'object' && (v[PY_INT] === true || v[PY_FLOAT] === true);
    // Python repr for a float: shortest round-trip, but always visibly a float.
    const pyFloatRepr = (value) => {
      if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : (value < 0 ? '-Infinity' : 'NaN');
      const text = String(value);
      return /[.eEn]/.test(text) ? text : text + '.0';
    };
    const pyNumber = (boxed) => {
      if (boxed[PY_FLOAT] === true) return pyFloatRepr(boxed.value);
      // Python int repr; normalizes JSON's permitted "-0".
      return String(BigInt(boxed.literal));
    };
    // json.dumps(sort_keys=True, ensure_ascii=False): keys sorted by code unit,
    // ", " between items and ": " after keys.
    const pyDumps = (value) => {
      if (value === null) return 'null';
      if (value === true) return 'true';
      if (value === false) return 'false';
      if (isBoxedNumber(value)) return pyNumber(value);
      if (typeof value === 'string') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(pyDumps).join(', ') + ']';
      if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ': ' + pyDumps(value[k])).join(', ') + '}';
      }
      return 'null';
    };
    const plainString = (value) => (typeof value === 'string' ? value : '');
    // Content extraction, per content type.
    const contentText = (content) => {
      const contentType = typeof content?.content_type === 'string' ? content.content_type : 'text';
      if (contentType === 'text') {
        const parts = Array.isArray(content.parts) ? content.parts : [];
        return [contentType, parts.filter((p) => typeof p === 'string').join('\\n\\n')];
      }
      if (contentType === 'code' || contentType === 'execution_output') {
        return [contentType, plainString(content.text)];
      }
      if (contentType === 'thoughts') {
        const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
        const chunks = thoughts.map((thought) => {
          if (thought !== null && typeof thought === 'object' && !Array.isArray(thought) && !isBoxedNumber(thought)) {
            const inner = thought.content;
            return inner === undefined ? 'None' : pyStr(inner);
          }
          return pyStr(thought);
        });
        return [contentType, chunks.join('\\n\\n')];
      }
      if (contentType === 'reasoning_recap') {
        const inner = content.content;
        return [contentType, inner ? pyStr(inner) : ''];
      }
      if (contentType === 'multimodal_text') {
        const parts = Array.isArray(content.parts) ? content.parts : [];
        const chunks = parts.map((part) => (typeof part === 'string' ? part : pyDumps(part)));
        return [contentType, chunks.join('\\n\\n')];
      }
      return [contentType, pyDumps(content)];
    };
    // Python str() for the scalar cases the normalizer can reach.
    const pyStr = (value) => {
      if (typeof value === 'string') return value;
      if (value === null) return 'None';
      if (value === true) return 'True';
      if (value === false) return 'False';
      if (isBoxedNumber(value)) return pyNumber(value);
      return pyDumps(value);
    };
    // Conversation order: prefer the current-node chain, else the first root's
    // first-child chain.
    const nodeOrder = (document) => {
      const mapping = document.mapping;
      const current = document.current_node;
      if (typeof current === 'string' && mapping[current]) {
        const chain = [];
        const seen = new Set();
        let nodeId = current;
        while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
          seen.add(nodeId);
          chain.push(nodeId);
          nodeId = mapping[nodeId].parent;
        }
        return chain.reverse();
      }
      const roots = Object.keys(mapping).filter((key) => !mapping[key].parent);
      if (roots.length === 0) throw new Error('backend-api mapping has no root node');
      const order = [];
      const seen = new Set();
      let nodeId = roots[0];
      while (nodeId && !seen.has(nodeId)) {
        seen.add(nodeId);
        order.push(nodeId);
        const children = mapping[nodeId].children || [];
        nodeId = children.length > 0 ? children[0] : null;
      }
      return order;
    };
    const normalizeTurns = (document) => {
      if (!document || typeof document !== 'object' || !document.mapping) {
        throw new Error('backend-api JSON has no mapping');
      }
      const turns = [];
      for (const nodeId of nodeOrder(document)) {
        const node = document.mapping[nodeId];
        const message = node && node.message;
        if (!message) continue;
        const role = (message.author && typeof message.author.role === 'string') ? message.author.role : 'unknown';
        if (role === 'system') continue;
        const [contentType, body] = contentText(message.content || {});
        turns.push({ index: turns.length, role, contentType, body });
      }
      return turns;
    };
  `;
}

function buildAuthAndFetchSource(conversationId: string): string {
  return `
    const conversationId = ${JSON.stringify(conversationId)};
    // The conversation endpoint needs the bearer token that /api/auth/session
    // issues to the logged-in page. The token is used here and never returned.
    const fetchConversationText = async () => {
      const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
      if (!sessionResponse.ok) {
        return { ok: false, reason: 'auth-session-unavailable', httpStatus: sessionResponse.status };
      }
      const session = await sessionResponse.json().catch(() => null);
      const accessToken = session && typeof session.accessToken === 'string' ? session.accessToken : null;
      if (!accessToken) {
        return { ok: false, reason: 'auth-session-unavailable', detail: 'session carries no accessToken' };
      }
      const response = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId), {
        credentials: 'include',
        headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
      });
      if (!response.ok) {
        // Bot mitigation answers with an HTML challenge rather than JSON, and it
        // means "retry later from a human-looking page", not "you are logged out".
        const contentType = response.headers.get('content-type') || '';
        const challenged = response.status === 403 || contentType.includes('text/html');
        return {
          ok: false,
          reason: challenged ? 'challenged' : 'http-error',
          httpStatus: response.status,
        };
      }
      const text = await response.text();
      if (!text) return { ok: false, reason: 'empty-document' };
      return { ok: true, text };
    };
  `;
}

function buildFetchDocumentExpression(conversationId: string): string {
  return `(async () => {
    ${buildAuthAndFetchSource(conversationId)}
    const result = await fetchConversationText();
    if (!result.ok) return result;
    // Stashed rather than returned whole: a conversation document can be several
    // megabytes, and one oversized evaluate response is a worse failure mode than
    // a handful of bounded ones.
    globalThis[${JSON.stringify(STASH_KEY)}] = result.text;
    return { ok: true, length: result.text.length };
  })()`;
}

function buildDrainExpression(offset: number): string {
  return `(() => {
    const stash = globalThis[${JSON.stringify(STASH_KEY)}];
    if (typeof stash !== 'string') return null;
    return stash.slice(${offset}, ${offset + DRAIN_CHUNK_CHARS});
  })()`;
}

function buildReleaseExpression(): string {
  return `(() => { delete globalThis[${JSON.stringify(STASH_KEY)}]; return true; })()`;
}

/**
 * Normalize-and-digest, shared by the live evidence path and its test double.
 * `sourceExpression` must evaluate to `{ok:true,text}` or a typed failure.
 */
function buildDigestSource(sourceExpression: string): string {
  return `
    ${buildNormalizerSource()}
    if (!globalThis.crypto || !globalThis.crypto.subtle || typeof globalThis.crypto.subtle.digest !== 'function') {
      return { ok: false, reason: 'digest-unavailable' };
    }
    const result = await (${sourceExpression});
    if (!result.ok) return result;
    const encoder = new TextEncoder();
    const digestDecimal = async (value) => {
      const bytes = encoder.encode(value);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return { digest: Array.from(new Uint8Array(digest)), bytes: bytes.length };
    };
    let document;
    try {
      document = parseJsonPreservingNumbers(result.text);
    } catch (error) {
      return { ok: false, reason: 'evaluate-failed', detail: String(error && error.message ? error.message : error) };
    }
    let turns;
    try {
      turns = normalizeTurns(document);
    } catch (error) {
      return { ok: false, reason: 'evaluate-failed', detail: String(error && error.message ? error.message : error) };
    }
    const perTurn = [];
    for (const turn of turns) {
      const hashed = await digestDecimal(turn.body);
      perTurn.push({
        index: turn.index,
        role: turn.role,
        contentType: turn.contentType,
        bytes: hashed.bytes,
        sha256Decimal: hashed.digest,
      });
    }
    const documentDigest = await digestDecimal(result.text);
    return {
      ok: true,
      documentSha256Decimal: documentDigest.digest,
      documentBytes: documentDigest.bytes,
      perTurn,
      fetchedAt: new Date().toISOString(),
    };
  `;
}

/**
 * Fetch B: independent, normalized and hashed without leaving the page. Only
 * digests cross the boundary, so this cannot be an echo of fetch A.
 */
function buildEvidenceExpression(conversationId: string): string {
  return `(async () => {
    ${buildAuthAndFetchSource(conversationId)}
    ${buildDigestSource("fetchConversationText()")}
  })()`;
}

/**
 * The same normalization and hashing the page performs, over a caller-supplied
 * document instead of a fetched one. Exists so the normalizer can be checked
 * against the reference implementation it must agree with, without a browser.
 */
export function buildNormalizeAndDigestExpressionForTest(rawText: string): string {
  return `(async () => {
    ${buildDigestSource(`Promise.resolve({ ok: true, text: ${JSON.stringify(rawText)} })`)}
  })()`;
}

async function evaluateInPage<T>(
  Runtime: ChromeClient["Runtime"],
  expression: string,
  awaitPromise: boolean,
): Promise<T | null> {
  const evaluated = await withTimeout(
    Runtime.evaluate({ expression, awaitPromise, returnByValue: true }),
    CAPTURE_TIMEOUT_MS,
    "in-page evaluation",
  );
  const exception = (evaluated as { exceptionDetails?: { text?: string } }).exceptionDetails;
  if (exception) {
    throw new Error(exception.text ?? "in-page evaluation threw");
  }
  return (evaluated.result?.value ?? null) as T | null;
}

interface InPageFailure {
  ok: false;
  reason: ProviderNativeFailureReason;
  detail?: string;
  httpStatus?: number;
}

function toFailure(value: InPageFailure): ProviderNativeCaptureFailure {
  return { reason: value.reason, detail: value.detail, httpStatus: value.httpStatus };
}

export async function captureProviderNativeConversation(params: {
  Runtime: ChromeClient["Runtime"];
  conversationId: string | null | undefined;
  logger?: BrowserLogger;
}): Promise<ProviderNativeCaptureOutcome> {
  const { Runtime, logger } = params;
  const conversationId = params.conversationId?.trim();
  if (!conversationId) {
    return { status: "unavailable", failure: { reason: "no-conversation-id" } };
  }

  let head: ({ ok: true; length: number } | InPageFailure) | null;
  try {
    head = await evaluateInPage(Runtime, buildFetchDocumentExpression(conversationId), true);
  } catch (error) {
    return {
      status: "unavailable",
      failure: {
        reason: "evaluate-failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (!head) {
    return { status: "unavailable", failure: { reason: "evaluate-failed" } };
  }
  if (!head.ok) {
    return { status: "unavailable", failure: toFailure(head) };
  }
  if (head.length > MAX_DOCUMENT_CHARS) {
    await evaluateInPage(Runtime, buildReleaseExpression(), false).catch(() => null);
    return {
      status: "unavailable",
      failure: {
        reason: "http-error",
        detail: `document of ${head.length} chars exceeds the ${MAX_DOCUMENT_CHARS}-char capture ceiling`,
      },
    };
  }

  let rawText = "";
  try {
    while (rawText.length < head.length) {
      const chunk = await evaluateInPage<string>(
        Runtime,
        buildDrainExpression(rawText.length),
        false,
      );
      if (chunk === null || chunk === "") {
        break;
      }
      rawText += chunk;
    }
  } finally {
    await evaluateInPage(Runtime, buildReleaseExpression(), false).catch(() => null);
  }

  if (rawText.length !== head.length) {
    return {
      status: "unavailable",
      failure: {
        reason: "evaluate-failed",
        detail: `document drained ${rawText.length} of ${head.length} chars`,
      },
    };
  }

  const rawBuffer = Buffer.from(rawText, "utf8");
  const capture: ProviderNativeCapture = {
    conversationId,
    rawText,
    rawSha256: createHash("sha256").update(rawBuffer).digest("hex"),
    rawBytes: rawBuffer.byteLength,
    evidence: null,
    documentHashesMatch: null,
  };

  let evidence:
    | (
        | {
            ok: true;
            documentSha256Decimal: number[];
            documentBytes: number;
            perTurn: ProviderNativeTurnDigest[];
            fetchedAt: string;
          }
        | InPageFailure
      )
    | null;
  try {
    evidence = await evaluateInPage(Runtime, buildEvidenceExpression(conversationId), true);
  } catch (error) {
    evidence = {
      ok: false,
      reason: "evaluate-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (evidence && evidence.ok) {
    capture.evidence = {
      documentSha256Decimal: evidence.documentSha256Decimal,
      documentBytes: evidence.documentBytes,
      perTurn: evidence.perTurn,
      fetchedAt: evidence.fetchedAt,
    };
    const evidenceHex = Buffer.from(evidence.documentSha256Decimal).toString("hex");
    capture.documentHashesMatch = evidenceHex === capture.rawSha256;
    if (!capture.documentHashesMatch) {
      // Expected: the backend document carries volatile nested metadata. Logged
      // so it is visible, recorded so it is auditable, never treated as failure.
      logger?.(
        `[capture] provider document hash differs between fetches (expected: volatile metadata); per-turn digests are the comparison that counts`,
      );
    }
  } else if (evidence) {
    capture.evidenceFailure = toFailure(evidence);
  } else {
    capture.evidenceFailure = { reason: "evaluate-failed" };
  }

  return { status: "captured", capture };
}

/**
 * What a run records about its own provider-native capture: enough to know
 * whether proof-grade material exists and where, without carrying the material.
 */
/**
 * How the run's own captured answer compares to the provider's record of it.
 *
 * `matched` means the answer Oracle captured is byte-identical to one of the
 * turns the provider reports, verified against digests derived by the
 * independent second fetch. `divergent` means it is not — which is not a failed
 * run, but is a run whose transcript must not be treated as the provider's text.
 * Notation is where this bites: a markdown round-trip that renders `_s` as `*s`
 * or drops the escape in `\,` reads fine and is wrong.
 */
export type AnswerFidelity = "matched" | "divergent" | "unknown";

export interface ProviderNativeCaptureSummary {
  status: "captured" | "unavailable";
  /** Whether the run's captured answer matches the provider's own bytes. */
  answerFidelity?: AnswerFidelity;
  /** Which normalization of the captured answer matched, when one did. */
  answerMatch?: "exact" | "trimmed";
  conversationId?: string;
  rawSha256?: string;
  rawBytes?: number;
  turnCount?: number;
  /** Recorded, not gated — the backend document mutates between fetches. */
  documentHashesMatch?: boolean | null;
  failure?: ProviderNativeCaptureFailure;
  evidenceFailure?: ProviderNativeCaptureFailure;
  capturedAt?: string;
}

function decimalToHex(bytes: number[]): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Compares the run's captured answer against the provider's turns by digest.
 *
 * Deliberately a digest membership test rather than a second normalizer: the
 * digests come from the independent fetch, so a match is evidence the captured
 * answer is the provider's bytes, and no second implementation of the
 * normalization can drift away from the one that produced them.
 */
function compareAnswerToProviderTurns(
  answerMarkdown: string | undefined,
  perTurn: ProviderNativeTurnDigest[] | undefined,
): { fidelity: AnswerFidelity; match?: "exact" | "trimmed" } {
  if (!answerMarkdown || !perTurn || perTurn.length === 0) {
    return { fidelity: "unknown" };
  }
  const digests = new Set(perTurn.map((turn) => decimalToHex(turn.sha256Decimal)));
  const exact = createHash("sha256").update(Buffer.from(answerMarkdown, "utf8")).digest("hex");
  if (digests.has(exact)) {
    return { fidelity: "matched", match: "exact" };
  }
  // Transcript writers trim; a trailing newline is not a fidelity failure.
  const trimmed = createHash("sha256")
    .update(Buffer.from(answerMarkdown.trim(), "utf8"))
    .digest("hex");
  if (digests.has(trimmed)) {
    return { fidelity: "matched", match: "trimmed" };
  }
  return { fidelity: "divergent" };
}

/**
 * Captures the provider's own conversation document and writes it beside the
 * run's other artifacts, along with the independently-derived digests.
 *
 * Two files rather than one, because they answer different questions and a
 * downstream verifier must be able to tell them apart: the raw document is the
 * material, the evidence file is the independent observation of it. Merging them
 * would make the evidence self-certifying.
 *
 * Never throws. A run whose capture failed is still a run whose answer is
 * perfectly good — it simply is not proof-grade, and says so.
 */
export async function finalizeProviderNativeCapture(params: {
  Runtime: ChromeClient["Runtime"];
  conversationId: string | null | undefined;
  conversationUrl?: string | null;
  sessionId?: string;
  /** The answer this run captured, for comparison against the provider's record. */
  answerMarkdown?: string;
  logger?: BrowserLogger;
}): Promise<{ summary: ProviderNativeCaptureSummary; artifacts: SessionArtifact[] }> {
  const { logger } = params;
  let outcome: ProviderNativeCaptureOutcome;
  try {
    outcome = await captureProviderNativeConversation({
      Runtime: params.Runtime,
      conversationId: params.conversationId,
      logger,
    });
  } catch (error) {
    return {
      summary: {
        status: "unavailable",
        failure: {
          reason: "evaluate-failed",
          detail: error instanceof Error ? error.message : String(error),
        },
      },
      artifacts: [],
    };
  }

  if (outcome.status === "unavailable") {
    if (outcome.failure.reason !== "no-conversation-id") {
      logger?.(
        `[capture] Provider-native conversation capture unavailable (${outcome.failure.reason}); the answer is unaffected.`,
      );
    }
    return { summary: { status: "unavailable", failure: outcome.failure }, artifacts: [] };
  }

  const capture = outcome.capture;
  const capturedAt = new Date().toISOString();
  const { fidelity, match } = compareAnswerToProviderTurns(
    params.answerMarkdown,
    capture.evidence?.perTurn,
  );
  if (fidelity === "divergent") {
    logger?.(
      "[capture] The captured answer does not match any provider turn byte-for-byte; treat this transcript as a rendering, not as the provider's text.",
    );
  }
  const summary: ProviderNativeCaptureSummary = {
    status: "captured",
    answerFidelity: fidelity,
    answerMatch: match,
    conversationId: capture.conversationId,
    rawSha256: capture.rawSha256,
    rawBytes: capture.rawBytes,
    turnCount: capture.evidence?.perTurn.length,
    documentHashesMatch: capture.documentHashesMatch,
    evidenceFailure: capture.evidenceFailure,
    capturedAt,
  };

  if (!params.sessionId) {
    return { summary, artifacts: [] };
  }

  const artifacts: SessionArtifact[] = [];
  try {
    const dir = resolveSessionArtifactsDir(params.sessionId);
    await mkdir(dir, { recursive: true });

    const rawPath = await resolveUniqueArtifactPath(
      path.join(dir, `conversation-${capture.conversationId}-raw.json`),
    );
    // Written from the same string that was hashed, so the file on disk is the
    // thing the digest describes.
    await writeFile(rawPath, capture.rawText, "utf8");
    artifacts.push({
      kind: "file",
      path: rawPath,
      label: "provider-native-conversation-raw",
      mimeType: "application/json",
      sizeBytes: capture.rawBytes,
      sha256: capture.rawSha256,
      sourceUrl: params.conversationUrl ?? undefined,
    });

    if (capture.evidence) {
      const evidenceDocument = {
        schema: "oracle.provider-native-capture-evidence/v1",
        conversation_id: capture.conversationId,
        chatgpt_url: params.conversationUrl ?? null,
        captured_at: capturedAt,
        fetched_at: capture.evidence.fetchedAt,
        raw_backend_api_json: {
          // False by construction: this file describes the SECOND fetch, whose
          // body never left the page. The first fetch is the one on disk.
          materialized_to_disk: false,
          sha256_decimal_bytes: capture.evidence.documentSha256Decimal,
          bytes: capture.evidence.documentBytes,
        },
        materialized_document: {
          path: path.basename(rawPath),
          sha256: capture.rawSha256,
          bytes: capture.rawBytes,
        },
        document_hashes_match: capture.documentHashesMatch,
        answer_fidelity: fidelity,
        answer_match: match ?? null,
        per_turn: capture.evidence.perTurn.map((turn) => ({
          i: turn.index,
          role: turn.role,
          ct: turn.contentType,
          blen: turn.bytes,
          sha256_dec: turn.sha256Decimal,
          sha256_hex: decimalToHex(turn.sha256Decimal),
        })),
      };
      const evidencePath = await resolveUniqueArtifactPath(
        path.join(dir, `conversation-${capture.conversationId}-evidence.json`),
      );
      const serialized = `${JSON.stringify(evidenceDocument, null, 2)}\n`;
      await writeFile(evidencePath, serialized, "utf8");
      artifacts.push({
        kind: "file",
        path: evidencePath,
        label: "provider-native-conversation-evidence",
        mimeType: "application/json",
        sizeBytes: Buffer.byteLength(serialized, "utf8"),
        sha256: createHash("sha256").update(serialized).digest("hex"),
      });
    }
    logger?.(
      `[capture] Provider-native conversation captured: ${capture.rawBytes} bytes, ${
        capture.evidence?.perTurn.length ?? 0
      } turns independently hashed.`,
    );
  } catch (error) {
    logger?.(
      `[capture] Provider-native conversation captured but could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { summary, artifacts };
}
