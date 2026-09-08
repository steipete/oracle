import { expect, test, vi } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRemoteServer } from "../../src/remote/server.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";

const token = "synthetic-admission-test";
const result = {
  answerText: "synthetic",
  answerMarkdown: "synthetic",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 9,
};
const payload = JSON.stringify({ prompt: "synthetic", options: {}, browserConfig: {} });
const health = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } }).then(
    (r) => r.json(),
  );

test("legacy default refuses a second caller with HTTP 409", async () => {
  let finish!: () => void;
  let started = false;
  const server = await createRemoteServer(
    { host: "127.0.0.1", port: 0, token, logger: () => {} },
    {
      runBrowser: async () => {
        started = true;
        await new Promise<void>((r) => {
          finish = r;
        });
        return result;
      },
    },
  );
  const first = fetch(`http://127.0.0.1:${server.port}/runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: payload,
  });
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    const second = await fetch(`http://127.0.0.1:${server.port}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: payload,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "busy" });
    expect(await health(server.port)).toMatchObject({
      admissionMode: "legacy",
      maxConcurrentRuns: 1,
      maxQueuedRuns: 0,
    });
  } finally {
    finish();
    await (await first).text();
    await server.close();
  }
});

test("queue capacity is reserved before concurrent request bodies are buffered", async () => {
  const finishes: (() => void)[] = [];
  const server = await createRemoteServer(
    { host: "127.0.0.1", port: 0, token, logger: () => {}, maxConcurrentRuns: 1, maxQueuedRuns: 1 },
    {
      runBrowser: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          finishes.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return result;
      },
    },
  );
  const codes: number[] = [];
  const pending: Promise<number>[] = [];
  const requests = Array.from({ length: 6 }, () => {
    let resolve!: (value: number) => void;
    let reject!: (reason: Error) => void;
    pending.push(
      new Promise<number>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const request = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/runs",
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Length": Buffer.byteLength(payload) },
      },
      (response) => {
        codes.push(response.statusCode ?? 0);
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.write(payload.slice(0, 1));
    return request;
  });
  try {
    await vi.waitFor(() => expect(codes.filter((code) => code === 503)).toHaveLength(4));
    expect(finishes).toHaveLength(0);
    for (const request of requests) request.end(payload.slice(1));
    expect(await health(server.port)).toMatchObject({
      activeRuns: 1,
      queuedRuns: 1,
      maxQueuedRuns: 1,
    });
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    finishes.shift()?.();
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    finishes.shift()?.();
    expect((await Promise.all(pending)).sort()).toEqual([200, 200, 503, 503, 503, 503]);
  } finally {
    for (const request of requests) request.destroy();
    for (const finish of finishes) finish();
    await Promise.allSettled(pending);
    await server.close();
  }
});

test("host configuration and environment resolve capacity with browser precedence", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-admission-config-"));
  vi.stubEnv("ORACLE_HOME_DIR", home);
  vi.stubEnv("ORACLE_BROWSER_MAX_CONCURRENT_TABS", "1");
  await fs.writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ browser: { maxConcurrentTabs: 2 } }),
  );
  let observed: number | undefined;
  const server = await createRemoteServer(
    { host: "127.0.0.1", port: 0, token, logger: () => {}, maxConcurrentRuns: 4 },
    {
      runBrowser: async (options) => {
        observed = options.config?.maxConcurrentTabs;
        return result;
      },
    },
  );
  try {
    expect(await health(server.port)).toMatchObject({ maxConcurrentRuns: 2 });
    await createRemoteBrowserExecutor({ host: `127.0.0.1:${server.port}`, token })({
      prompt: "synthetic",
      config: {},
    });
    expect(observed).toBe(2);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("explicit cancellation refuses an old host before starting a run", async () => {
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST") posts++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        capabilities: {
          artifactTransfer: true,
          artifactProtocolVersion: 1,
          maxArtifactBytes: 1000,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const executor = createRemoteBrowserExecutor({
      host: `127.0.0.1:${(server.address() as { port: number }).port}`,
      token,
    });
    await expect(
      executor({ prompt: "synthetic", config: {}, signal: new AbortController().signal }),
    ).rejects.toThrow(/does not support run cancellation/);
    expect(posts).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function partialRequest(port: number, prompt: string) {
  const body = JSON.stringify({ prompt, options: {}, browserConfig: {} });
  let finish!: (code: number) => void;
  const completed = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/runs",
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Length": Buffer.byteLength(body) },
    },
    (response) => {
      response.resume();
      response.on("end", () => finish(response.statusCode ?? 0));
    },
  );
  req.on("error", () => finish(-1));
  req.write(body.slice(0, 1));
  return { req, completed, end: () => req.end(body.slice(1)) };
}

test("slow body reception retains FIFO order over a later complete body", async () => {
  const started: string[] = [];
  const server = await createRemoteServer(
    { host: "127.0.0.1", port: 0, token, logger: () => {}, maxConcurrentRuns: 1, maxQueuedRuns: 1 },
    {
      runBrowser: async (options) => {
        started.push(options.prompt);
        return result;
      },
    },
  );
  const first = partialRequest(server.port, "first");
  let second: ReturnType<typeof partialRequest> | undefined;
  try {
    await vi.waitFor(async () =>
      expect(await health(server.port)).toMatchObject({ activeRuns: 1 }),
    );
    second = partialRequest(server.port, "second");
    second.end();
    await vi.waitFor(async () =>
      expect(await health(server.port)).toMatchObject({ queuedRuns: 1 }),
    );
    expect(started).toEqual([]);
    first.end();
    expect(await first.completed).toBe(200);
    expect(await second.completed).toBe(200);
    expect(started).toEqual(["first", "second"]);
  } finally {
    first.req.destroy();
    second?.req.destroy();
    await server.close();
  }
});

test("invalid and disconnected incomplete bodies release their reservations", async () => {
  const runBrowser = vi.fn(async () => result);
  const server = await createRemoteServer(
    { host: "127.0.0.1", port: 0, token, logger: () => {}, maxConcurrentRuns: 1, maxQueuedRuns: 1 },
    { runBrowser },
  );
  let active: ReturnType<typeof partialRequest> | undefined;
  let queued: ReturnType<typeof partialRequest> | undefined;
  try {
    const bad = await fetch(`http://127.0.0.1:${server.port}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{",
      signal: AbortSignal.timeout(3000),
    });
    expect(bad.status).toBe(400);
    await bad.text();
    expect(await health(server.port)).toMatchObject({ activeRuns: 0, queuedRuns: 0 });
    active = partialRequest(server.port, "unfinished-active");
    await vi.waitFor(async () =>
      expect(await health(server.port)).toMatchObject({ activeRuns: 1 }),
    );
    queued = partialRequest(server.port, "unfinished-queued");
    await vi.waitFor(async () =>
      expect(await health(server.port)).toMatchObject({ queuedRuns: 1 }),
    );
    queued.req.destroy();
    await queued.completed;
    await vi.waitFor(async () =>
      expect(await health(server.port)).toMatchObject({ queuedRuns: 0 }),
    );
    active.req.destroy();
    await active.completed;
    await vi.waitFor(async () =>
      expect(await health(server.port)).toMatchObject({ activeRuns: 0 }),
    );
    expect(runBrowser).not.toHaveBeenCalled();
  } finally {
    active?.req.destroy();
    queued?.req.destroy();
    await server.close();
  }
});
