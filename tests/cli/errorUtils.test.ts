import { describe, expect, test } from "vitest";
import { isErrorLogged, markErrorLogged, formatCliError } from "../../src/cli/errorUtils.ts";

describe("errorUtils", () => {
  test("marks errors as logged", () => {
    const err = new Error("boom");
    expect(isErrorLogged(err)).toBe(false);
    markErrorLogged(err);
    expect(isErrorLogged(err)).toBe(true);
  });

  test("ignores non-error values", () => {
    expect(isErrorLogged("oops")).toBe(false);
    markErrorLogged("oops");
    expect(isErrorLogged("oops")).toBe(false);
  });
});

describe("formatCliError", () => {
  test.each([new Error(), new Error("   "), "", "\n", undefined, null])(
    "never renders a blank failure for %s",
    (error) => {
      expect(formatCliError(error)).toBe(
        "An unexpected error occurred. Retry with --verbose for more details.",
      );
    },
  );
  test("preserves useful error messages and codes", () => {
    expect(formatCliError(new Error("missing conversation"))).toBe("missing conversation");
    expect(formatCliError(Object.assign(new Error(), { code: "ECONNREFUSED" }))).toContain(
      "ECONNREFUSED",
    );
  });
});
