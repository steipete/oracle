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

describe("Gemini web model fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects Argon High at both protocol locations and confirms reported model", async () => {
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://gemini.google.com/app") {
        return new Response('"SNlM0e":"test-access-token"');
      }
      if (url.includes("/StreamGenerate")) {
        requestCount += 1;
        const header = JSON.parse(new Headers(init?.headers).get("x-goog-ext-525001261-jspb")!);
        expect(header[4]).toBe("95a4c0abcba24364");
        expect(header[14]).toBe(8);
        expect(header[15]).toBe(2);
        const form = new URLSearchParams(String(init?.body));
        const payload = JSON.parse(form.get("f.req")!);
        const inner = JSON.parse(payload[1]);
        expect(inner[79]).toBe(8);
        expect(inner[80]).toBe(2);
        return new Response(successResponse("argonaut", "4 Argon High"));
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    const output = await runGeminiWebWithFallback({
      prompt: "Say hello.",
      model: "gemini-4-argon-high",
      cookieMap: { SID: "fake-test-cookie" },
    });
    expect(output.text).toBe("argonaut");
    expect(output.effectiveModel).toBe("gemini-4-argon-high");
    expect(requestCount).toBe(1);
  });

  it.each(["3.5 Flash-Lite", "4 Argon", undefined])(
    "fails closed when Argon High is not confirmed (reported: %s)",
    async (reportedModel) => {
      let requests = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input) === "https://gemini.google.com/app") {
          return new Response('"SNlM0e":"test-access-token"');
        }
        requests += 1;
        return new Response(successResponse("unexpected answer", reportedModel));
      });
      await expect(
        runGeminiWebWithFallback({
          prompt: "Say hello.",
          model: "gemini-4-argon-high",
          cookieMap: { SID: "fake-test-cookie" },
        }),
      ).rejects.toThrow("Gemini 4 Argon High model verification failed");
      expect(requests).toBe(1);
    },
  );

  it("preserves legitimate answer text that resembles a generic upstream error sentence", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "https://gemini.google.com/app") {
        return new Response('"SNlM0e":"test-access-token"');
      }
      return new Response(
        successResponse(
          "I encountered an error doing what you asked. Could you try again?",
          "4 Argon High",
        ),
      );
    });

    const output = await runGeminiWebWithFallback({
      prompt: "Reply exactly: I encountered an error doing what you asked. Could you try again?",
      model: "gemini-4-argon-high",
      cookieMap: {},
    });
    expect(output.text).toBe("I encountered an error doing what you asked. Could you try again?");
    expect(output.effectiveModel).toBe("gemini-4-argon-high");
  });

  it("rejects Argon protocol errors using the parsed error code rather than answer prose", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "https://gemini.google.com/app") {
        return new Response('"SNlM0e":"test-access-token"');
      }
      return new Response(unavailableResponse(1061), { status: 200 });
    });

    await expect(
      runGeminiWebWithFallback({
        prompt: "test",
        model: "gemini-4-argon-high",
        cookieMap: {},
      }),
    ).rejects.toThrow("Gemini web request failed with error code 1061.");
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
