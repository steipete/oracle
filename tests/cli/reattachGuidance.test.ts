import { describe, expect, test } from "vitest";
import { formatBrowserReattachGuidance } from "../../src/cli/reattachGuidance.js";

describe("formatBrowserReattachGuidance", () => {
  test("includes the real session slug and all reattach commands", () => {
    const message = formatBrowserReattachGuidance("gpt55-pro-plan-review");

    expect(message).toContain(
      "This run did not return cleanly, but it may still be alive. Reattach:",
    );
    expect(message).toContain(
      "oracle session gpt55-pro-plan-review --render    # final markdown when complete",
    );
    expect(message).toContain("oracle session gpt55-pro-plan-review --live      # tail until done");
    expect(message).toContain(
      "oracle session gpt55-pro-plan-review --harvest   # snapshot the current answer now",
    );
  });
});
