import { describe, it, expect } from "vitest";
import {
  parseGeminiStreamGenerateResponse,
  isGeminiModelUnavailable,
} from "../../src/gemini-web/client.js";

function makeRawResponseWithBody(body: unknown): string {
  return makeRawResponseWithBodies([body]);
}

function makeRawResponseWithBodies(bodies: unknown[]): string {
  const responseJson = bodies.map((body) => [null, null, JSON.stringify(body)]);
  return `)]}'\n\n${JSON.stringify(responseJson)}`;
}

function makeBodyWithText(rcid: string, text: string): unknown[] {
  const candidate: unknown[] = [];
  candidate[0] = rcid;
  candidate[1] = [text];

  const body: unknown[] = [];
  body[1] = ["cid", "rid", rcid];
  body[4] = [candidate];
  return body;
}

describe("gemini-web parseGeminiStreamGenerateResponse", () => {
  it("parses text + thoughts from minimal body payload", () => {
    const candidate: unknown[] = [];
    candidate[0] = "rcid-1";
    candidate[1] = ["Hello"];
    candidate[37] = [["Thinking"]];

    const body: unknown[] = [];
    body[1] = ["cid", "rid", "rcid-1"];
    body[4] = [candidate];

    const parsed = parseGeminiStreamGenerateResponse(makeRawResponseWithBody(body));
    expect(parsed.text).toBe("Hello");
    expect(parsed.thoughts).toBe("Thinking");
    expect(parsed.metadata).toEqual(["cid", "rid", "rcid-1"]);
  });

  it("extracts web image candidates", () => {
    const candidate: unknown[] = [];
    candidate[0] = "rcid-1";
    candidate[1] = ["Hello"];

    // firstCandidate[12][1] = webImages
    const webImage: unknown[] = [];
    webImage[0] = [];
    (webImage[0] as unknown[])[0] = ["https://example.com/img.png"];
    (webImage[0] as unknown[])[4] = "alt text";
    webImage[7] = ["Title"];

    candidate[12] = [];
    (candidate[12] as unknown[])[1] = [webImage];

    const body: unknown[] = [];
    body[1] = ["cid", "rid", "rcid-1"];
    body[4] = [candidate];

    const parsed = parseGeminiStreamGenerateResponse(makeRawResponseWithBody(body));
    expect(parsed.images[0]).toEqual({
      kind: "web",
      url: "https://example.com/img.png",
      title: "Title",
      alt: "alt text",
    });
  });

  it("uses fallback text when response is a card_content URL", () => {
    const candidate: unknown[] = [];
    candidate[0] = "rcid-1";
    candidate[1] = ["http://googleusercontent.com/card_content/123"];
    candidate[22] = ["Expanded card content"];

    const body: unknown[] = [];
    body[1] = ["cid", "rid", "rcid-1"];
    body[4] = [candidate];

    const parsed = parseGeminiStreamGenerateResponse(makeRawResponseWithBody(body));
    expect(parsed.text).toBe("Expanded card content");
  });

  it("picks the latest non-empty text across streaming chunks", () => {
    const raw = makeRawResponseWithBodies([
      makeBodyWithText("rcid-1", ""),
      makeBodyWithText("rcid-1", "Pong! 🏓 partial"),
      makeBodyWithText("rcid-1", "Pong! 🏓 partial answer with more"),
      makeBodyWithText("rcid-1", "Pong! 🏓 partial answer with more — final."),
    ]);

    const parsed = parseGeminiStreamGenerateResponse(raw);
    expect(parsed.text).toBe("Pong! 🏓 partial answer with more — final.");
  });

  it("still parses a single coalesced chunk (regression guard)", () => {
    const raw = makeRawResponseWithBody(makeBodyWithText("rcid-1", "single-chunk reply"));
    const parsed = parseGeminiStreamGenerateResponse(raw);
    expect(parsed.text).toBe("single-chunk reply");
  });

  it("preserves the previous non-empty chunk when a later chunk has empty text", () => {
    const raw = makeRawResponseWithBodies([
      makeBodyWithText("rcid-1", "first answer"),
      makeBodyWithText("rcid-1", ""),
    ]);

    const parsed = parseGeminiStreamGenerateResponse(raw);
    expect(parsed.text).toBe("first answer");
  });

  it("extracts model-unavailable error code 1052 from response json", () => {
    const responseJson: unknown[] = [];
    // errorCode path: [0,5,2,0,1,0]
    responseJson[0] = [];
    (responseJson[0] as unknown[])[5] = [];
    ((responseJson[0] as unknown[])[5] as unknown[])[2] = [];
    (((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] = [];
    ((((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] as unknown[])[1] = [];
    (
      (
        (((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] as unknown[]
      )[1] as unknown[]
    )[0] = 1052;

    const raw = `)]}'\n\n${JSON.stringify(responseJson)}`;
    expect(isGeminiModelUnavailable(parseGeminiStreamGenerateResponse(raw).errorCode)).toBe(true);
  });
});
