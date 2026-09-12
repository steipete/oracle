#!/usr/bin/env node
// Built CLI + real Chrome proof against a synthetic ChatGPT-shaped page.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Launcher } from "chrome-launcher";
import CDP from "chrome-remote-interface";
import { writeChromePid, writeDevToolsActivePort } from "../dist/src/browser/profileState.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const baseline = option("--baseline-cli");
const captures = option("--captures");
const fourTier = process.argv.includes("--four-tier");
// Snap Chromium can access home-backed files, unlike the host's private /tmp.
const root = await fs.mkdtemp(path.join(os.homedir(), "oracle-effort-proof-"));
const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p));
assert.ok(chromePath, "Chrome/Chromium is required");
const observations = new Map();
let activeRun;
let submissionCapture = Promise.resolve();
const page = (
  mode,
) => `<!doctype html><meta charset="utf-8"><title>Oracle effort readiness fixture</title>
<style>body{font:18px system-ui;max-width:800px;margin:40px auto}button{padding:8px}textarea{display:block;width:95%;height:100px}#menu{padding:20px;border:1px solid #aaa}#simple{min-height:80px}#control{height:60px;padding:12px;box-sizing:border-box;background:#eee}#control.hidden{height:0;padding:0;overflow:hidden}article{padding:12px;border-bottom:1px solid #ddd}</style>
<h1>Oracle effort readiness fixture</h1><p>Synthetic controls; no provider account or generated model answer.</p>
<button data-testid="profile-button">Synthetic profile</button><button data-testid="model-switcher-dropdown-button">GPT-5.6 Sol</button>
<main><div id="turns"></div><form><textarea id="prompt-textarea" name="prompt-textarea" placeholder="Ask anything"></textarea>
<button id="pill" type="button" class="__composer-pill" aria-haspopup="menu" aria-controls="menu" aria-expanded="false">${mode === "already" ? "Pro" : "Extra High"}</button>
<button type="button" data-testid="send-button">Send</button></form></main>
<div id="menu" role="menu" style="display:none"><div data-testid="composer-intelligence-picker-content" role="group"><div data-model-selection-view="true"><div id="simple" data-testid="composer-model-picker-slider-simple-view" data-active="true"></div></div></div></div>
<script>
const mode=${JSON.stringify(mode)}, labels=${JSON.stringify(fourTier ? ["Instant", "Medium", "High", "Extra High"] : ["Instant", "Medium", "High", "Extra High", "Pro"])};
let index=${mode === "four-move" ? 1 : mode === "already" ? 4 : 3}, opened=false; const state={mode,keys:[],sends:0,ready:false,tier:labels[index]};
const report=()=>fetch('/events/'+mode,{method:'POST',body:JSON.stringify(state)});
const close=()=>{document.querySelector('#menu').style.display='none';document.querySelector('#pill').setAttribute('aria-expanded','false');};
const mount=()=>{
 const simple=document.querySelector('#simple');simple.innerHTML='<div id="control" tabindex="0" role="menuitem" aria-label="Power" aria-describedby="announcement"><div data-model-reasoning-effort-slider><div role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="'+(labels.length-1)+'" aria-valuenow="'+index+'"></div></div></div><div id="announcement">'+labels[index]+', '+(index+1)+' of '+labels.length+'.</div>';
 const control=document.querySelector('#control');
 if(mode==='geometry'||mode==='never')control.className='hidden';
 else state.ready=true;
 control.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
  state.keys.push({key:event.key,ready:state.ready});
  index=Math.max(0,Math.min(labels.length-1,index+(event.key==='ArrowRight'?1:-1)));state.tier=labels[index];
  control.querySelector('[role=slider]').setAttribute('aria-valuenow',String(index));
  document.querySelector('#announcement').textContent=labels[index]+', '+(index+1)+' of '+labels.length+'.';
  document.querySelector('#pill').textContent=labels[index];report();
 });report();
};
document.querySelector('#pill').onclick=()=>{
 document.querySelector('#menu').style.display='block';document.querySelector('#pill').setAttribute('aria-expanded','true');
 if(opened)return;opened=true;report();
 if(mode==='mounted')setTimeout(mount,2500);
 else{mount();if(mode==='geometry')setTimeout(()=>{document.querySelector('#control').className='';state.ready=true;report();},2500);}
};
document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
const send=()=>{
 state.sends++;state.sentTier=state.tier;report();
 const prompt=document.querySelector('#prompt-textarea').value;
 const turn=document.createElement('article');turn.dataset.testid='conversation-turn-0';turn.dataset.turn='user';
 const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.dataset.messageId='effort-user-'+state.sends;user.textContent=prompt;turn.append(user);document.querySelector('#turns').append(turn);
 document.querySelector('#prompt-textarea').value='';history.replaceState({},'', '/c/fixture-'+mode);
 setTimeout(()=>{
 const answer=document.createElement('article');answer.dataset.testid='conversation-turn-1';answer.dataset.turn='assistant';
 answer.innerHTML='<div data-message-author-role="assistant" data-message-id="synthetic-answer"><div class="markdown"><p>ORACLE_SLIDER_PROOF_OK</p></div></div><button type="button" data-testid="copy-turn-action-button" aria-label="Copy">Copy</button>';
 answer.querySelector('button').onclick=()=>navigator.clipboard.writeText('ORACLE_SLIDER_PROOF_OK');document.querySelector('#turns').append(answer);
 },200);
};
document.querySelector('[data-testid=send-button]').onclick=send;
document.querySelector('form').onsubmit=event=>{event.preventDefault();send();};
document.querySelector('#prompt-textarea').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}});
</script>`;
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/events/")) {
    let body = "";
    for await (const c of req) body += c;
    const update = JSON.parse(body);
    observations.set(req.url.slice(8), update);
    if (captures && update.sends === 1) {
      submissionCapture = captureSelectedTier(activeRun);
      submissionCapture.catch(() => {});
    }
    res.end("ok");
    return;
  }
  if (req.url.startsWith("/api/auth/session")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ user: { name: "Synthetic fixture" } }));
    return;
  }
  const mode = new URL(req.url, "http://localhost").searchParams.get("mode") ?? "mounted";
  res.setHeader("content-type", "text/html");
  res.end(page(mode));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const chrome = new Launcher({
  chromePath,
  userDataDir: path.join(root, "chrome"),
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
async function captureSelectedTier(name) {
  const target = (await CDP.List({ port: chrome.port })).find(
    (t) => t.type === "page" && t.url.includes(`127.0.0.1:${server.address().port}`),
  );
  assert.ok(target, "Expected the submitted fixture target");
  const client = await CDP({ port: chrome.port, target: target.id });
  try {
    const shot = await client.Page.captureScreenshot({ format: "png" });
    await fs.mkdir(captures, { recursive: true });
    await fs.writeFile(
      path.join(captures, name + "-selected.png"),
      Buffer.from(shot.data, "base64"),
    );
  } finally {
    await client.close();
  }
}
const results = [];
const serviceToken = "oracle-effort-fixture-only";
let service;
let serviceDone;
let servicePort;
let interceptor;
let interceptorError;
async function startBridge() {
  await writeChromePid(path.join(root, "chrome"), chrome.pid);
  await writeDevToolsActivePort(path.join(root, "chrome"), chrome.port);
  const version = await fetch(`http://127.0.0.1:${chrome.port}/json/version`).then((r) => r.json());
  interceptor = await CDP({ target: version.webSocketDebuggerUrl });
  interceptor.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== "page") return;
    void (async () => {
      await interceptor.send(
        "Fetch.enable",
        { patterns: [{ urlPattern: "https://chatgpt.com/*", requestStage: "Request" }] },
        sessionId,
      );
      await interceptor.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })().catch((error) => {
      interceptorError = error;
    });
  });
  interceptor.on("Fetch.requestPaused", (event, sessionId) => {
    const auth = new URL(event.request.url).pathname === "/api/auth/session";
    void interceptor
      .send(
        "Fetch.fulfillRequest",
        {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: auth ? "application/json" : "text/html" },
          ],
          body: Buffer.from(
            auth ? JSON.stringify({ user: { name: "Synthetic" } }) : page("mounted"),
          ).toString("base64"),
        },
        sessionId,
      )
      .catch((error) => {
        interceptorError = error;
      });
  });
  await interceptor.Target.setAutoAttach({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page", exclude: false }, { exclude: true }],
  });
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  servicePort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  service = spawn(
    process.execPath,
    [
      path.join(repo, "dist/bin/oracle-cli.js"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(servicePort),
      "--token",
      serviceToken,
      "--manual-login",
      "--manual-login-profile-dir",
      path.join(root, "chrome"),
    ],
    {
      cwd: repo,
      env: { ...process.env, ORACLE_HOME_DIR: path.join(root, "service-home") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serviceOutput = "";
  service.stdout.on("data", (d) => {
    serviceOutput += d;
  });
  service.stderr.on("data", (d) => {
    serviceOutput += d;
  });
  serviceDone = new Promise((resolve, reject) => {
    service.once("error", reject);
    service.once("exit", resolve);
  });
  serviceDone.catch(() => {});
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${servicePort}/health`, {
        headers: { Authorization: `Bearer ${serviceToken}` },
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    if (service.exitCode !== null) throw new Error(`Fixture bridge exited: ${serviceOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture bridge did not become ready");
}
try {
  await fs.mkdir(path.join(root, "chrome"));
  await chrome.launch();
  for (const run of fourTier
    ? [
        ...(baseline
          ? [
              {
                name: "baseline-four",
                mode: "four-already",
                cli: baseline,
                level: "extra-high",
                success: true,
                baseline: true,
              },
            ]
          : []),
        ...["four-already", "four-move", "four-pro"].map((mode) => ({
          name: "candidate-" + mode,
          mode,
          level: mode === "four-pro" ? "pro" : "extra-high",
          cli: path.join(repo, "dist/bin/oracle-cli.js"),
          success: mode !== "four-pro",
        })),
      ]
    : [
        ...(baseline ? [{ name: "baseline", mode: "mounted", cli: baseline, success: false }] : []),
        ...["mounted", "geometry", "never"].map((mode) => ({
          name: "candidate-" + mode,
          mode,
          cli: path.join(repo, "dist/bin/oracle-cli.js"),
          success: mode !== "never",
        })),
        {
          name: "candidate-already",
          mode: "already",
          strategy: "select",
          cli: path.join(repo, "dist/bin/oracle-cli.js"),
          success: true,
        },
        {
          name: "candidate-unverified",
          mode: "never",
          level: "standard",
          cli: path.join(repo, "dist/bin/oracle-cli.js"),
          success: true,
        },
        {
          name: "candidate-bridge",
          mode: "mounted",
          bridge: true,
          cli: path.join(repo, "dist/bin/oracle-cli.js"),
          success: true,
        },
      ]) {
    if (run.bridge) await startBridge();
    activeRun = run.name;
    submissionCapture = Promise.resolve();
    observations.delete(run.mode);
    const home = path.join(root, run.name);
    await fs.mkdir(home);
    const args = [
      run.cli,
      "--engine",
      "browser",
      "--model",
      "gpt-5.6-sol",
      "--browser-thinking-time",
      run.level ?? "pro",
      "--browser-model-strategy",
      run.strategy ?? "current",
      ...(run.bridge
        ? ["--remote-host", `127.0.0.1:${servicePort}`, "--remote-token", serviceToken]
        : ["--remote-chrome", `127.0.0.1:${chrome.port}`]),
      "--browser-keep-browser",
      "--chatgpt-url",
      `http://127.0.0.1:${server.address().port}/?mode=${run.mode}`,
      "--browser-timeout",
      "30s",
      "--browser-input-timeout",
      "20s",
      "--browser-archive",
      "never",
      "--prompt",
      "Return the synthetic fixture marker.",
      "--no-notify",
      "--wait",
      "--verbose",
    ];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: repo,
        env: { ...process.env, ORACLE_HOME_DIR: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      let force;
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        force = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, 50000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        clearTimeout(force);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        clearTimeout(force);
        resolve({ code, output });
      });
    });
    if (captures) {
      await fs.mkdir(captures, { recursive: true });
      await fs.writeFile(path.join(captures, run.name + ".log"), result.output);
    }
    if (captures) {
      const target = (await CDP.List({ port: chrome.port })).find(
        (t) => t.type === "page" && t.url.includes(`127.0.0.1:${server.address().port}`),
      );
      if (target) {
        const client = await CDP({ port: chrome.port, target: target.id });
        const diagnostic = await client.Runtime.evaluate({
          expression:
            "JSON.stringify({state, text:document.body.innerText, turns:document.querySelector('#turns').innerHTML, prompt:document.querySelector('#prompt-textarea').value})",
          returnByValue: true,
        });
        await fs.writeFile(
          path.join(captures, run.name + ".state.json"),
          JSON.stringify(
            { observed: observations.get(run.mode), page: diagnostic.result.value },
            null,
            2,
          ),
        );
        const shot = await client.Page.captureScreenshot({ format: "png" });
        await fs.writeFile(
          path.join(captures, run.name + ".png"),
          Buffer.from(shot.data, "base64"),
        );
        await client.close();
      }
    }
    await submissionCapture;
    const state = observations.get(run.mode);
    assert.ok(state, result.output);
    assert.equal(result.code, run.success ? 0 : 1, result.output);
    assert.equal(state.sends, run.success ? 1 : 0, JSON.stringify(state));
    assert.deepEqual(
      state.keys.map((k) => k.key),
      fourTier
        ? run.mode === "four-move"
          ? ["ArrowRight", "ArrowRight"]
          : []
        : run.success && run.mode !== "already" && !run.level
          ? ["ArrowRight"]
          : [],
      JSON.stringify(state),
    );
    assert.ok(state.keys.every((k) => k.ready));
    if (run.success) {
      assert.equal(state.sentTier, run.level ? "Extra High" : "Pro");
      assert.match(result.output, /ORACLE_SLIDER_PROOF_OK/);
    } else
      assert.match(
        result.output,
        fourTier
          ? /Pro is unavailable[^\n]*four-tier[^\n]*refusing to submit/
          : /selection unverified[^\n]*refusing to submit without confirmed Pro/,
      );
    const sessions = await fs.readdir(path.join(home, "sessions"));
    assert.equal(sessions.length, 1);
    const meta = JSON.parse(
      await fs.readFile(path.join(home, "sessions", sessions[0], "meta.json"), "utf8"),
    );
    assert.equal(meta.status, run.success ? "completed" : "error");
    if (fourTier && run.success) {
      const evidence = meta.browser.thinkingSelection;
      assert.equal(evidence.requestedLevel, "extra-high");
      assert.equal(evidence.verified, !run.baseline);
      assert.equal(evidence.resolvedLabel, run.baseline ? null : "Extra High");
      assert.equal(
        evidence.status,
        run.baseline ? "unverified" : run.mode === "four-move" ? "switched" : "already-selected",
      );
    } else if (run.success) {
      assert.equal(meta.browser.thinkingSelection.requestedLevel, run.level ?? "pro");
      assert.equal(meta.browser.thinkingSelection.verified, !run.level);
      assert.equal(meta.browser.thinkingSelection.strictFailClosed, !run.level);
      assert.equal(meta.browser.thinkingSelection.resolvedLabel, run.level ? null : "Pro");
      assert.equal(
        meta.browser.thinkingSelection.status,
        run.level ? "unverified" : run.mode === "already" ? "already-selected" : "switched",
      );
      assert.ok(Number.isFinite(Date.parse(meta.browser.thinkingSelection.capturedAt)));
      const displayed = await promisify(execFile)(
        process.execPath,
        [run.cli, "status", sessions[0]],
        { cwd: repo, env: { ...process.env, ORACLE_HOME_DIR: home }, timeout: 10000 },
      );
      assert.match(displayed.stdout, /effort requestedLevel=/);
      assert.match(displayed.stdout, run.level ? /verified=no/ : /verified=yes/);
      if (run.bridge) {
        assert.equal(meta.browser.runtime?.chromePid, undefined);
        assert.equal(meta.browser.runtime?.chromePort, undefined);
        assert.equal(meta.browser.runtime?.userDataDir, undefined);
        assert.equal(interceptorError, undefined);
      }
    } else assert.equal(meta.browser?.thinkingSelection, undefined);
    results.push({
      name: run.name,
      exit: result.code,
      ...state,
      evidence: meta.browser?.thinkingSelection,
    });
    for (const target of await CDP.List({ port: chrome.port })) {
      if (target.type === "page" && target.url.includes(`127.0.0.1:${server.address().port}`))
        await CDP.Close({ port: chrome.port, id: target.id });
    }
  }
  console.log(JSON.stringify({ provider: "synthetic renderer", results }, null, 2));
} finally {
  if (service && service.exitCode === null) {
    service.kill("SIGTERM");
    const force = setTimeout(() => service.kill("SIGKILL"), 5000);
    await serviceDone.catch(() => {});
    clearTimeout(force);
  }
  await interceptor?.close().catch(() => {});
  await Promise.resolve(chrome.kill());
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
