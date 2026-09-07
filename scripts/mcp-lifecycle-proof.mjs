#!/usr/bin/env node
// Real built MCP/worker lifecycle matrix. Default: local Chat Completions fixture.
// --live-key-file <path> forwards synthetic requests to OpenAI, holding replies
// until the timeout/cancel/reconnect assertions have observed the live worker.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("..", import.meta.url));
const keyIndex = process.argv.indexOf("--live-key-file");
const key =
  keyIndex < 0 ? undefined : (await fs.readFile(process.argv[keyIndex + 1], "utf8")).trim();
const clients = [
  { name: "v1", Client: LegacyClient, Transport: LegacyTransport, modern: false },
  { name: "v2-legacy", Client: ModernClient, Transport: ModernTransport, modern: false },
  { name: "v2-modern", Client: ModernClient, Transport: ModernTransport, modern: true },
];
const results = [];
for (const { name, Client, Transport, modern } of clients) {
  for (const alias of [false, true]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-mcp-lifecycle-"));
    let releaseResponse;
    const responseGate = new Promise((resolve) => {
      releaseResponse = resolve;
    });
    let receiveRequest;
    let rejectRequest;
    const requested = new Promise((resolve, reject) => {
      receiveRequest = resolve;
      rejectRequest = reject;
    });
    requested.catch(() => {});
    let requests = 0;
    let workerPid;
    const marker = "ORACLE_MCP_LIFECYCLE_OK";
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.url, "/v1/chat/completions");
        assert.equal(req.method, "POST");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const request = JSON.parse(body);
        assert.equal(request.model, "gpt-5.4");
        assert.equal(request.stream, true);
        requests += 1;
        receiveRequest();
        let responseBody;
        let responseStatus = 200;
        let contentType = "text/event-stream";
        if (key) {
          const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            signal: AbortSignal.timeout(60_000),
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body,
          });
          responseStatus = upstream.status;
          contentType = upstream.headers.get("content-type") ?? contentType;
          responseBody = Buffer.from(await upstream.arrayBuffer());
        } else {
          const chunk = {
            id: "chatcmpl_fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: request.model,
          };
          responseBody =
            [
              {
                ...chunk,
                choices: [
                  { index: 0, delta: { role: "assistant", content: marker }, finish_reason: null },
                ],
              },
              {
                ...chunk,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join("") + "data: [DONE]\n\n";
        }
        await responseGate;
        res.writeHead(responseStatus, { "Content-Type": contentType });
        res.end(responseBody);
      } catch (error) {
        rejectRequest(error);
        res.writeHead(500);
        res.end("Lifecycle proof upstream failed.");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        ORACLE_HOME_DIR: home,
        OPENAI_API_KEY: "synthetic-proof-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
        ORACLE_DISABLE_KEYTAR: "1",
        ORACLE_NO_DETACH: undefined,
      }).filter(([, value]) => typeof value === "string"),
    );
    let client;
    let transport;
    const connect = async () => {
      client = new Client(
        { name: "oracle-lifecycle-proof", version: "1.0.0" },
        modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
      );
      transport = new Transport({
        command: process.execPath,
        args: alias
          ? [path.join(root, "dist/bin/oracle-cli.js"), "oracle-mcp"]
          : [path.join(root, "dist/bin/oracle-mcp.js")],
        cwd: home,
        env,
        stderr: "pipe",
      });
      await client.connect(transport);
      if (modern) assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === "wait"));
    };
    const call = (params, options) =>
      name === "v1"
        ? client.callTool(params, undefined, options)
        : client.callTool(params, options);
    try {
      await connect();
      const before = Date.now();
      const started = await call({
        name: "consult",
        arguments: {
          prompt: `Reply with exactly ${marker}.`,
          model: "gpt-5.4",
          engine: "api",
          waitForCompletion: false,
        },
      });
      assert.notEqual(started.isError, true, JSON.stringify(started));
      assert.equal(started.structuredContent.detached, true);
      const startMs = Date.now() - before;
      const id = started.structuredContent.sessionId;
      const readMeta = async () =>
        JSON.parse(await fs.readFile(path.join(home, "sessions", id, "meta.json"), "utf8"));
      workerPid = (await readMeta()).lifecycle.workerPid;
      assert.ok(Number.isInteger(workerPid));
      await Promise.race([
        requested,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Worker did not send its API request")),
            15000,
          );
          timer.unref();
        }),
      ]);
      const timeout = await call({ name: "wait", arguments: { id, timeoutMs: 20 } });
      assert.equal(timeout.structuredContent.timedOut, true);
      assert.equal((await readMeta()).status, "running");
      const controller = new AbortController();
      const cancelled = call(
        { name: "wait", arguments: { id } },
        {
          signal: controller.signal,
        },
      );
      const cancelledCheck = assert.rejects(cancelled);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const abortStarted = Date.now();
      controller.abort();
      await cancelledCheck;
      assert.ok(
        Date.now() - abortStarted < 2000,
        "Cancellation must not wait for the request timeout",
      );
      assert.equal((await readMeta()).status, "running");
      process.kill(workerPid, 0);
      // Closing while another waiter is pending must not take its worker down.
      const interrupted = call({ name: "wait", arguments: { id } });
      const interruptedCheck = assert.rejects(interrupted);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.close();
      await interruptedCheck;
      process.kill(workerPid, 0);
      assert.equal((await readMeta()).status, "running");
      await connect();
      releaseResponse();
      const completed = await call(
        { name: "wait", arguments: { id, timeoutMs: 120000 } },
        { timeout: 130000 },
      );
      assert.equal(completed.structuredContent.status, "completed", JSON.stringify(completed));
      assert.match(completed.structuredContent.output, new RegExp(marker));
      assert.equal((await readMeta()).status, "completed");
      assert.equal(requests, 1, "Timeout/cancellation/reconnect must not resubmit");
      await client.close();
      assert.equal(transport.pid, null);
      results.push({
        client: name,
        entrypoint: alias ? "oracle oracle-mcp" : "oracle-mcp",
        startMs,
        waitTimeout: true,
        cancellation: true,
        reconnect: true,
        completed: true,
        requests,
      });
    } finally {
      releaseResponse();
      await client?.close();
      if (workerPid) {
        try {
          process.kill(workerPid, "SIGTERM");
        } catch {}
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(home, { recursive: true, force: true });
    }
  }
}
console.log(
  JSON.stringify(
    {
      provider: key ? "OpenAI via delayed-response proxy" : "local Chat Completions fixture",
      results,
    },
    null,
    2,
  ),
);
