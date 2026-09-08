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

function successResponse(text: string): string {
  const candidate: unknown[] = [];
  candidate[0] = "rcid-1";
  candidate[1] = [text];
  const body: unknown[] = [];
  body[1] = ["cid", "rid", "rcid-1"];
  body[4] = [candidate];
  return `)]}'\n\n${JSON.stringify([[null, null, JSON.stringify(body)]])}`;
}

describe("Gemini web model fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
