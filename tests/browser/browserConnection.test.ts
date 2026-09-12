import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

const { cdp } = vi.hoisted(() => ({ cdp: vi.fn() }));
vi.mock("chrome-remote-interface", () => ({ default: cdp }));

function browserFixture() {
  let next = 0;
  const emitter = new EventEmitter();
  const evaluate = vi.fn(async (_params: unknown, session: string) => ({
    result: { value: session },
  }));
  const loadEvent = Object.assign(vi.fn(), { category: "event" });
  return Object.assign(emitter, {
    _ws: { _socket: { ref: vi.fn(), unref: vi.fn() } },
    Target: {
      getTargets: vi.fn(async () => ({ targetInfos: [{ targetId: "saved", type: "page" }] })),
      createTarget: vi.fn(async () => ({ targetId: `target-${++next}` })),
      attachToTarget: vi.fn(async ({ targetId }: { targetId: string }) => ({
        sessionId: targetId,
      })),
      detachFromTarget: vi.fn(async () => ({})),
      closeTarget: vi.fn(async () => ({ success: true })),
    },
    Runtime: { evaluate },
    Page: { loadEventFired: loadEvent },
    close: vi.fn(async () => {}),
    send: vi.fn(async () => ({})),
  });
}

const endpoint = "ws://127.0.0.1:9222/devtools/browser/pool";
const logger = () => {};
async function lifecycle() {
  return import("../../src/browser/chromeLifecycle.js");
}
async function attach(targetId = "saved") {
  const { connectToRemoteChromeTarget } = await lifecycle();
  return connectToRemoteChromeTarget("127.0.0.1", 9222, logger, {
    browserWSEndpoint: endpoint,
    targetId,
  });
}
async function list(signal?: AbortSignal, approvalWaitMs?: number) {
  const { listRemoteChromeTargets } = await lifecycle();
  return listRemoteChromeTargets({
    host: "127.0.0.1",
    port: 9222,
    browserWSEndpoint: endpoint,
    signal,
    approvalWaitMs,
  });
}

beforeEach(() => {
  vi.resetModules();
  cdp.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("process-owned browser connection", () => {
  test("shares concurrent discovery and page sessions, retaining approval between requests", async () => {
    const browser = browserFixture();
    cdp.mockResolvedValue(browser);
    const [targets, first, second] = await Promise.all([list(), attach("a"), attach("b")]);
    expect(targets).toHaveLength(1);
    expect(cdp).toHaveBeenCalledTimes(1);
    await first.close();
    expect(browser._ws._socket.unref).not.toHaveBeenCalled();
    expect(await second.client.Runtime.evaluate({ expression: "1" })).toMatchObject({
      result: { value: "b" },
    });
    await second.close();
    expect(browser._ws._socket.unref).toHaveBeenCalledTimes(1);
    await list();
    expect(cdp).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
  });

  test("cancelling discovery does not close an active peer's transport", async () => {
    const browser = browserFixture();
    browser.Target.getTargets.mockImplementation(() => new Promise(() => {}));
    cdp.mockResolvedValue(browser);
    const peer = await attach();
    const abort = new AbortController();
    const waiting = list(abort.signal);
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(browser.Target.getTargets).toHaveBeenCalled());
    abort.abort();
    await rejected;
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser._ws._socket.unref).not.toHaveBeenCalled();
    await peer.client.Runtime.evaluate({ expression: "1" });
    await peer.close();
    expect(browser._ws._socket.unref).toHaveBeenCalledOnce();
  });

  test("shares pending approval even if its first waiter is cancelled", async () => {
    const browser = browserFixture();
    let approve!: (value: typeof browser) => void;
    cdp.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const abort = new AbortController();
    const cancelled = list(abort.signal);
    const rejection = expect(cancelled).rejects.toThrow("cancelled");
    const peer = list();
    await vi.waitFor(() => expect(cdp).toHaveBeenCalledOnce());
    abort.abort();
    await rejection;
    approve(browser);
    expect(await peer).toHaveLength(1);
    expect(cdp).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser._ws._socket.unref).toHaveBeenCalled();
  });

  test("a caller deadline does not create another approval handshake", async () => {
    vi.useFakeTimers();
    const browser = browserFixture();
    cdp.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(browser), 200)));
    // Resolve imports before advancing virtual time.
    await lifecycle();
    const waiting = list(undefined, 100);
    const rejection = expect(waiting).rejects.toThrow(/waited 100ms/);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    const retry = list(undefined, 500);
    await vi.advanceTimersByTimeAsync(100);
    expect(await retry).toHaveLength(1);
    expect(cdp).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
  });

  test("reconnects after transport disconnect, not after a page detaches", async () => {
    const first = browserFixture();
    const second = browserFixture();
    cdp.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const a = await attach("a");
    const b = await attach("b");
    const lostA = vi.fn();
    const lostB = vi.fn();
    a.client.on("disconnect", lostA);
    b.client.on("disconnect", lostB);
    first.emit("Target.detachedFromTarget", { sessionId: "a" });
    expect(lostA).toHaveBeenCalledOnce();
    expect(lostB).not.toHaveBeenCalled();
    await a.close();
    await list();
    expect(cdp).toHaveBeenCalledOnce();
    first.emit("disconnect");
    expect(lostB).toHaveBeenCalledOnce();
    await b.close();
    await list();
    expect(cdp).toHaveBeenCalledTimes(2);
  });

  test("removes only the closing page's listeners, including shorthand and raw events", async () => {
    const browser = browserFixture();
    cdp.mockResolvedValue(browser);
    const a = await attach("a");
    const b = await attach("b");
    const pageA = vi.fn();
    const pageB = vi.fn();
    const rawA = vi.fn();
    a.client.Page.loadEventFired(pageA);
    b.client.Page.on("loadEventFired", pageB);
    a.client.on("Target.attachedToTarget", rawA);
    await Promise.all([a.client.close(), a.close(), a.client.close()]);
    browser.emit("Page.loadEventFired.a", {});
    browser.emit("Page.loadEventFired.b", {});
    browser.emit("Target.attachedToTarget", {});
    expect(pageA).not.toHaveBeenCalled();
    expect(rawA).not.toHaveBeenCalled();
    expect(pageB).toHaveBeenCalledOnce();
    expect(browser.Target.detachFromTarget).toHaveBeenCalledTimes(1);
    await b.close();
    expect(browser.eventNames()).toEqual(["disconnect"]);
  });

  test("failed target attachment closes only the tab created for that attempt", async () => {
    const browser = browserFixture();
    cdp.mockResolvedValue(browser);
    browser.Target.attachToTarget.mockRejectedValue(new Error("no target"));
    const { connectToRemoteChromeTarget } = await lifecycle();
    await expect(
      connectToRemoteChromeTarget("127.0.0.1", 9222, logger, { browserWSEndpoint: endpoint }),
    ).rejects.toThrow("no target");
    expect(browser.Target.closeTarget).toHaveBeenCalledWith({ targetId: "target-1" });
    await expect(attach("borrowed")).rejects.toThrow("no target");
    expect(browser.Target.closeTarget).toHaveBeenCalledTimes(1);
    expect(cdp).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
  });

  test("a failed handshake is evicted without poisoning the next connection", async () => {
    cdp.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce(browserFixture());
    await expect(list()).rejects.toThrow("ECONNREFUSED");
    expect(await list()).toHaveLength(1);
    expect(cdp).toHaveBeenCalledTimes(2);
  });

  test("forwards callback-only and parameterized commands without treating them as events", async () => {
    const browser = browserFixture();
    const enable = Object.assign(vi.fn(), { category: "command" });
    Object.assign(browser.Page, { enable });
    cdp.mockResolvedValue(browser);
    const page = await attach();
    const callback = vi.fn();
    const callEnable = page.client.Page.enable as unknown as (...args: unknown[]) => void;
    callEnable(callback);
    expect(enable).toHaveBeenLastCalledWith({}, "saved", callback);
    callEnable({ enableFileChooserOpenedEvent: true }, callback);
    expect(enable).toHaveBeenLastCalledWith(
      { enableFileChooserOpenedEvent: true },
      "saved",
      callback,
    );
    expect(browser.listenerCount("Page.enable.saved")).toBe(0);
    await page.close();
  });
});
