#!/usr/bin/env node
// Two real CLI controllers sharing a fresh profile; synthetic pages, no provider account.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import CDP from "chrome-remote-interface";
import { Launcher } from "chrome-launcher";
import { readChromePid, readDevToolsPort } from "../dist/src/browser/profileState.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const captureIndex = process.argv.indexOf("--captures");
const captures = captureIndex < 0 ? undefined : process.argv[captureIndex + 1];
const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p));
assert.ok(chromePath, "Chrome/Chromium is required");
const root = await fs.mkdtemp(path.join(os.homedir(), "oracle-shared-chrome-proof-"));
const profile = path.join(root, "shared profile");
const release = new Set();
const submitted = new Map();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windowsConsoleIds = async () => {
  if (process.platform !== "win32") return [];
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "ConvertTo-Json -InputObject @(Get-Process -Name WindowsTerminal,OpenConsole -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -Compress",
    ],
    { windowsHide: true },
  );
  return JSON.parse(stdout.trim() || "[]");
};
const consoleIdsBefore = await windowsConsoleIds();
const html = (
  name,
) => `<!doctype html><meta charset="utf-8"><title>Oracle shared Chrome fixture</title>
<style>body{font:18px system-ui;margin:30px}textarea{width:600px;height:100px}article{padding:12px}</style>
<h1>Oracle shared Chrome fixture</h1><p>Synthetic ${name} controller; no provider account.</p><span id="run-name">${name}</span>
<button data-testid="profile-button">Synthetic profile</button><button data-testid="model-switcher-dropdown-button">GPT-5.5</button>
<main><div id="turns"></div><form><textarea id="prompt-textarea" name="prompt-textarea" placeholder="Ask anything"></textarea><button data-testid="send-button" type="button">Send</button></form></main>
<script>
let sends=0;const name=${JSON.stringify(name)};
function send(){
 sends++; const prompt=document.querySelector('textarea').value;document.querySelector('textarea').value='';
 const user=document.createElement('article');user.dataset.testid='conversation-turn-0';user.dataset.turn='user';const content=document.createElement('div');content.dataset.messageAuthorRole='user';content.dataset.messageId='lifecycle-user';content.textContent=prompt;user.append(content);document.querySelector('#turns').append(user);
 history.replaceState({},'', '/c/fixture-'+name);
 const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='Stop';document.querySelector('form').append(stop);
 fetch('/submitted/'+name,{method:'POST',body:JSON.stringify({sends,url:location.href})});
 const poll=setInterval(async()=>{
  const state=await fetch('/release/'+name).then(r=>r.json());if(!state.ready)return;clearInterval(poll);stop.remove();
  const answer=document.createElement('article');answer.dataset.testid='conversation-turn-1';answer.dataset.turn='assistant';
  answer.innerHTML='<div data-message-author-role="assistant" data-message-id="message-'+name+'"><div class="markdown"><p>ORACLE_SHARED_'+name.toUpperCase()+'_OK</p></div></div><button data-testid="copy-turn-action-button" type="button">Copy</button>';
  answer.querySelector('button').onclick=()=>navigator.clipboard.writeText('ORACLE_SHARED_'+name.toUpperCase()+'_OK');document.querySelector('#turns').append(answer);
 },100);
}
document.querySelector('[data-testid=send-button]').onclick=send;
document.querySelector('form').onsubmit=e=>{e.preventDefault();send();};document.querySelector('textarea').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
</script>`;
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/submitted/")) {
    let body = "";
    for await (const c of req) body += c;
    submitted.set(req.url.slice(11), JSON.parse(body));
    res.end("ok");
    return;
  }
  if (req.url.startsWith("/release/")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ready: release.has(req.url.slice(9)) }));
    return;
  }
  if (req.url.startsWith("/api/auth/session")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ user: { name: "Synthetic" } }));
    return;
  }
  const name = new URL(req.url, "http://localhost").searchParams.get("name") ?? "owner";
  res.setHeader("content-type", "text/html");
  res.end(html(name === "peer" ? "peer" : "owner"));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const runs = [];
let primer;
let browser;
let peerTarget;
let chromePid;
let chromePort;
let interceptedRequests = 0;
let interceptionError;
async function attachFixtureInterceptor() {
  const deadline = Date.now() + 30000;
  let version;
  while (Date.now() < deadline) {
    try {
      version = await fetch(`http://127.0.0.1:${chromePort}/json/version`, {
        signal: AbortSignal.timeout(200),
      }).then((r) => r.json());
      break;
    } catch {}
    const failure = runs.find((run) => run.finished && run.exit !== 0);
    assert.ok(!failure, failure?.output);
    await pause(10);
  }
  assert.ok(version?.webSocketDebuggerUrl, "The owner did not expose Chrome DevTools");
  const client = await CDP({ target: version.webSocketDebuggerUrl });
  const processes = await client.SystemInfo.getProcessInfo();
  const recordedPid = await readChromePid(profile);
  if (
    recordedPid &&
    processes.processInfo.find((process) => process.type === "browser")?.id === recordedPid
  )
    browser = client;
  const targets = await client.Target.getTargets();
  assert.ok(
    targets.targetInfos
      .filter((t) => t.type === "page")
      .every((t) => !t.url || t.url === "about:blank" || t.url === "chrome://newtab/"),
    "Fixture interception must precede any homepage navigation",
  );
  client.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== "page") return;
    void (async () => {
      await client.send(
        "Fetch.enable",
        { patterns: [{ urlPattern: "https://chatgpt.com/*", requestStage: "Request" }] },
        sessionId,
      );
      await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })().catch((error) => {
      interceptionError = error;
    });
  });
  client.on("Fetch.requestPaused", (event, sessionId) => {
    const auth = new URL(event.request.url).pathname === "/api/auth/session";
    const body = auth ? JSON.stringify({ user: { name: "Synthetic fixture" } }) : html("owner");
    interceptedRequests += 1;
    void client
      .send(
        "Fetch.fulfillRequest",
        {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: auth ? "application/json" : "text/html" },
          ],
          body: Buffer.from(body).toString("base64"),
        },
        sessionId,
      )
      .catch((error) => {
        interceptionError = error;
      });
  });
  await client.Target.setAutoAttach({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page", exclude: false }, { exclude: true }],
  });
  return client;
}
const start = async (name) => {
  const home = path.join(root, name);
  await fs.mkdir(home);
  const args = [
    path.join(repo, "dist/bin/oracle-cli.js"),
    "--engine",
    "browser",
    "--model",
    "gpt-5.5",
    "--browser-model-strategy",
    "ignore",
    "--browser-manual-login",
    "--browser-manual-login-profile-dir",
    profile,
    "--browser-headless",
    "--browser-port",
    String(chromePort),
    "--browser-chrome-path",
    chromePath,
    "--browser-profile-lock-timeout",
    "30s",
    "--browser-max-concurrent-tabs",
    "2",
    "--browser-timeout",
    "90s",
    "--browser-input-timeout",
    "20s",
    "--browser-archive",
    "never",
    "--chatgpt-url",
    `http://127.0.0.1:${server.address().port}/?name=${name}`,
    "--prompt",
    `Return the synthetic ${name} marker.`,
    "--slug",
    `shared-${name}-proof`,
    "--no-notify",
    "--wait",
    "--verbose",
  ];
  const child = spawn(process.execPath, args, {
    cwd: repo,
    env: { ...process.env, ORACLE_HOME_DIR: home, ORACLE_CHROME_NO_SANDBOX: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = { name, home, child, output: "", finished: false, exit: null };
  runs.push(run);
  child.stdout.on("data", (d) => (run.output += d));
  child.stderr.on("data", (d) => (run.output += d));
  run.done = new Promise((resolve, reject) => {
    let force;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 2000);
    }, 120000);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(force);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(force);
      run.finished = true;
      run.exit = code;
      run.signal = signal;
      resolve(run);
    });
  });
  run.done.catch(() => {});
  return run;
};
const waitUntil = async (predicate, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    const failure = runs.find((r) => r.finished && r.exit !== 0);
    assert.ok(!failure, failure?.output);
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
};
const readRegistry = async () =>
  JSON.parse(await fs.readFile(path.join(profile, "oracle-tab-leases.json"), "utf8"));
try {
  // Initialize an empty real Chrome profile, then stop it. The owner CLI must
  // launch the shared process itself; priming does not supply provider login.
  await fs.mkdir(profile, { recursive: true });
  primer = new Launcher({
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
  await primer.launch();
  const primerPid = primer.pid;
  await Promise.resolve(primer.kill());
  await waitUntil(
    () => {
      try {
        process.kill(primerPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    "profile primer exit",
    10000,
  );
  primer = undefined;
  const portReservation = net.createServer();
  await new Promise((resolve) => portReservation.listen(0, "127.0.0.1", resolve));
  chromePort = portReservation.address().port;
  await new Promise((resolve) => portReservation.close(resolve));
  const attaching = attachFixtureInterceptor();
  attaching.catch(() => {});
  const owner = await start("owner");
  browser = await attaching;
  await waitUntil(() => submitted.has("owner"), "owner submit");
  chromePid = await readChromePid(profile);
  assert.equal(await readDevToolsPort(profile), chromePort);
  assert.ok(chromePid);
  const processes = await browser.SystemInfo.getProcessInfo();
  assert.equal(processes.processInfo.find((process) => process.type === "browser").id, chromePid);
  const peer = await start("peer");
  await waitUntil(() => submitted.has("peer"), "peer submit");
  assert.equal(interceptionError, undefined);
  assert.ok(interceptedRequests >= 2);
  const leases = (await readRegistry()).leases;
  assert.equal(leases.length, 2);
  const ownerLease = leases.find((l) => l.pid === owner.child.pid),
    peerLease = leases.find((l) => l.pid === peer.child.pid);
  assert.ok(ownerLease?.chromeTargetId && peerLease?.chromeTargetId);
  assert.notEqual(ownerLease.chromeTargetId, peerLease.chromeTargetId);
  assert.equal(await readChromePid(profile), chromePid);
  assert.equal(submitted.get("owner").sends, 1);
  assert.equal(submitted.get("peer").sends, 1);
  peerTarget = await CDP({ port: chromePort, target: peerLease.chromeTargetId });
  release.add("owner");
  await owner.done;
  assert.equal(owner.exit, 0, owner.output);
  assert.match(owner.output, /isLastLease=false/);
  assert.deepEqual(
    (await readRegistry()).leases.map((l) => l.id),
    [peerLease.id],
  );
  for (let i = 0; i < 20; i++) {
    process.kill(chromePid, 0);
    assert.ok(
      (await fetch(`http://127.0.0.1:${chromePort}/json/version`).then((r) => r.json()))
        .webSocketDebuggerUrl,
    );
    const targets = await CDP.List({ port: chromePort });
    assert.ok(targets.some((t) => t.id === peerLease.chromeTargetId));
    assert.ok(!targets.some((t) => t.id === ownerLease.chromeTargetId));
    const result = await peerTarget.Runtime.evaluate({
      expression: "document.querySelector('#run-name').textContent",
      returnByValue: true,
    });
    assert.equal(result.result.value, "peer");
    assert.equal(peer.finished, false);
    await pause(100);
  }
  release.add("peer");
  await peer.done;
  assert.equal(peer.exit, 0, peer.output);
  assert.match(peer.output, /isLastLease=true/);
  assert.equal((await readRegistry()).leases.length, 0);
  await assert.rejects(fs.access(path.join(profile, "oracle-tab-leases.lock")));
  await waitUntil(
    () => {
      try {
        process.kill(chromePid, 0);
        return false;
      } catch {
        return true;
      }
    },
    "final Chrome exit",
    5000,
  );
  await assert.rejects(
    fetch(`http://127.0.0.1:${chromePort}/json/version`, { signal: AbortSignal.timeout(1000) }),
  );
  const transcripts = [];
  for (const run of runs) {
    const sessionDir = path.join(run.home, "sessions", `shared-${run.name}-proof`);
    const meta = JSON.parse(await fs.readFile(path.join(sessionDir, "meta.json"), "utf8"));
    assert.equal(meta.status, "completed");
    const transcript = await fs.readFile(path.join(sessionDir, "artifacts", "transcript.md"));
    assert.match(transcript.toString(), new RegExp(`ORACLE_SHARED_${run.name.toUpperCase()}_OK`));
    assert.doesNotMatch(
      transcript.toString(),
      new RegExp(`ORACLE_SHARED_${run.name === "owner" ? "PEER" : "OWNER"}_OK`),
    );
    transcripts.push({
      name: run.name,
      sha256: createHash("sha256").update(transcript).digest("hex"),
    });
  }
  const consoleIdsAfter = await windowsConsoleIds();
  assert.deepEqual(
    consoleIdsAfter.filter((id) => !consoleIdsBefore.includes(id)),
    [],
  );
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        homepageRequestsServedByFixture: interceptedRequests,
        chromePid,
        ownerPid: owner.child.pid,
        peerPid: peer.child.pid,
        distinctTargets: true,
        sends: [1, 1],
        ownerExited: true,
        peerChecksAfterOwnerExit: 20,
        peerCompleted: true,
        finalLease: true,
        registryEmpty: true,
        chromeExited: true,
        endpointClosed: true,
        noAdditionalWindowsConsoleProcessesAtEnd: true,
        transcripts,
      },
      null,
      2,
    ),
  );
} finally {
  if (captures) {
    await fs.mkdir(captures, { recursive: true });
    for (const run of runs) await fs.writeFile(path.join(captures, run.name + ".log"), run.output);
  }
  for (const run of runs) if (!run.finished) run.child.kill("SIGTERM");
  if (primer) await Promise.resolve(primer.kill());
  await peerTarget?.close().catch(() => {});
  if (browser) {
    await browser.Browser.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  await Promise.allSettled(runs.map((run) => run.done));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
