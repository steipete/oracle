import { afterEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { sessionStore } from "../../src/sessionStore.js";
import { startBrowserFollowUpSession } from "../../src/cli/browserFollowUp.js";

afterEach(() => {
  setOracleHomeDirOverrideForTest(null);
  vi.restoreAllMocks();
});

async function withOracleHome<T>(fn: (tmpHome: string) => Promise<T>): Promise<T> {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), "oracle-follow-up-"));
  setOracleHomeDirOverrideForTest(tmpHome);
  try {
    return await fn(tmpHome);
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
}

async function createBrowserParent() {
  const parent = await sessionStore.createSession(
    {
      prompt: "parent prompt",
      model: "gpt-5.5-pro",
      mode: "browser",
      waitPreference: false,
      browserConfig: {
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
        url: "https://chatgpt.com/",
        chatgptUrl: "https://chatgpt.com/",
        researchMode: "deep",
        archiveConversations: "auto",
      },
    },
    "/tmp/project",
    undefined,
    "parent-session",
  );
  await sessionStore.updateSession(parent.id, {
    status: "completed",
    browser: {
      ...(parent.browser ?? {}),
      runtime: {
        tabUrl: "https://chatgpt.com/c/abc123",
        conversationId: "abc123",
      },
    },
  });
  return (await sessionStore.readSession(parent.id)) ?? parent;
}

describe("browser follow-up sessions", () => {
  test("creates a detached child session linked to the parent conversation", async () => {
    await withOracleHome(async () => {
      const parent = await createBrowserParent();
      const launchDetachedSessionRunner = vi.fn(async () => true);
      const launchDetachedSessionFinalizer = vi.fn(async () => true);

      const result = await startBrowserFollowUpSession(
        parent.id,
        {
          prompt: "challenge the recommendation",
          slug: "child follow up now",
          cliEntrypoint: "/tmp/oracle-cli.js",
        },
        { launchDetachedSessionRunner, launchDetachedSessionFinalizer },
      );

      expect(result.session.id).toBe("child-follow-up-now");
      expect(result.session.parentSessionId).toBe(parent.id);
      expect(result.session.followUpOfSessionId).toBe(parent.id);
      expect(result.session.options.parentSessionId).toBe(parent.id);
      expect(result.session.options.followUpOfSessionId).toBe(parent.id);
      expect(result.session.options.prompt).toBe("challenge the recommendation");
      expect(result.session.options.waitPreference).toBe(false);
      expect(result.session.browser?.config).toMatchObject({
        url: "https://chatgpt.com/",
        resumeConversationUrl: "https://chatgpt.com/c/abc123",
        browserTabRef: null,
        researchMode: "off",
        archiveConversations: "never",
      });
      expect(result.session.lifecycle).toMatchObject({
        engine: "browser",
        detached: true,
        reattachCommand: `oracle session ${result.session.id}`,
      });
      expect(launchDetachedSessionRunner).toHaveBeenCalledWith(result.session.id, {
        cliEntrypoint: "/tmp/oracle-cli.js",
        env: undefined,
      });
      expect(launchDetachedSessionFinalizer).toHaveBeenCalledWith(result.session.id, {
        cliEntrypoint: "/tmp/oracle-cli.js",
        env: undefined,
      });
    });
  });

  test("uses a live tab ref instead of recovery when recover is disabled", async () => {
    await withOracleHome(async () => {
      const parent = await createBrowserParent();
      const result = await startBrowserFollowUpSession(
        parent.id,
        {
          prompt: "one more turn",
          recover: false,
          cliEntrypoint: "/tmp/oracle-cli.js",
        },
        {
          launchDetachedSessionRunner: vi.fn(async () => true),
          launchDetachedSessionFinalizer: vi.fn(async () => true),
        },
      );

      expect(result.session.id).toBe("parent-session-follow-up");
      expect(result.session.browser?.config).toMatchObject({
        attachRunning: true,
        url: "https://chatgpt.com/",
        browserTabRef: "https://chatgpt.com/c/abc123",
        resumeConversationUrl: "https://chatgpt.com/c/abc123",
      });
    });
  });

  test("rejects invalid parent sessions and unsupported files", async () => {
    await withOracleHome(async () => {
      await expect(
        startBrowserFollowUpSession("missing", {
          prompt: "next",
          cliEntrypoint: "/tmp/oracle-cli.js",
        }),
      ).rejects.toThrow(/No parent session found/i);

      const apiParent = await sessionStore.createSession(
        { prompt: "api", model: "gpt-5.1", mode: "api" },
        "/tmp/project",
        undefined,
        "api-parent-session",
      );
      await expect(
        startBrowserFollowUpSession(apiParent.id, {
          prompt: "next",
          cliEntrypoint: "/tmp/oracle-cli.js",
        }),
      ).rejects.toThrow(/not a browser session/i);

      await expect(
        startBrowserFollowUpSession(apiParent.id, {
          prompt: "next",
          files: ["a.ts"],
          cliEntrypoint: "/tmp/oracle-cli.js",
        }),
      ).rejects.toThrow(/prompt-only/i);
    });
  });

  test("rejects browser parents without a recoverable conversation url", async () => {
    await withOracleHome(async () => {
      const parent = await sessionStore.createSession(
        {
          prompt: "parent",
          model: "gpt-5.5-pro",
          mode: "browser",
          browserConfig: { manualLogin: true, manualLoginProfileDir: "/tmp/oracle-profile" },
        },
        "/tmp/project",
        undefined,
        "no-url-parent",
      );

      await expect(
        startBrowserFollowUpSession(parent.id, {
          prompt: "next",
          cliEntrypoint: "/tmp/oracle-cli.js",
        }),
      ).rejects.toThrow(/no recoverable ChatGPT conversation URL/i);
    });
  });
});
