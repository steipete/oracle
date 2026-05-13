// Regression test for the remote browser payload — proves the
// serialized request body never carries credentials or local-only
// browser-config fields, regardless of what the caller passes in.
//
// History (oracle-fpq): a prior version of this test tried to mock
// `node:http` via vi.mock with a factory that returned
// `{ ...actual, request: vi.fn() }`. Under ESM that does NOT cover
// the `import http from "node:http"` default export — `http.request`
// at the call site remained the real (un-mocked) function, and
// `vi.mocked(http.request).mockImplementation(...)` threw because
// `vi.mocked()` of a non-mock returns the bare function.
//
// Cleaner pattern: createRemoteBrowserExecutor accepts an optional
// `requestFn` DI seam. The test passes a stub — no module-level
// mocking, no ESM default-export gymnastics, and test isolation is
// bulletproof because nothing else in the runner shares the mocked
// node:http surface.

import { describe, expect, it, vi } from "vitest";

import { createRemoteBrowserExecutor } from "../../src/remote/client.js";

type ExecutorOptions = Parameters<typeof createRemoteBrowserExecutor>[0];
type RequestFn = NonNullable<ExecutorOptions["requestFn"]>;

type RequestHandlers = Record<string, (...args: unknown[]) => void>;

function makeCapturingRequest(): {
  fn: RequestFn;
  spy: ReturnType<typeof vi.fn>;
  capture: () => Record<string, unknown> | null;
} {
  let inspected: Record<string, unknown> | null = null;
  const spy = vi.fn((_opts: unknown, _cb: unknown) => {
    const handlers: RequestHandlers = {};
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      }),
      write: vi.fn((body: Buffer | string) => {
        const raw = typeof body === "string" ? body : body.toString("utf8");
        inspected = JSON.parse(raw) as Record<string, unknown>;
      }),
      end: vi.fn(() => {
        // Fail-fast: after the executor calls .end(), surface a
        // synthetic error so the awaiting promise rejects instead
        // of hanging. The test catches the rejection — we only care
        // that the body inspection happened during .write().
        setImmediate(() => handlers.error?.(new Error("test-stub: end")));
      }),
      destroy: vi.fn(),
    };
  });
  return {
    fn: spy as unknown as RequestFn,
    spy,
    capture: () => inspected,
  };
}

describe("Remote payload serialization", () => {
  it("does not leak the bearer token into the serialized payload", async () => {
    const { fn, spy, capture } = makeCapturingRequest();
    const exec = createRemoteBrowserExecutor({
      host: "localhost:9222",
      token: "super-secret-token",
      requestFn: fn,
    });

    await exec({
      prompt: "hello",
      config: {
        chromeProfile: "Test",
        // @ts-expect-error intentionally injecting to confirm the
        // executor scrubs remoteToken from browserConfig before
        // serialization.
        remoteToken: "super-secret-token",
      },
      log: () => {},
    }).catch(() => {
      // The executor returns a never-resolving promise — it waits for
      // /runs to stream events. The body inspection happened
      // synchronously inside the request stub's write() call.
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const payload = capture();
    expect(payload, "request body was not captured").not.toBeNull();

    const browserConfig = (payload as Record<string, unknown>).browserConfig as
      | Record<string, unknown>
      | undefined;
    expect(browserConfig?.remoteToken).toBeUndefined();
    // The serialized payload must not carry the raw token in ANY field.
    expect(JSON.stringify(payload)).not.toContain("super-secret-token");
  });

  it("strips remoteChrome / remoteChromeBrowserWSEndpoint / remoteChromeProfileRoot from browserConfig", async () => {
    const { fn, spy, capture } = makeCapturingRequest();
    const exec = createRemoteBrowserExecutor({
      host: "localhost:9222",
      requestFn: fn,
    });

    await exec({
      prompt: "scrub-config",
      config: {
        chromeProfile: "Test",
        // @ts-expect-error intentionally injecting local-only fields
        remoteChrome: "127.0.0.1:9222",
        remoteChromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/...",
        remoteChromeProfileRoot: "/tmp/profile",
      },
      log: () => {},
    }).catch(() => {});

    expect(spy).toHaveBeenCalledTimes(1);
    const payload = capture();
    const browserConfig = (payload as Record<string, unknown> | null)?.browserConfig as
      | Record<string, unknown>
      | undefined;
    expect(browserConfig?.remoteChrome).toBeUndefined();
    expect(browserConfig?.remoteChromeBrowserWSEndpoint).toBeUndefined();
    expect(browserConfig?.remoteChromeProfileRoot).toBeUndefined();
    expect(browserConfig?.chromeProfile).toBeUndefined();
  });

  it("authorization header carries the token but the body does not", async () => {
    let recordedHeaders: Record<string, unknown> | null = null;
    const requestFn: RequestFn = ((opts: { headers?: Record<string, unknown> }) => {
      recordedHeaders = opts.headers ?? {};
      const handlers: RequestHandlers = {};
      return {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
        }),
        write: vi.fn(),
        end: vi.fn(() => {
          setImmediate(() => handlers.error?.(new Error("test-stub: end")));
        }),
        destroy: vi.fn(),
      };
    }) as unknown as RequestFn;

    const exec = createRemoteBrowserExecutor({
      host: "localhost:9222",
      token: "header-bound-token",
      requestFn,
    });

    await exec({
      prompt: "header check",
      config: { chromeProfile: "Test" },
      log: () => {},
    }).catch(() => {});

    expect(recordedHeaders).not.toBeNull();
    // Bearer header is the intended transport for the token.
    const headers = recordedHeaders as unknown as Record<string, unknown>;
    expect(headers.authorization).toBe("Bearer header-bound-token");
  });
});
