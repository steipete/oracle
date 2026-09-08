import { afterEach, expect, test, vi } from "vitest";
import { fetchGeminiWebResource } from "../../src/gemini-web/http.js";

afterEach(() => vi.restoreAllMocks());

test("preserves the configured fetch transport and request options", async () => {
  const response = new Response("configured transport");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const init = { headers: { "x-synthetic": "proof" }, redirect: "manual" as const };
  expect(await fetchGeminiWebResource("https://gemini.google.com/app", init)).toBe(response);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("https://gemini.google.com/app", init);
});

test("explains an oversized Google response without exposing request details", async () => {
  const error = new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_OVERFLOW" } });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
  await expect(fetchGeminiWebResource("https://gemini.google.com/app")).rejects.toThrow(
    "NODE_OPTIONS=--max-http-header-size=65536",
  );
});

test("preserves unrelated fetch failures", async () => {
  const error = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
  await expect(fetchGeminiWebResource("https://gemini.google.com/app")).rejects.toBe(error);
});
