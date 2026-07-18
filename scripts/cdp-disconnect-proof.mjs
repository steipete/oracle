#!/usr/bin/env node
/**
 * Real-Chrome proof for recoverable vs closed-target CDP disconnects.
 *
 * Merge-readiness for PR #327:
 * 1) Client disconnect while Chrome/target stay alive → recoverable
 * 2) Chrome gone → non-recoverable closed fallback
 *
 * Does not require ChatGPT login.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { Launcher } = require("chrome-launcher");
const CDP = require("chrome-remote-interface");

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(here, "..", "dist", "src");
const { probeChromeTargetLiveness, isRecoverableChromeDisconnect, connectionLostUserMessage } =
  await import(pathToFileURL(path.join(distRoot, "browser", "cdpLiveness.js")).href);

function log(step, detail) {
  console.log(`[${new Date().toISOString()}] ${step}${detail ? `: ${detail}` : ""}`);
}

/** Resolve Chrome/Chromium for macOS + Linux CI/Docker without hardcoding one OS. */
function resolveChromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const installations = Launcher.getInstallations?.() ?? [];
    if (installations[0] && existsSync(installations[0])) {
      return installations[0];
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    "Chrome/Chromium not found. Set CHROME_PATH to a browser binary (Linux: chromium or google-chrome).",
  );
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list failed: ${res.status}`);
  return res.json();
}

async function run() {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-cdp-proof-"));
  let chrome;
  let client;
  let port;
  const chromePath = resolveChromePath();

  try {
    log("platform", `${process.platform}/${process.arch} chromePath=${chromePath}`);
    log("launch", "Chrome/Chromium headless with remote debugging");
    // Keep the launcher handle before awaiting readiness. If DevTools startup
    // times out, the rejected promise otherwise loses the spawned Chrome pid
    // and leaves the proof process behind.
    chrome = new Launcher({
      chromePath,
      chromeFlags: [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        // Required for Chromium in many Linux/Docker/CI sandboxes.
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
      userDataDir,
      handleSIGINT: false,
    });
    await chrome.launch();
    port = chrome.port;
    log("chrome-up", `port=${port} pid=${chrome.pid}`);

    client = await CDP({ host: "127.0.0.1", port });
    const { Page, Runtime } = client;
    await Page.enable();
    await Page.navigate({
      url: "data:text/html,<title>oracle-cdp-proof</title><h1>alive</h1>",
    });
    await Page.loadEventFired();
    const { result: titleResult } = await Runtime.evaluate({
      expression: "document.title",
      returnByValue: true,
    });
    log("page-ready", `title=${titleResult.value}`);

    const targetsBefore = await listTargets(port);
    const pageTarget =
      targetsBefore.find(
        (t) => t.type === "page" && String(t.url || "").includes("oracle-cdp-proof"),
      ) || targetsBefore.find((t) => t.type === "page");
    if (!pageTarget?.id) throw new Error("no page target found");
    const targetId = pageTarget.id;
    log("target", `id=${targetId.slice(0, 8)}…`);

    log("case-1", "CDP client disconnect; Chrome+target remain");
    await client.close();
    client = null;
    await new Promise((r) => setTimeout(r, 300));

    const alive = await probeChromeTargetLiveness({
      host: "127.0.0.1",
      port,
      targetId,
    });
    const recoverable = isRecoverableChromeDisconnect(alive);
    log(
      "case-1-result",
      JSON.stringify({
        endpointReachable: alive.endpointReachable,
        targetFound: alive.targetFound,
        recoverable,
        userMessage: connectionLostUserMessage({ recoverable }),
      }),
    );
    if (!recoverable) {
      throw new Error("case-1 failed: expected recoverable while target alive");
    }
    log("case-1-pass", "recoverableDisconnect path; sessionRunner would auto-reattach");

    log("case-2", "close target + kill Chrome");
    client = await CDP({ host: "127.0.0.1", port });
    try {
      await client.Target.closeTarget({ targetId });
    } catch (err) {
      log("close-target", String(err?.message || err));
    }
    await client.close();
    client = null;
    chrome.kill();
    chrome = null;

    let endpointDead = false;
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(300),
        });
      } catch {
        endpointDead = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!endpointDead) {
      throw new Error("chrome endpoint still reachable after kill");
    }

    const dead = await probeChromeTargetLiveness({
      host: "127.0.0.1",
      port,
      targetId,
    });
    const recoverableDead = isRecoverableChromeDisconnect(dead);
    log(
      "case-2-result",
      JSON.stringify({
        endpointReachable: dead.endpointReachable,
        targetFound: dead.targetFound,
        recoverable: recoverableDead,
        userMessage: connectionLostUserMessage({ recoverable: recoverableDead }),
        error: dead.error,
      }),
    );
    if (recoverableDead) {
      throw new Error("case-2 failed: expected non-recoverable after Chrome closed");
    }
    log("case-2-pass", "closed-window message; no stale auto-reattach loop");

    console.log("\nPROOF_OK both disconnect outcomes demonstrated against real Chrome CDP");
  } catch (error) {
    console.error("\nPROOF_FAILED", error);
    process.exitCode = 1;
  } finally {
    try {
      await client?.close?.();
    } catch {
      /* ignore */
    }
    try {
      chrome?.kill?.();
    } catch {
      /* ignore */
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

await run();
// chrome-launcher can retain an internal log descriptor after a failed startup
// with a caller-owned profile. Cleanup above is complete, so terminate with the
// recorded proof status instead of leaving CI waiting on that descriptor.
process.exit(process.exitCode ?? 0);
