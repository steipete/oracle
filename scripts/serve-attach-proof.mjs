#!/usr/bin/env node
// Built service + client, synthetic DevTools endpoint, no provider account or Chrome launch.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const { Server: WebSocketServer } = createRequire(require.resolve("chrome-remote-interface"))("ws");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-serve-attach-"));
const guard = path.join(root, "refuse-launch.mjs");
await fs.writeFile(
  guard,
  `import {createRequire,syncBuiltinESMExports} from "node:module";
const cp=createRequire(import.meta.url)("node:child_process");
const os=createRequire(import.meta.url)("node:os");
// Keep profile discovery inside the fixture instead of scanning the user's application data.
os.homedir=()=>process.env.ORACLE_HOME_DIR;
const spawn=cp.spawn;
cp.spawn=function(command,...args){
  if(/(?:chrome|chromium)(?:\\.exe)?$/i.test(String(command)))throw new Error("UNEXPECTED_CHROME_LAUNCH");
  return spawn.call(this,command,...args);
};syncBuiltinESMExports();`,
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function prove(mode) {
  const home = path.join(root, mode);
  const clientHome = path.join(home, "client");
  await fs.mkdir(clientHome, { recursive: true });
  let targetRequests = 0;
  let connections = 0;
  const sockets = new Set();
  const timers = new Set();
  const wss = new WebSocketServer({ noServer: true });
  const devtools = http.createServer((req, res) => {
    if (req.url.startsWith("/json/new")) {
      targetRequests++;
      res.writeHead(500);
      res.end("CLASSIC_ATTACH_ROUTED");
    } else if (req.url === "/json/version") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${devtools.address().port}/devtools/browser/proof`,
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  devtools.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  devtools.on("upgrade", (req, socket, head) => {
    connections++;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (raw) => {
          const command = JSON.parse(String(raw));
          if (command.method === "Target.createTarget") targetRequests++;
          ws.send(
            JSON.stringify({
              id: command.id,
              error: { code: -32000, message: "SERVE_ATTACH_ROUTED" },
            }),
          );
        });
      });
    }, 100);
    timers.add(timer);
  });
  await new Promise((resolve) => devtools.listen(0, "127.0.0.1", resolve));
  const port = devtools.address().port;
  await fs.writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      browser: {
        attachRunning: mode === "config",
        remoteChrome: { host: "127.0.0.1", port: mode === "config" ? port : 1 },
        approvalWaitMs: mode === "config" ? 1000 : 1,
        maxConcurrentTabs: 2,
      },
    }),
  );
  const env = {
    ...process.env,
    ORACLE_HOME_DIR: home,
    NO_COLOR: "1",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(guard).href}`.trim(),
  };
  delete env.ORACLE_BROWSER_APPROVAL_WAIT;
  if (mode === "environment") env.ORACLE_BROWSER_APPROVAL_WAIT = "1s";
  const args = [
    path.join(repo, "dist/bin/oracle-cli.js"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--manual-login-profile-dir",
    path.join(home, "profile"),
    "--max-concurrent-runs",
    "2",
    "--max-queued-runs",
    "2",
  ];
  if (mode !== "config") args.push("--remote-chrome", `127.0.0.1:${port}`);
  if (mode !== "config" && mode !== "classic") args.push("--browser-attach-running");
  if (mode === "flags") args.push("--browser-approval-wait", "1s");
  const server = spawn(process.execPath, args, {
    cwd: home,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverDone = new Promise((resolve) => server.on("exit", resolve));
  let serverOutput = "",
    client,
    clientDone,
    token;
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });
  try {
    const deadline = Date.now() + 20_000;
    let address;
    while (Date.now() < deadline) {
      token = serverOutput.match(/Access token: ([^\s]+)/)?.[1];
      address = serverOutput.match(/Listening at (127\.0\.0\.1:\d+)/)?.[1];
      if (token && address) break;
      if (server.exitCode !== null) break;
      await pause(25);
    }
    assert.ok(token && address, `${mode}: service did not become ready`);
    assert.ok(
      !serverOutput.includes("UNEXPECTED_CHROME_LAUNCH"),
      `${mode}: service bootstrapped another Chrome`,
    );
    const health = await fetch(`http://${address}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.equal(health.admissionMode, "queue");
    assert.equal(health.maxConcurrentRuns, 2);
    client = spawn(
      process.execPath,
      [
        path.join(repo, "dist/bin/oracle-cli.js"),
        "--engine",
        "browser",
        "--model",
        "gpt-5.5",
        "--browser-model-strategy",
        "current",
        "--remote-host",
        address,
        "--browser-approval-wait",
        "1ms",
        "--wait",
        "--no-notify",
        "--slug",
        `serve-routing-proof-${mode}`,
        "--prompt",
        "Synthetic routing proof",
      ],
      {
        cwd: clientHome,
        env: { ...env, ORACLE_HOME_DIR: clientHome, ORACLE_REMOTE_TOKEN: token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    client.stdout.on("data", (chunk) => {
      output += chunk;
    });
    client.stderr.on("data", (chunk) => {
      output += chunk;
    });
    clientDone = new Promise((resolve) => client.on("exit", resolve));
    const timeout = setTimeout(() => client.kill("SIGKILL"), 20_000);
    const code = await clientDone;
    clearTimeout(timeout);
    assert.equal(code, 1, `${mode}: expected synthetic endpoint refusal`);
    assert.equal(targetRequests, 1, `${mode}: host route did not reach its DevTools endpoint`);
    if (mode !== "classic") {
      assert.equal(connections, 1, `${mode}: expected one pending approval connection`);
      assert.ok(output.includes("SERVE_ATTACH_ROUTED"), `${mode}: target creation was not reached`);
    }
    assert.ok(
      !serverOutput.includes("UNEXPECTED_CHROME_LAUNCH"),
      `${mode}: run attempted a local launch`,
    );
    console.log(
      `PASS ${mode}: host route reached, no local Chrome launch, client approval override refused, bounded admission enabled`,
    );
  } finally {
    client?.kill("SIGTERM");
    server.kill("SIGTERM");
    await Promise.race([serverDone, pause(1500)]);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    await serverDone;
    if (clientDone) await clientDone;
    for (const timer of timers) clearTimeout(timer);
    for (const ws of wss.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => devtools.close(resolve));
    wss.close();
  }
}
try {
  for (const mode of ["flags", "config", "environment", "classic"]) await prove(mode);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
