import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ConversationExport } from "../../src/browser/conversationExport.js";
import { renderObsidianVault } from "../../src/cli/conversationObsidian.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const CANVAS_TEXT = "# doc body";
const TEXT_SEGMENT = "Here is the summary";
const FINAL_ANSWER_TEXT = "final answer text";
const QUERY_1_RAW = "Hello there\r\nsecond line"; // CRLF on purpose

/**
 * Synthetic v2 (api source) export covering every case the obsidian renderer
 * must handle: a 2-segment answer (canvas + text), a CRLF query, a
 * thoughts-only assistant turn sandwiched between two user turns, a user
 * turn with an image attachment, and a trailing query-only user turn.
 * No real conversation content is used anywhere in this fixture.
 */
function buildFixtureExport(): ConversationExport {
  return {
    version: 2,
    engine: "api",
    source: {
      url: "https://chatgpt.com/c/test-conv-id-1234",
      conversationId: "test-conv-id-1234",
      targetId: "tab-1",
      exportedAt: "2026-08-20T00:00:00.000Z",
    },
    conversation: {
      title: "Test conversation",
      createTime: "2025-07-07T15:00:00.000Z",
      updateTime: "2025-07-09T03:05:00.000Z",
      nodeCount: 12,
      branchNodesSkipped: 1,
    },
    records: [
      {
        ordinal: 0,
        turnIndex: 1,
        role: "user",
        turnId: "u1",
        messageIds: ["u1"],
        text: QUERY_1_RAW,
        textHash: sha256(QUERY_1_RAW),
        hiddenNodes: [],
        createTime: "2025-07-07T15:30:00.000Z",
      },
      {
        ordinal: 1,
        turnIndex: 2,
        role: "assistant",
        turnId: "a1-turn",
        messageIds: ["a1-canvas-msg", "a1-text-msg"],
        text: `${CANVAS_TEXT}\n\n${TEXT_SEGMENT}`,
        markdown: `${CANVAS_TEXT}\n\n${TEXT_SEGMENT}`,
        textHash: sha256(`${CANVAS_TEXT}\n\n${TEXT_SEGMENT}`),
        hiddenNodes: ["assistant:thoughts"],
        createTime: "2025-07-07T15:30:50.000Z",
        model: "gpt-5.6",
        segments: [
          {
            messageId: "a1-canvas-msg",
            contentType: "canvas:canmore.create_textdoc",
            text: CANVAS_TEXT,
          },
          {
            messageId: "a1-text-msg",
            contentType: "text",
            text: TEXT_SEGMENT,
            model: "gpt-5.6",
            createTime: "2025-07-07T15:31:00.000Z",
          },
        ],
      },
      {
        ordinal: 2,
        turnIndex: 3,
        role: "user",
        turnId: "u2",
        messageIds: ["u2"],
        text: "second question, with a picture",
        textHash: sha256("second question, with a picture"),
        hiddenNodes: [],
        createTime: "2025-07-08T01:00:00.000Z",
        attachments: [
          {
            content_type: "image_asset_pointer",
            asset_pointer: "file-service://photo.png",
            size_bytes: 999,
            width: 640,
            height: 480,
          },
        ],
      },
      {
        ordinal: 3,
        turnIndex: 4,
        role: "assistant",
        turnId: "a2-turn",
        messageIds: ["a2-thoughts-msg"],
        text: "",
        markdown: "",
        textHash: sha256(""),
        segments: [],
        hiddenNodes: ["assistant:thoughts"],
        createTime: "2025-07-08T01:00:30.000Z",
      },
      {
        ordinal: 4,
        turnIndex: 5,
        role: "user",
        turnId: "u3",
        messageIds: ["u3"],
        text: "third question, now with a normal answer",
        textHash: sha256("third question, now with a normal answer"),
        hiddenNodes: [],
        createTime: "2025-07-08T02:00:00.000Z",
      },
      {
        ordinal: 5,
        turnIndex: 6,
        role: "assistant",
        turnId: "a3-turn",
        messageIds: ["a3-text-msg"],
        text: FINAL_ANSWER_TEXT,
        markdown: FINAL_ANSWER_TEXT,
        textHash: sha256(FINAL_ANSWER_TEXT),
        hiddenNodes: [],
        createTime: "2025-07-08T02:00:05.000Z",
        model: "gpt-5.6",
        segments: [
          {
            messageId: "a3-text-msg",
            contentType: "text",
            text: FINAL_ANSWER_TEXT,
            model: "gpt-5.6",
            createTime: "2025-07-08T02:00:10.000Z",
          },
        ],
      },
      {
        ordinal: 6,
        turnIndex: 7,
        role: "user",
        turnId: "u4",
        messageIds: ["u4"],
        text: "trailing question with no answer",
        textHash: sha256("trailing question with no answer"),
        hiddenNodes: [],
        createTime: "2025-07-09T03:00:00.000Z",
      },
    ],
    fingerprint: "fingerprint-fixture",
    complete: true,
    missingTurnIndices: [],
  };
}

const OPTS = { timezone: "Asia/Tokyo", captured: "2026-08-20", folderName: "ChatGPT-testconv" };

describe("renderObsidianVault", () => {
  const { files, summary } = renderObsidianVault(buildFixtureExport(), OPTS);
  const byPath = new Map(files.map((f) => [f.relativePath, f.content]));

  it("writes 4 exchange notes plus INDEX.md, all under the folder", () => {
    expect(files).toHaveLength(5);
    for (const file of files) {
      expect(file.relativePath.startsWith("ChatGPT-testconv/")).toBe(true);
    }
    expect(byPath.has("ChatGPT-testconv/INDEX.md")).toBe(true);
  });

  it("names files NNN-YYYY-MM-DD-turn-TTT.md using the query's local date and turn index", () => {
    // 2025-07-07T15:30:00.000Z in Asia/Tokyo is 2025-07-08T00:30 local.
    expect(byPath.has("ChatGPT-testconv/001-2025-07-08-turn-001.md")).toBe(true);
    expect(byPath.has("ChatGPT-testconv/002-2025-07-08-turn-003.md")).toBe(true);
    expect(byPath.has("ChatGPT-testconv/003-2025-07-08-turn-005.md")).toBe(true);
    // 2025-07-09T03:00:00.000Z in Asia/Tokyo is 2025-07-09T12:00 local (no rollover).
    expect(byPath.has("ChatGPT-testconv/004-2025-07-09-turn-007.md")).toBe(true);
  });

  it("normalizes CRLF in the query body but hashes the original raw text", () => {
    const content = byPath.get("ChatGPT-testconv/001-2025-07-08-turn-001.md")!;
    expect(content).toContain(
      "<!-- QUERY_RAW_START -->\nHello there\nsecond line\n<!-- QUERY_RAW_END -->",
    );
    expect(content).not.toContain("\r");
    expect(content).toContain(`query_sha256: ${sha256(QUERY_1_RAW)}`);
    expect(content).toContain('normalization: "query_crlf_to_lf"');
  });

  it("emits frontmatter keys in the documented order with correct values for a 2-segment answer", () => {
    const content = byPath.get("ChatGPT-testconv/001-2025-07-08-turn-001.md")!;
    const fmBlock = content.slice(0, content.indexOf("\n---\n", 4) + 5);
    const keys = [...fmBlock.matchAll(/^([a-z0-9_]+):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      "created",
      "captured",
      "original_date",
      "timezone",
      "query_created_at",
      "answer_created_at",
      "timestamp_source",
      "source",
      "capture_mode",
      "conversation_id",
      "source_url",
      "query_turn",
      "query_turn_id",
      "query_sha256",
      "query_attachments",
      "answer_turns",
      "answer_turn_ids",
      "answer_sha256",
      "redaction",
      "normalization",
      "tags",
    ]);
    expect(content).toContain("created: 2025-07-08");
    expect(content).toContain("captured: 2026-08-20");
    expect(content).toContain('query_created_at: "2025-07-07T15:30:00.000Z"');
    expect(content).toContain('answer_created_at: ["2025-07-07T15:30:50.000Z"]');
    expect(content).toContain("source: backend-api");
    expect(content).toContain("capture_mode: raw");
    expect(content).toContain("conversation_id: test-conv-id-1234");
    expect(content).toContain('source_url: "https://chatgpt.com/c/test-conv-id-1234"');
    expect(content).toContain("query_turn: 1");
    expect(content).toContain('query_turn_id: "u1"');
    expect(content).toContain("query_attachments: []");
    expect(content).toContain('answer_turns: ["2"]');
    expect(content).toContain('answer_turn_ids: ["a1-turn"]');
    expect(content).toContain(
      `answer_sha256: ["multi:${sha256(CANVAS_TEXT)},${sha256(TEXT_SEGMENT)}"]`,
    );
    expect(content).toContain("redaction: none");
    expect(content).toContain("tags: [chatgpt, conversation_export, raw, inbox]");
  });

  it("renders one #### Segment block per visible segment with the documented field table", () => {
    const content = byPath.get("ChatGPT-testconv/001-2025-07-08-turn-001.md")!;
    expect(content).toContain("### Assistant turn 2");
    expect(content).toContain("| turn_id | a1-turn |");
    expect(content).toContain("| visible_segments | 2 |");
    expect(content).toContain("| hidden_nodes | assistant:thoughts |");
    expect(content).toContain("#### Segment 1");
    expect(content).toContain("| content_type | canvas:canmore.create_textdoc |");
    expect(content).toContain(
      `<!-- ANSWER_RAW_START turn=2 segment=1 -->\n${CANVAS_TEXT}\n<!-- ANSWER_RAW_END turn=2 segment=1 -->`,
    );
    expect(content).toContain("#### Segment 2");
    expect(content).toContain("| model | gpt-5.6 |");
    expect(content).toContain(`| sha256 | ${sha256(TEXT_SEGMENT)} |`);
    expect(content).toContain(
      `<!-- ANSWER_RAW_START turn=2 segment=2 -->\n${TEXT_SEGMENT}\n<!-- ANSWER_RAW_END turn=2 segment=2 -->`,
    );
  });

  it("lists a user attachment as a query_attachments frontmatter array", () => {
    const content = byPath.get("ChatGPT-testconv/002-2025-07-08-turn-003.md")!;
    expect(content).toContain(
      'query_attachments: [{"content_type":"image_asset_pointer","asset_pointer":"file-service://photo.png","size_bytes":999,"width":640,"height":480}]',
    );
  });

  it("still emits a note for a thoughts-only assistant turn, with the ANSWER_EMPTY marker", () => {
    const content = byPath.get("ChatGPT-testconv/002-2025-07-08-turn-003.md")!;
    expect(content).toContain("| visible_segments | 0 |");
    expect(content).toContain("| hidden_nodes | assistant:thoughts |");
    expect(content).toContain(
      "<!-- ANSWER_EMPTY turn=4 -->\n_(no visible assistant text in this turn)_",
    );
    expect(content).toContain(`answer_sha256: ["${sha256("")}"]`);
  });

  it("renders a normal single-segment Q/A note", () => {
    const content = byPath.get("ChatGPT-testconv/003-2025-07-08-turn-005.md")!;
    expect(content).toContain("# 003. ChatGPT raw Q/A");
    expect(content).toContain(FINAL_ANSWER_TEXT);
    expect(content).toContain(`answer_sha256: ["${sha256(FINAL_ANSWER_TEXT)}"]`);
  });

  it("renders a query-only trailing note with no assistant turn", () => {
    const content = byPath.get("ChatGPT-testconv/004-2025-07-09-turn-007.md")!;
    expect(content).toContain("# 004. ChatGPT raw query only");
    expect(content).toContain("_(no assistant turn follows this query)_");
    expect(content).toContain("query_turn: 7");
    expect(content).toContain("answer_turns: []");
    expect(content).not.toContain("### Assistant turn");
  });

  it("ends every note with a relative wikilink to the folder's INDEX", () => {
    for (const [relativePath, content] of byPath) {
      if (relativePath.endsWith("INDEX.md")) continue;
      expect(content).toContain("- [[ChatGPT-testconv/INDEX]]");
    }
  });

  it("builds INDEX.md with frontmatter, summary bullets, and per-exchange wikilinks", () => {
    const index = byPath.get("ChatGPT-testconv/INDEX.md")!;
    expect(index).toContain("original_date_start: 2025-07-08");
    expect(index).toContain("original_date_end: 2025-07-09");
    expect(index).toContain("source: chatgpt");
    expect(index).toContain("capture_mode: raw/conversation/full");
    expect(index).toContain('conversation_title: "Test conversation"');
    expect(index).toContain("# ChatGPT raw conversation — 2025-07-08 to 2025-07-09");
    expect(index).toContain(
      "- complete: true (backend-api current_node path; every node on the path is accounted for)",
    );
    expect(index).toContain(
      "- 7 turns: user 4 / assistant 3; turn index 1..7 (turn = user message or run of consecutive assistant nodes; turn_id = first node id, same as DOM data-turn-id)",
    );
    expect(index).toContain(
      "- 4 exchanges: query-only 1; thoughts-only assistant turns 1; empty assistant 0; visible raw segments 3; CRLF->LF normalised records 1",
    );
    expect(index).toContain("- mapping nodes 12; off-path (branch) nodes 1 are not exported");
    expect(index).toContain("- 原文を保存した一次資料。query本文は索引へ重複しない。");
    expect(index).toContain("001. [[ChatGPT-testconv/001-2025-07-08-turn-001|2025-07-08 — Q/A]]");
    expect(index).toContain("002. [[ChatGPT-testconv/002-2025-07-08-turn-003|2025-07-08 — Q/A]]");
    expect(index).toContain(
      "004. [[ChatGPT-testconv/004-2025-07-09-turn-007|2025-07-09 — query only]]",
    );
  });

  it("returns a summary matching the fixture's known shape", () => {
    expect(summary).toEqual({
      turns: 7,
      users: 4,
      assistants: 3,
      exchanges: 4,
      queryOnly: 1,
      thoughtsOnlyTurns: 1,
      emptyAssistant: 0,
      segments: 3,
      crlfNormalized: 1,
      mappingNodes: 12,
      branchNodesSkipped: 1,
      dateRangeStart: "2025-07-08",
      dateRangeEnd: "2025-07-09",
    });
  });

  it("rejects a v1/dom export", () => {
    const v1: ConversationExport = {
      version: 1,
      engine: "dom",
      source: {
        url: "https://chatgpt.com/c/x",
        targetId: "t",
        exportedAt: "2026-01-01T00:00:00.000Z",
      },
      records: [],
      fingerprint: "x",
      complete: true,
    };
    expect(() => renderObsidianVault(v1, OPTS)).toThrow(/v2/);
  });
});
