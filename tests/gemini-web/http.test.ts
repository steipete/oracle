import { afterEach, expect, test, vi } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { getGlobalDispatcher } from "undici";
import { createGeminiWebDispatcher, fetchGeminiWebResource } from "../../src/gemini-web/http.js";

const servers: Server[] = [];
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("accepts Gemini-sized policy headers that overflow ordinary Node fetch", async () => {
  const url = await serve((_req, res) => {
    res.setHeader("Content-Security-Policy", `script-src ${"https://example.test ".repeat(1000)}`);
    res.setHeader("Reporting-Endpoints", `default="https://example.test/${"x".repeat(4000)}"`);
    res.end('"SNlM0e":"synthetic-access-token"');
  });
  await expect(fetch(url)).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_OVERFLOW" } });
  const response = await fetchGeminiWebResource(url);
  expect(await response.text()).toBe('"SNlM0e":"synthetic-access-token"');
});

test("keeps its dispatcher scoped to Gemini and preserves request options", async () => {
  const globalDispatcher = getGlobalDispatcher();
  const response = new Response("configured transport");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const init = { headers: { "x-synthetic": "proof" }, redirect: "manual" as const };
  expect(await fetchGeminiWebResource("https://gemini.google.com/app", init)).toBe(response);
  expect(fetch).toHaveBeenCalledExactlyOnceWith("https://gemini.google.com/app", {
    ...init,
    dispatcher: expect.objectContaining({ dispatch: expect.any(Function) }),
  });
  expect(getGlobalDispatcher()).toBe(globalDispatcher);
  expect(fetch.mock.calls[0][1]).not.toHaveProperty("dispatcher", globalDispatcher);
});

test("explains an oversized Google response without exposing request details", async () => {
  const error = new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_OVERFLOW" } });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
  await expect(fetchGeminiWebResource("https://gemini.google.com/app")).rejects.toThrow(
    "Oracle's default is 64 KiB",
  );
});

test("preserves unrelated fetch failures", async () => {
  const error = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
  await expect(fetchGeminiWebResource("https://gemini.google.com/app")).rejects.toBe(error);
});

test("follows oversized-header redirects and completes a POST without replaying it", async () => {
  const calls: string[] = [];
  const url = await serve(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Security-Policy", "x".repeat(24 * 1024));
    if (req.url === "/start") {
      res.writeHead(307, { location: "/answer" });
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end(body);
  });
  const response = await fetchGeminiWebResource(`${url}/start`, {
    method: "POST",
    body: "synthetic prompt",
  });
  expect(await response.text()).toBe("synthetic prompt");
  expect(calls).toEqual(["POST /start", "POST /answer"]);
});

test("bounds oversized responses and never retries a dispatched POST", async () => {
  let calls = 0;
  const url = await serve((_req, res) => {
    calls += 1;
    res.setHeader("Content-Security-Policy", "x".repeat(65 * 1024));
    res.end("too large");
  });
  await expect(fetchGeminiWebResource(url, { method: "POST", body: "prompt" })).rejects.toThrow(
    "Oracle's default is 64 KiB",
  );
  expect(calls).toBe(1);
});

test("preserves cancellation after response headers", async () => {
  const url = await serve((_req, res) => {
    res.setHeader("Content-Security-Policy", "x".repeat(24 * 1024));
    res.flushHeaders();
  });
  const controller = new AbortController();
  const response = await fetchGeminiWebResource(url, { signal: controller.signal });
  controller.abort();
  await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
});

test("keeps large headers working through environment proxies and honors NO_PROXY", async () => {
  const origin = await serve((_req, res) => {
    res.setHeader("Content-Security-Policy", "x".repeat(24 * 1024));
    res.end("proxied answer");
  });
  const proxy = await serve((_req, res) => res.end("unexpected plain proxy request"));
  let tunnels = 0;
  const sockets = new Set<Socket>();
  servers.at(-1)?.on("connect", (_req, socket, head) => {
    tunnels += 1;
    const upstream = connect(Number(new URL(origin).port), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket as Socket);
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  for (const name of ["http_proxy", "https_proxy", "no_proxy"]) vi.stubEnv(name, undefined);
  vi.stubEnv("HTTP_PROXY", proxy);
  vi.stubEnv("HTTPS_PROXY", proxy);
  vi.stubEnv("NO_PROXY", "");
  const dispatcher = createGeminiWebDispatcher();
  try {
    expect(await (await fetchGeminiWebResource(origin, { dispatcher })).text()).toBe(
      "proxied answer",
    );
    expect(tunnels).toBe(1);
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    expect(await (await fetchGeminiWebResource(origin, { dispatcher })).text()).toBe(
      "proxied answer",
    );
    expect(tunnels).toBe(1);
  } finally {
    await dispatcher.destroy();
    for (const socket of sockets) socket.destroy();
  }
});
