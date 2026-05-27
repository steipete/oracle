import { describe, expect, it } from "vitest";
import { runOracle, extractTextOutput } from "../../src/oracle.js";

const live = process.env.ORACLE_LIVE_TEST === "1";
const hasKey = Boolean(process.env.GEMINI_API_KEY);
const isAccessOrAuthError = (message: string): boolean =>
  /api key expired|api[_ ]?key[_ ]?invalid|invalid api key|API_KEY_INVALID|INVALID_ARGUMENT|permission|access|does not exist|not found|404/i.test(
    message,
  );

(live ? describe : describe.skip)("Gemini live smoke", () => {
  if (!hasKey) {
    it.skip("requires GEMINI_API_KEY", () => {});
    return;
  }

  it("returns a short answer", async () => {
    let result: Awaited<ReturnType<typeof runOracle>>;
    try {
      result = await runOracle(
        {
          prompt: "Give one short sentence about photosynthesis.",
          model: "gemini-3-pro",
          search: false,
        },
        {
          log: () => {},
          write: () => true,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAccessOrAuthError(message)) {
        return;
      }
      throw error;
    }
    if (result.mode !== "live") {
      throw new Error(`Expected live result, received ${result.mode ?? "unknown"}`);
    }
    const text = extractTextOutput(result.response);
    expect(text?.length ?? 0).toBeGreaterThan(10);
  }, 120_000);
});
