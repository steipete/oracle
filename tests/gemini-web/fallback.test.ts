import { afterEach, describe, expect, it, vi } from "vitest";
import { runGeminiWebWithFallback } from "../../src/gemini-web/client.js";

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
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
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
					generateCalls === 1
						? unavailableResponse()
						: successResponse("fallback ok"),
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
});
