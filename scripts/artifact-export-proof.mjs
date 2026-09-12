#!/usr/bin/env node
// Built CLI + real Chrome capture/export, with synthetic sandbox responses only.
import assert from "node:assert/strict";
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
const cli = path.join(repo, "dist/bin/oracle-cli.js");
const root = await fs.mkdtemp(path.join(os.homedir(), "oracle-artifact-export-proof-"));
const captureIndex = process.argv.indexOf("--captures");
const captures = captureIndex < 0 ? undefined : process.argv[captureIndex + 1];
const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p));
assert.ok(chromePath, "Chrome/Chromium is required");
const bytes = Buffer.from([0, 255, 1, 254, 65, 13, 10, 66, 0, 127, 128, 200]);
const digest = createHash("sha256").update(bytes).digest("hex");
const answer = "sandbox:/mnt/data/report.dat";
let downloads = 0;
let sends = 0;
let interceptionError;
const html = `<!doctype html><meta charset="utf-8"><title>Oracle artifact export fixture</title>
<style>body{font:18px system-ui;margin:30px}textarea{width:600px;height:100px}button{padding:8px}article{padding:12px}</style>
<h1>Oracle artifact export fixture</h1><p>Synthetic response and binary; no provider account.</p>
<button data-testid="profile-button">Synthetic profile</button><button data-testid="model-switcher-dropdown-button">GPT-5.5</button>
<button type="button" role="radio" aria-checked="true">Chat</button><button type="button" role="radio" aria-checked="false">Work</button>
<main><div id="turns"></div><form><textarea id="prompt-textarea" name="prompt-textarea" placeholder="Ask anything"></textarea><button type="button" data-testid="send-button">Send</button></form></main>
<script>
function send(){
 fetch('/fixture-sent',{method:'POST'});const editor=document.querySelector('textarea');const prompt=editor.value;editor.value='';
 const user=document.createElement('article');user.dataset.testid='conversation-turn-0';user.dataset.turn='user';const text=document.createElement('div');text.dataset.messageAuthorRole='user';text.dataset.messageId='artifact-user';text.textContent=prompt;user.append(text);document.querySelector('#turns').append(user);
 history.replaceState({},'', '/c/artifact-fixture');
 const response=document.createElement('article');response.dataset.testid='conversation-turn-1';response.dataset.turn='assistant';response.innerHTML='<div data-message-author-role="assistant" data-message-id="artifact-answer"><div class="markdown"><p><a href="sandbox:/mnt/data/report.dat">sandbox:/mnt/data/report.dat</a></p></div></div><button type="button" data-testid="copy-turn-action-button">Copy</button>';response.querySelector('button').onclick=()=>navigator.clipboard.writeText(${JSON.stringify(answer)});document.querySelector('#turns').append(response);
}
document.querySelector('[data-testid=send-button]').onclick=send;
document.querySelector('form').onsubmit=e=>{e.preventDefault();send();};document.querySelector('textarea').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
</script>`;
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
let browser;
async function run(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repo,
      env: { ...process.env, ORACLE_HOME_DIR: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let force;
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 2000);
    }, 50000);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(force);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      resolve({ code, output });
    });
  });
}
const results = [];
try {
  await fs.mkdir(path.join(root, "chrome"));
  await chrome.launch();
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
      await browser.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    })().catch((error) => {
      interceptionError = error;
    });
  });
  browser.on("Fetch.requestPaused", (event, sessionId) => {
    const url = new URL(event.request.url);
    const isDownload = url.pathname === "/backend-api/sandbox/download";
    if (isDownload) {
      assert.equal(url.searchParams.get("path"), "/mnt/data/report.dat");
      downloads++;
    }
    if (url.pathname === "/fixture-sent") sends++;
    const auth = url.pathname === "/api/auth/session";
    const body = isDownload
      ? bytes
      : Buffer.from(auth ? JSON.stringify({ user: { name: "Synthetic" } }) : html);
    const headers = [
      {
        name: "Content-Type",
        value: isDownload ? "application/octet-stream" : auth ? "application/json" : "text/html",
      },
    ];
    if (isDownload)
      headers.push({ name: "Content-Disposition", value: 'attachment; filename="report.dat"' });
    void browser
      .send(
        "Fetch.fulfillRequest",
        {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: headers,
          body: body.toString("base64"),
        },
        sessionId,
      )
      .catch((error) => {
        interceptionError = error;
      });
  });
  await browser.Target.setAutoAttach({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page", exclude: false }, { exclude: true }],
  });
  for (const scenario of [
    "default",
    "export",
    "collision",
    ...(process.platform === "win32" ? [] : ["copy-failure"]),
  ]) {
    const home = path.join(root, scenario);
    const outputDir = path.join(root, scenario + "-output");
    await fs.mkdir(home);
    await fs.mkdir(outputDir);
    const outputPath = path.join(outputDir, "answer.md");
    if (scenario === "collision")
      await fs.writeFile(path.join(outputDir, "report.dat"), "existing file");
    if (scenario === "copy-failure") {
      await fs.writeFile(outputPath, "old answer");
      await fs.chmod(outputDir, 0o555);
    }
    const previousDownloads = downloads;
    const previousSends = sends;
    try {
      const args = [
        "--engine",
        "browser",
        "--model",
        "gpt-5.5",
        "--browser-model-strategy",
        "ignore",
        "--remote-chrome",
        `127.0.0.1:${chrome.port}`,
        "--browser-keep-browser",
        "--browser-archive",
        "never",
        "--browser-timeout",
        "25s",
        "--browser-input-timeout",
        "15s",
        "--prompt",
        "Return the synthetic sandbox file.",
        "--write-output",
        outputPath,
        "--no-notify",
        "--wait",
        "--verbose",
      ];
      if (scenario !== "default") args.push("--write-artifacts");
      const result = await run(args, home);
      if (captures) {
        await fs.mkdir(captures, { recursive: true });
        await fs.writeFile(path.join(captures, scenario + ".log"), result.output);
      }
      assert.equal(result.code, 0, result.output);
      assert.equal(interceptionError, undefined);
      assert.equal(downloads - previousDownloads, 1, result.output);
      assert.equal(sends - previousSends, 1, result.output);
      assert.match(await fs.readFile(outputPath, "utf8"), /sandbox:\/mnt\/data\/report\.dat/);
      const sessions = await fs.readdir(path.join(home, "sessions"));
      assert.equal(sessions.length, 1);
      const meta = JSON.parse(
        await fs.readFile(path.join(home, "sessions", sessions[0], "meta.json"), "utf8"),
      );
      assert.equal(meta.status, "completed");
      assert.equal(meta.options.writeArtifacts, scenario !== "default");
      const canonical = meta.artifacts.find(
        (a) => a.kind === "file" && a.path.includes(`${path.sep}sessions${path.sep}`),
      );
      assert.ok(canonical, JSON.stringify(meta.artifacts));
      assert.equal(canonical.sha256, digest);
      assert.deepEqual(await fs.readFile(canonical.path), bytes);
      const exportedPath = path.join(
        outputDir,
        scenario === "collision" ? "report-2.dat" : "report.dat",
      );
      if (scenario === "default" || scenario === "copy-failure") {
        assert.equal(existsSync(exportedPath), false);
        if (scenario === "copy-failure")
          assert.ok(
            meta.browser.warnings.some((w) => w.code === "browser-output-artifact-copy-failed"),
          );
      } else {
        assert.deepEqual(await fs.readFile(exportedPath), bytes);
        assert.equal(
          createHash("sha256")
            .update(await fs.readFile(exportedPath))
            .digest("hex"),
          digest,
        );
        assert.ok(meta.artifacts.some((a) => a.path === exportedPath && a.sha256 === digest));
      }
      if (scenario === "collision")
        assert.equal(
          await fs.readFile(path.join(outputDir, "report.dat"), "utf8"),
          "existing file",
        );
      results.push({
        scenario,
        completed: true,
        downloads: 1,
        sends: 1,
        canonicalPreserved: true,
        sha256: digest,
        adjacentExport: scenario === "export" || scenario === "collision",
        warning: scenario === "copy-failure",
      });
    } finally {
      await fs.chmod(outputDir, 0o755);
      for (const target of await CDP.List({ port: chrome.port }))
        if (target.type === "page" && target.url.startsWith("https://chatgpt.com/"))
          await CDP.Close({ port: chrome.port, id: target.id });
    }
  }
  for (const [args, message] of [
    [
      [
        "--engine",
        "api",
        "--write-artifacts",
        "--write-output",
        path.join(root, "invalid.md"),
        "--dry-run",
        "--prompt",
        "synthetic",
      ],
      /requires --engine browser/,
    ],
    [
      ["--engine", "browser", "--write-artifacts", "--dry-run", "--prompt", "synthetic"],
      /requires --write-output/,
    ],
  ]) {
    const result = await run(args, path.join(root, "invalid-home"));
    assert.equal(result.code, 1);
    assert.match(result.output, message);
  }
  console.log(
    JSON.stringify(
      { provider: "synthetic intercepted sandbox", results, invalidOptionsRejected: true },
      null,
      2,
    ),
  );
} finally {
  await browser?.close().catch(() => {});
  await Promise.resolve(chrome.kill());
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
