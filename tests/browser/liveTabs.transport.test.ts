import { beforeEach, describe, expect, test, vi } from "vitest";

const cdp = vi.hoisted(() => Object.assign(vi.fn(), { List: vi.fn(), New: vi.fn() }));
vi.mock("chrome-remote-interface", () => ({ default: cdp }));
let inspectChatGptTab: (typeof import("../../src/browser/liveTabs.js"))["inspectChatGptTab"];
let listChatGptTargets: (typeof import("../../src/browser/liveTabs.js"))["listChatGptTargets"];
let openChatGptTarget: (typeof import("../../src/browser/liveTabs.js"))["openChatGptTarget"];

const endpoint = {
  host: "127.0.0.1",
  port: 9222,
  browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/test",
  approvalWaitMs: 100,
};

function browserClient() {
  return {
    Target: {
      getTargets: vi.fn(async () => ({
        targetInfos: [
          {
            targetId: "saved",
            type: "page",
            title: "Saved answer",
            url: "https://chatgpt.com/c/saved",
          },
        ],
      })),
      createTarget: vi.fn(async () => ({ targetId: "recovered" })),
      attachToTarget: vi.fn(async () => ({ sessionId: "session" })),
      detachFromTarget: vi.fn(async () => {}),
      closeTarget: vi.fn(async () => {}),
    },
    Runtime: {
      enable: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({ result: { value: {} } })),
    },
    DOM: { enable: vi.fn(async () => {}) },
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

describe("live tab transport", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    ({ inspectChatGptTab, listChatGptTargets, openChatGptTarget } =
      await import("../../src/browser/liveTabs.js"));
  });

  test("uses the saved browser socket to discover targets when HTTP discovery is unavailable", async () => {
    cdp.List.mockRejectedValue(new Error());
    const browser = browserClient();
    cdp.mockResolvedValue(browser);
    expect(await listChatGptTargets(endpoint)).toEqual([
      {
        targetId: "saved",
        type: "page",
        title: "Saved answer",
        url: "https://chatgpt.com/c/saved",
      },
    ]);
    expect(cdp).toHaveBeenCalledWith({ target: endpoint.browserWSEndpoint, local: true });
    expect(cdp.List).not.toHaveBeenCalled();
    expect(browser.Target.getTargets).toHaveBeenCalledOnce();
  });

  test("reports endpoint and recovery guidance for an empty discovery error", async () => {
    cdp.List.mockRejectedValue(new Error());
    await expect(listChatGptTargets({ host: "127.0.0.1", port: 9222 })).rejects.toThrow(
      /Unable to list ChatGPT tabs on Chrome at 127.0.0.1:9222.*Chrome returned no error details.*remote debugging/,
    );
  });

  test("inspects only the named browser target and detaches without closing the tab", async () => {
    const browser = browserClient();
    cdp.mockResolvedValue(browser);
    await inspectChatGptTab({
      ...endpoint,
      target: { targetId: "saved", type: "page", url: "https://chatgpt.com/c/saved" },
    });
    expect(browser.Target.attachToTarget).toHaveBeenCalledWith({
      targetId: "saved",
      flatten: true,
    });
    expect(browser.Runtime.enable).toHaveBeenCalledWith("session");
    expect(browser.Target.detachFromTarget).toHaveBeenCalledWith({ sessionId: "session" });
    expect(browser.Target.detachFromTarget).toHaveBeenCalledOnce();
    expect(browser.Target.closeTarget).not.toHaveBeenCalled();
  });

  test("closes failed inspections and preserves HTTP target connections", async () => {
    const browser = browserClient();
    browser.Runtime.enable.mockRejectedValue(new Error("enable failed"));
    cdp.mockResolvedValue(browser);
    await expect(
      inspectChatGptTab({ host: "localhost", port: 9333, target: { id: "saved" } }),
    ).rejects.toThrow("enable failed");
    expect(cdp).toHaveBeenCalledWith({ host: "localhost", port: 9333, target: "saved" });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  test("explains empty errors while reopening a saved conversation", async () => {
    cdp.mockRejectedValue(new Error());
    await expect(
      openChatGptTarget({ ...endpoint, url: "https://chatgpt.com/c/saved" }),
    ).rejects.toThrow(
      /Unable to open saved ChatGPT conversation on Chrome at 127.0.0.1:9222.*Chrome returned no error details/,
    );
  });

  test("reopens saved conversations through the browser socket and leaves the target open", async () => {
    const browser = browserClient();
    cdp.mockResolvedValue(browser);
    expect(await openChatGptTarget({ ...endpoint, url: "https://chatgpt.com/c/saved" })).toBe(
      "recovered",
    );
    expect(browser.Target.createTarget).toHaveBeenCalledWith({
      url: "https://chatgpt.com/c/saved",
    });
    expect(cdp.New).not.toHaveBeenCalled();
    expect(browser.Target.detachFromTarget).toHaveBeenCalledWith({ sessionId: "session" });
    expect(browser.Target.closeTarget).not.toHaveBeenCalled();
  });
});
