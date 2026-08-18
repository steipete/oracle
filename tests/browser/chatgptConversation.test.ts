import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildNormalizeAndDigestExpressionForTest,
  captureProviderNativeConversation,
} from "../../src/browser/chatgptConversation.js";

interface FixtureTurn {
  index: number;
  role: string;
  content_type: string;
  bytes: number;
  sha256: string;
}

async function evaluateInNode(expression: string): Promise<unknown> {
  // The capture expression is written to run in the page. Node provides the same
  // primitives it depends on (TextEncoder, crypto.subtle), so the normalizer can
  // be checked here without a browser.
  return await (0, eval)(expression);
}

describe("provider conversation normalization", () => {
  it("reproduces the reference normalizer byte-for-byte across every content type", async () => {
    // The expected digests in this fixture were produced by the downstream
    // proof-grade normalizer itself, not by this implementation. That is the
    // point: these two must agree, and only one of them is authoritative.
    //
    // The awkward cases are deliberate. `multimodal_text` and unknown content
    // types fall back to Python's json.dumps(sort_keys=True, ensure_ascii=False),
    // which writes ", " and ": " separators, sorts keys, leaves non-ASCII
    // unescaped, and — the part JSON.parse destroys — renders 1.0 as "1.0" and 1
    // as "1". A literal-preserving parse is what keeps those apart.
    const fixturePath = path.join(
      process.cwd(),
      "tests/fixtures/provider-conversation-normalization.json",
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      raw: string;
      expected: FixtureTurn[];
    };

    const result = (await evaluateInNode(
      buildNormalizeAndDigestExpressionForTest(fixture.raw),
    )) as {
      ok: boolean;
      perTurn: {
        index: number;
        role: string;
        contentType: string;
        bytes: number;
        sha256Decimal: number[];
      }[];
    };

    expect(result.ok).toBe(true);
    expect(result.perTurn).toHaveLength(fixture.expected.length);
    for (const [position, expected] of fixture.expected.entries()) {
      const actual = result.perTurn[position];
      expect({
        index: actual?.index,
        role: actual?.role,
        content_type: actual?.contentType,
        bytes: actual?.bytes,
        sha256: Buffer.from(actual?.sha256Decimal ?? []).toString("hex"),
      }).toEqual(expected);
    }
  });

  it("skips system turns and follows the current-node chain", async () => {
    const fixturePath = path.join(
      process.cwd(),
      "tests/fixtures/provider-conversation-normalization.json",
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      raw: string;
      expected: FixtureTurn[];
    };
    const document = JSON.parse(fixture.raw) as { mapping: Record<string, unknown> };
    // Six nodes carry messages; one of them is the system turn that must not
    // appear, and the root carries none.
    expect(Object.keys(document.mapping)).toHaveLength(fixture.expected.length + 2);
    expect(fixture.expected.some((turn) => turn.role === "system")).toBe(false);
  });
});

describe("provider capture failure handling", () => {
  it("treats a conversation with no id as a normal unavailable result, not an error", async () => {
    const outcome = await captureProviderNativeConversation({
      Runtime: {
        evaluate: async () => {
          throw new Error("should never be called");
        },
      } as never,
      conversationId: undefined,
    });
    expect(outcome).toEqual({ status: "unavailable", failure: { reason: "no-conversation-id" } });
  });

  it("reports a bot-mitigation challenge as its own reason rather than a generic failure", async () => {
    // A 403 here means "retry later from a page that looks human", not "you are
    // logged out" — and it must never be mistaken for a failed run.
    const outcome = await captureProviderNativeConversation({
      Runtime: {
        evaluate: async () => ({
          result: { value: { ok: false, reason: "challenged", httpStatus: 403 } },
        }),
      } as never,
      conversationId: "abc-123",
    });
    expect(outcome).toEqual({
      status: "unavailable",
      failure: { reason: "challenged", detail: undefined, httpStatus: 403 },
    });
  });

  it("surfaces an in-page exception instead of silently returning nothing", async () => {
    const outcome = await captureProviderNativeConversation({
      Runtime: {
        evaluate: async () => ({ exceptionDetails: { text: "TypeError: boom" }, result: {} }),
      } as never,
      conversationId: "abc-123",
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome).toMatchObject({ failure: { reason: "evaluate-failed" } });
  });
});
