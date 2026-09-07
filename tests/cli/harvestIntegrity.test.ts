import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { persistBrowserHarvest } from "../../src/cli/harvestIntegrity.js";
import { sessionStore } from "../../src/sessionStore.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import type { ChatGptTabSummary } from "../../src/browser/liveTabs.js";

const url = (id: string) => `https://chatgpt.com/c/${id}`;
function observed(id: string): ChatGptTabSummary {
  return {
    targetId: "new-target",
    url: url(id),
    conversationId: id,
    state: "completed",
    authenticated: true,
    stopExists: false,
    sendExists: true,
    assistantCount: 1,
    currentModelLabel: "Synthetic model",
    lastAssistantMarkdown: "New harvest answer",
    lastAssistantText: "New harvest answer",
    lastAssistantSnippet: "New harvest answer",
  } as ChatGptTabSummary;
}

describe("harvest capture identity", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-harvest-integrity-"));
    setOracleHomeDirOverrideForTest(home);
  });
  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await fs.rm(home, { recursive: true, force: true });
  });

  async function seed(recordedId: string, transcriptId = recordedId) {
    const meta = await sessionStore.createSession(
      { prompt: "Synthetic original prompt", file: [], model: "gpt-5.5", mode: "browser" },
      home,
    );
    const paths = await sessionStore.getPaths(meta.id);
    await fs.mkdir(path.join(paths.dir, "artifacts"), { recursive: true });
    const transcript = path.join(paths.dir, "artifacts", "transcript.md");
    const body = `# Oracle Browser Transcript\n\nConversation: ${url(transcriptId)}\n\n## Answer\nOriginal answer\n`;
    await fs.writeFile(transcript, body);
    await fs.writeFile(paths.log, "Original answer\n");
    await sessionStore.updateSession(meta.id, {
      status: "completed",
      browser: {
        runtime: {
          conversationId: recordedId,
          tabUrl: url(recordedId),
          chromeTargetId: "original-target",
        },
        archive: {
          mode: "never",
          attempted: false,
          archived: false,
          conversationUrl: url(recordedId),
        },
        warnings: [{ code: "existing", severity: "warning", message: "Existing warning" }],
      },
      artifacts: [{ kind: "transcript", path: transcript, sourceUrl: url(recordedId) }],
    });
    return { id: meta.id, paths, transcript, body };
  }

  test("persists both identities and refuses an implicit mismatch without replacing saved output", async () => {
    const saved = await seed("capture-a");
    await expect(persistBrowserHarvest(saved.id, observed("harvest-b"))).rejects.toMatchObject({
      details: { stage: "harvest-integrity", code: "conversation-identity-mismatch" },
    });
    const meta = await sessionStore.readSession(saved.id);
    expect(meta?.browser?.runtime?.conversationId).toBe("capture-a");
    expect(meta?.browser?.harvest?.integrity).toMatchObject({
      status: "mismatch",
      observedConversationId: "harvest-b",
      explicitTarget: false,
      captured: expect.arrayContaining([{ source: "runtime", conversationId: "capture-a" }]),
    });
    expect(meta?.browser?.warnings?.map((warning) => warning.code)).toEqual([
      "existing",
      "browser-harvest-integrity",
    ]);
    expect(await fs.readFile(saved.transcript, "utf8")).toBe(saved.body);
    expect(await fs.readFile(saved.paths.log, "utf8")).toBe("Original answer\n");
  });

  test("detects a conflicting transcript even when all metadata agrees with the harvest", async () => {
    const saved = await seed("harvest-b", "capture-a");
    await expect(persistBrowserHarvest(saved.id, observed("harvest-b"))).rejects.toMatchObject({
      details: {
        integrity: {
          captured: expect.arrayContaining([
            { source: "transcript:transcript.md", conversationId: "capture-a" },
          ]),
        },
      },
    });
  });

  test("detects contradictory saved identities even on the first unidentified harvest", async () => {
    const saved = await seed("harvest-b", "capture-a");
    const unidentified = {
      ...observed("harvest-b"),
      conversationId: undefined,
      url: "https://chatgpt.com/",
    };
    await expect(persistBrowserHarvest(saved.id, unidentified)).rejects.toMatchObject({
      details: { code: "conversation-identity-mismatch" },
    });
  });

  test.each(["capture-a", "harvest-b"])(
    "retains known conflicts after unidentified harvests (runtime %s)",
    async (runtimeId) => {
      const saved = await seed(runtimeId, "capture-a");
      await expect(persistBrowserHarvest(saved.id, observed("harvest-b"))).rejects.toMatchObject({
        details: { code: "conversation-identity-mismatch" },
      });
      const unidentified = {
        ...observed("harvest-b"),
        conversationId: undefined,
        url: "https://chatgpt.com/",
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(persistBrowserHarvest(saved.id, unidentified, true)).resolves.toMatchObject({
          status: "mismatch",
          previousHarvestConversationId: "harvest-b",
        });
        const meta = await sessionStore.readSession(saved.id);
        expect(
          meta?.browser?.warnings?.filter(
            (warning) => warning.code === "browser-harvest-integrity",
          ),
        ).toHaveLength(1);
        expect(meta?.status).toBe("completed");
      }
      await expect(persistBrowserHarvest(saved.id, unidentified)).rejects.toMatchObject({
        details: { code: "conversation-identity-mismatch" },
      });
      expect(await fs.readFile(saved.transcript, "utf8")).toBe(saved.body);
      expect(await fs.readFile(saved.paths.log, "utf8")).toBe("Original answer\n");
    },
  );

  test("allows an explicit target while retaining the conflict and original capture", async () => {
    const saved = await seed("capture-a");
    await expect(
      persistBrowserHarvest(saved.id, observed("harvest-b"), true),
    ).resolves.toMatchObject({
      status: "mismatch",
      explicitTarget: true,
    });
    expect((await sessionStore.readSession(saved.id))?.browser?.runtime?.chromeTargetId).toBe(
      "original-target",
    );
    expect(await fs.readFile(saved.transcript, "utf8")).toBe(saved.body);
  });

  test("matches known identities and preserves unrelated warnings", async () => {
    const saved = await seed("capture-a");
    await expect(persistBrowserHarvest(saved.id, observed("capture-a"))).resolves.toMatchObject({
      status: "matched",
    });
    expect(
      (await sessionStore.readSession(saved.id))?.browser?.warnings?.map((warning) => warning.code),
    ).toEqual(["existing"]);
  });

  test("marks unreadable provenance unverified instead of claiming an identity match", async () => {
    const saved = await seed("capture-a");
    await fs.writeFile(saved.transcript, "An unrecognized transcript format\n");
    await expect(persistBrowserHarvest(saved.id, observed("capture-a"))).resolves.toMatchObject({
      status: "unverified",
      unverifiedSources: ["transcript:transcript.md"],
    });
  });

  test("does not inspect a transcript path outside this session's artifact directory", async () => {
    const saved = await seed("capture-a");
    const outside = path.join(home, "outside.md");
    await fs.writeFile(outside, saved.body.replaceAll("capture-a", "other-b"));
    await sessionStore.updateSession(saved.id, {
      artifacts: [{ kind: "transcript", path: outside, sourceUrl: url("capture-a") }],
    });
    await expect(persistBrowserHarvest(saved.id, observed("capture-a"))).resolves.toMatchObject({
      status: "unverified",
      unverifiedSources: ["external-transcript-path"],
    });
  });

  test("does not claim a match when a recorded conversation URL is unreadable", async () => {
    const saved = await seed("capture-a");
    const meta = await sessionStore.readSession(saved.id);
    await sessionStore.updateSession(saved.id, {
      browser: {
        ...meta?.browser,
        archive: {
          mode: "never",
          attempted: false,
          archived: false,
          conversationUrl: "unreadable",
        },
      },
    });
    await expect(persistBrowserHarvest(saved.id, observed("capture-a"))).resolves.toMatchObject({
      status: "unverified",
      unverifiedSources: ["archive"],
    });
  });

  test("does not treat image download URLs as malformed conversation provenance", async () => {
    const saved = await seed("capture-a");
    const meta = await sessionStore.readSession(saved.id);
    await sessionStore.updateSession(saved.id, {
      artifacts: [
        ...(meta?.artifacts ?? []),
        {
          kind: "image",
          path: "artifacts/image.png",
          sourceUrl: "https://chatgpt.com/backend-api/estuary/content?id=file-synthetic",
        },
      ],
    });
    await expect(persistBrowserHarvest(saved.id, observed("capture-a"))).resolves.toMatchObject({
      status: "matched",
    });
  });
});
