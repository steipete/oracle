import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sessionStore } from "../../src/sessionStore.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { connectToRemoteChromeTarget } from "../../src/browser/chromeLifecycle.js";
import {
  matchesOwnedRecoveryTarget,
  retireRecoveredBrowserTarget,
} from "../../src/browser/recoveryTarget.js";
import { completeOwnedBrowserHarvest } from "../../src/cli/recoveredBrowserHarvest.js";
import type { ChatGptTabSummary } from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

vi.mock("../../src/browser/chromeLifecycle.js", async (original) => ({
  ...(await original<typeof import("../../src/browser/chromeLifecycle.js")>()),
  connectToRemoteChromeTarget: vi.fn(),
}));

const capture = {
  host: "127.0.0.1",
  port: 9222,
  targetId: "owned",
  conversationId: "recovery",
  claimId: "original-claim",
};
const answer =
  "## Full recovered answer\n\n" + "This must reach disk before the tab closes.\n".repeat(100);
const integrity = {
  status: "matched" as const,
  captured: [],
  unverifiedSources: [],
  explicitTarget: false,
};
let root: string;
let metadata: SessionMetadata;
let closeTarget: ReturnType<typeof vi.fn>;
let evaluate: ReturnType<typeof vi.fn>;
let createTarget: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-recovery-target-"));
  setOracleHomeDirOverrideForTest(root);
  metadata = await sessionStore.createSession(
    { prompt: "Recovery test", model: "gpt-5.5", mode: "browser" },
    root,
  );
  metadata = await sessionStore.updateSession(metadata.id, {
    status: "error",
    response: { status: "incomplete", incompleteReason: "incomplete-capture" },
    browser: {
      config: {},
      runtime: {
        chromeHost: capture.host,
        chromePort: capture.port,
        chromeTargetId: capture.targetId,
        conversationId: capture.conversationId,
        ownedRecoveryTarget: capture,
      },
    },
  });
  evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
    result: {
      value: expression.includes("claim.retiring = true")
        ? true
        : { url: "https://chatgpt.com/c/recovery", generating: false },
    },
  }));
  closeTarget = vi.fn(async () => {
    expect((await sessionStore.readSession(metadata.id))?.status).toBe("completed");
    expect(await sessionStore.readLog(metadata.id)).toContain(answer);
    return { success: true };
  });
  createTarget = vi.fn(async () => ({ targetId: "replacement" }));
  vi.mocked(connectToRemoteChromeTarget).mockResolvedValue({
    targetId: "owned",
    close: vi.fn(async () => {}),
    client: {
      Runtime: { evaluate },
      Target: {
        closeTarget,
        createTarget,
        getTargets: vi.fn(async () => ({
          targetInfos: [
            { type: "page", targetId: "owned" },
            { type: "page", targetId: "peer" },
          ],
        })),
      },
    } as never,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setOracleHomeDirOverrideForTest(null);
  await fs.rm(root, { recursive: true, force: true });
});
const harvested = (patch: Partial<ChatGptTabSummary> = {}): ChatGptTabSummary => ({
  ...capture,
  url: "https://chatgpt.com/c/recovery",
  state: "completed",
  authenticated: true,
  stopExists: false,
  assistantCount: 1,
  assistantFollowsLatestUser: true,
  title: "Synthetic ChatGPT",
  currentModelLabel: "GPT-5.5",
  sendExists: true,
  promptReady: true,
  loginButtonExists: false,
  lastAssistantSnippet: answer,
  lastUserText: "Recovery test",
  lastUserSnippet: "Recovery test",
  focused: true,
  visibilityState: "visible",
  fingerprint: "synthetic",
  lastAssistantMarkdown: answer,
  lastAssistantText: answer,
  ...patch,
});

describe("owned recovery target retirement", () => {
  test("harvest saves the full answer and completes the session before closing only its target", async () => {
    await completeOwnedBrowserHarvest(metadata.id, harvested(), integrity, () => {});
    expect(closeTarget).toHaveBeenCalledExactlyOnceWith({ targetId: "owned" });
    expect(createTarget).not.toHaveBeenCalled();
  });
  test.each([
    "legacy",
    "borrowed",
    "endpoint",
    "conversation",
    "running",
    "explicit",
    "mismatch",
    "active-controller",
  ])("preserves %s captures", async (variant) => {
    let observed = harvested();
    let proof = integrity;
    if (variant === "legacy") {
      metadata.browser!.runtime!.ownedRecoveryTarget = undefined;
      await sessionStore.updateSession(metadata.id, { browser: metadata.browser });
    }
    if (variant === "borrowed") observed = harvested({ targetId: "other" });
    if (variant === "endpoint") observed = harvested({ port: 9223 });
    if (variant === "conversation") observed = harvested({ conversationId: "other" });
    if (variant === "running") observed = harvested({ state: "running", stopExists: true });
    if (variant === "explicit") proof = { ...integrity, explicitTarget: true };
    if (variant === "mismatch") proof = { ...integrity, status: "mismatch" as never };
    if (variant === "active-controller") {
      metadata.browser!.runtime!.controllerPid = process.ppid;
      await sessionStore.updateSession(metadata.id, { browser: metadata.browser });
    }
    await completeOwnedBrowserHarvest(metadata.id, observed, proof, () => {});
    expect(connectToRemoteChromeTarget).not.toHaveBeenCalled();
    expect((await sessionStore.readSession(metadata.id))?.status).toBe("error");
  });
  test.each(["answer", "model", "metadata"])(
    "does not close after a %s persistence failure",
    async (where) => {
      if (where === "answer")
        vi.spyOn(fs, "appendFile").mockRejectedValueOnce(new Error("disk full"));
      else if (where === "model")
        vi.spyOn(sessionStore, "updateModelRun").mockRejectedValueOnce(new Error("disk full"));
      else vi.spyOn(sessionStore, "updateSession").mockRejectedValueOnce(new Error("disk full"));
      await expect(
        completeOwnedBrowserHarvest(metadata.id, harvested(), integrity, () => {}),
      ).rejects.toThrow("disk full");
      expect(closeTarget).not.toHaveBeenCalled();
    },
  );
  test("preserves the target if a new generation starts before cleanup", async () => {
    evaluate.mockResolvedValue({
      result: { value: { url: "https://chatgpt.com/c/recovery", generating: true } },
    });
    await completeOwnedBrowserHarvest(metadata.id, harvested(), integrity, () => {});
    expect(evaluate.mock.calls[0][0].expression).toContain("composer-stop-button");
    expect(closeTarget).not.toHaveBeenCalled();
  });
  test("cleanup failure cannot turn a saved recovery into an error", async () => {
    closeTarget.mockRejectedValue(new Error("disconnected"));
    const logger = vi.fn();
    await completeOwnedBrowserHarvest(metadata.id, harvested(), integrity, logger);
    expect((await sessionStore.readSession(metadata.id))?.status).toBe("completed");
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("browser tab cleanup failed"));
  });
  test("manual retirement respects another live controller", async () => {
    metadata.browser!.runtime!.controllerPid = process.ppid;
    await sessionStore.updateSession(metadata.id, {
      status: "completed",
      browser: metadata.browser,
    });
    await retireRecoveredBrowserTarget(metadata.id, capture, () => {});
    expect(connectToRemoteChromeTarget).not.toHaveBeenCalled();
  });
  test("manual reattach persists the full answer before retiring its captured target", async () => {
    const reattach = await import("../../src/browser/reattach.js");
    vi.spyOn(reattach, "resumeBrowserSession").mockResolvedValue({
      answerText: answer,
      answerMarkdown: answer,
      captureTarget: capture,
    });
    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession(metadata.id, { suppressMetadata: true, renderPrompt: false });
    expect(closeTarget).toHaveBeenCalledExactlyOnceWith({ targetId: "owned" });
  });
  test("ownership cannot follow a fallback target or browser restart", () => {
    expect(matchesOwnedRecoveryTarget(metadata, { ...capture, targetId: "fallback" })).toBe(false);
    expect(
      matchesOwnedRecoveryTarget(metadata, { ...capture, browserWSEndpoint: "ws://other" }),
    ).toBe(false);
  });
  test("preserves a target acquired by another session after capture", async () => {
    const other = await sessionStore.createSession(
      { prompt: "Borrow this target", model: "gpt-5.5", mode: "browser" },
      root,
    );
    await sessionStore.updateSession(other.id, {
      status: "running",
      browser: {
        runtime: {
          chromeHost: capture.host,
          chromePort: capture.port,
          chromeTargetId: capture.targetId,
          controllerPid: process.pid,
        },
      },
    });
    await completeOwnedBrowserHarvest(metadata.id, harvested(), integrity, () => {});
    expect(closeTarget).not.toHaveBeenCalled();
  });
  test("preserves a target leased by a controller using another session store", async () => {
    const profile = path.join(root, "profile");
    await fs.mkdir(profile);
    await fs.writeFile(
      path.join(profile, "oracle-tab-leases.json"),
      JSON.stringify({
        version: 1,
        leases: [
          {
            id: "other-store",
            pid: process.pid,
            chromeTargetId: capture.targetId,
            chromePort: capture.port,
            chromeHost: capture.host,
          },
        ],
      }),
    );
    metadata.browser!.runtime!.userDataDir = profile;
    await sessionStore.updateSession(metadata.id, { browser: metadata.browser });
    await completeOwnedBrowserHarvest(metadata.id, harvested(), integrity, () => {});
    expect(closeTarget).not.toHaveBeenCalled();
  });
});
