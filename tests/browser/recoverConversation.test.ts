import { describe, expect, test } from "vitest";
import {
  resolveRecoveryProfileDir,
  resolveRecoveryUrl,
} from "../../src/browser/recoverConversation.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

function metaWith(
  runtime: Record<string, unknown> | undefined,
  harvest: Record<string, unknown> | undefined,
  config: Record<string, unknown> | undefined = undefined,
): SessionMetadata {
  return {
    id: "x",
    createdAt: "2026-05-26T00:00:00.000Z",
    status: "completed",
    options: {},
    mode: "browser",
    browser: {
      config: config ?? {},
      runtime: runtime ?? {},
      harvest: harvest ?? {},
    },
  } as unknown as SessionMetadata;
}

describe("resolveRecoveryUrl", () => {
  test("accepts a chatgpt.com/c/<id> conversation URL", () => {
    expect(
      resolveRecoveryUrl(metaWith({ tabUrl: "https://chatgpt.com/c/abc-123" }, undefined)),
    ).toBe("https://chatgpt.com/c/abc-123");
  });

  test("accepts a legacy chat.openai.com/c/<id> URL", () => {
    expect(
      resolveRecoveryUrl(metaWith({ tabUrl: "https://chat.openai.com/c/legacy-id" }, undefined)),
    ).toBe("https://chat.openai.com/c/legacy-id");
  });

  test("rejects the ChatGPT home shell URL", () => {
    expect(resolveRecoveryUrl(metaWith({ tabUrl: "https://chatgpt.com/" }, undefined))).toBeNull();
  });

  test("rejects a project shell URL with no conversation segment", () => {
    expect(
      resolveRecoveryUrl(
        metaWith({ tabUrl: "https://chatgpt.com/g/g-12345-some-project" }, undefined),
      ),
    ).toBeNull();
  });

  test("rejects an unrelated external URL stored in metadata", () => {
    expect(
      resolveRecoveryUrl(metaWith({ tabUrl: "https://example.com/some/path" }, undefined)),
    ).toBeNull();
  });

  test("rejects malformed URL strings", () => {
    expect(resolveRecoveryUrl(metaWith({ tabUrl: "not a url" }, undefined))).toBeNull();
    expect(resolveRecoveryUrl(metaWith({ tabUrl: "" }, undefined))).toBeNull();
  });

  test("prefers harvest.url when runtime.tabUrl is a stale shell URL", () => {
    expect(
      resolveRecoveryUrl(
        metaWith({ tabUrl: "https://chatgpt.com/" }, { url: "https://chatgpt.com/c/from-harvest" }),
      ),
    ).toBe("https://chatgpt.com/c/from-harvest");
  });

  test("falls back to runtime.tabUrl when harvest.url is missing", () => {
    expect(
      resolveRecoveryUrl(metaWith({ tabUrl: "https://chatgpt.com/c/runtime-only" }, undefined)),
    ).toBe("https://chatgpt.com/c/runtime-only");
  });

  test("returns null when neither candidate is a valid conversation URL", () => {
    expect(
      resolveRecoveryUrl(
        metaWith({ tabUrl: "https://chatgpt.com/" }, { url: "https://example.com/foo" }),
      ),
    ).toBeNull();
  });

  test("ignores empty browser metadata", () => {
    expect(resolveRecoveryUrl({ id: "x" } as unknown as SessionMetadata)).toBeNull();
  });
});

describe("resolveRecoveryProfileDir", () => {
  test("uses the session manual-login profile dir", () => {
    expect(
      resolveRecoveryProfileDir(
        metaWith({ tabUrl: "https://chatgpt.com/c/abc" }, undefined, {
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-profile",
        }),
      ),
    ).toBe("/tmp/oracle-profile");
  });

  test("prefers the recorded runtime profile dir for default manual-login sessions", () => {
    expect(
      resolveRecoveryProfileDir(
        metaWith(
          {
            tabUrl: "https://chatgpt.com/c/abc",
            userDataDir: "/tmp/runtime-profile",
          },
          undefined,
          {
            manualLogin: true,
          },
        ),
      ),
    ).toBe("/tmp/runtime-profile");
  });

  test("allows a recorded runtime profile when manual-login was implicit", () => {
    expect(
      resolveRecoveryProfileDir(
        metaWith(
          {
            tabUrl: "https://chatgpt.com/c/abc",
            userDataDir: "/tmp/windows-default-profile",
          },
          undefined,
          {},
        ),
      ),
    ).toBe("/tmp/windows-default-profile");
  });

  test("rejects sessions that did not use manual-login mode", () => {
    expect(() =>
      resolveRecoveryProfileDir(
        metaWith(
          {
            tabUrl: "https://chatgpt.com/c/abc",
            userDataDir: "/tmp/temp-profile",
          },
          undefined,
          {
            manualLogin: false,
          },
        ),
      ),
    ).toThrow(/manual-login browser profile/);
  });

  test("rejects missing manual-login profile dir", () => {
    expect(() =>
      resolveRecoveryProfileDir(
        metaWith({ tabUrl: "https://chatgpt.com/c/abc" }, undefined, {
          manualLogin: true,
        }),
      ),
    ).toThrow(/manual-login profile directory/);
  });
});
