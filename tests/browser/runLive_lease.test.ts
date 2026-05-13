import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  detectBrowserLeaseProvider,
  wrapBrowserExecutorWithLease,
  wrapWithLeaseOrPassthrough,
} from "@src/browser/runLive.ts";
import type { BrowserRunOptions, BrowserRunResult } from "@src/browser/types.ts";

const successResult: BrowserRunResult = {
  text: "ok",
  meta: { messageId: "m-1", turnId: "t-1" },
} as unknown as BrowserRunResult;

function buildOptions(
  config: Record<string, unknown> = {},
  overrides: Partial<BrowserRunOptions> = {},
): BrowserRunOptions {
  return {
    prompt: "hello",
    sessionId: "sess-test",
    config: config as BrowserRunOptions["config"],
    ...overrides,
  };
}

describe("detectBrowserLeaseProvider", () => {
  test("returns 'chatgpt' for chatgpt.com URLs", () => {
    expect(
      detectBrowserLeaseProvider(buildOptions({ chatgptUrl: "https://chatgpt.com/" })),
    ).toBe("chatgpt");
    expect(
      detectBrowserLeaseProvider(buildOptions({ url: "https://chat.openai.com/c/abc" })),
    ).toBe("chatgpt");
  });

  test("returns 'gemini' for gemini.google.com URLs", () => {
    expect(
      detectBrowserLeaseProvider(buildOptions({ chatgptUrl: "https://gemini.google.com/app" })),
    ).toBe("gemini");
  });

  test("returns null when no provider URL is configured", () => {
    expect(detectBrowserLeaseProvider(buildOptions({}))).toBeNull();
    expect(detectBrowserLeaseProvider(buildOptions({ chatgptUrl: "" }))).toBeNull();
    expect(detectBrowserLeaseProvider(buildOptions({ chatgptUrl: "https://example.com/" }))).toBeNull();
  });

  test("explicit provider hint takes precedence over URL detection", () => {
    const opts = {
      ...buildOptions({ chatgptUrl: "https://chatgpt.com/" }),
      provider: "gemini",
    } as unknown as BrowserRunOptions;
    expect(detectBrowserLeaseProvider(opts)).toBe("gemini");
  });
});

describe("wrapBrowserExecutorWithLease — happy path acquire/release", () => {
  let leaseDir: string;

  beforeEach(async () => {
    leaseDir = await mkdtemp(path.join(os.tmpdir(), "oracle-runLive-lease-"));
  });

  afterEach(async () => {
    await rm(leaseDir, { recursive: true, force: true });
  });

  test("ChatGPT run acquires lease before executor and releases after success", async () => {
    const order: string[] = [];
    const executor = vi.fn(async () => {
      order.push("executor");
      return successResult;
    });
    const acquired = vi.fn(() => order.push("acquired"));
    const released = vi.fn(() => order.push("released"));
    const wrapped = wrapBrowserExecutorWithLease(executor, {
      leaseDir,
      onLeaseAcquired: acquired,
      onLeaseReleased: released,
    });

    const result = await wrapped(
      buildOptions({ chatgptUrl: "https://chatgpt.com/" }),
    );

    expect(executor).toHaveBeenCalledOnce();
    expect(acquired).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
    expect(order).toEqual(["acquired", "executor", "released"]);
    expect(result.lease.provider).toBe("chatgpt");
    expect(result.lease.status).toBe("released");
  });

  test("Gemini run records gemini provider on the lease evidence", async () => {
    const executor = vi.fn(async () => successResult);
    const wrapped = wrapBrowserExecutorWithLease(executor, { leaseDir });
    const result = await wrapped(
      buildOptions({ chatgptUrl: "https://gemini.google.com/app" }),
    );
    expect(result.lease.provider).toBe("gemini");
    expect(result.lease.status).toBe("released");
  });

  test("executor error still releases the lease and rethrows", async () => {
    const order: string[] = [];
    const failure = new Error("browser blew up");
    const executor = vi.fn(async () => {
      order.push("executor");
      throw failure;
    });
    const acquired = vi.fn(() => order.push("acquired"));
    const released = vi.fn(() => order.push("released"));
    const wrapped = wrapBrowserExecutorWithLease(executor, {
      leaseDir,
      onLeaseAcquired: acquired,
      onLeaseReleased: released,
    });

    await expect(
      wrapped(buildOptions({ chatgptUrl: "https://chatgpt.com/" })),
    ).rejects.toBe(failure);
    expect(order).toEqual(["acquired", "executor", "released"]);
  });

  test("runtimeHintCb forwards browserLease evidence to the caller", async () => {
    const executor = vi.fn(async (opts: BrowserRunOptions) => {
      await opts.runtimeHintCb?.({} as never);
      return successResult;
    });
    const captured: unknown[] = [];
    const userHint = vi.fn(async (runtime: unknown) => {
      captured.push(runtime);
    });
    const wrapped = wrapBrowserExecutorWithLease(executor, { leaseDir });
    await wrapped(
      buildOptions({ chatgptUrl: "https://chatgpt.com/" }, { runtimeHintCb: userHint }),
    );

    expect(userHint).toHaveBeenCalledOnce();
    const runtime = captured[0] as Record<string, unknown>;
    const lease = runtime.browserLease as Record<string, unknown>;
    expect(lease).toBeDefined();
    expect(lease.provider).toBe("chatgpt");
    expect(lease.status).toBe("acquired");
  });

  test("throws when no ChatGPT/Gemini provider is configured", async () => {
    const executor = vi.fn(async () => successResult);
    const wrapped = wrapBrowserExecutorWithLease(executor, { leaseDir });
    await expect(
      wrapped(buildOptions({ chatgptUrl: "https://example.com/" })),
    ).rejects.toThrow(/unable to detect ChatGPT\/Gemini provider/i);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("wrapWithLeaseOrPassthrough — forgiving variant", () => {
  let leaseDir: string;

  beforeEach(async () => {
    leaseDir = await mkdtemp(path.join(os.tmpdir(), "oracle-runLive-lease-pass-"));
  });

  afterEach(async () => {
    await rm(leaseDir, { recursive: true, force: true });
  });

  test("ordinary Oracle browser run is passed through without acquiring a lease", async () => {
    const acquired = vi.fn();
    const executor = vi.fn(async () => successResult);
    const wrapped = wrapWithLeaseOrPassthrough(executor, {
      leaseDir,
      onLeaseAcquired: acquired,
    });
    const result = await wrapped(
      buildOptions({ chatgptUrl: "https://example.com/" }),
    );
    expect(executor).toHaveBeenCalledOnce();
    expect(acquired).not.toHaveBeenCalled();
    // Passthrough returns the raw BrowserRunResult without a `lease` field.
    expect((result as Record<string, unknown>).lease).toBeUndefined();
  });

  test("ChatGPT run is still wrapped (acquire/release happens)", async () => {
    const acquired = vi.fn();
    const released = vi.fn();
    const executor = vi.fn(async () => successResult);
    const wrapped = wrapWithLeaseOrPassthrough(executor, {
      leaseDir,
      onLeaseAcquired: acquired,
      onLeaseReleased: released,
    });
    const result = await wrapped(
      buildOptions({ chatgptUrl: "https://chatgpt.com/" }),
    );
    expect(acquired).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
    expect((result as Record<string, unknown>).lease).toBeDefined();
  });
});
