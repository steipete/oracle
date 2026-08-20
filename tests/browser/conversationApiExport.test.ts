import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildConversationApiFetchExpression,
  buildRecordsFromConversation,
  exportChatGptConversationViaApi,
  type ChatGptConversationBody,
} from "../../src/browser/conversationApiExport.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Synthetic backend-api mapping covering: a messageless root, a skipped
 * system message, a plain user turn, an assistant turn with thoughts +
 * reasoning_recap + visible text, a multimodal user turn with an image
 * attachment, an assistant turn with a web.run tool call folded in, a
 * thoughts-only assistant turn immediately followed by a user re-ask, an
 * assistant turn with a canvas document plus a visually-hidden text
 * message plus a visible text message (two segments, one hidden), and one
 * off-path branch node hanging off n_u2 that current_node never reaches.
 */
function buildFixtureConversation(): ChatGptConversationBody {
  const node = (
    id: string,
    parent: string | undefined,
    message: ChatGptConversationBody["mapping"][string]["message"],
  ) => ({ id, parent, children: [], message });

  const mapping: ChatGptConversationBody["mapping"] = {
    root: node("root", undefined, null),
    n_sys: node("n_sys", "root", {
      id: "n_sys",
      author: { role: "system" },
      content: { content_type: "text", parts: ["you are chatgpt"] },
    }),
    n_u1: node("n_u1", "n_sys", {
      id: "n_u1",
      author: { role: "user" },
      create_time: 1751860249.522024,
      content: { content_type: "text", parts: ["Hello there"] },
    }),
    n_a1_thoughts: node("n_a1_thoughts", "n_u1", {
      id: "n_a1_thoughts",
      author: { role: "assistant" },
      content: { content_type: "thoughts" },
    }),
    n_a1_recap: node("n_a1_recap", "n_a1_thoughts", {
      id: "n_a1_recap",
      author: { role: "assistant" },
      content: { content_type: "reasoning_recap" },
    }),
    n_a1_text: node("n_a1_text", "n_a1_recap", {
      id: "n_a1_text",
      author: { role: "assistant" },
      content: { content_type: "text", parts: ["assistant answer one"] },
      metadata: { model_slug: "gpt-5.6" },
    }),
    n_u2: node("n_u2", "n_a1_text", {
      id: "n_u2",
      author: { role: "user" },
      content: {
        content_type: "multimodal_text",
        parts: [
          "caption text",
          {
            content_type: "image_asset_pointer",
            asset_pointer: "file-service://abc",
            size_bytes: 123,
            width: 800,
            height: 600,
          },
        ],
      },
    }),
    n_branch: node("n_branch", "n_u2", {
      id: "n_branch",
      author: { role: "assistant" },
      content: { content_type: "text", parts: ["an alternate regeneration nobody chose"] },
    }),
    n_a2_code_webrun: node("n_a2_code_webrun", "n_u2", {
      id: "n_a2_code_webrun",
      author: { role: "assistant" },
      recipient: "web.run",
      content: { content_type: "code", text: "search('...')" },
    }),
    n_a2_tool: node("n_a2_tool", "n_a2_code_webrun", {
      id: "n_a2_tool",
      author: { role: "tool", name: "web" },
      content: { content_type: "text", parts: ["search results..."] },
    }),
    n_a2_text: node("n_a2_text", "n_a2_tool", {
      id: "n_a2_text",
      author: { role: "assistant" },
      content: { content_type: "text", parts: ["assistant answer two"] },
    }),
    n_u2b: node("n_u2b", "n_a2_text", {
      id: "n_u2b",
      author: { role: "user" },
      content: { content_type: "text", parts: ["ok, keep going"] },
    }),
    n_a3_thoughts: node("n_a3_thoughts", "n_u2b", {
      id: "n_a3_thoughts",
      author: { role: "assistant" },
      content: { content_type: "thoughts" },
    }),
    n_u3: node("n_u3", "n_a3_thoughts", {
      id: "n_u3",
      author: { role: "user" },
      content: { content_type: "text", parts: ["actually, one more thing"] },
    }),
    n_a4_canvas: node("n_a4_canvas", "n_u3", {
      id: "n_a4_canvas",
      author: { role: "assistant" },
      recipient: "canmore.create_textdoc",
      content: { content_type: "code", text: "# canvas doc body" },
    }),
    n_a4_hidden: node("n_a4_hidden", "n_a4_canvas", {
      id: "n_a4_hidden",
      author: { role: "assistant" },
      content: { content_type: "text", parts: ["a duplicate the UI hides"] },
      metadata: { is_visually_hidden_from_conversation: true },
    }),
    n_a4_text: node("n_a4_text", "n_a4_hidden", {
      id: "n_a4_text",
      author: { role: "assistant" },
      content: { content_type: "text", parts: ["final visible answer"] },
    }),
  };

  return {
    title: "Fixture conversation",
    create_time: 1751860000,
    update_time: 1751860300,
    conversation_id: "fixture-1",
    current_node: "n_a4_text",
    mapping,
    default_model_slug: "gpt-5.6",
  };
}

describe("buildRecordsFromConversation", () => {
  const { records, turns, branchNodesSkipped } = buildRecordsFromConversation(
    buildFixtureConversation(),
  );

  it("counts one off-path branch node and eight linear turns", () => {
    expect(branchNodesSkipped).toBe(1);
    expect(turns).toBe(8);
    expect(records).toHaveLength(8);
  });

  it("orders turns and sets turnId to the first message id in the turn", () => {
    expect(records.map((r) => [r.turnIndex, r.role])).toEqual([
      [1, "user"],
      [2, "assistant"],
      [3, "user"],
      [4, "assistant"],
      [5, "user"],
      [6, "assistant"],
      [7, "user"],
      [8, "assistant"],
    ]);
    expect(records[1].turnId).toBe("n_a1_thoughts");
    expect(records[3].turnId).toBe("n_a2_code_webrun");
    expect(records[7].turnId).toBe("n_a4_canvas");
  });

  it("converts epoch seconds (with fractional millis) to an ISO-8601 UTC string", () => {
    expect(records[0].createTime).toBe("2025-07-07T03:50:49.522Z");
  });

  it("folds thoughts + reasoning_recap into hiddenNodes and keeps only the visible text segment", () => {
    const turn2 = records[1];
    expect(turn2.text).toBe("assistant answer one");
    expect(turn2.markdown).toBe("assistant answer one");
    expect(turn2.hiddenNodes).toEqual(["assistant:thoughts", "assistant:reasoning_recap"]);
    expect(turn2.segments).toEqual([
      {
        messageId: "n_a1_text",
        contentType: "text",
        text: "assistant answer one",
        model: "gpt-5.6",
      },
    ]);
    expect(turn2.model).toBe("gpt-5.6");
    expect(turn2.messageIds).toEqual(["n_a1_thoughts", "n_a1_recap", "n_a1_text"]);
    expect(turn2.textHash).toBe(sha256("assistant answer one"));
  });

  it("copies non-string multimodal parts into attachments with only the documented fields", () => {
    const turn3 = records[2];
    expect(turn3.role).toBe("user");
    expect(turn3.text).toBe("caption text");
    expect(turn3.attachments).toEqual([
      {
        content_type: "image_asset_pointer",
        asset_pointer: "file-service://abc",
        size_bytes: 123,
        width: 800,
        height: 600,
      },
    ]);
  });

  it("folds a web.run tool call and its tool-role result into hiddenNodes", () => {
    const turn4 = records[3];
    expect(turn4.hiddenNodes).toEqual(["assistant:code:web.run", "tool:text"]);
    expect(turn4.segments).toEqual([
      { messageId: "n_a2_text", contentType: "text", text: "assistant answer two" },
    ]);
    expect(turn4.text).toBe("assistant answer two");
  });

  it("still emits a record for a thoughts-only assistant turn", () => {
    const turn6 = records[5];
    expect(turn6.role).toBe("assistant");
    expect(turn6.text).toBe("");
    expect(turn6.markdown).toBe("");
    expect(turn6.segments).toEqual([]);
    expect(turn6.hiddenNodes).toEqual(["assistant:thoughts"]);
    expect(turn6.model).toBeUndefined();
    expect(turn6.textHash).toBe(sha256(""));
  });

  it("captures a canmore canvas document as its own segment alongside visible text, and hides the visually-hidden duplicate", () => {
    const turn8 = records[7];
    expect(turn8.hiddenNodes).toEqual(["assistant:text"]);
    expect(turn8.segments).toEqual([
      {
        messageId: "n_a4_canvas",
        contentType: "canvas:canmore.create_textdoc",
        text: "# canvas doc body",
      },
      { messageId: "n_a4_text", contentType: "text", text: "final visible answer" },
    ]);
    expect(turn8.text).toBe("# canvas doc body\n\nfinal visible answer");
  });
});

describe("buildRecordsFromConversation assistant segment attachments", () => {
  it("copies image attachments onto the visible segment that carries them", () => {
    const mapping: ChatGptConversationBody["mapping"] = {
      root: { id: "root", parent: undefined, children: [], message: null },
      m1: {
        id: "m1",
        parent: "root",
        children: [],
        message: {
          id: "m1",
          author: { role: "user" },
          content: { content_type: "text", parts: ["draw me a cat"] },
        },
      },
      m2: {
        id: "m2",
        parent: "m1",
        children: [],
        message: {
          id: "m2",
          author: { role: "assistant" },
          content: {
            content_type: "multimodal_text",
            parts: [
              "here you go",
              {
                content_type: "image_asset_pointer",
                asset_pointer: "file-service://cat.png",
                size_bytes: 456,
                width: 512,
                height: 512,
              },
            ],
          },
        },
      },
    };
    const { records } = buildRecordsFromConversation({
      conversation_id: "attach-1",
      current_node: "m2",
      mapping,
    });
    const assistantTurn = records[1];
    expect(assistantTurn.segments?.[0].attachments).toEqual([
      {
        content_type: "image_asset_pointer",
        asset_pointer: "file-service://cat.png",
        size_bytes: 456,
        width: 512,
        height: 512,
      },
    ]);
  });
});

describe("buildConversationApiFetchExpression", () => {
  const expression = buildConversationApiFetchExpression("fixture-1");

  it("hits both read-only endpoints with a Bearer token", () => {
    expect(expression).toContain("/api/auth/session");
    expect(expression).toContain("/backend-api/conversation/");
    expect(expression).toContain("Authorization");
    expect(expression).toContain("Bearer");
    expect(expression).toContain("fixture-1");
  });

  it("contains no navigation, click, submit, or write-method calls", () => {
    expect(expression).not.toMatch(/\.click\(/);
    expect(expression).not.toMatch(/\.submit\(/);
    expect(expression).not.toMatch(/location\.assign/);
    expect(expression).not.toMatch(/location\.href\s*=/);
    expect(expression).not.toMatch(/pushState/);
    expect(expression).not.toMatch(/method:\s*['"]POST['"]/);
  });
});

function buildMinimalConversationBody(): ChatGptConversationBody {
  const mapping: ChatGptConversationBody["mapping"] = {
    root: { id: "root", parent: undefined, children: [], message: null },
    m1: {
      id: "m1",
      parent: "root",
      children: [],
      message: {
        id: "m1",
        author: { role: "user" },
        content: { content_type: "text", parts: ["hi"] },
      },
    },
    m2: {
      id: "m2",
      parent: "m1",
      children: [],
      message: {
        id: "m2",
        author: { role: "assistant" },
        content: { content_type: "text", parts: ["hello"] },
      },
    },
  };
  return { title: "min", conversation_id: "min-1", current_node: "m2", mapping };
}

describe("exportChatGptConversationViaApi CDP surface", () => {
  it("only calls Runtime.evaluate and close", async () => {
    const evaluate = vi.fn(async () => ({
      result: { value: { ok: true, status: 200, body: buildMinimalConversationBody() } },
    }));
    const close = vi.fn(async () => undefined);
    const client = { Runtime: { evaluate }, close };
    const connect = vi.fn(async () => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/c/min-1" } as never,
    }));

    const value = await exportChatGptConversationViaApi({
      ref: "min-1",
      connect: connect as never,
    });

    expect(value.version).toBe(2);
    expect(value.engine).toBe("api");
    expect(value.records.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(value.complete).toBe(true);
    expect(value.missingTurnIndices).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
    expect(Object.keys(client)).toEqual(["Runtime", "close"]);
  });

  it("falls back to a ref-less connect when the ref-scoped tab is not found", async () => {
    const evaluate = vi.fn(async () => ({
      result: { value: { ok: true, status: 200, body: buildMinimalConversationBody() } },
    }));
    const client = { Runtime: { evaluate }, close: vi.fn(async () => undefined) };
    const connect = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('No ChatGPT tab matched "min-1". Use "oracle-tabs" to inspect live targets.'),
      )
      .mockResolvedValueOnce({
        client,
        targetId: "target-1",
        tab: { url: "https://chatgpt.com/c/min-1" } as never,
      });

    const value = await exportChatGptConversationViaApi({
      ref: "min-1",
      connect: connect as never,
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0][0]).toMatchObject({ ref: "min-1" });
    expect(connect.mock.calls[1][0]).toMatchObject({ ref: undefined });
    expect(value.records).toHaveLength(2);
  });

  it("surfaces a helpful error for a 404 conversation_inaccessible response", async () => {
    const evaluate = vi.fn(async () => ({
      result: {
        value: {
          ok: false,
          status: 404,
          statusText: "Not Found",
          bodySnippet: '{"detail":"conversation_inaccessible"}',
        },
      },
    }));
    const client = { Runtime: { evaluate }, close: vi.fn(async () => undefined) };
    const connect = vi.fn(async () => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/c/min-1" } as never,
    }));

    await expect(
      exportChatGptConversationViaApi({ ref: "min-1", connect: connect as never }),
    ).rejects.toThrow(/logged out|different account/);
  });

  it("strips text/markdown/segment text when redactText is set", async () => {
    const evaluate = vi.fn(async () => ({
      result: { value: { ok: true, status: 200, body: buildMinimalConversationBody() } },
    }));
    const client = { Runtime: { evaluate }, close: vi.fn(async () => undefined) };
    const connect = vi.fn(async () => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/c/min-1" } as never,
    }));

    const value = await exportChatGptConversationViaApi({
      ref: "min-1",
      connect: connect as never,
      redactText: true,
    });

    const serialized = JSON.stringify(value.records);
    expect(serialized).not.toContain("hello");
    expect(serialized).not.toContain('"hi"');
    for (const record of value.records) {
      expect(record.text).toBe("");
      expect(record.textHash).toBeTruthy();
    }
    const assistantRecord = value.records.find((r) => r.role === "assistant");
    expect(assistantRecord?.segments?.[0]?.text).toBeUndefined();
  });

  it("attaches the untouched backend-api body when includeRaw is set", async () => {
    const body = buildMinimalConversationBody();
    const evaluate = vi.fn(async () => ({
      result: { value: { ok: true, status: 200, body } },
    }));
    const client = { Runtime: { evaluate }, close: vi.fn(async () => undefined) };
    const connect = vi.fn(async () => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/c/min-1" } as never,
    }));

    const value = await exportChatGptConversationViaApi({
      ref: "min-1",
      connect: connect as never,
      includeRaw: true,
    });

    expect(value.raw).toEqual(body);
  });
});
