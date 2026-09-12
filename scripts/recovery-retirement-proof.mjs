#!/usr/bin/env node
// Built CLI + real isolated Chrome; all pages, files, and session records are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch } from "chrome-launcher";
import CDP from "chrome-remote-interface";
import {
  buildTargetRetirementExpression,
  claimBrowserTarget,
} from "../dist/src/browser/targetClaim.js";
const repo = fileURLToPath(new URL("..", import.meta.url));
const baselineCli = process.argv[2] === "--baseline-cli" ? process.argv[3] : undefined;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-retirement-proof-"));
process.env.ORACLE_HOME_DIR = path.join(root, "home");
const { sessionStore } = await import("../dist/src/sessionStore.js");
const answer = "ORACLE_RECOVERY_SAVED";
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>ChatGPT synthetic recovery</title>
  <article data-testid="conversation-turn-0" data-turn="user"><div data-message-author-role="user" data-message-id="recovery-user">Recovery proof</div></article>
  <article data-testid="conversation-turn-1" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="answer"><div class="markdown"><p>${answer}</p></div></div></article>
  <form><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>${req.url.includes("generating") ? '<button data-testid="composer-stop-button">Stop generating</button>' : ""}</form>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let chrome;
const results = [];
try {
  await fs.mkdir(path.join(root, "chrome"), { recursive: true });
  chrome = await launch({
    userDataDir: path.join(root, "chrome"),
    chromeFlags: [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const peer = await CDP.New({ port: chrome.port, url: "about:blank" });
  for (const mode of baselineCli
    ? ["owned"]
    : ["owned", "borrowed", "kept", "generating", "active-controller", "reclaimed"]) {
    const url = `http://127.0.0.1:${server.address().port}/c/${mode}`;
    const target = await CDP.New({ port: chrome.port, url });
    const page = await CDP({ port: chrome.port, target: target.id });
    try {
      await page.Runtime.enable();
      for (let tries = 0; tries < 100; tries++) {
        const state = await page.Runtime.evaluate({
          expression: "document.readyState",
          returnByValue: true,
        });
        if (state.result.value === "complete") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await claimBrowserTarget(page.Runtime, "proof-claim");
      await page.Page.enable();
      const reloaded = new Promise((resolve) => page.Page.loadEventFired(resolve));
      await page.Page.reload();
      await reloaded;
      if (mode === "reclaimed") await claimBrowserTarget(page.Runtime, "other-controller");
    } finally {
      await page.close();
    }
    const record = await sessionStore.createSession(
      { prompt: "Recovery proof", model: "gpt-5.5", mode: "browser" },
      root,
    );
    const ownership = ["borrowed", "kept"].includes(mode)
      ? undefined
      : { host: "127.0.0.1", port: chrome.port, targetId: target.id, claimId: "proof-claim" };
    await sessionStore.updateSession(record.id, {
      status: "error",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: {
        config: { keepBrowser: mode === "kept" },
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: chrome.port,
          chromeTargetId: target.id,
          tabUrl: url,
          conversationId: mode,
          ownedRecoveryTarget: ownership,
          controllerPid: mode === "active-controller" ? process.pid : undefined,
        },
      },
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          baselineCli ?? path.join(repo, "dist/bin/oracle-cli.js"),
          "session",
          record.id,
          "--harvest",
        ],
        {
          cwd: root,
          env: { ...process.env, ORACLE_NO_DETACH: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    const after = await sessionStore.readSession(record.id);
    const tabs = await CDP.List({ port: chrome.port });
    const retained = tabs.some((tab) => tab.id === target.id);
    assert.ok(
      tabs.some((tab) => tab.id === peer.id),
      "peer tab must survive",
    );
    assert.equal(retained, Boolean(baselineCli) || mode !== "owned", result.output);
    assert.equal(
      after.status,
      !baselineCli && ["owned", "reclaimed"].includes(mode) ? "completed" : "error",
      result.output,
    );
    if (!baselineCli && mode === "owned")
      assert.match(await sessionStore.readLog(record.id), /ORACLE_RECOVERY_SAVED/);
    if (mode === "generating") assert.match(result.output, /state|State/);
    results.push({ mode, status: after.status, targetRetained: retained, peerRetained: true });
    if (retained) await CDP.Close({ port: chrome.port, id: target.id });
  }
  if (!baselineCli) {
    const target = await CDP.New({
      port: chrome.port,
      url: `http://127.0.0.1:${server.address().port}/c/reservation`,
    });
    const page = await CDP({ port: chrome.port, target: target.id });
    try {
      await page.Runtime.enable();
      await claimBrowserTarget(page.Runtime, "reservation-owner");
      const locked = await page.Runtime.evaluate({
        expression: buildTargetRetirementExpression(
          "reservation-owner",
          "reservation",
          "proof-reservation",
        ),
        returnByValue: true,
      });
      assert.equal(locked.result.value, true);
      await assert.rejects(claimBrowserTarget(page.Runtime, "new-controller"), /being retired/);
      results.push({ mode: "retirement-reservation", newControllerRefused: true });
    } finally {
      await page.close();
      await CDP.Close({ port: chrome.port, id: target.id });
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await chrome?.kill();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
