import { createHash } from "node:crypto";
import { connectToExistingChatGptTab } from "./liveTabs.js";
import { extractStableConversationIdFromUrl } from "./conversationUrl.js";
import { normalizeConversationRef } from "./conversationExport.js";
import type {
  ConversationAttachment,
  ConversationExport,
  ConversationRecord,
  ConversationSegment,
} from "./conversationExport.js";

const CHATGPT_HOSTNAME_RE = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/;

/** Message id -> mapping node, as returned by GET /backend-api/conversation/<id>. */
export interface ChatGptMappingNode {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: ChatGptMessage | null;
}

export interface ChatGptMessage {
  id: string;
  author: { role: string; name?: string | null };
  create_time?: number | null;
  recipient?: string;
  status?: string;
  content: {
    content_type: string;
    parts?: Array<string | Record<string, unknown>>;
    text?: string;
    language?: string;
  };
  metadata?: {
    model_slug?: string;
    is_visually_hidden_from_conversation?: boolean;
    [key: string]: unknown;
  } | null;
}

export interface ChatGptConversationBody {
  title?: string;
  create_time?: number;
  update_time?: number;
  conversation_id?: string;
  current_node?: string;
  mapping: Record<string, ChatGptMappingNode>;
  default_model_slug?: string;
  gizmo_id?: string;
  [key: string]: unknown;
}

export type ApiConversationFetchResult =
  | { ok: true; status: number; body: ChatGptConversationBody }
  | { ok: false; status: number; statusText?: string; bodySnippet?: string; reason?: string }
  | { ok: false; status: -1; reason: "no_access_token" | "wrong_origin" | string };

export interface ApiConversationRecord extends ConversationRecord {
  turnIndex: number;
  turnId: string;
  messageIds: string[];
  hiddenNodes: string[];
  text: string;
}

export interface BuildRecordsResult {
  records: ApiConversationRecord[];
  turns: number;
  branchNodesSkipped: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function epochToIso(seconds: number | null | undefined): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Read-only, GET-only fetch expression: the ChatGPT session cookie/token
 * (never navigation, clicks, or writes) authorizes a direct backend-api
 * conversation read. Guarded to only run on a chatgpt.com / chat.openai.com
 * origin so it cannot be mistakenly evaluated against an unrelated tab.
 */
export function buildConversationApiFetchExpression(conversationId: string): string {
  const conversationIdLiteral = JSON.stringify(conversationId);
  return `(async () => {
    try {
      if (!${CHATGPT_HOSTNAME_RE.toString()}.test(location.hostname)) {
        return { ok: false, status: -1, reason: 'wrong_origin' };
      }
      const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
      if (!sessionRes.ok) {
        const bodySnippet = await sessionRes.text().then((t) => t.slice(0, 500)).catch(() => '');
        return { ok: false, status: sessionRes.status, statusText: sessionRes.statusText, bodySnippet };
      }
      const session = await sessionRes.json().catch(() => null);
      const accessToken = session && session.accessToken;
      if (!accessToken) {
        return { ok: false, status: -1, reason: 'no_access_token' };
      }
      const conversationId = ${conversationIdLiteral};
      const convRes = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId), {
        credentials: 'include',
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      if (!convRes.ok) {
        const bodySnippet = await convRes.text().then((t) => t.slice(0, 500)).catch(() => '');
        return { ok: false, status: convRes.status, statusText: convRes.statusText, bodySnippet };
      }
      const body = await convRes.json();
      return { ok: true, status: convRes.status, body };
    } catch (error) {
      return { ok: false, status: -1, reason: String((error && error.message) || error) };
    }
  })()`;
}

function isVisibleAssistantContent(message: ChatGptMessage): boolean {
  const contentType = message.content?.content_type;
  if (contentType !== "text" && contentType !== "multimodal_text") return false;
  return !message.metadata?.is_visually_hidden_from_conversation;
}

function isCanvasDocument(message: ChatGptMessage): boolean {
  return (
    message.content?.content_type === "code" && Boolean(message.recipient?.startsWith("canmore"))
  );
}

function joinStringParts(parts: Array<string | Record<string, unknown>> | undefined): string {
  if (!parts) return "";
  return parts.filter((part): part is string => typeof part === "string").join("\n\n");
}

function extractAttachments(message: ChatGptMessage): ConversationAttachment[] {
  const parts = message.content?.parts;
  if (!parts) return [];
  const attachments: ConversationAttachment[] = [];
  for (const part of parts) {
    if (typeof part === "string" || !part) continue;
    const record = part as Record<string, unknown>;
    attachments.push({
      content_type: typeof record.content_type === "string" ? record.content_type : undefined,
      asset_pointer: typeof record.asset_pointer === "string" ? record.asset_pointer : undefined,
      size_bytes: typeof record.size_bytes === "number" ? record.size_bytes : undefined,
      width: typeof record.width === "number" ? record.width : undefined,
      height: typeof record.height === "number" ? record.height : undefined,
    });
  }
  return attachments;
}

function hiddenNodeLabel(message: ChatGptMessage): string {
  const role = message.author?.role ?? "unknown";
  const contentType = message.content?.content_type ?? "unknown";
  const recipient = message.recipient;
  if (recipient && recipient !== "all") {
    return `${role}:${contentType}:${recipient}`;
  }
  return `${role}:${contentType}`;
}

/**
 * Pure transform: walks `current_node` back to the root, drops branch/system
 * nodes, groups the linear path into user/assistant turns (a run of
 * consecutive non-user messages is one assistant turn), and emits exactly
 * one record per turn. A thoughts-only assistant turn still produces a
 * record (`text: ""`, `segments: []`, hiddenNodes listing what was skipped)
 * so it is never mistaken for a missing turn.
 */
export function buildRecordsFromConversation(conv: ChatGptConversationBody): BuildRecordsResult {
  const mapping = conv.mapping ?? {};
  const messageBearingIds = new Set(
    Object.values(mapping)
      .filter((node) => node.message)
      .map((node) => node.id),
  );

  const pathIds: string[] = [];
  let cursor = conv.current_node;
  while (cursor && mapping[cursor]) {
    pathIds.push(cursor);
    cursor = mapping[cursor].parent ?? undefined;
  }
  pathIds.reverse();

  const pathMessages: ChatGptMessage[] = [];
  // Every message-bearing node actually on the current_node -> root path,
  // including system messages (they are filtered out of pathMessages below,
  // but they are not branches: they must not count toward branchNodesSkipped).
  const onPathIds = new Set<string>();
  for (const id of pathIds) {
    const node = mapping[id];
    if (!node?.message) continue;
    onPathIds.add(id);
    if (node.message.author?.role === "system") continue;
    pathMessages.push(node.message);
  }

  let branchNodesSkipped = 0;
  for (const id of messageBearingIds) {
    if (!onPathIds.has(id)) branchNodesSkipped += 1;
  }

  interface TurnBuild {
    role: "user" | "assistant";
    messages: ChatGptMessage[];
  }
  const turns: TurnBuild[] = [];
  for (const message of pathMessages) {
    if (message.author?.role === "user") {
      turns.push({ role: "user", messages: [message] });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last && last.role === "assistant") {
      last.messages.push(message);
    } else {
      turns.push({ role: "assistant", messages: [message] });
    }
  }

  const records: ApiConversationRecord[] = turns.map((turn, index) => {
    const ordinal = index;
    const turnIndex = index + 1;
    const first = turn.messages[0];
    const turnId = first.id;
    const messageIds = turn.messages.map((message) => message.id);
    const createTime = epochToIso(first.create_time);

    if (turn.role === "user") {
      const parts = first.content?.parts;
      const text = joinStringParts(parts);
      const attachments = extractAttachments(first);
      return {
        ordinal,
        turnIndex,
        role: "user",
        turnId,
        messageIds,
        text,
        textHash: sha256(text),
        hiddenNodes: [],
        ...(attachments.length ? { attachments } : {}),
        ...(createTime ? { createTime } : {}),
      };
    }

    const segments: ConversationSegment[] = [];
    const hiddenNodes: string[] = [];
    const attachments: ConversationAttachment[] = [];
    for (const message of turn.messages) {
      if (message.author?.role === "assistant" && isVisibleAssistantContent(message)) {
        const segmentText =
          message.content.content_type === "text" ||
          message.content.content_type === "multimodal_text"
            ? joinStringParts(message.content.parts)
            : "";
        const segmentAttachments = extractAttachments(message);
        segments.push({
          messageId: message.id,
          contentType: message.content.content_type,
          text: segmentText,
          ...(message.metadata?.model_slug ? { model: message.metadata.model_slug } : {}),
          ...(epochToIso(message.create_time)
            ? { createTime: epochToIso(message.create_time) }
            : {}),
          ...(segmentAttachments.length ? { attachments: segmentAttachments } : {}),
        });
        attachments.push(...segmentAttachments);
      } else if (message.author?.role === "assistant" && isCanvasDocument(message)) {
        segments.push({
          messageId: message.id,
          contentType: `canvas:${message.recipient}`,
          text: message.content.text ?? "",
          ...(message.metadata?.model_slug ? { model: message.metadata.model_slug } : {}),
          ...(epochToIso(message.create_time)
            ? { createTime: epochToIso(message.create_time) }
            : {}),
        });
      } else {
        hiddenNodes.push(hiddenNodeLabel(message));
      }
    }
    const text = segments.map((segment) => segment.text).join("\n\n");
    const firstSegmentModel = segments[0]?.model;
    return {
      ordinal,
      turnIndex,
      role: "assistant",
      turnId,
      messageIds,
      text,
      markdown: text,
      textHash: sha256(text),
      segments,
      hiddenNodes,
      ...(attachments.length ? { attachments } : {}),
      ...(createTime ? { createTime } : {}),
      ...(firstSegmentModel ? { model: firstSegmentModel } : {}),
    };
  });

  return { records, turns: records.length, branchNodesSkipped };
}

export interface ExportConversationApiOptions {
  host?: string;
  port?: number;
  ref?: string;
  /** Do not return message text; hashes and browser provenance remain. */
  redactText?: boolean;
  /** Attach the untouched backend-api response body as `raw`. */
  includeRaw?: boolean;
  /** Test-only DI: override how the ChatGPT tab is attached to. */
  connect?: typeof connectToExistingChatGptTab;
}

function isNoTabMatchedError(error: unknown): boolean {
  return error instanceof Error && /No ChatGPT tab matched/.test(error.message);
}

function describeApiFetchFailure(result: ApiConversationFetchResult | undefined): string {
  if (!result || result.ok) {
    return "Conversation export (api engine) got no response evaluating the backend-api fetch in the attached tab.";
  }
  if (result.reason === "wrong_origin") {
    return "Conversation export (api engine) must run against a chatgpt.com or chat.openai.com tab.";
  }
  if (result.reason === "no_access_token") {
    return "Conversation export (api engine) could not read a ChatGPT session access token from /api/auth/session. Make sure the attached tab is logged in.";
  }
  const status = "status" in result ? result.status : -1;
  const snippet = "bodySnippet" in result ? (result.bodySnippet ?? "") : "";
  if (
    status === 401 ||
    status === 403 ||
    (status === 404 && /conversation_inaccessible/i.test(snippet))
  ) {
    return `ChatGPT backend-api rejected the conversation request (status ${status}). The attached tab may be logged out, or logged in as a different account than the one that owns this conversation.`;
  }
  const statusText = "statusText" in result && result.statusText ? ` ${result.statusText}` : "";
  const snippetSuffix = snippet ? ` ${snippet.slice(0, 200)}` : "";
  return `ChatGPT backend-api request failed with status ${status}${statusText}.${snippetSuffix}`;
}

function stripTextForFingerprint(record: ApiConversationRecord): unknown {
  const { text: _text, markdown: _markdown, segments, ...rest } = record;
  return {
    ...rest,
    ...(segments
      ? { segments: segments.map(({ text: _segmentText, ...segmentRest }) => segmentRest) }
      : {}),
  };
}

function redactRecord(record: ApiConversationRecord): ApiConversationRecord {
  return {
    ...record,
    text: "",
    markdown: record.markdown !== undefined ? "" : undefined,
    segments: record.segments?.map((segment) => ({ ...segment, text: undefined })),
  };
}

/**
 * Attach-only export via ChatGPT's own backend-api conversation endpoint.
 * Unlike the DOM crawl, this sees the full canonical mapping (branches,
 * hidden/thoughts nodes, canvas documents) in a single read, so it never
 * has to virtual-scroll or gap-check. Resolution order: (1) connect using
 * the normalized ref; (2) if no live tab matches that ref, retry with no
 * ref (any live ChatGPT tab); (3) if no ref was given at all, derive the
 * conversation id from the attached tab's own URL.
 */
export async function exportChatGptConversationViaApi(
  options: ExportConversationApiOptions = {},
): Promise<ConversationExport> {
  const connect = options.connect ?? connectToExistingChatGptTab;
  const normalizedRef = normalizeConversationRef(options.ref);
  let attached: Awaited<ReturnType<typeof connectToExistingChatGptTab>>;
  try {
    attached = await connect({ host: options.host, port: options.port, ref: normalizedRef });
  } catch (error) {
    if (normalizedRef && isNoTabMatchedError(error)) {
      attached = await connect({ host: options.host, port: options.port, ref: undefined });
    } else {
      throw error;
    }
  }
  const { client, targetId, tab } = attached;
  try {
    const conversationId = normalizedRef ?? extractStableConversationIdFromUrl(tab.url);
    if (!conversationId) {
      throw new Error(
        "Conversation export (api engine) needs a conversation ref (URL or id): the attached ChatGPT tab is not on a stable /c/<id> URL.",
      );
    }

    const evaluation = await client.Runtime.evaluate({
      expression: buildConversationApiFetchExpression(conversationId),
      awaitPromise: true,
      returnByValue: true,
    });
    const result = evaluation.result?.value as ApiConversationFetchResult | undefined;
    if (!result || !result.ok) {
      throw new Error(describeApiFetchFailure(result));
    }

    const conv = result.body;
    const { records: builtRecords, branchNodesSkipped } = buildRecordsFromConversation(conv);
    const records = options.redactText ? builtRecords.map(redactRecord) : builtRecords;
    const provenance = builtRecords.map(stripTextForFingerprint);

    const exportValue: ConversationExport = {
      version: 2,
      engine: "api",
      source: {
        url: tab.url,
        conversationId,
        targetId,
        exportedAt: new Date().toISOString(),
      },
      conversation: {
        ...(conv.title ? { title: conv.title } : {}),
        ...(epochToIso(conv.create_time) ? { createTime: epochToIso(conv.create_time) } : {}),
        ...(epochToIso(conv.update_time) ? { updateTime: epochToIso(conv.update_time) } : {}),
        ...(conv.default_model_slug ? { defaultModelSlug: conv.default_model_slug } : {}),
        ...(conv.gizmo_id ? { gizmoId: conv.gizmo_id } : {}),
        nodeCount: Object.keys(conv.mapping ?? {}).length,
        branchNodesSkipped,
      },
      records,
      fingerprint: sha256(JSON.stringify(provenance)),
      complete: true,
      missingTurnIndices: [],
      ...(options.includeRaw ? { raw: conv } : {}),
    };
    return exportValue;
  } finally {
    await client.close().catch(() => undefined);
  }
}
