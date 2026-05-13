import { describe, expect, test, vi } from "vitest";

import { createRemoteBrowserExecutor } from "../../src/remote/client.js";

type ExecutorOptions = Parameters<typeof createRemoteBrowserExecutor>[0];
type RequestFn = NonNullable<ExecutorOptions["requestFn"]>;
type RequestHandlers = Record<string, (...args: unknown[]) => void>;

describe("remote client payload sanitizer", () => {
  test("serializes requests through the wire allowlist before sending", async () => {
    const { requestFn, body } = captureSerializedBodyRequest();
    const exec = createRemoteBrowserExecutor({
      host: "localhost:9222",
      token: "remote-client-token",
      requestFn,
    });

    await exec({
      prompt: "CHECK_CLIENT_SANITIZE",
      config: {
        url: "https://chatgpt.com/",
        desiredModel: "gpt-5.5-pro",
        modelStrategy: "select",
        timeoutMs: 90_000,
        inputTimeoutMs: 12_000,
        researchMode: "deep",
        inlineCookies: [
          {
            name: "__Secure-next-auth.session-token",
            value: "client-cookie-secret",
            domain: "chatgpt.com",
            path: "/",
            secure: true,
            httpOnly: true,
          },
        ],
        inlineCookiesSource: "/tmp/client-inline-cookie-source.json",
        chromeCookiePath: "/Users/client/Chrome/Default/Cookies",
        chromeProfile: "ClientDefault",
        manualLoginProfileDir: "/Users/client/.oracle/browser-profile",
        debugPort: 9222,
        attachRunning: true,
        keepBrowser: true,
        browserTabRef: "client-tab",
        remoteChrome: { host: "127.0.0.1", port: 9223 },
        // @ts-expect-error regression input from older callers/config plumbing
        remoteToken: "remote-token-in-config",
      },
      heartbeatIntervalMs: 5000,
      verbose: true,
      sessionId: "client-payload-sanitize",
      followUpPrompts: ["safe follow-up", 42 as unknown as string],
      log: () => {},
    }).catch(() => {});

    const raw = body();
    expect(raw, "request body was not captured").not.toBeNull();
    expect(raw).toContain("CHECK_CLIENT_SANITIZE");
    expect(raw).toContain("gpt-5.5-pro");
    expect(raw).not.toContain("client-cookie-secret");
    expect(raw).not.toContain("client-inline-cookie-source");
    expect(raw).not.toContain("/Users/client/Chrome");
    expect(raw).not.toContain("/Users/client/.oracle/browser-profile");
    expect(raw).not.toContain("ClientDefault");
    expect(raw).not.toContain("client-tab");
    expect(raw).not.toContain("remote-client-token");
    expect(raw).not.toContain("remote-token-in-config");

    const payload = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    const browserConfig = payload.browserConfig as Record<string, unknown>;
    expect(browserConfig).toMatchObject({
      url: "https://chatgpt.com/",
      desiredModel: "gpt-5.5-pro",
      modelStrategy: "select",
      timeoutMs: 90_000,
      inputTimeoutMs: 12_000,
      researchMode: "deep",
    });
    for (const forbidden of [
      "inlineCookies",
      "inlineCookiesSource",
      "chromeCookiePath",
      "chromeProfile",
      "manualLoginProfileDir",
      "debugPort",
      "attachRunning",
      "keepBrowser",
      "browserTabRef",
      "remoteChrome",
      "remoteToken",
    ]) {
      expect(browserConfig).not.toHaveProperty(forbidden);
    }

    expect(payload.options).toMatchObject({
      heartbeatIntervalMs: 5000,
      verbose: true,
      sessionId: "client-payload-sanitize",
      followUpPrompts: ["safe follow-up"],
    });
  });
});

function captureSerializedBodyRequest(): {
  requestFn: RequestFn;
  body: () => string | null;
} {
  let capturedBody: string | null = null;
  const requestFn: RequestFn = ((_opts: unknown, _cb: unknown) => {
    const handlers: RequestHandlers = {};
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      }),
      write: vi.fn((body: Buffer | string) => {
        capturedBody = typeof body === "string" ? body : body.toString("utf8");
      }),
      end: vi.fn(() => {
        setImmediate(() => handlers.error?.(new Error("test-stub: end")));
      }),
      destroy: vi.fn(),
    };
  }) as unknown as RequestFn;
  return { requestFn, body: () => capturedBody };
}
