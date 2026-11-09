import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runGeminiWebWithFallback,
  saveFirstGeminiImageFromOutput,
} from "../../src/gemini-web/client.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function unavailableResponse(code = 1052): string {
  const response: unknown[] = [];
  const root: unknown[] = [];
  const levelTwo: unknown[] = [];
  const levelThree: unknown[] = [];
  const levelFour: unknown[] = [];
  const levelFive: unknown[] = [];
  levelFive[0] = code;
  levelFour[1] = levelFive;
  levelThree[0] = levelFour;
  levelTwo[2] = levelThree;
  root[5] = levelTwo;
  response[0] = root;
  return JSON.stringify(response);
}

function successResponse(text: string, reportedModel?: string): string {
  const candidate: unknown[] = [];
  candidate[0] = "rcid-1";
  candidate[1] = [text];
  const body: unknown[] = [];
  body[1] = ["cid", "rid", "rcid-1"];
  body[4] = [candidate];
  if (reportedModel) {
    body[42] = ["95a4c0abcba24364", null, null, reportedModel];
  }
  return `)]}'\n\n${JSON.stringify([[null, null, JSON.stringify(body)]])}`;
}

function webChannelFrame(id: number, payload: unknown): string {
  const frame = JSON.stringify([[id, JSON.stringify(payload)]]);
  return String(frame.length) + "\n" + frame;
}

function webChannelResponse(text: string, reportedModel?: string, rawInner?: string): string {
  const raw = successResponse(text, reportedModel);
  const inner = rawInner ?? JSON.parse(raw.slice(raw.indexOf("[")))[0][2];
  const wrapper = JSON.stringify([null, null, null, inner]);
  const body: unknown[] = Array(7).fill(null);
  body[6] = [["1", null, null, wrapper]];
  const top = [null, JSON.stringify(body)];
  return [
    webChannelFrame(1, [[]]),
    webChannelFrame(2, [JSON.stringify(top)]),
    webChannelFrame(3, [[null, null, null, []]]),
  ].join("");
}

function mockArgonWebChannel(
  text: string,
  reportedModel?: string,
  rawInner?: string,
  channelOverride?: string | string[],
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const channelResponses = Array.isArray(channelOverride) ? [...channelOverride] : null;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://gemini.google.com/app") {
      return new Response('{"d2zJAe":"AIzaTestKey"}');
    }
    if (url.includes("/v1/processSession") && url.includes("RID=rpc")) {
      return new Response(
        channelResponses?.shift() ??
          (typeof channelOverride === "string" ? channelOverride : undefined) ??
          webChannelResponse(text, reportedModel, rawInner),
      );
    }
    if (url.includes("/v1/processSession")) {
      const body = String(init?.body ?? "");
      if (body === "count=0") {
        return new Response('0\n[["c","test-sid"]]', {
          headers: { "x-http-session-id": "test-gsid" },
        });
      }
      return new Response("");
    }
    throw new Error("Unexpected fetch URL: " + url);
  });
  return { fetchMock, calls };
}

describe("Gemini web model fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects Argon High in the WebChannel handshake and payload", async () => {
    const { calls } = mockArgonWebChannel("argonaut", "4 Argon High");
    const output = await runGeminiWebWithFallback({
      prompt: "Say hello.",
      model: "gemini-4-argon-high",
      cookieMap: { SID: "fake-test-cookie" },
    });
    expect(output.text).toBe("argonaut");
    expect(output.effectiveModel).toBe("gemini-4-argon-high");

    const handshake = calls.find((call) => String(call.init?.body) === "count=0");
    expect(handshake).toBeDefined();
    const httpHeaders = new URL(handshake!.url).searchParams.get("$httpHeaders") ?? "";
    const modelHeader = httpHeaders.match(/x-goog-ext-525001261-bin:([^\r\n]+)/i)?.[1];
    expect(modelHeader).toBeDefined();
    expect(Buffer.from(modelHeader!, "base64").toString()).toContain("95a4c0abcba24364");
    expect(httpHeaders).toContain("X-WebChannel-Content-Type:application/json+protobuf");

    const posts = calls.filter(
      (call) =>
        call.url.includes("/v1/processSession") && String(call.init?.body).startsWith("count=1"),
    );
    expect(posts).toHaveLength(3);
    const firstPayload = new URLSearchParams(String(posts[0].init?.body)).get("req0___data__");
    const firstData = JSON.parse(firstPayload!);
    const inner = firstData[0][7][4][0];
    expect(inner[79]).toBe(8);
    expect(inner[80]).toBe(2);
  });

  it.each(["3.5 Flash-Lite", "4 Argon", undefined])(
    "fails closed when Argon High is not confirmed (reported: %s)",
    async (reportedModel) => {
      const { calls } = mockArgonWebChannel("unexpected answer", reportedModel);
      await expect(
        runGeminiWebWithFallback({
          prompt: "Say hello.",
          model: "gemini-4-argon-high",
          cookieMap: { SID: "fake-test-cookie" },
        }),
      ).rejects.toThrow("Gemini 4 Argon High model verification failed");
      expect(calls.filter((call) => call.url.includes("/v1/processSession")).length).toBe(5);
    },
  );

  it("preserves legitimate answer text that resembles a generic upstream error sentence", async () => {
    mockArgonWebChannel(
      "I encountered an error doing what you asked. Could you try again?",
      "4 Argon High",
    );

    const output = await runGeminiWebWithFallback({
      prompt: "Reply exactly: I encountered an error doing what you asked. Could you try again?",
      model: "gemini-4-argon-high",
      cookieMap: {},
    });
    expect(output.text).toBe("I encountered an error doing what you asked. Could you try again?");
    expect(output.effectiveModel).toBe("gemini-4-argon-high");
  });

  it("rejects Argon protocol errors using the parsed error code rather than answer prose", async () => {
    mockArgonWebChannel("", undefined, unavailableResponse(1061));

    await expect(
      runGeminiWebWithFallback({
        prompt: "test",
        model: "gemini-4-argon-high",
        cookieMap: {},
      }),
    ).rejects.toThrow("Gemini web request failed with error code 1061.");
  });

  it("does not hide a protocol error after a partial response", async () => {
    const end = webChannelFrame(3, [[null, null, null, []]]);
    const first = webChannelResponse("partial", "4 Argon High");
    const error = webChannelResponse("", undefined, unavailableResponse(1061));
    const merged = first.slice(0, first.lastIndexOf(end)) + error;
    mockArgonWebChannel("", undefined, undefined, merged);
    await expect(
      runGeminiWebWithFallback({ prompt: "test", model: "gemini-4-argon-high", cookieMap: {} }),
    ).rejects.toThrow("Gemini web request failed with error code 1061.");
  });

  it("rejects a truncated response frame", async () => {
    const complete = webChannelResponse("partial", "4 Argon High");
    const firstTwo = complete.slice(
      0,
      complete.lastIndexOf(webChannelFrame(3, [[null, null, null, []]])),
    );
    mockArgonWebChannel("", undefined, undefined, firstTwo + "3\n[");
    await expect(
      runGeminiWebWithFallback({ prompt: "test", model: "gemini-4-argon-high", cookieMap: {} }),
    ).rejects.toThrow("truncated frame");
  });
  it("reconnects after a clean poll response before receiving frames", async () => {
    const firstPoll = webChannelFrame(1, [["noop"]]);
    const secondPoll = webChannelResponse("reconnected", "4 Argon High");
    const { calls } = mockArgonWebChannel("", undefined, undefined, [firstPoll, secondPoll]);
    const output = await runGeminiWebWithFallback({
      prompt: "test",
      model: "gemini-4-argon-high",
      cookieMap: {},
    });
    expect(output.text).toBe("reconnected");
    expect(calls.filter((call) => call.url.includes("RID=rpc")).length).toBe(2);
  });
  it("rejects upstream status frames after a partial response", async () => {
    const complete = webChannelResponse("partial", "4 Argon High");
    const end = webChannelFrame(3, [[null, null, null, []]]);
    const partial = complete.slice(0, complete.lastIndexOf(end));
    const status = webChannelFrame(3, { __sm__: { status: 16 } });
    mockArgonWebChannel("", undefined, undefined, partial + status);
    await expect(
      runGeminiWebWithFallback({ prompt: "test", model: "gemini-4-argon-high", cookieMap: {} }),
    ).rejects.toThrow("upstream status frame");
  });

  it("fails when the requested model is unavailable and fallback is disabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gemini.google.com/app") {
        return new Response('<html>"SNlM0e":"test-access-token"</html>', {
          status: 200,
        });
      }
      if (url.includes("/StreamGenerate")) {
        return new Response(unavailableResponse(), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    await expect(
      runGeminiWebWithFallback({
        prompt: "test",
        model: "gemini-3.1-pro",
        cookieMap: { SID: "cookie" },
        allowModelFallback: false,
      }),
    ).rejects.toThrow(
      "Requested Gemini web model gemini-3.1-pro is unavailable and model fallback is disabled.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the existing Flash-Lite fallback by default", async () => {
    let generateCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gemini.google.com/app") {
        return new Response('<html>"SNlM0e":"test-access-token"</html>', {
          status: 200,
        });
      }
      if (url.includes("/StreamGenerate")) {
        generateCalls += 1;
        return new Response(
          generateCalls === 1 ? unavailableResponse() : successResponse("fallback ok"),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const result = await runGeminiWebWithFallback({
      prompt: "test",
      model: "gemini-3.1-pro",
      cookieMap: { SID: "cookie" },
    });

    expect(result.text).toBe("fallback ok");
    expect(result.effectiveModel).toBe("gemini-3.1-flash-lite");
    expect(generateCalls).toBe(2);
  });

  it("rejects other upstream errors instead of completing with an empty answer", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gemini.google.com/app") {
        return new Response('<html>"SNlM0e":"test-access-token"</html>', {
          status: 200,
        });
      }
      if (url.includes("/StreamGenerate")) {
        return new Response(unavailableResponse(1061), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    await expect(
      runGeminiWebWithFallback({
        prompt: "test",
        model: "gemini-3.1-pro",
        cookieMap: { SID: "cookie" },
        allowModelFallback: false,
      }),
    ).rejects.toThrow("Gemini web request failed with error code 1061.");
  });

  it("keeps raw image downloads reachable through the success guard", async () => {
    const imageUrl = "https://lh3.googleusercontent.com/gg-dl/synthetic-proof";
    const bytes = new Uint8Array([9, 8, 7, 6]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gemini.google.com/app")
        return new Response('"SNlM0e":"test-access-token"');
      if (url.includes("/StreamGenerate")) {
        const body: unknown[] = [];
        body[1] = ["cid", "rid", "rcid"];
        body[4] = [["rcid", [""]]];
        body[7] = { unparsedImage: imageUrl };
        return new Response(`)]}'\n\n${JSON.stringify([[null, null, JSON.stringify(body)]])}`);
      }
      if (url.startsWith(imageUrl))
        return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
      throw new Error("Unexpected fixture request");
    });
    const output = await runGeminiWebWithFallback({
      prompt: "image",
      model: "gemini-3.1-pro",
      cookieMap: {},
    });
    expect(output.text).toBe("");
    expect(output.images).toEqual([]);
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-raw-image-"));
    try {
      const filename = path.join(directory, "image.jpg");
      await expect(saveFirstGeminiImageFromOutput(output, {}, filename)).resolves.toMatchObject({
        saved: true,
      });
      expect(new Uint8Array(await readFile(filename))).toEqual(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
