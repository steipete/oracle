#!/usr/bin/env node
// Exercise the built CLI against synthetic ChatGPT failures in isolated Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Launcher } from "chrome-launcher";
import { connectToChrome } from "../dist/src/browser/chromeLifecycle.js";
import { readAssistantSnapshot } from "../dist/src/browser/actions/assistantResponse.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await fs.mkdtemp(path.join(os.homedir(), "oracle-failure-proof-"));
const chromePath = [process.env.CHROME_PATH, "/usr/bin/chromium", "/usr/bin/google-chrome"].find(
  (candidate) => candidate && existsSync(candidate),
);
assert.ok(chromePath, "Set CHROME_PATH to an installed Chromium binary");
const requestedCases = new Set(process.argv.slice(2));
const cases = [
  { name: "without-retry", text: "Thinking failed", retry: false },
  { name: "with-retry", text: "Thinking failed", retry: true },
  {
    name: "connection-turn",
    text: "No response from ChatGPT. Check your connection.",
    retry: true,
  },
  {
    name: "connection-banner",
    text: "No response from ChatGPT. Check your connection.",
    retry: true,
    banner: true,
  },
  {
    name: "with-feedback",
    text: "Thinking failed\nIs this conversation helpful so far?",
    retry: false,
  },
].filter(({ name }) => requestedCases.size === 0 || requestedCases.has(name));
assert.ok(cases.length > 0, "Select at least one known failure case");
const sends = new Map(cases.map(({ name }) => [name, 0]));
const server = http.createServer(async (request, response) => {
  if (request.url.startsWith("/sent/")) {
    const name = request.url.slice(6);
    sends.set(name, sends.get(name) + 1);
    response.end("ok");
    return;
  }
  if (request.url === "/api/auth/session" || request.url === "/backend-api/me") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ user: { name: "Synthetic" } }));
    return;
  }
  const test = cases.find(({ name }) => request.url === `/c/${name}`);
  if (!test) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><meta charset="utf-8"><title>Synthetic assistant failure</title>
<style>body{font:18px system-ui;margin:30px}textarea{width:600px;height:100px}button{padding:8px}</style>
<button data-testid="profile-button">Synthetic profile</button>
<button data-testid="model-switcher-dropdown-button">GPT-5.5</button>
<button role="radio" data-mode="chat" aria-checked="true">Chat</button>
<button role="radio" data-mode="work" aria-checked="false">Work</button>
<a class="__menu-item" href="/c/${test.name}" aria-label="Synthetic Chat">Synthetic Chat</a>
<main><div id="turns"></div><form><textarea id="prompt-textarea" placeholder="Ask anything"></textarea><button type="button" id="send" data-testid="send-button">Send</button></form></main>
<script>
document.querySelector('form').onsubmit = event => event.preventDefault();
document.querySelector('#send').onclick = async () => {
  await fetch('/sent/${test.name}', { method: 'POST' });
  const user = document.createElement('article'); user.dataset.testid='conversation-turn-0'; user.dataset.turn='user'; user.textContent=document.querySelector('textarea').value;
  document.querySelector('#turns').append(user); document.querySelector('textarea').value='';
  ${test.banner ? `const alert=document.createElement('aside');alert.setAttribute('role','alert');alert.textContent=${JSON.stringify(test.text)};const alertRetry=document.createElement('button');alertRetry.textContent='Retry';alertRetry.onclick=()=>fetch('/sent/${test.name}',{method:'POST'});alert.append(alertRetry);document.querySelector('#turns').append(alert);return;` : ""}
  const turn=document.createElement('article'); turn.dataset.testid='conversation-turn-1'; turn.dataset.turn='assistant';
  turn.innerHTML='<div data-message-author-role="assistant" data-message-id="synthetic-failure"><div class="markdown"></div></div><button data-testid="copy-turn-action-button">Copy</button>';
  turn.querySelector('button').onclick=()=>navigator.clipboard.writeText(turn.querySelector('.markdown').innerText);
  turn.querySelector('.markdown').textContent=${JSON.stringify(test.text)};
  ${test.retry ? "const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=()=>fetch('/sent/' + " + JSON.stringify(test.name) + ", {method:'POST'});turn.append(retry);" : ""}
  document.querySelector('#turns').append(turn);
};
</script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await fs.mkdir(path.join(root, "chrome"));
const chrome = new Launcher({
  chromePath,
  userDataDir: path.join(root, "chrome"),
  handleSIGINT: false,
  chromeFlags: [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
  ],
});
try {
  await chrome.launch();
  const client = await connectToChrome(
    chrome.port,
    Object.assign(() => {}, { verbose: false }),
  );
  try {
    for (const probe of [
      { name: "terminal", text: "Thinking failed", expected: true },
      {
        name: "connection failure",
        text: "No response from ChatGPT. Check your connection.",
        retry: true,
        expected: true,
      },
      {
        name: "connection prose",
        text: 'The banner says "No response from ChatGPT. Check your connection."',
        retry: true,
        expected: false,
      },
      {
        name: "ordinary prose",
        text: 'The UI says "Thinking failed" on failure.',
        expected: false,
      },
      { name: "active generation", text: "Thinking failed", stop: true, expected: false },
      { name: "busy assistant", text: "Thinking failed", busy: true, expected: false },
      { name: "previous turn", text: "Thinking failed", minTurn: 2, expected: false },
    ]) {
      const html = `<main><article data-testid="conversation-turn-0" data-turn="user">Synthetic prompt</article><article data-testid="conversation-turn-1" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown">${probe.text}</div></div>${probe.busy ? '<div aria-busy="true">Working</div>' : ""}${probe.retry ? "<button>Retry</button>" : ""}</article></main><form>${probe.stop ? '<button data-testid="stop-button">Stop</button>' : ""}</form>`;
      await client.Runtime.evaluate({
        expression: `document.body.innerHTML = ${JSON.stringify(html)}`,
      });
      const snapshot = await readAssistantSnapshot(client.Runtime, probe.minTurn ?? 1);
      assert.equal(snapshot?.uiError === "temporary_unavailable", probe.expected, probe.name);
      console.log(JSON.stringify({ renderer: probe.name, rejected: probe.expected }));
    }
  } finally {
    await client.close();
  }
  for (const test of cases) {
    const home = path.join(root, test.name);
    await fs.mkdir(home);
    const outputPath = path.join(home, "answer.md");
    const child = spawn(
      process.execPath,
      [
        path.join(repo, "dist/bin/oracle-cli.js"),
        "--engine",
        "browser",
        "--model",
        "gpt-5.5",
        "--browser-model-strategy",
        "ignore",
        "--remote-chrome",
        `127.0.0.1:${chrome.port}`,
        "--chatgpt-url",
        `http://127.0.0.1:${server.address().port}/c/${test.name}`,
        "--browser-timeout",
        "30s",
        "--browser-input-timeout",
        "10s",
        "--browser-archive",
        "never",
        "--prompt",
        "Return a synthetic answer.",
        "--write-output",
        outputPath,
        "--no-notify",
        "--wait",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          ORACLE_HOME_DIR: home,
          ORACLE_CHROME_NO_SANDBOX: "1",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const startedAt = Date.now();
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      assert.equal(code, 1, output);
      assert.equal(sends.get(test.name), 1, output);
      assert.equal(existsSync(outputPath), false, "Failure text must not be saved as the answer");
      const ids = await fs.readdir(path.join(home, "sessions"));
      assert.equal(ids.length, 1);
      const meta = JSON.parse(
        await fs.readFile(path.join(home, "sessions", ids[0], "meta.json"), "utf8"),
      );
      assert.equal(meta.status, "error", JSON.stringify(meta));
      assert.match(
        output,
        test.banner
          ? /temporary-unavailable warning/i
          : /could not generate the submitted assistant turn/i,
      );
      assert.ok(
        Date.now() - startedAt < 20_000,
        "Failure should precede the 30-second response timeout",
      );
      console.log(
        JSON.stringify({
          case: test.name,
          exitCode: code,
          status: meta.status,
          submissions: sends.get(test.name),
          answerWritten: false,
        }),
      );
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  }
} finally {
  await Promise.resolve(chrome.kill());
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
