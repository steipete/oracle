#!/usr/bin/env node
// Actual CLI service/clients and Chrome; synthetic pages, no provider account.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = createRequire(require.resolve("chrome-remote-interface"))("ws");
const WebSocketServer = WebSocket.Server;
import { Launcher } from "chrome-launcher";
import CDP from "chrome-remote-interface";

const repo = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repo, "dist/bin/oracle-cli.js");
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const captures = option("--captures");
const baseline = option("--baseline-cli");
const guardOnly = process.argv.includes("--guard-only");
const root = await fs.mkdtemp(path.join(os.homedir(), "oracle-serve-queue-proof-"));
const previousHome = process.env.ORACLE_HOME_DIR;
process.env.ORACLE_HOME_DIR = path.join(root, "integration-home");
const { runBrowserMode } = await import("../dist/src/browser/index.js");
const { acquireProfileRunLock, writeChromePid, writeDevToolsActivePort } =
  await import("../dist/src/browser/profileState.js");
const { acquireBrowserTabLease } = await import("../dist/src/browser/tabLeaseRegistry.js");
const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p));
assert.ok(chromePath, "Chrome/Chromium is required");
const token = "oracle-queue-synthetic-proof";
const profile = path.join(root, "profile");
const guardFile = path.join(root, "guard.txt");
await fs.writeFile(guardFile, "Synthetic guard cancellation attachment");
const releases = new Set();
const submitted = new Map();
const children = [];
const controllers = [];
const integrations = [];
const proxies = [];
const makeController = () => {
  const controller = new AbortController();
  controllers.push(controller);
  return controller;
};
const startIntegration = (options) => {
  const logs = [];
  const pending = runBrowserMode({
    ...options,
    log: (message) => {
      logs.push(message);
      options.log?.(message);
    },
  });
  pending.observedLogs = logs;
  integrations.push(pending);
  pending.catch((error) => {
    pending.observedError = error;
  });
  return pending;
};
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
const page = (name) => `<!doctype html><meta charset="utf-8"><title>Oracle queue fixture</title>
<style>body{font:18px system-ui;margin:30px}textarea{width:600px;height:100px}button{padding:8px}article{padding:12px}</style>
<h1>Oracle queue fixture</h1><p>Synthetic ${name} run; no provider account.</p><span id="run-name">${name}</span>
<button data-testid="profile-button">Synthetic profile</button><button data-testid="model-switcher-dropdown-button">GPT-5.5</button>
<a class="__menu-item" aria-label="Synthetic Chat" href="/c/borrowed-fixture">Synthetic Chat</a>
<main><div id="turns"></div><form><textarea id="prompt-textarea" name="prompt-textarea" placeholder="Ask anything"></textarea><button type="button" id="composer-plus-btn" aria-expanded="false">+</button><input type="file" id="upload"><div id="chips"></div><button type="button" data-testid="send-button">Send</button></form></main>
<script>
const name=${JSON.stringify(name)};let sends=0;const files=[];
window.__oracleProofListeners=new Map();window.__oracleProofArmed=false;
const add=window.addEventListener.bind(window), remove=window.removeEventListener.bind(window);
window.addEventListener=(type,handler,...args)=>{
 add(type,handler,...args);
 if(window.__oracleProofArmed&&['keydown','keyup','click','beforeinput','input','change'].includes(type)){
  const listeners=window.__oracleProofListeners.get(type)||new Set();listeners.add(handler);window.__oracleProofListeners.set(type,listeners);
 }

};
window.removeEventListener=(type,handler,...args)=>{window.__oracleProofListeners.get(type)?.delete(handler);return remove(type,handler,...args);};
document.querySelector('#composer-plus-btn').onclick=event=>event.currentTarget.setAttribute('aria-expanded',String(event.currentTarget.getAttribute('aria-expanded')!=='true'));
document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('#composer-plus-btn').setAttribute('aria-expanded','false');});
document.querySelector('#upload').onchange=event=>{for(const file of event.target.files){files.push(file.name);const chip=document.createElement('div');chip.dataset.testid='attachment-chip';chip.textContent=file.name;document.querySelector('#chips').append(chip);}event.target.value='';};
function send(){
 sends++;const editor=document.querySelector('textarea');const prompt=editor.value;editor.value='';
 const user=document.createElement('article');user.dataset.testid='conversation-turn-0';user.dataset.turn='user';const text=document.createElement('div');text.dataset.messageAuthorRole='user';text.textContent=prompt;user.append(text);for(const name of files){const chip=document.createElement('div');chip.dataset.testid='attachment-chip';chip.textContent=name;user.append(chip);}document.querySelector('#turns').append(user);
 history.replaceState({},'', '/c/queue-'+name);fetch('/submitted/'+name,{method:'POST',body:JSON.stringify({name,sends,url:location.href})});
 const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.type='button';stop.textContent='Stop';document.querySelector('form').append(stop);
 const timer=setInterval(async()=>{const state=await fetch('/release/'+name).then(r=>r.json());if(!state.ready)return;clearInterval(timer);stop.remove();
 const answer=document.createElement('article');answer.dataset.testid='conversation-turn-1';answer.dataset.turn='assistant';answer.innerHTML='<div data-message-author-role="assistant" data-message-id="queue-'+name+'"><div class="markdown"><p>QUEUE_'+name+'_OK</p></div></div><button type="button" data-testid="copy-turn-action-button">Copy</button>';answer.querySelector('button').onclick=()=>navigator.clipboard.writeText('QUEUE_'+name+'_OK');document.querySelector('#turns').append(answer);
 },100);
}
document.querySelector('[data-testid=send-button]').onclick=send;
document.querySelector('form').onsubmit=e=>{e.preventDefault();send();};document.querySelector('textarea').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
</script>`;
function responseFor(url, body = "") {
  if (url.pathname.startsWith("/submitted/")) {
    submitted.set(url.pathname.slice(11), JSON.parse(body));
    return { mime: "application/json", body: "{}" };
  }
  if (url.pathname.startsWith("/release/"))
    return {
      mime: "application/json",
      body: JSON.stringify({ ready: releases.has(url.pathname.slice(9)) }),
    };
  if (url.pathname === "/api/auth/session")
    return { mime: "application/json", body: JSON.stringify({ user: { name: "Synthetic" } }) };
  const name =
    url.searchParams.get("name") ??
    (url.pathname === "/c/borrowed-fixture" ? "borrowed" : "warmup");
  return { mime: "text/html", body: page(/^[a-zA-Z0-9_-]+$/.test(name) ? name : "warmup") };
}
const fixture = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const response = responseFor(new URL(req.url, "http://localhost"), body);
  res.setHeader("content-type", response.mime);
  res.end(response.body);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const urlFor = (name) => `http://127.0.0.1:${fixture.address().port}/?name=${name}`;
const chrome = new Launcher({
  chromePath,
  userDataDir: profile,
  handleSIGINT: false,
  chromeFlags: [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});
let browser;
let interceptError;
const interceptedTargets = new Set();
function child(name, args, home, extra = {}) {
  const process = spawn(globalThis.process.execPath, args, {
    cwd: repo,
    env: { ...globalThis.process.env, ORACLE_HOME_DIR: home, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = { name, process, output: "", done: false, code: null };
  children.push(run);
  process.stdout.on("data", (d) => {
    run.output += d;
  });
  process.stderr.on("data", (d) => {
    run.output += d;
  });
  run.finished = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code) => {
      run.done = true;
      run.code = code;
      resolve(run);
    });
  });
  run.finished.catch(() => {});
  return run;
}
async function stop(run) {
  if (run.done) return;
  run.process.kill("SIGTERM");
  const force = setTimeout(() => run.process.kill("SIGKILL"), 3000);
  await run.finished.catch(() => {});
  clearTimeout(force);
}
async function startService(name, queued) {
  const port = await unusedPort();
  const home = path.join(root, name);
  await fs.mkdir(home);
  const args = [
    cli,
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--token",
    token,
    "--manual-login",
    "--manual-login-profile-dir",
    profile,
  ];
  if (queued) args.push("--max-concurrent-runs", "4", "--max-queued-runs", "2");
  const run = child(name, args, home, { ORACLE_BROWSER_MAX_CONCURRENT_TABS: "2" });
  const health = async () =>
    fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000),
    }).then((r) => r.json());
  await waitFor(async () => {
    if (run.done) throw new Error(run.output);
    try {
      return (await health()).ok;
    } catch {
      return false;
    }
  }, "service readiness");
  return { run, port, home, health };
}
async function startClient(name, service, binary = cli, extraArgs = []) {
  const home = path.join(root, "client-" + name);
  await fs.mkdir(home);
  const args = [
    binary,
    "--engine",
    "browser",
    "--model",
    "gpt-5.5",
    "--browser-model-strategy",
    "ignore",
    "--remote-host",
    `127.0.0.1:${service.port}`,
    "--remote-token",
    token,
    "--chatgpt-url",
    urlFor(name),
    "--browser-timeout",
    "45s",
    "--browser-input-timeout",
    "15s",
    "--browser-archive",
    "never",
    "--slug",
    "same-client-session",
    "--prompt",
    `Return the synthetic ${name} marker.`,
    "--no-notify",
    "--wait",
    "--verbose",
  ];
  const run = child(name, [...args, ...extraArgs], home);
  run.home = home;
  return run;
}
async function finishClient(run) {
  releases.add(run.name);
  await waitFor(() => run.done, `${run.name} completion`, 25000);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, new RegExp(`QUEUE_${run.name}_OK`));
  const meta = JSON.parse(
    await fs.readFile(path.join(run.home, "sessions", "same-client-session", "meta.json"), "utf8"),
  );
  assert.equal(meta.status, "completed");
  assert.equal(submitted.get(run.name)?.sends, 1);
}
async function targetFor(name) {
  return (await CDP.List({ port: chrome.port })).find((t) => t.url.includes(`/c/queue-${name}`));
}
const registry = async () =>
  JSON.parse(await fs.readFile(path.join(profile, "oracle-tab-leases.json"), "utf8")).leases;
async function delayedProxy(kind) {
  let release;
  let observed;
  let inFlight = 0;
  const sockets = new Set();
  const proxy = http.createServer(async (req, res) => {
    inFlight++;
    try {
      const upstream = await fetch(`http://127.0.0.1:${chrome.port}${req.url}`, {
        method: req.method,
      });
      const body = await upstream.text();
      if (
        (kind === "target" && req.url.startsWith("/json/new")) ||
        (kind === "version" && req.url === "/json/version")
      ) {
        observed = JSON.parse(body);
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      if (!res.destroyed) {
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(body);
      }
    } catch {
      if (!res.destroyed) {
        res.writeHead(502);
        res.end();
      }
    } finally {
      inFlight--;
    }
  });
  proxy.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    const upstream = net.connect(chrome.port, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${req.rawHeaders.map((v, i) => (i % 2 === 0 ? v + ": " : v + "\r\n")).join("")}\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      upstream.destroy();
    });
    upstream.on("close", () => sockets.delete(upstream));
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const handle = {
    port: proxy.address().port,
    observed: () => observed,
    release: () => release?.(),
    idle: () => inFlight === 0,
    close: async () => {
      release?.();
      for (const socket of sockets) socket.destroy();
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
    },
  };
  proxies.push(handle);
  return handle;
}
// Delay only the acknowledgement: the renderer has finished installing the guard,
// while Oracle still awaits the real CDP response. Cleanup RPCs remain usable.
async function guardResponseProxy() {
  let selected = null,
    held = null;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: chrome.port, path: req.url, method: req.method },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let body = Buffer.concat(chunks).toString();
          try {
            body = JSON.stringify(JSON.parse(body), (key, value) =>
              key === "webSocketDebuggerUrl"
                ? value.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${server.address().port}`)
                : value,
            );
          } catch {}
          res.writeHead(response.statusCode, {
            "content-type": response.headers["content-type"] ?? "application/json",
          });
          res.end(body);
        });
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (client) => {
      const remote = new WebSocket(`ws://127.0.0.1:${chrome.port}${req.url}`);
      sockets.add(client);
      sockets.add(remote);
      const waiting = [];
      const candidates = new Set();
      client.on("message", (data) => {
        const message = JSON.parse(data.toString());
        const expression = message.params?.expression ?? "";
        if (selected && message.method === "Runtime.evaluate") {
          const [stage, route] = selected;
          const match =
            stage === "file"
              ? route === "local"
                ? expression.includes("return { installed: true }")
                : expression.includes("const base64Data")
              : stage === "plus"
                ? expression.includes("const guard = { sawKeyDown: false, clicked: false")
                : stage === "prompt"
                  ? expression.includes("guard.fallback = text")
                  : expression.includes("window.__oracleAttachmentDispatchGuard = guard");
          if (match) candidates.add(message.id);
        }
        if (remote.readyState === WebSocket.OPEN) remote.send(data.toString());
        else waiting.push(data);
      });
      remote.on("open", () => {
        for (const data of waiting) remote.send(data.toString());
        waiting.length = 0;
      });
      remote.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (selected && !held && candidates.delete(message.id)) {
          held = { client, data };
          selected = null;
          return;
        }
        if (client.readyState === WebSocket.OPEN) client.send(data.toString());
      });
      client.on("close", () => {
        remote.close();
        sockets.delete(client);
      });
      remote.on("close", () => {
        client.close();
        sockets.delete(remote);
      });
      client.on("error", () => {});
      remote.on("error", () => client.close());
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const release = () => {
    if (held?.client.readyState === WebSocket.OPEN) held.client.send(held.data.toString());
    held = null;
    selected = null;
  };
  const handle = {
    port: server.address().port,
    arm(stage, route) {
      release();
      selected = [stage, route];
    },
    held: () => Boolean(held),
    release,
    close: async () => {
      release();
      for (const socket of sockets) socket.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  proxies.push(handle);
  return handle;
}

try {
  await fs.mkdir(profile);
  await chrome.launch();
  await writeChromePid(profile, chrome.pid);
  await writeDevToolsActivePort(profile, chrome.port);
  const version = await fetch(`http://127.0.0.1:${chrome.port}/json/version`).then((r) => r.json());
  browser = await CDP({ target: version.webSocketDebuggerUrl });
  browser.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== "page") return;
    void (async () => {
      await browser.send(
        "Fetch.enable",
        { patterns: [{ urlPattern: "https://chatgpt.com/*", requestStage: "Request" }] },
        sessionId,
      );
      interceptedTargets.add(targetInfo.targetId);
      await browser.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })().catch((e) => {
      interceptError = e;
    });
  });
  browser.on("Fetch.requestPaused", (event, sessionId) => {
    const response = responseFor(new URL(event.request.url), event.request.postData);
    void browser
      .send(
        "Fetch.fulfillRequest",
        {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: response.mime }],
          body: Buffer.from(response.body).toString("base64"),
        },
        sessionId,
      )
      .catch((e) => {
        interceptError = e;
      });
  });
  await browser.Target.setAutoAttach({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page", exclude: false }, { exclude: true }],
  });

  if (!guardOnly) {
    const legacy = await startService("legacy-service", false);
    const legacyClient = await startClient("legacy", legacy);
    await waitFor(() => submitted.has("legacy"), "legacy submit");
    const refused = await fetch(`http://127.0.0.1:${legacy.port}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: "overflow", options: {}, browserConfig: {} }),
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "busy" });
    assert.equal((await legacy.health()).admissionMode, "legacy");
    await finishClient(legacyClient);
    await stop(legacy.run);
    results.push({ legacyDefault409: true });

    const service = await startService("queue-service", true);
    const partialUploads = [];
    let overflowUpload;
    try {
      for (let index = 0; index < 4; index++) {
        const body = JSON.stringify({ prompt: `body-${index}`, options: {}, browserConfig: {} });
        const request = http.request({
          host: "127.0.0.1",
          port: service.port,
          path: "/runs",
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Length": Buffer.byteLength(body) },
        });
        request.on("error", () => {});
        request.write(body.slice(0, 1));
        partialUploads.push(request);
        await waitFor(async () => {
          const state = await service.health();
          return state.activeRuns + state.queuedRuns === index + 1;
        }, "body reservation");
      }
      const rejected = await new Promise((resolve, reject) => {
        overflowUpload = http.request(
          {
            host: "127.0.0.1",
            port: service.port,
            path: "/runs",
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Length": 100000 },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        overflowUpload.on("error", reject);
        overflowUpload.flushHeaders();
      });
      assert.equal(rejected, 503);
      assert.equal(
        [...submitted.keys()].some((name) => name.startsWith("body-")),
        false,
      );
      const receiving = await service.health();
      assert.equal(receiving.activeRuns, 2);
      assert.equal(receiving.queuedRuns, 2);
    } finally {
      overflowUpload?.destroy();
      for (const request of partialUploads) request.destroy();
    }
    await waitFor(async () => {
      const state = await service.health();
      return state.activeRuns === 0 && state.queuedRuns === 0;
    }, "body reservation cleanup");
    results.push({
      incompleteBodiesBounded: true,
      refusedBeforePayload: true,
      cancelledReadersReleased: true,
    });

    assert.equal((await service.health()).maxConcurrentRuns, 2);
    const a = await startClient("A", service),
      b = await startClient("B", service);
    await waitFor(() => submitted.has("A") && submitted.has("B"), "two active clients");
    const aTarget = await targetFor("A"),
      bTarget = await targetFor("B");
    assert.ok(aTarget && bTarget);
    assert.notEqual(aTarget.id, bTarget.id);
    const c = await startClient("C", service);
    await waitFor(async () => (await service.health()).queuedRuns === 1, "first waiter");
    const d = await startClient("D", service, baseline ?? cli);
    await waitFor(async () => (await service.health()).queuedRuns === 2, "second waiter");
    const overflow = await fetch(`http://127.0.0.1:${service.port}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: "overflow", options: {}, browserConfig: {} }),
    });
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers.get("retry-after"), "60");
    assert.deepEqual(await overflow.json(), { error: "queue_full" });
    await stop(c);
    await waitFor(async () => (await service.health()).queuedRuns === 1, "queued cancellation");
    assert.equal(submitted.has("C"), false);
    const e = await startClient("E", service);
    await waitFor(async () => (await service.health()).queuedRuns === 2, "replacement waiter");
    const cancelledAt = Date.now();
    await stop(a);
    await waitFor(
      async () => !(await targetFor("A")) && submitted.has("D"),
      "active cancellation and FIFO handoff",
      10000,
    );
    assert.equal(submitted.has("E"), false);
    assert.ok((await CDP.List({ port: chrome.port })).some((t) => t.id === bTarget.id));
    const activeCancellationMs = Date.now() - cancelledAt;
    await finishClient(b);
    await waitFor(() => submitted.has("E"), "next FIFO handoff");
    await finishClient(d);
    await finishClient(e);
    await waitFor(
      async () => (await service.health()).activeRuns === 0 && (await registry()).length === 0,
      "empty service and lease registry",
    );
    const hostSessions = await fs.readdir(path.join(service.home, "sessions"));
    assert.ok(new Set(hostSessions).size >= 3);
    for (const name of ["B", "D", "E"]) {
      let found = false;
      for (const id of hostSessions) {
        const text = await fs
          .readFile(path.join(service.home, "sessions", id, "artifacts", "transcript.md"), "utf8")
          .catch(() => "");
        if (text.includes(`QUEUE_${name}_OK`)) {
          found = true;
          for (const other of ["B", "D", "E"].filter((n) => n !== name))
            assert.ok(!text.includes(`QUEUE_${other}_OK`));
        }
      }
      assert.ok(found, `missing host transcript ${name}`);
    }
    results.push({
      effectiveHostCap: 2,
      overflow503: true,
      fifo: ["D", "E"],
      queuedCancelledWithoutSubmit: true,
      activeCancelledTargetClosed: true,
      activeCancellationMs,
      peerSurvived: true,
      isolatedHostSessions: true,
      priorClientCompleted: Boolean(baseline),
    });

    const leaseOne = await acquireBrowserTabLease(profile, { maxConcurrentTabs: 2 }),
      leaseTwo = await acquireBrowserTabLease(profile, { maxConcurrentTabs: 2 });
    try {
      const waiting = await startClient("lease-wait", service);
      await waitFor(
        () => waiting.output.includes("Waiting for ChatGPT browser slot"),
        "browser lease waiter entered",
      );
      await stop(waiting);
      await waitFor(
        async () => (await service.health()).activeRuns === 0,
        "lease waiter cancellation",
      );
      assert.equal(submitted.has("lease-wait"), false);
      assert.deepEqual(
        (await registry()).map((l) => l.id).sort(),
        [leaseOne.id, leaseTwo.id].sort(),
      );
    } finally {
      await leaseOne.release();
      await leaseTwo.release();
    }
    await stop(service.run);
    results.push({ leaseWaitCancelled: true, foreignLeasesPreserved: true });

    let heldLock;
    let lockPromise;
    const lockedController = makeController();
    let lockTarget;
    let sawLock = false;
    const locked = startIntegration({
      prompt: "synthetic lock wait",
      signal: lockedController.signal,
      config: {
        manualLogin: true,
        manualLoginProfileDir: profile,
        keepBrowser: true,
        modelStrategy: "ignore",
        profileLockTimeoutMs: 20000,
        timeoutMs: 30000,
        chatgptUrl: urlFor("lock-wait"),
        archiveConversations: "never",
      },
      closeOwnedTabOnCancel: true,
      runtimeHintCb: async (hint) => {
        lockTarget ??= hint.chromeTargetId;
        if (lockTarget && !lockPromise)
          lockPromise = acquireProfileRunLock(profile, { timeoutMs: 1000 });
        if (lockPromise) heldLock = await lockPromise;
      },
      log: (message) => {
        if (message.includes("profile lock held")) sawLock = true;
      },
    });
    locked.catch(() => {});
    try {
      await waitFor(() => sawLock && lockTarget, "profile lock wait");
      lockedController.abort();
      await assert.rejects(locked, /cancelled/);
      assert.ok(existsSync(heldLock.path));
      assert.equal(JSON.parse(await fs.readFile(heldLock.path, "utf8")).lockId, heldLock.lockId);
      assert.ok(!(await CDP.List({ port: chrome.port })).some((t) => t.id === lockTarget));
      assert.equal(submitted.has("lock-wait"), false);
    } finally {
      lockedController.abort();
      await locked.catch(() => {});
      await heldLock?.release();
    }
    results.push({
      profileLockWaitCancelled: true,
      lockOwnerPreserved: true,
      ownedTargetClosed: true,
    });

    const borrowed = await CDP.New({
      port: chrome.port,
      url: "about:blank",
    });
    await waitFor(() => interceptedTargets.has(borrowed.id), "borrowed target interception");
    const borrowedInspector = await CDP({ port: chrome.port, target: borrowed.id });
    await borrowedInspector.Page.navigate({ url: "https://chatgpt.com/c/borrowed-fixture" });
    await borrowedInspector.close();
    await waitFor(
      async () =>
        (await CDP.List({ port: chrome.port })).some(
          (target) =>
            target.id === borrowed.id && target.url === "https://chatgpt.com/c/borrowed-fixture",
        ),
      "borrowed page navigation",
    );
    const borrowedController = makeController();
    const borrowing = startIntegration({
      prompt: "synthetic borrowed run",
      signal: borrowedController.signal,
      config: {
        remoteChrome: { host: "127.0.0.1", port: chrome.port },
        browserTabRef: borrowed.id,
        keepBrowser: true,
        modelStrategy: "ignore",
        timeoutMs: 30000,
        archiveConversations: "never",
      },
    });
    borrowing.catch(() => {});
    await waitFor(() => {
      if (borrowing.observedError)
        throw new Error(`${borrowing.observedError.message}\n${borrowing.observedLogs.join("\n")}`);
      return submitted.has("borrowed");
    }, "borrowed target submit");
    borrowedController.abort();
    await assert.rejects(borrowing, /cancelled/);
    assert.ok((await CDP.List({ port: chrome.port })).some((t) => t.id === borrowed.id));
    await CDP.Close({ port: chrome.port, id: borrowed.id });
    results.push({ borrowedTargetPreservedOnCancel: true });
  }

  const guardProxy = await guardResponseProxy();
  await writeDevToolsActivePort(profile, guardProxy.port);
  // Cancel while the actual guard registration/transfer response is in flight.
  for (const [stage, route] of [
    ["file", "local"],
    ["file", "remote"],
    ["prompt", "local"],
    ["prompt", "remote"],
    ["plus", "local"],
    ["send", "local"],
    ["send", "remote"],
  ]) {
    console.error(`Checking ${stage} guard cancellation on ${route} Chrome`);
    const name = `guard-${stage}`;
    const target = await CDP.New({ port: chrome.port, url: "about:blank" });
    await waitFor(() => interceptedTargets.has(target.id), "guard target interception");
    const inspector = await CDP({ port: chrome.port, target: target.id });
    await inspector.Page.navigate({ url: `https://chatgpt.com/c/borrowed-fixture?name=${name}` });
    await waitFor(
      async () =>
        (
          await inspector.Runtime.evaluate({
            expression: "Boolean(window.__oracleProofListeners)",
            returnByValue: true,
          })
        ).result.value,
      "guard fixture ready",
    );
    await inspector.Runtime.evaluate({ expression: "window.__oracleProofArmed = true" });
    guardProxy.arm(stage, route);
    const controller = makeController();
    const pending = startIntegration({
      prompt: "Synthetic guarded attachment prompt",
      attachments: [{ path: guardFile, displayPath: "guard.txt" }],
      signal: controller.signal,
      config: {
        ...(route === "remote"
          ? { remoteChrome: { host: "127.0.0.1", port: guardProxy.port } }
          : { manualLogin: true, manualLoginProfileDir: profile, chromePath, headless: true }),
        browserTabRef: target.id,
        keepBrowser: true,
        modelStrategy: "ignore",
        timeoutMs: 30000,
        archiveConversations: "never",
      },
    });
    try {
      await waitFor(() => {
        if (pending.observedError) throw pending.observedError;
        return guardProxy.held();
      }, `${stage} guard installed`);
      const activeGuards = (
        await inspector.Runtime.evaluate({
          expression: `Object.keys(window.__oracleAttachmentInputGuards ?? {}).length + Object.keys(window.__oracleAttachmentPromptGuards ?? {}).length + Object.keys(window.__oracleAttachmentPlusGuards ?? {}).length + Number(Boolean(window.__oracleAttachmentDispatchGuard))`,
          returnByValue: true,
        })
      ).result.value;
      if (!(stage === "file" && route === "remote"))
        assert.ok(activeGuards > 0, "guard must be installed before abort");
      controller.abort();
      await assert.rejects(pending, /cancelled/);
      guardProxy.release();
      const observed = (
        await inspector.Runtime.evaluate({
          expression: `({
        listeners: [...window.__oracleProofListeners.values()].reduce((sum, set) => sum + set.size, 0),
        remaining: [...window.__oracleProofListeners].filter(([, set]) => set.size).map(([type, set]) => [type, [...set].map(fn => fn.name)]),
        file: Object.keys(window.__oracleAttachmentInputGuards ?? {}).length,
        prompt: Object.keys(window.__oracleAttachmentPromptGuards ?? {}).length,
        plus: Object.keys(window.__oracleAttachmentPlusGuards ?? {}).length,
        nodes: Object.keys(window.__oracleAttachmentPlusNodes ?? {}).length,
        send: Boolean(window.__oracleAttachmentDispatchGuard)
      })`,
          returnByValue: true,
        })
      ).result.value;
      assert.deepEqual(observed, {
        listeners: 0,
        remaining: [],
        file: 0,
        prompt: 0,
        plus: 0,
        nodes: 0,
        send: false,
      });
      assert.equal(submitted.has(name), false);
      assert.ok((await CDP.List({ port: chrome.port })).some((t) => t.id === target.id));
      results.push({
        guardCancellation: stage,
        route,
        guardObservedBeforeAbort: activeGuards > 0,
        listenersRemoved: true,
        noSubmit: true,
        borrowedTargetPreserved: true,
      });
    } finally {
      controller.abort();
      guardProxy.release();
      await pending.catch(() => {});
      await inspector.close();
      await CDP.Close({ port: chrome.port, id: target.id }).catch(() => {});
    }
  }

  console.error("Checking built CLI/service cancellation with an active prompt guard");
  const guardService = await startService("guard-service", true);
  guardProxy.arm("prompt", "local");
  const guardClient = await startClient("guard-prompt", guardService, cli, [
    "--file",
    guardFile,
    "--browser-attachments",
    "always",
  ]);
  try {
    await waitFor(() => {
      if (guardClient.done) throw new Error(guardClient.output);
      return guardProxy.held();
    }, "service prompt guard installed");
    const ownedTarget = (await CDP.List({ port: chrome.port })).find(
      (target) => target.url === urlFor("guard-prompt"),
    );
    assert.ok(ownedTarget);
    await stop(guardClient);
    await waitFor(
      async () => (await guardService.health()).activeRuns === 0,
      "guarded service cancellation",
    );
    guardProxy.release();
    assert.equal(submitted.has("guard-prompt"), false);
    assert.equal(
      (await CDP.List({ port: chrome.port })).some((t) => t.id === ownedTarget.id),
      false,
    );
    results.push({ builtClientGuardCancellation: true, noSubmit: true, ownedTargetClosed: true });
  } finally {
    guardProxy.release();
    await stop(guardClient);
    await stop(guardService.run);
  }

  await writeDevToolsActivePort(profile, chrome.port);
  await guardProxy.close();
  proxies.splice(proxies.indexOf(guardProxy), 1);

  if (!guardOnly) {
    const proxy = await delayedProxy("target");
    const lateController = makeController();
    const late = startIntegration({
      prompt: "no late submit",
      signal: lateController.signal,
      config: {
        remoteChrome: { host: "127.0.0.1", port: proxy.port },
        modelStrategy: "ignore",
        timeoutMs: 30000,
        chatgptUrl: urlFor("late"),
      },
    });
    late.catch(() => {});
    try {
      await waitFor(() => proxy.observed()?.id, "created target with delayed reply");
      const id = proxy.observed().id;
      lateController.abort();
      await assert.rejects(late, /cancelled/);
      proxy.release();
      await waitFor(
        async () => !(await CDP.List({ port: chrome.port })).some((t) => t.id === id),
        "late target cleanup",
      );
      assert.equal(submitted.has("late"), false);
    } finally {
      lateController.abort();
      proxy.release();
      await late.catch(() => {});
      await proxy.close();
    }
    results.push({ delayedCdpSetupCancelled: true, lateOwnedTargetClosed: true });

    const acquisitionProxy = await delayedProxy("version");
    await writeDevToolsActivePort(profile, acquisitionProxy.port);
    const acquisitionController = makeController();
    const acquiring = startIntegration({
      prompt: "no acquisition submit",
      signal: acquisitionController.signal,
      config: {
        manualLogin: true,
        manualLoginProfileDir: profile,
        keepBrowser: true,
        modelStrategy: "ignore",
        timeoutMs: 30000,
        reuseChromeWaitMs: 0,
        chatgptUrl: urlFor("acquisition"),
      },
    });
    acquiring.catch(() => {});
    try {
      await waitFor(() => acquisitionProxy.observed(), "pending Chrome acquisition");
      acquisitionController.abort();
      await assert.rejects(acquiring, /cancelled/);
      acquisitionProxy.release();
      await waitFor(acquisitionProxy.idle, "acquisition response drain");
      await pause(100);
      assert.equal(submitted.has("acquisition"), false);
    } finally {
      acquisitionController.abort();
      acquisitionProxy.release();
      await acquiring.catch(() => {});
      await acquisitionProxy.close();
      await writeDevToolsActivePort(profile, chrome.port);
    }
    results.push({ chromeAcquisitionCancelled: true, sharedChromePreserved: true });

    const temporaryController = makeController();
    let temporaryPid;
    let temporaryProfile;
    const temporary = startIntegration({
      prompt: "no temporary submit",
      signal: temporaryController.signal,
      config: {
        chromePath,
        headless: true,
        cookieSync: false,
        modelStrategy: "ignore",
        debugPort: await unusedPort(),
      },
      log: (message) => {
        if (message.startsWith("Created temporary Chrome profile at "))
          temporaryProfile = message.slice("Created temporary Chrome profile at ".length);
        if (message.startsWith("Launched Chrome")) {
          temporaryPid = Number(message.match(/pid (\d+)/)?.[1]);
          temporaryController.abort();
        }
      },
    });
    await assert.rejects(temporary, /cancelled/);
    assert.ok(temporaryPid && temporaryProfile);
    await waitFor(() => {
      try {
        process.kill(temporaryPid, 0);
        return false;
      } catch {
        return true;
      }
    }, "late temporary Chrome termination");
    await waitFor(() => !existsSync(temporaryProfile), "temporary profile cleanup");
    results.push({
      temporaryLaunchCancelled: true,
      lateChromeClosed: true,
      temporaryProfileRemoved: true,
    });
    assert.equal(interceptError, undefined);
    assert.equal((await registry()).length, 0);
  }
  console.log(JSON.stringify({ provider: "synthetic local renderer", results }, null, 2));
} finally {
  for (const controller of controllers) controller.abort();
  for (const proxy of proxies) proxy.release();
  await Promise.allSettled(integrations);
  for (const run of children) await stop(run);
  if (captures) {
    await fs.mkdir(captures, { recursive: true });
    for (const run of children)
      await fs.writeFile(path.join(captures, run.name + ".log"), run.output);
    for (const [index, run] of integrations.entries())
      await fs.writeFile(
        path.join(captures, `integration-${index}.log`),
        run.observedLogs.join("\n"),
      );
  }
  await browser?.close().catch(() => {});
  await Promise.resolve(chrome.kill());
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (previousHome === undefined) delete process.env.ORACLE_HOME_DIR;
  else process.env.ORACLE_HOME_DIR = previousHome;
}
