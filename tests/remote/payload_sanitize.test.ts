import http from "node:http";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import type { BrowserRunResult } from "../../src/browserMode.js";
import { createRemoteServer } from "../../src/remote/server.js";
import {
  sanitizeRemoteRunPayloadForHost,
  serializeRemoteRunPayloadForWire,
} from "../../src/remote/payload_sanitize.js";
import type { RemoteRunPayload } from "../../src/remote/types.js";

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

describe("remote payload sanitization", () => {
  test("wire serializer strips client cookies, tokens, and host-local browser config", () => {
    const raw = serializeRemoteRunPayloadForWire(maliciousPayload());

    expect(raw).toContain("gpt-5.5-pro");
    expect(raw).toContain("CHECK_SAFE_REMOTE_PAYLOAD");
    expect(raw).not.toContain("client-cookie-secret");
    expect(raw).not.toContain("client-inline-cookie-source");
    expect(raw).not.toContain("/Users/client/Chrome");
    expect(raw).not.toContain("/Applications/Client Chrome.app");
    expect(raw).not.toContain("/Users/client/.oracle/browser-profile");
    expect(raw).not.toContain("remote-browser-token");

    const parsed = JSON.parse(raw) as RemoteRunPayload;
    expect(parsed.browserConfig).toMatchObject({
      desiredModel: "gpt-5.5-pro",
      modelStrategy: "select",
      timeoutMs: 90_000,
      thinkingTime: "heavy",
    });
    expect(parsed.browserConfig).not.toHaveProperty("inlineCookies");
    expect(parsed.browserConfig).not.toHaveProperty("inlineCookiesSource");
    expect(parsed.browserConfig).not.toHaveProperty("chromePath");
    expect(parsed.browserConfig).not.toHaveProperty("chromeCookiePath");
    expect(parsed.browserConfig).not.toHaveProperty("chromeProfile");
    expect(parsed.browserConfig).not.toHaveProperty("manualLoginProfileDir");
    expect(parsed.browserConfig).not.toHaveProperty("debugPort");
    expect(parsed.browserConfig).not.toHaveProperty("attachRunning");
    expect(parsed.browserConfig).not.toHaveProperty("keepBrowser");
    expect(parsed.browserConfig).not.toHaveProperty("browserTabRef");
  });

  test("host intake enforces server-owned cookie sync and keeps unsafe client fields out", () => {
    const sanitized = sanitizeRemoteRunPayloadForHost(maliciousPayload());
    expect(sanitized.browserConfig.cookieSync).toBe(true);
    expect(sanitized.browserConfig.inlineCookies).toBeNull();
    expect(sanitized.browserConfig.inlineCookiesSource).toBeNull();
    expect(sanitized.browserConfig.desiredModel).toBe("gpt-5.5-pro");
    expect(sanitized.browserConfig).not.toHaveProperty("chromeCookiePath");
    expect(sanitized.browserConfig).not.toHaveProperty("manualLoginProfileDir");
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "server does not pass client cookies or host-local paths to runBrowser",
    async () => {
      let capturedConfig: Record<string, unknown> | null = null;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "server-token",
          logger: () => {},
          manualLoginDefault: true,
          manualLoginProfileDir: "/server-owned/manual-profile",
        },
        {
          runBrowser: async (options) => {
            capturedConfig = (options.config ?? {}) as Record<string, unknown>;
            return okResult();
          },
        },
      );

      try {
        const response = await postRun(server.port, maliciousPayload(), "server-token");
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('"type":"result"');
      } finally {
        await server.close();
      }

      expect(capturedConfig).toMatchObject({
        desiredModel: "gpt-5.5-pro",
        modelStrategy: "select",
        timeoutMs: 90_000,
        thinkingTime: "heavy",
        cookieSync: true,
        inlineCookies: null,
        inlineCookiesSource: null,
        manualLogin: true,
        manualLoginProfileDir: "/server-owned/manual-profile",
        keepBrowser: true,
      });
      expect(capturedConfig).not.toHaveProperty("chromePath");
      expect(capturedConfig).not.toHaveProperty("chromeCookiePath");
      expect(capturedConfig).not.toHaveProperty("chromeProfile");
      expect(capturedConfig).not.toHaveProperty("debugPort");
      expect(capturedConfig).not.toHaveProperty("attachRunning");
      expect(capturedConfig).not.toHaveProperty("browserTabRef");
      expect(JSON.stringify(capturedConfig)).not.toContain("client-cookie-secret");
      expect(JSON.stringify(capturedConfig)).not.toContain("/Users/client");
    },
  );
});

function maliciousPayload(): RemoteRunPayload {
  return {
    prompt: "CHECK_SAFE_REMOTE_PAYLOAD",
    attachments: [],
    browserConfig: {
      url: "https://chatgpt.com/",
      desiredModel: "gpt-5.5-pro",
      modelStrategy: "select",
      timeoutMs: 90_000,
      thinkingTime: "heavy",
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
      chromePath: "/Applications/Client Chrome.app/Contents/MacOS/Google Chrome",
      chromeCookiePath: "/Users/client/Chrome/Default/Cookies",
      chromeProfile: "ClientDefault",
      manualLoginProfileDir: "/Users/client/.oracle/browser-profile",
      debugPort: 9222,
      attachRunning: true,
      keepBrowser: true,
      browserTabRef: "client-tab",
      remoteChrome: { host: "127.0.0.1", port: 9223 },
      cookieNames: ["__Secure-next-auth.session-token"],
      cookieSync: false,
      manualLogin: true,
      allowCookieErrors: true,
      // @ts-expect-error security regression input from older clients
      remoteToken: "remote-browser-token",
    },
    options: {
      verbose: true,
      sessionId: "remote-payload-sanitize-test",
    },
  };
}

function okResult(): BrowserRunResult {
  return {
    answerText: "ok",
    answerMarkdown: "ok",
    tookMs: 1,
    answerTokens: 1,
    answerChars: 2,
  };
}

async function postRun(
  port: number,
  payload: RemoteRunPayload,
  token: string,
): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
