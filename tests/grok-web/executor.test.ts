import { beforeEach, describe, expect, it, vi } from "vitest";

const { closeTab, connectWithNewTab, resolveAttachRunningConnection, delay } = vi.hoisted(() => ({
  closeTab: vi.fn(async () => true),
  connectWithNewTab: vi.fn(),
  resolveAttachRunningConnection: vi.fn(),
  delay: vi.fn(async () => undefined),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({ closeTab, connectWithNewTab }));
vi.mock("../../src/browser/attachRunning.js", () => ({ resolveAttachRunningConnection }));
vi.mock("../../src/browser/utils.js", () => ({ delay }));

describe("Grok web executor", () => {
  beforeEach(() => {
    closeTab.mockClear();
    connectWithNewTab.mockReset();
    resolveAttachRunningConnection.mockReset();
    delay.mockClear();
  });

  it("submits a text prompt and returns a stable Grok response", async () => {
    let responsePoll = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (
        expression.includes("querySelectorAll") &&
        expression.includes("assistant-message") &&
        !expression.includes("turns =")
      ) {
        return { result: { value: 0 } };
      }
      if (expression.includes("blocked:")) {
        return { result: { value: { ready: true, blocked: false } } };
      }
      if (expression.includes("HTMLTextAreaElement.prototype")) {
        return { result: { value: "typed" } };
      }
      if (expression.includes("button.disabled")) {
        return { result: { value: "clicked" } };
      }
      if (expression.includes("const turns =")) {
        responsePoll += 1;
        const status = responsePoll === 1 ? "streaming" : "idle";
        return {
          result: {
            value: JSON.stringify({ status, text: "Grok answer", html: "<p>Grok answer</p>" }),
          },
        };
      }
      return { result: { value: null } };
    });
    const client = {
      Runtime: { enable: vi.fn(async () => undefined), evaluate },
      Page: { enable: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
    };
    connectWithNewTab.mockResolvedValue({ client, targetId: "grok-target" });

    const { createGrokWebExecutor } = await import("../../src/grok-web/executor.js");
    const result = await createGrokWebExecutor()({
      prompt: "Test prompt",
      config: { remoteChrome: { host: "127.0.0.1", port: 9333 }, keepBrowser: true },
      log: () => {},
    });

    expect(connectWithNewTab).toHaveBeenCalledWith(
      9333,
      expect.any(Function),
      "https://grok.com/",
      "127.0.0.1",
      expect.objectContaining({ fallbackToDefault: false }),
    );
    expect(result.answerText).toBe("Grok answer");
    expect(result.answerHtml).toBe("<p>Grok answer</p>");
    expect(result.chromeTargetId).toBe("grok-target");
    expect(result.promptSubmitted).toBe(true);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("resolves --browser-attach-running and closes the isolated tab when requested", async () => {
    resolveAttachRunningConnection.mockResolvedValue({
      host: "127.0.0.1",
      port: 9444,
      browserWSEndpoint: "ws://browser",
      profileRoot: "/tmp/profile",
    });
    let stablePolls = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("blocked:")) return { result: { value: { ready: true } } };
      if (expression.includes("HTMLTextAreaElement.prototype"))
        return { result: { value: "typed" } };
      if (expression.includes("button.disabled")) return { result: { value: "clicked" } };
      if (expression.includes("const turns =")) {
        stablePolls += 1;
        return { result: { value: JSON.stringify({ status: "idle", text: "done" }) } };
      }
      return { result: { value: 0 } };
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-2",
      client: {
        Runtime: { enable: vi.fn(async () => undefined), evaluate },
        Page: { enable: vi.fn(async () => undefined) },
        close: vi.fn(async () => undefined),
      },
    });

    const { createGrokWebExecutor } = await import("../../src/grok-web/executor.js");
    const result = await createGrokWebExecutor()({
      prompt: "Test prompt",
      config: { attachRunning: true, keepBrowser: false },
    });

    expect(stablePolls).toBeGreaterThanOrEqual(2);
    expect(result.chromeBrowserWSEndpoint).toBe("ws://browser");
    expect(closeTab).toHaveBeenCalledWith(9444, "target-2", expect.any(Function), "127.0.0.1");
  });

  it("rejects attachments instead of silently dropping them", async () => {
    const { createGrokWebExecutor } = await import("../../src/grok-web/executor.js");
    await expect(
      createGrokWebExecutor()({
        prompt: "Review this file",
        attachments: [{ path: "/tmp/a.txt", displayPath: "a.txt" }],
        config: { remoteChrome: { host: "127.0.0.1", port: 9333 } },
      }),
    ).rejects.toThrow(/does not support file attachments/);
    expect(connectWithNewTab).not.toHaveBeenCalled();
  });

  it("reports the anonymous Grok sign-up wall immediately", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("blocked:")) return { result: { value: { ready: true } } };
      if (expression.includes("HTMLTextAreaElement.prototype"))
        return { result: { value: "typed" } };
      if (expression.includes("button.disabled")) return { result: { value: "clicked" } };
      if (expression.includes("const turns =")) {
        return { result: { value: JSON.stringify({ status: "login-required" }) } };
      }
      return { result: { value: 0 } };
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-login",
      client: {
        Runtime: { enable: vi.fn(async () => undefined), evaluate },
        Page: { enable: vi.fn(async () => undefined) },
        close: vi.fn(async () => undefined),
      },
    });

    const { createGrokWebExecutor } = await import("../../src/grok-web/executor.js");
    await expect(
      createGrokWebExecutor()({
        prompt: "Test prompt",
        config: { remoteChrome: { host: "127.0.0.1", port: 9333 } },
      }),
    ).rejects.toThrow(/requires sign-in/);
  });
});
