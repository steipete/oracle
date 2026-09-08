#!/usr/bin/env node
// Actual built CLI, local and remote Chrome; all pages and attachments are synthetic.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Launcher } from "chrome-launcher";
import CDP from "chrome-remote-interface";

const repo = fileURLToPath(new URL("..", import.meta.url));
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const baseline = option("--baseline-cli");
const captures = option("--captures");
const root = await fs.mkdtemp(path.join(os.homedir(), "oracle-attachment-cli-"));
const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p));
assert.ok(chromePath, "Chrome/Chromium is required");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const observations = new Map();
const files = ["first.png", "second.png"];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=",
  "base64",
);
for (const name of files) await fs.writeFile(path.join(root, name), png);
const page = (
  mode,
) => `<!doctype html><meta charset="utf-8"><title>Oracle attachment safety fixture</title>
<style>body{font:18px system-ui;margin:30px}#prompt-textarea{width:600px;min-height:100px;white-space:pre-wrap}button{padding:8px}#chips{min-height:60px}article{padding:12px}.tile{display:inline-block;margin:4px}img{width:30px;height:30px}</style>
<h1>Oracle attachment safety fixture</h1><p>Synthetic page and files; no provider account.</p>
<button data-testid="profile-button">Synthetic profile</button><button data-testid="model-switcher-dropdown-button">GPT-5.5</button>
<button type="button" role="radio" data-mode="chat" aria-checked="${mode === "localized-work" ? "false" : "true"}">${mode.startsWith("localized") ? "Unterhaltung" : "Chat"}</button>
<${mode === "localized-work" ? "div" : 'button type="button"'} role="radio" data-mode="work" aria-checked="${mode === "localized-work" ? "true" : "false"}">${mode.startsWith("localized") ? "Arbeit" : "Work"}</${mode === "localized-work" ? "div" : "button"}>
${mode === "machine-work" ? '<button type="button" data-mode="work" data-state="active">Arbeit</button>' : ""}
${mode === "localized-chat" ? '<button type="button" aria-pressed="true">Work</button>' : ""}
<a class="__menu-item" href="/c/fixture-initial" aria-label="Synthetic Chat">Synthetic Chat</a>
<aside><div data-state="uploading">Unrelated activity</div></aside>
<main><div id="turns"></div><form data-testid="composer">${mode.startsWith("contenteditable") ? '<div id="prompt-textarea" contenteditable="true" role="textbox" data-placeholder="Ask anything"></div>' : '<textarea id="prompt-textarea" name="prompt-textarea" placeholder="Ask anything"></textarea>'}
<button type="button" ${mode.startsWith("generic-plus") ? 'id="unrelated-plus" aria-label="Add suggestion"' : 'id="composer-plus-btn"'} aria-expanded="false">+</button>
<input id="upload" type="file"><div id="chips"></div><div id="progress" style="display:none" data-state="uploading">Uploading</div>
<button type="button" ${mode === "missing-send" ? 'aria-label="Send prompt"' : 'data-testid="send-button"'} id="send">Send</button></form></main>
<script>
const mode=${JSON.stringify(mode)};const state={mode,assignments:[],sends:0,editorEnters:0,genericClicks:0,sendKeys:[],busy:false,focusRecoveries:0};
const report=()=>fetch('/events/'+mode,{method:'POST',body:JSON.stringify(state)});
const editor=document.querySelector('#prompt-textarea'), send=document.querySelector('#send'), progress=document.querySelector('#progress');
if(mode.startsWith('contenteditable'))Object.defineProperty(editor,'value',{get(){return this.innerText;},set(value){this.textContent=value;}});
let uploads=[];let busyTimer;
function busy(){clearTimeout(busyTimer);state.busy=true;progress.style.display='block';report();busyTimer=setTimeout(()=>{state.busy=false;progress.style.display='none';report();},3500);}
const fileInput=document.querySelector('#upload');
if(mode.endsWith('file-handler-switch')){
 const value=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
 Object.defineProperty(fileInput,'value',{get(){return value.get.call(this);},set(next){value.set.call(this,next);if(state.fileHandlerRan){state.selectionAfterHandler=this.files.length;report();}}});
}
fileInput.onchange=async event=>{
 if(mode.endsWith('file-handler-switch')){state.fileHandlerRan=true;state.selectionAfterHandler=event.target.files.length;history.replaceState({},'', '/g/project-b/project?mode='+mode);report();return;}
 for(const file of Array.from(event.target.files||[])){
  uploads.push(file);state.assignments.push({name:file.name,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))});
  const tile=document.createElement('div');tile.className='tile';tile.dataset.testid='attachment-chip';
  const img=document.createElement('img');img.alt='Image preview';img.src=URL.createObjectURL(file);tile.append(img);
  const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove attachment');remove.textContent='×';remove.onclick=()=>tile.remove();tile.append(remove);document.querySelector('#chips').append(tile);
 }
 event.target.value='';busy();
 if(state.assignments.length===(mode==='project-switch-first'?1:2)){
  if(mode.startsWith('project-switch'))history.replaceState({},'', '/g/project-b/project?mode='+mode);
  if(mode==='same-conversation')history.replaceState({},'', '/g/project-a/project/c/fixture-initial?mode='+mode);
  if(mode==='work'){const work=document.createElement('button');work.type='button';work.textContent='Work';work.setAttribute('aria-pressed','true');document.querySelector('form').append(work);}
 }
 report();
};
const plus=document.querySelector('#composer-plus-btn');
if(plus)plus.onclick=()=>plus.setAttribute('aria-expanded',String(plus.getAttribute('aria-expanded')!=='true'));
document.querySelector('#unrelated-plus')?.addEventListener('click',()=>{state.genericClicks++;report();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')plus?.setAttribute('aria-expanded','false');});
if(mode==='plus-focus-race')plus.addEventListener('focus',()=>queueMicrotask(()=>{send.focus();report();}),{once:true});
if(mode==='plus-boundary-focus'){
 const rect=plus.getBoundingClientRect.bind(plus);let triggered=false;
 plus.getBoundingClientRect=()=>{const value=rect();if(!triggered&&document.activeElement===plus){triggered=true;queueMicrotask(()=>{send.focus();report();});}return value;};
}
if(mode==='prompt-fallback'||mode==='contenteditable-fallback'){const exec=document.execCommand.bind(document);document.execCommand=(command,...args)=>{if(command==='insertText'){state.nativeInsertBlocked=(state.nativeInsertBlocked||0)+1;report();return false;}return exec(command,...args);};}
if(mode==='prompt-handler-switch')editor.addEventListener('input',()=>{if(state.assignments.length===2){history.replaceState({},'', '/g/project-b/project?mode='+mode);queueMicrotask(()=>{state.stagedPromptLength=editor.value.length;report();});}});
if(mode==='prompt-focus-switch'){const focus=editor.focus.bind(editor);editor.focus=(...args)=>{focus(...args);if(state.assignments.length===2){history.replaceState({},'', '/g/project-b/project?mode='+mode);report();}};}
if(mode==='prompt-input-switch')window.addEventListener('beforeinput',event=>{if(event.target===editor&&state.assignments.length===2){history.replaceState({},'', '/g/project-b/project?mode='+mode);report();}},true);
if(mode==='focus-recovery')send.addEventListener('focus',()=>queueMicrotask(()=>{state.focusRecoveries++;editor.focus();report();}),{once:true});
if(mode==='readiness-recovery')send.addEventListener('focus',busy,{once:true});
function commit(){
 state.sends++;state.sentWhileBusy=state.busy;state.sentUrl=location.href;state.sentFiles=uploads.map(f=>f.name);report();
 const prompt=editor.value;const stop=document.createElement('button');stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';document.querySelector('form').append(stop);
 setTimeout(()=>{
  const user=document.createElement('article');user.dataset.testid='conversation-turn-0';user.dataset.turn='user';const message=document.createElement('div');message.dataset.messageAuthorRole='user';message.textContent=prompt;user.append(message);
  for(const file of uploads){const chip=document.createElement('div');chip.dataset.testid='attachment-chip';chip.textContent=file.name;user.append(chip);}document.querySelector('#turns').append(user);
  editor.value='';document.querySelector('#chips').replaceChildren();stop.remove();history.replaceState({},'', '/c/fixture-'+mode);
  const answer=document.createElement('article');answer.dataset.testid='conversation-turn-1';answer.dataset.turn='assistant';answer.innerHTML='<div data-message-author-role="assistant" data-message-id="fixture-answer"><div class="markdown"><p>ORACLE_ATTACHMENT_CLI_OK</p></div></div><button type="button" data-testid="copy-turn-action-button">Copy</button>';answer.querySelector('button').onclick=()=>navigator.clipboard.writeText('ORACLE_ATTACHMENT_CLI_OK');document.querySelector('#turns').append(answer);report();
 },1800);
}
send.onclick=commit;send.onkeydown=e=>{if(e.key==='Enter')state.sendKeys.push(e.type);};
editor.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();state.editorEnters++;commit();}};
editor.addEventListener('input',()=>{state.stagedPromptLength=editor.value.length;report();});
document.querySelector('form').onsubmit=e=>e.preventDefault();
if(mode==='assignment-switch'){
 const OriginalFile=window.File;let triggered=false;
 window.File=class extends OriginalFile{constructor(...args){super(...args);if(!triggered){triggered=true;history.replaceState({},'', '/g/project-b/project?mode='+mode);report();}}};
}
if(mode==='native-assignment-switch'){
 let triggered=false;const move=event=>{if(!triggered&&event.target===document.querySelector('#upload')){triggered=true;history.replaceState({},'', '/g/project-b/project?mode='+mode);report();}};
 window.addEventListener('input',move,true);window.addEventListener('change',move,true);
}
if(mode==='dispatch-switch'){
 const getStyle=window.getComputedStyle.bind(window);let triggered=false;
 window.getComputedStyle=(node,...args)=>{const result=getStyle(node,...args);if(!triggered&&node===send&&document.activeElement===send&&editor.value){triggered=true;queueMicrotask(()=>{history.replaceState({},'', '/g/project-b/project?mode='+mode);report();});}return result;};
}
if(mode==='generic-plus-switch'){
 const query=document.querySelector.bind(document);let triggered=false;
 document.querySelector=selector=>{const found=query(selector);if(!triggered&&selector==='#composer-plus-btn'){triggered=true;setTimeout(()=>{history.replaceState({},'', '/g/project-b/project?mode='+mode);report();},50);}return found;};
}
report();
</script>`;
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/events/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    observations.set(req.url.slice(8), JSON.parse(body));
    res.end("ok");
    return;
  }
  const mode = new URL(req.url, "http://localhost").searchParams.get("mode") ?? "warmup";
  res.setHeader("content-type", "text/html");
  res.end(page(mode));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const launch = async (profile) => {
  await fs.mkdir(profile, { recursive: true });
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
  await chrome.launch();
  return chrome;
};
async function interceptHomepage(port, profile) {
  let version;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      version = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(200),
      }).then((r) => r.json());
      break;
    } catch {}
    await pause(10);
  }
  assert.ok(version?.webSocketDebuggerUrl, "local CLI did not expose Chrome");
  const client = await CDP({ target: version.webSocketDebuggerUrl });
  const targets = await client.Target.getTargets();
  assert.ok(
    targets.targetInfos
      .filter((t) => t.type === "page")
      .every((t) => !t.url || t.url === "about:blank" || t.url === "chrome://newtab/"),
    "interception must precede homepage navigation",
  );
  let error;
  client.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== "page") return;
    void (async () => {
      await client.send(
        "Fetch.enable",
        { patterns: [{ urlPattern: "https://chatgpt.com/*", requestStage: "Request" }] },
        sessionId,
      );
      await client.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })().catch((cause) => {
      error = cause;
    });
  });
  client.on("Fetch.requestPaused", (event, sessionId) => {
    const auth = new URL(event.request.url).pathname === "/api/auth/session";
    void client
      .send(
        "Fetch.fulfillRequest",
        {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: auth ? "application/json" : "text/html" },
          ],
          body: Buffer.from(
            auth ? JSON.stringify({ user: { name: "Synthetic" } }) : page("warmup"),
          ).toString("base64"),
        },
        sessionId,
      )
      .catch((cause) => {
        error = cause;
      });
  });
  await client.Target.setAutoAttach({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page", exclude: false }, { exclude: true }],
  });
  return { client, profile, check: () => assert.equal(error, undefined) };
}
const remote = await launch(path.join(root, "remote-profile"));
const results = [];
const cases = [
  ...(baseline ? [{ mode: "project-switch", route: "remote", baseline: true }] : []),
  ...[
    "normal",
    "project-switch",
    "project-switch-first",
    "dispatch-switch",
    "assignment-switch",
    "localized-work",
    "machine-work",
    "localized-chat",
    "plus-focus-race",
    "plus-boundary-focus",
    "prompt-focus-switch",
    "prompt-input-switch",
    "prompt-handler-switch",
    "file-handler-switch",
    "prompt-fallback",
    "contenteditable",
    "contenteditable-fallback",
    "work",
    "missing-send",
    "same-conversation",
    "focus-recovery",
    "readiness-recovery",
  ].map((mode) => ({ mode, route: mode.startsWith("plus-") ? "local" : "remote" })),
  { mode: "normal", route: "local" },
  { mode: "generic-plus", route: "local" },
  { mode: "generic-plus-switch", route: "local" },
  { mode: "native-assignment-switch", route: "local" },
  { mode: "native-file-handler-switch", route: "local" },
];
try {
  const selectedCase = option("--case");
  const selectedCases = cases.filter((run) => !selectedCase || run.mode === selectedCase);
  assert.ok(selectedCases.length, "Unknown proof case");
  for (const run of selectedCases) {
    const name = `${run.baseline ? "baseline" : "candidate"}-${run.route}-${run.mode}`;
    const home = path.join(root, name);
    await fs.mkdir(home);
    observations.delete(run.mode);
    let interceptor;
    let attaching;
    let child;
    let finished = false;
    const initialPath =
      run.mode === "same-conversation" ? "/c/fixture-initial" : "/g/project-a/project";
    const args = [
      run.baseline ? baseline : (option("--cli") ?? path.join(repo, "dist/bin/oracle-cli.js")),
      "--engine",
      "browser",
      "--model",
      "gpt-5.5",
      "--browser-model-strategy",
      "ignore",
      "--browser-keep-browser",
      "--chatgpt-url",
      `http://127.0.0.1:${server.address().port}${initialPath}?mode=${run.mode}`,
      "--browser-timeout",
      "25s",
      "--browser-input-timeout",
      "15s",
      "--browser-attachment-timeout",
      "6s",
      "--browser-archive",
      "never",
      "--browser-attachments",
      "always",
      "--file",
      ...files.map((f) => path.join(root, f)),
      "--prompt",
      "Read the synthetic attachments and return the fixture marker.",
      "--no-notify",
      "--wait",
      "--verbose",
    ];
    if (run.route === "remote") args.push("--remote-chrome", `127.0.0.1:${remote.port}`);
    else {
      const profile = path.join(home, "profile");
      const primer = await launch(profile);
      await Promise.resolve(primer.kill());
      const reservation = net.createServer();
      await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      args.push(
        "--browser-manual-login",
        "--browser-manual-login-profile-dir",
        profile,
        "--browser-headless",
        "--browser-port",
        String(port),
        "--browser-chrome-path",
        chromePath,
      );
      attaching = interceptHomepage(port, profile);
      attaching.catch(() => {});
    }
    let output = "";
    let timer;
    let force;
    const done = new Promise((resolve, reject) => {
      child = spawn(process.execPath, args, {
        cwd: repo,
        env: { ...process.env, ORACLE_HOME_DIR: home, ORACLE_CHROME_NO_SANDBOX: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => {
        output += d;
      });
      child.stderr.on("data", (d) => {
        output += d;
      });
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        force = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, 55000);
      child.once("error", reject);
      child.once("exit", (code) => {
        finished = true;
        clearTimeout(timer);
        clearTimeout(force);
        resolve(code);
      });
    });
    done.catch(() => {});
    try {
      if (attaching) interceptor = await attaching;
      const code = await done;
      interceptor?.check();
      if (captures) {
        await fs.mkdir(captures, { recursive: true });
        await fs.writeFile(path.join(captures, name + ".log"), output);
      }
      const state = observations.get(run.mode);
      assert.ok(state, output);
      const refused =
        !run.baseline &&
        [
          "project-switch",
          "project-switch-first",
          "dispatch-switch",
          "assignment-switch",
          "native-assignment-switch",
          "localized-work",
          "machine-work",
          "plus-focus-race",
          "plus-boundary-focus",
          "prompt-focus-switch",
          "prompt-input-switch",
          "prompt-handler-switch",
          "file-handler-switch",
          "native-file-handler-switch",
          "generic-plus-switch",
          "work",
          "missing-send",
        ].includes(run.mode);
      assert.equal(code, refused ? 1 : 0, output);
      assert.equal(state.sends, refused ? 0 : 1, JSON.stringify(state));
      assert.equal(state.editorEnters, 0, JSON.stringify(state));
      assert.equal(state.genericClicks, 0, JSON.stringify(state));
      if (run.mode.endsWith("fallback")) assert.ok(state.nativeInsertBlocked > 0);
      if (run.mode.endsWith("file-handler-switch")) assert.equal(state.selectionAfterHandler, 0);
      if (run.baseline) assert.ok(state.sentUrl.includes("/project-b/"), JSON.stringify(state));
      else if (!refused) {
        assert.equal(state.sentWhileBusy, false, JSON.stringify(state));
        assert.equal(state.sendKeys.length, 1, JSON.stringify(state));
        assert.match(output, /ORACLE_ATTACHMENT_CLI_OK/);
      }
      if (refused)
        assert.match(
          output,
          run.mode === "missing-send"
            ? /exact ready send button/
            : run.mode.startsWith("plus-")
              ? /Attachment menu focus changed/
              : /navigated to Work or another ChatGPT context|Work mode/,
        );
      if (refused && !["missing-send", "dispatch-switch"].includes(run.mode))
        assert.equal(state.stagedPromptLength ?? 0, 0);
      for (const name of files) {
        const assigned = state.assignments.filter((f) => f.name === name);
        const expected =
          [
            "generic-plus-switch",
            "assignment-switch",
            "native-assignment-switch",
            "localized-work",
            "machine-work",
            "file-handler-switch",
            "native-file-handler-switch",
            "plus-focus-race",
            "plus-boundary-focus",
          ].includes(run.mode) ||
          (run.mode === "project-switch-first" && name === files[1])
            ? 0
            : 1;
        assert.equal(assigned.length, expected, JSON.stringify(state));
        if (expected) assert.deepEqual(Buffer.from(assigned[0].bytes), png);
      }
      const sessions = await fs.readdir(path.join(home, "sessions"));
      assert.equal(sessions.length, 1);
      const meta = JSON.parse(
        await fs.readFile(path.join(home, "sessions", sessions[0], "meta.json"), "utf8"),
      );
      assert.equal(meta.status, refused ? "error" : "completed");
      results.push({
        name,
        code,
        ...state,
        assignments: state.assignments.map(({ name, bytes }) => ({
          name,
          sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
        })),
      });
    } finally {
      if (!finished) child.kill("SIGTERM");
      if (interceptor) {
        const processes = await interceptor.client.SystemInfo.getProcessInfo().catch(() => null);
        if (processes) {
          const recordedPid = Number(
            await fs.readFile(path.join(interceptor.profile, "chrome.pid"), "utf8"),
          );
          assert.equal(
            processes.processInfo.find((p) => p.type === "browser")?.id,
            recordedPid,
            "cleanup must target the CLI-owned Chrome process",
          );
          await interceptor.client.Browser.close().catch(() => {});
        }
      }
      await interceptor?.client.close().catch(() => {});
      await done.catch(() => {});
      clearTimeout(timer);
      clearTimeout(force);
      for (const target of await CDP.List({ port: remote.port }))
        if (target.type === "page" && target.url.includes(`127.0.0.1:${server.address().port}`))
          await CDP.Close({ port: remote.port, id: target.id });
    }
  }
  console.log(JSON.stringify({ provider: "synthetic local fixture", results }, null, 2));
} finally {
  await Promise.resolve(remote.kill());
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
