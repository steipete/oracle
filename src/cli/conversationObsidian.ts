import { createHash } from "node:crypto";
import type {
  ConversationAttachment,
  ConversationExport,
  ConversationRecord,
  ConversationSegment,
} from "../browser/conversationExport.js";

/**
 * Raw-first ChatGPT -> Obsidian vault archiver. Faithful TypeScript port of
 * knowledge/scripts/chatgpt_api_to_inbox.py (Meta/KNOWLEDGE_CAPTURE.md rules:
 * query text and assistant markdown are stored byte-exact except CRLF->LF,
 * which is recorded per record; no summarising, no auto-redaction). Operates
 * on an already-built v2 (`api` source) ConversationExport — the export's
 * turn records replace the python script's own mapping-walk/turn-grouping,
 * everything else (exchange grouping, frontmatter shape, body markup,
 * INDEX.md) is ported 1:1.
 */

const TIMESTAMP_SOURCE = "ChatGPT backend-api message.create_time (epoch seconds -> ISO UTC)";

/** Note section headings, centralized here for future localisation. */
const HEADINGS = {
  query: "Original query",
  answer: "Original answer",
  related: "Related",
} as const;

const NOTE_KIND = {
  qa: "Q/A",
  queryOnly: "query only",
  answerOnly: "answer only",
} as const;

export interface ObsidianRenderOptions {
  /** IANA timezone used to convert message create_time into a calendar date for filenames/frontmatter. */
  timezone: string;
  /** YYYY-MM-DD capture date recorded in every note's frontmatter. */
  captured: string;
  /** Vault subfolder name, e.g. `ChatGPT-<first 8 chars of conversation id>`. Also used in wikilinks. */
  folderName: string;
}

export interface ObsidianFile {
  /** Path relative to the vault root, e.g. `ChatGPT-abcd1234/001-2025-07-07-turn-001.md`. */
  relativePath: string;
  content: string;
}

export interface ObsidianVaultSummary {
  turns: number;
  users: number;
  assistants: number;
  exchanges: number;
  queryOnly: number;
  thoughtsOnlyTurns: number;
  emptyAssistant: number;
  segments: number;
  crlfNormalized: number;
  mappingNodes: number;
  branchNodesSkipped: number;
  dateRangeStart: string;
  dateRangeEnd: string;
}

export interface RenderObsidianVaultResult {
  files: ObsidianFile[];
  summary: ObsidianVaultSummary;
}

interface Exchange {
  query: ConversationRecord | null;
  answers: ConversationRecord[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON-encodes a value for YAML frontmatter: strings get quoted, null/arrays/numbers pass through as-is. */
function yamlValue(value: unknown): string {
  return JSON.stringify(value);
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** `\r\n`/`\r` -> `\n`. Returns whether anything changed, so callers can record it in `normalization`. */
function normalizeLf(text: string): { text: string; changed: boolean } {
  if (text.includes("\r")) {
    return { text: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), changed: true };
  }
  return { text, changed: false };
}

/** Converts an ISO-8601 UTC timestamp to a `YYYY-MM-DD` calendar date in `timezone`. */
function localDate(isoTimestamp: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(isoTimestamp));
}

/** Today's date, `YYYY-MM-DD`, in `timezone`. Used for the `--captured` default. */
export function todayInTimezone(timezone: string): string {
  return localDate(new Date().toISOString(), timezone);
}

function buildExchanges(records: ConversationRecord[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let i = 0;
  while (i < records.length) {
    const turn = records[i];
    if (turn.role !== "user") {
      exchanges.push({ query: null, answers: [turn] });
      i += 1;
      continue;
    }
    const exchange: Exchange = { query: turn, answers: [] };
    i += 1;
    while (i < records.length && records[i].role === "assistant") {
      exchange.answers.push(records[i]);
      i += 1;
    }
    exchanges.push(exchange);
  }
  return exchanges;
}

function noteKind(query: ConversationRecord | null, answers: ConversationRecord[]): string {
  if (answers.length === 0) return NOTE_KIND.queryOnly;
  if (!query) return NOTE_KIND.answerOnly;
  return NOTE_KIND.qa;
}

function attachmentsTableLine(attachments: ConversationAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return "";
  return `| attachments | ${JSON.stringify(attachments)} |\n`;
}

function segmentBlock(
  turnIndex: number,
  segmentOrdinal: number,
  segment: ConversationSegment,
  hash: string,
  normalizedText: string,
): string {
  const model = segment.model ?? "unknown";
  const createdAt = segment.createTime ?? "unknown";
  const attLine = attachmentsTableLine(segment.attachments);
  return (
    `#### Segment ${segmentOrdinal}\n\n` +
    `| field | value |\n| --- | --- |\n` +
    `| message_id | ${segment.messageId} |\n` +
    `| content_type | ${segment.contentType} |\n` +
    `| model | ${model} |\n` +
    `| sha256 | ${hash} |\n` +
    `| created_at | ${createdAt} |\n` +
    `${attLine}| source | backend-api |\n\n` +
    `<!-- ANSWER_RAW_START turn=${turnIndex} segment=${segmentOrdinal} -->\n${normalizedText}\n<!-- ANSWER_RAW_END turn=${turnIndex} segment=${segmentOrdinal} -->\n`
  );
}

function emptyAnswerBlock(turn: ConversationRecord, hiddenNodes: string[]): string {
  const hiddenStr = hiddenNodes.length > 0 ? hiddenNodes.join(", ") : "none";
  const createdAt = turn.createTime ?? "unknown";
  return (
    `### Assistant turn ${turn.turnIndex}\n\n` +
    `| field | value |\n| --- | --- |\n` +
    `| turn_id | ${turn.turnId} |\n` +
    `| visible_segments | 0 |\n` +
    `| hidden_nodes | ${hiddenStr} |\n` +
    `| created_at | ${createdAt} |\n` +
    `| source | backend-api |\n\n` +
    `<!-- ANSWER_EMPTY turn=${turn.turnIndex} -->\n_(no visible assistant text in this turn)_\n`
  );
}

interface AnswerTurnResult {
  block: string;
  turnHash: string;
  crlfCount: number;
  normNotes: string[];
  isThoughtsOnly: boolean;
  isEmpty: boolean;
  segmentCount: number;
}

function renderAnswerTurn(turn: ConversationRecord): AnswerTurnResult {
  const segments = turn.segments ?? [];
  const hiddenNodes = turn.hiddenNodes ?? [];
  if (segments.length === 0) {
    const isThoughtsOnly = hiddenNodes.includes("assistant:thoughts");
    return {
      block: emptyAnswerBlock(turn, hiddenNodes),
      turnHash: sha256(""),
      crlfCount: 0,
      normNotes: [],
      isThoughtsOnly,
      isEmpty: !isThoughtsOnly,
      segmentCount: 0,
    };
  }
  const segBlocks: string[] = [];
  const segHashes: string[] = [];
  const normNotes: string[] = [];
  let crlfCount = 0;
  segments.forEach((segment, index) => {
    const segmentOrdinal = index + 1;
    const rawText = segment.text ?? "";
    const { text: normalizedText, changed } = normalizeLf(rawText);
    if (changed) {
      normNotes.push(`answer_turn${turn.turnIndex}_seg${segmentOrdinal}_crlf_to_lf`);
      crlfCount += 1;
    }
    const hash = sha256(rawText);
    segHashes.push(hash);
    segBlocks.push(
      segmentBlock(turn.turnIndex ?? 0, segmentOrdinal, segment, hash, normalizedText),
    );
  });
  const header =
    `### Assistant turn ${turn.turnIndex}\n\n` +
    `| field | value |\n| --- | --- |\n` +
    `| turn_id | ${turn.turnId} |\n` +
    `| visible_segments | ${segments.length} |\n` +
    `| hidden_nodes | ${hiddenNodes.length > 0 ? hiddenNodes.join(", ") : "none"} |\n` +
    `| created_at | ${turn.createTime ?? "unknown"} |\n` +
    `| source | backend-api |\n\n`;
  return {
    block: header + segBlocks.join("\n"),
    turnHash: segHashes.length === 1 ? segHashes[0] : `multi:${segHashes.join(",")}`,
    crlfCount,
    normNotes,
    isThoughtsOnly: false,
    isEmpty: false,
    segmentCount: segments.length,
  };
}

/**
 * Pure transform: an api-source v2 ConversationExport -> Obsidian vault note
 * files (one per exchange, raw-first) + an INDEX.md. Does no I/O.
 */
export function renderObsidianVault(
  exportV2: ConversationExport,
  opts: ObsidianRenderOptions,
): RenderObsidianVaultResult {
  if (exportV2.version !== 2 || !exportV2.conversation) {
    throw new Error("renderObsidianVault requires a v2 (api source) ConversationExport.");
  }
  const conversationId = exportV2.source.conversationId ?? "unknown";
  const sourceUrl = exportV2.source.url;
  const records = exportV2.records;
  const exchanges = buildExchanges(records);

  const files: ObsidianFile[] = [];
  const indexLines: string[] = [];
  const dates: string[] = [];
  let queryOnly = 0;
  let thoughtsOnlyTurns = 0;
  let emptyAssistant = 0;
  let segmentCount = 0;
  let crlfNormalized = 0;

  exchanges.forEach((exchange, exchangeIndex) => {
    const n = exchangeIndex + 1;
    const query = exchange.query;
    const qtextRaw = query?.text ?? "";
    const qAttachments = query?.attachments ?? [];
    const { text: qtext, changed: qCrlf } = normalizeLf(qtextRaw);

    let qts = query?.createTime;
    if (qts === undefined && exchange.answers.length > 0) {
      qts = exchange.answers[0].createTime;
    }
    const odate = qts ? localDate(qts, opts.timezone) : "unknown";
    if (qts) dates.push(odate);

    const turnNo = query ? (query.turnIndex ?? 0) : (exchange.answers[0]?.turnIndex ?? 0);
    const fname = `${pad3(n)}-${odate}-turn-${pad3(turnNo)}.md`;
    const kind = noteKind(query, exchange.answers);

    const normNotes: string[] = [];
    if (qCrlf) {
      normNotes.push("query_crlf_to_lf");
      crlfNormalized += 1;
    }

    const bodyAnswers: string[] = [];
    const answerTurns: string[] = [];
    const answerIds: string[] = [];
    const answerCreated: (string | null)[] = [];
    const answerSha: string[] = [];
    for (const answerTurn of exchange.answers) {
      const result = renderAnswerTurn(answerTurn);
      answerTurns.push(String(answerTurn.turnIndex ?? 0));
      answerIds.push(answerTurn.turnId ?? "");
      answerCreated.push(answerTurn.createTime ?? null);
      answerSha.push(result.turnHash);
      bodyAnswers.push(result.block);
      normNotes.push(...result.normNotes);
      crlfNormalized += result.crlfCount;
      segmentCount += result.segmentCount;
      if (result.isThoughtsOnly) thoughtsOnlyTurns += 1;
      if (result.isEmpty) emptyAssistant += 1;
    }
    if (exchange.answers.length === 0) queryOnly += 1;

    const frontmatter = [
      "---",
      `created: ${odate !== "unknown" ? odate : opts.captured}`,
      `captured: ${opts.captured}`,
      `original_date: ${odate}`,
      `timezone: ${opts.timezone}`,
      `query_created_at: ${query ? yamlValue(qts ?? null) : "null"}`,
      `answer_created_at: ${JSON.stringify(answerCreated)}`,
      `timestamp_source: ${yamlValue(TIMESTAMP_SOURCE)}`,
      "source: backend-api",
      "capture_mode: raw",
      `conversation_id: ${conversationId}`,
      `source_url: ${yamlValue(sourceUrl)}`,
      `query_turn: ${query ? (query.turnIndex ?? "null") : "null"}`,
      `query_turn_id: ${query ? yamlValue(query.turnId ?? null) : "null"}`,
      `query_sha256: ${query ? sha256(qtextRaw) : "null"}`,
      `query_attachments: ${JSON.stringify(qAttachments)}`,
      `answer_turns: ${JSON.stringify(answerTurns)}`,
      `answer_turn_ids: ${JSON.stringify(answerIds)}`,
      `answer_sha256: ${JSON.stringify(answerSha)}`,
      "redaction: none",
      `normalization: ${yamlValue(normNotes.length > 0 ? normNotes.join("; ") : "none; source LF preserved")}`,
      "tags: [chatgpt, conversation_export, raw, inbox]",
      "---",
    ];

    let body = `${frontmatter.join("\n")}\n\n# ${pad3(n)}. ChatGPT raw ${kind}\n\n`;
    if (query) {
      body += `## ${HEADINGS.query}\n\n<!-- QUERY_RAW_START -->\n${qtext}\n<!-- QUERY_RAW_END -->\n\n`;
    }
    body += `## ${HEADINGS.answer}\n\n`;
    body +=
      bodyAnswers.length > 0
        ? bodyAnswers.join("\n")
        : "_(no assistant turn follows this query)_\n";
    body += `\n## ${HEADINGS.related}\n\n- [[${opts.folderName}/INDEX]]\n`;

    files.push({ relativePath: `${opts.folderName}/${fname}`, content: body });
    indexLines.push(`${pad3(n)}. [[${opts.folderName}/${fname.slice(0, -3)}|${odate} — ${kind}]]`);
  });

  const users = records.filter((record) => record.role === "user").length;
  const assistants = records.length - users;
  const dateRangeStart = dates.length > 0 ? [...dates].sort()[0] : "unknown";
  const dateRangeEnd = dates.length > 0 ? [...dates].sort().at(-1)! : "unknown";
  const nodeCount = exportV2.conversation.nodeCount;
  const branchNodesSkipped = exportV2.conversation.branchNodesSkipped;

  const indexFrontmatter = [
    "---",
    `created: ${dateRangeStart}`,
    `captured: ${opts.captured}`,
    `original_date_start: ${dateRangeStart}`,
    `original_date_end: ${dateRangeEnd}`,
    `timezone: ${opts.timezone}`,
    "source: chatgpt",
    "capture_mode: raw/conversation/full",
    `source_url: ${yamlValue(sourceUrl)}`,
    `timestamp_source: ${yamlValue(TIMESTAMP_SOURCE)}`,
    `conversation_id: ${conversationId}`,
    `conversation_title: ${yamlValue(exportV2.conversation.title ?? "")}`,
    `conversation_create_time: ${yamlValue(exportV2.conversation.createTime ?? null)}`,
    `conversation_update_time: ${yamlValue(exportV2.conversation.updateTime ?? null)}`,
    "tags: [chatgpt, raw-capture, conversation-export, inbox]",
    "---",
  ];
  const indexBody = [
    ...indexFrontmatter,
    "",
    `# ChatGPT raw conversation — ${dateRangeStart} to ${dateRangeEnd}`,
    "",
    `- complete: ${exportV2.complete} (backend-api current_node path; every node on the path is accounted for)`,
    `- ${records.length} turns: user ${users} / assistant ${assistants}; turn index 1..${records.length} (turn = user message or run of consecutive assistant nodes; turn_id = first node id, same as DOM data-turn-id)`,
    `- ${exchanges.length} exchanges: query-only ${queryOnly}; thoughts-only assistant turns ${thoughtsOnlyTurns}; empty assistant ${emptyAssistant}; visible raw segments ${segmentCount}; CRLF->LF normalised records ${crlfNormalized}`,
    `- mapping nodes ${nodeCount}; off-path (branch) nodes ${branchNodesSkipped} are not exported`,
    "- Primary source, stored verbatim. Query text is not duplicated into this index.",
    "",
    "## Q/A",
    "",
    ...indexLines,
  ].join("\n");
  files.push({ relativePath: `${opts.folderName}/INDEX.md`, content: `${indexBody}\n` });

  return {
    files,
    summary: {
      turns: records.length,
      users,
      assistants,
      exchanges: exchanges.length,
      queryOnly,
      thoughtsOnlyTurns,
      emptyAssistant,
      segments: segmentCount,
      crlfNormalized,
      mappingNodes: nodeCount,
      branchNodesSkipped,
      dateRangeStart,
      dateRangeEnd,
    },
  };
}
