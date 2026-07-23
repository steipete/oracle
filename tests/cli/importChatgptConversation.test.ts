import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  importChatgptConversation,
  validateChatgptConversationUrl,
} from "../../src/cli/importChatgptConversation.js";
import { resolveBrowserFollowupReference } from "../../src/cli/followup.js";
import { sessionStore } from "../../src/sessionStore.js";

let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-import-chatgpt-tests-"));
  setOracleHomeDirOverrideForTest(oracleHomeDir);
  await sessionStore.ensureStorage();
});

beforeEach(async () => {
  await rm(sessionStore.sessionsDir(), { recursive: true, force: true });
  await sessionStore.ensureStorage();
});

afterAll(async () => {
  await rm(oracleHomeDir, { recursive: true, force: true });
  setOracleHomeDirOverrideForTest(null);
});

describe("ChatGPT conversation import", () => {
  test("validates recoverable ChatGPT conversation URLs", () => {
    expect(validateChatgptConversationUrl("https://chatgpt.com/c/import-test")).toEqual({
      conversationUrl: "https://chatgpt.com/c/import-test",
      conversationId: "import-test",
    });
    expect(validateChatgptConversationUrl("https://chat.openai.com/c/import-test")).toEqual({
      conversationUrl: "https://chat.openai.com/c/import-test",
      conversationId: "import-test",
    });
  });

  test("rejects non-conversation URLs", () => {
    expect(() => validateChatgptConversationUrl("https://evil.example.com/c/import-test")).toThrow(
      /requires an HTTPS conversation URL/,
    );
    expect(() => validateChatgptConversationUrl("http://chatgpt.com/c/import-test")).toThrow(
      /requires an HTTPS conversation URL/,
    );
    expect(() => validateChatgptConversationUrl("https://chatgpt.com/g/g-p-demo/project")).toThrow(
      /requires an HTTPS conversation URL/,
    );
  });

  test("creates browser session metadata that resolves through follow-up", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/import-test",
      slug: "manual import test",
      model: "GPT-5.5 Pro",
      cwd: "/tmp/oracle-import-test",
      browserConfig: {
        url: "https://chatgpt.com/",
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
        modelStrategy: "current",
        archiveConversations: "never",
        researchMode: "off",
      },
    });

    expect(metadata.id).toBe("manual-import-test");
    expect(metadata.status).toBe("completed");
    expect(metadata.mode).toBe("browser");
    expect(metadata.model).toBe("gpt-5.5-pro");
    expect(metadata.browser?.runtime?.tabUrl).toBe("https://chatgpt.com/c/import-test");
    expect(metadata.browser?.runtime?.conversationId).toBe("import-test");
    expect(metadata.browser?.config?.modelStrategy).toBe("current");
    expect(metadata.browser?.config?.archiveConversations).toBe("never");
    expect(metadata.browser?.config?.manualLogin).toBe(true);
    expect(metadata.browser?.config?.manualLoginProfileDir).toBe("/tmp/oracle-profile");

    const stored = JSON.parse(
      await readFile(path.join(sessionStore.sessionsDir(), metadata.id, "meta.json"), "utf8"),
    );
    expect(stored.promptPreview).toBe("Imported ChatGPT conversation");
    expect(stored.options.browserConfig.modelStrategy).toBe("current");

    await expect(resolveBrowserFollowupReference(metadata.id, sessionStore)).resolves.toMatchObject(
      {
        sessionId: "manual-import-test",
        resumeConversationUrl: "https://chatgpt.com/c/import-test",
        model: "gpt-5.5-pro",
        browserConfig: {
          resumeConversationUrl: "https://chatgpt.com/c/import-test",
          archiveConversations: "never",
          researchMode: "off",
        },
      },
    );
  });

  test("infers browser model labels before writing metadata", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/model-label",
      slug: "browser model label",
      model: "5.2 thinking",
    });

    expect(metadata.model).toBe("gpt-5.2-thinking");
  });

  test("rejects an existing slug unless force is set", async () => {
    await importChatgptConversation({
      url: "https://chatgpt.com/c/first",
      slug: "manual import test",
    });

    await expect(
      importChatgptConversation({
        url: "https://chatgpt.com/c/second",
        slug: "manual import test",
      }),
    ).rejects.toThrow(/already exists.*--force/);

    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/second",
      slug: "manual import test",
      force: true,
    });
    expect(metadata.id).toBe("manual-import-test");
    expect(metadata.browser?.runtime?.conversationId).toBe("second");
  });
});
