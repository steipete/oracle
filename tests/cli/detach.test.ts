import { describe, expect, test, vi } from "vitest";
import { shouldDetachSession, stopDetachedWorker } from "../../src/cli/detach.js";

describe("shouldDetachSession", () => {
  test("disables detach when env disables it", () => {
    const result = shouldDetachSession({
      engine: "browser",
      model: "gpt-5-pro",
      waitPreference: true,
      disableDetachEnv: true,
    });
    expect(result).toBe(false);
  });

  test("disables detach for non-pro models (gemini, codex, 5.1)", () => {
    const result = shouldDetachSession({
      engine: "api",
      model: "gemini-3-pro",
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(result).toBe(false);

    const codex = shouldDetachSession({
      engine: "api",
      model: "gpt-5.1-codex",
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(codex).toBe(false);

    const standard = shouldDetachSession({
      engine: "api",
      model: "gpt-5.1",
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(standard).toBe(false);
  });

  test("does not detach pro API runs when wait preference is true", () => {
    const pro52 = shouldDetachSession({
      engine: "api",
      model: "gpt-5.2-pro",
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(pro52).toBe(false);
  });

  test("allows detach for pro models when wait preference is false and env permits", () => {
    const pro52 = shouldDetachSession({
      engine: "api",
      model: "gpt-5.2-pro",
      waitPreference: false,
      disableDetachEnv: false,
    });
    expect(pro52).toBe(true);
  });

  test.each([true, false])(
    "isolates pro browser runs while wait preference is %s",
    (waitPreference) => {
      const result = shouldDetachSession({
        engine: "browser",
        model: "gpt-5-pro",
        waitPreference,
        disableDetachEnv: false,
      });
      expect(result).toBe(true);
    },
  );

  test("keeps non-pro browser runs inline", () => {
    const result = shouldDetachSession({
      engine: "browser",
      model: "gpt-5.6-sol",
      waitPreference: true,
      disableDetachEnv: false,
    });
    expect(result).toBe(false);
  });

  test("stops the detached worker on explicit cancellation", () => {
    const kill = vi.fn();

    expect(stopDetachedWorker(1234, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(1234, "SIGTERM");
  });

  test("accepts a worker that already exited during cancellation", () => {
    const error = Object.assign(new Error("missing"), { code: "ESRCH" });

    expect(
      stopDetachedWorker(1234, () => {
        throw error;
      }),
    ).toBe(false);
  });
});
