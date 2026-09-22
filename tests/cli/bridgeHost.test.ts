import { describe, expect, test } from "vitest";
import { resolveBridgeHostToken } from "../../src/cli/bridge/host.js";

describe("resolveBridgeHostToken", () => {
  test("uses the explicit token when provided", () => {
    expect(resolveBridgeHostToken("explicit-token", "env-token")).toBe("explicit-token");
  });

  test("explicit --token auto generates a fresh token even when an env token exists", () => {
    const generated = resolveBridgeHostToken("auto", "stale-env-token");
    expect(generated).not.toBe("stale-env-token");
    expect(generated).toMatch(/^[0-9a-f]{32}$/);
  });

  test("auto regenerates on each call", () => {
    expect(resolveBridgeHostToken("auto", undefined)).not.toBe(
      resolveBridgeHostToken("auto", undefined),
    );
  });

  test("falls back to the inherited background token when --token is unset", () => {
    expect(resolveBridgeHostToken(undefined, "env-token")).toBe("env-token");
  });

  test("generates a token when neither flag nor env are set", () => {
    expect(resolveBridgeHostToken(undefined, undefined)).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveBridgeHostToken("", "  ")).toMatch(/^[0-9a-f]{32}$/);
  });
});
