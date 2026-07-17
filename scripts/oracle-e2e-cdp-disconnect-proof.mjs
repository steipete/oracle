#!/usr/bin/env node
/**
 * End-to-end proof for PR #327: force a CDP client disconnect during a real
 * Oracle browser run, then confirm auto-reattach harvests an answer and marks
 * the session completed.
 *
 * Requires: logged-in Chrome ChatGPT cookies, built dist CLI.
 * Redact prompts/paths before posting logs.
 *
 * Usage:
 *   node scripts/export-chatgpt-cookies.mjs /tmp/oracle-e2e-cookies.json
 *   ORACLE_BROWSER_COOKIES_FILE=/tmp/oracle-e2e-cookies.json \
 *     node scripts/oracle-e2e-cdp-disconnect-proof.mjs
 *
 * Optional:
 *   ORACLE_E2E_REMOTE_CHROME=127.0.0.1:9222
 *   ORACLE_E2E_BROWSER_PORT=9342
 *   ORACLE_E2E_MODEL_STRATEGY=current|select|ignore
 *   ORACLE_E2E_CLEANUP=1
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cli = path.join(root, "dist", "bin", "oracle-cli.js");

const slug = `e2e-cdp-${Date.now().toString(36)}`;
const sessionDir = path.join(os.homedir(), ".oracle", "sessions", slug);
const metaPath = path.join(sessionDir, "meta.json");
const model = process.env.ORACLE_E2E_MODEL || "gpt-5.5";
const token = `e2e-cdp-ok-${Date.now().toString(36)}`;
// Long enough that ChatGPT is still generating when we steal the CDP socket.
const prompt = [
  token,
  "Write a detailed technical essay of at least 35 sentences about TCP congestion control,",
  "slow start, congestion avoidance, fast retransmit, and CUBIC vs BBR.",
  "End with a final line that repeats the first line of this prompt exactly.",
].join("\n");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function readMeta() {
  try {
    return JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    return null;
  }
}

async function waitFor(
  predicate,
  { timeoutMs = 180_000, intervalMs = 250, label = "condition", shouldAbort } = {},
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldAbort?.()) {
      throw new Error(`aborted waiting for ${label}`);
    }
    const meta = await readMeta();
    if (await predicate(meta)) return meta;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function listOutboundCdpFds(pid, port) {
  let out = "";
  try {
    out = execFileSync(
      "lsof",
      ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:ESTABLISHED"],
      { encoding: "utf8" },
    );
  } catch {
    return [];
  }
  const fds = [];
  for (const line of out.trim().split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (!/^IPv[46]$/.test(cols[4] || "")) continue;
    const name = cols.slice(8).join(" ");
    if (!new RegExp(`->127\\.0\\.0\\.1:${port}\\b`).test(name)) continue;
    const fd = Number.parseInt(String(cols[3]).replace(/[^0-9]/g, ""), 10);
    if (Number.isFinite(fd)) fds.push(fd);
  }
  return [...new Set(fds)];
}

function closeRemoteFds(pid, fds) {
  if (!fds.length) throw new Error(`no outbound CDP fds for pid=${pid}`);
  // Modern Chrome allows multiple CDP clients, so a second attach does not drop
  // Oracle's socket. Close Oracle's established CDP fds in-process.
  // macOS: lldb; Linux/Ubuntu: gdb (matches issue #326's report environment).
  if (process.platform === "linux") {
    const args = ["-p", String(pid), "-batch", "-n"];
    for (const fd of fds) {
      args.push("-ex", `call (int)close(${fd})`);
    }
    return execFileSync("gdb", args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const args = ["-p", String(pid), "-b"];
  for (const fd of fds) {
    args.push("-o", `expr -- (int)close(${fd})`);
  }
  return execFileSync("lldb", args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function forceDetachOracleClient(port, controllerPid) {
  if (!controllerPid) {
    throw new Error("missing browser.runtime.controllerPid for forced CDP detach");
  }
  // Confirm Chrome/target stay reachable before and after the socket drop.
  const versionBefore = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  if (!versionBefore?.webSocketDebuggerUrl) {
    throw new Error("Chrome CDP endpoint not reachable before forced detach");
  }

  let fds = listOutboundCdpFds(controllerPid, port);
  for (let i = 0; i < 20 && fds.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 200));
    fds = listOutboundCdpFds(controllerPid, port);
  }
  log(
    `forcing CDP detach by closing Oracle pid=${controllerPid} fds=[${fds.join(",")}] on port=${port}`,
  );
  const debuggerOut = closeRemoteFds(controllerPid, fds);
  if (/error:/i.test(debuggerOut) && !/close\(/.test(debuggerOut)) {
    log(`fd-close warning: ${debuggerOut.slice(0, 240)}`);
  }

  // Endpoint must remain up (recoverable path), unlike killing Chrome.
  await new Promise((r) => setTimeout(r, 500));
  const versionAfter = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  if (!versionAfter?.webSocketDebuggerUrl) {
    throw new Error("Chrome CDP endpoint died; disconnect was not recoverable");
  }
  log("Oracle CDP sockets closed; Chrome/target still reachable");
}

function proofSignals(fullLog, meta) {
  const sawAutoReattach = /Auto-reattach|auto-reattach/i.test(fullLog);
  const sawRecoverableMessage =
    /CDP client disconnected|still reachable|recoverable|chrome-disconnected|keeping session running for reattach/i.test(
      fullLog,
    );
  const incompleteReason = meta?.response?.incompleteReason ?? null;
  const errorMessage = String(meta?.errorMessage ?? meta?.error?.message ?? "");
  const sawRecoverableMeta =
    incompleteReason === "chrome-disconnected" ||
    /CDP client disconnected|still reachable|recoverable/i.test(errorMessage) ||
    Boolean(meta?.browser?.runtime?.recoverableDisconnect) ||
    Boolean(meta?.error?.details?.recoverableDisconnect);
  return { sawAutoReattach, sawRecoverableMessage, sawRecoverableMeta };
}

async function main() {
  await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(path.dirname(sessionDir), { recursive: true });

  const logPath = path.join(
    await mkdtemp(path.join(os.tmpdir(), "oracle-e2e-cdp-")),
    "run.log",
  );
  const logStream = createWriteStream(logPath, { flags: "a" });
  log(`slug=${slug}`);
  log(`model=${model}`);
  log(`log=${logPath}`);

  // Default: launch automation Chrome with cookie sync (not --copy-profile:
  // copied profiles disable connection-lost reattach). Opt into remote with
  // ORACLE_E2E_REMOTE_CHROME=host:port.
  const remoteChrome = process.env.ORACLE_E2E_REMOTE_CHROME || "";
  const args = [
    cli,
    "--engine",
    "browser",
    "--wait",
    "--heartbeat",
    "0",
    "--timeout",
    "600",
    "--browser-input-timeout",
    "120000",
    // Free / Plus accounts often lack Thinking 5.5; keep whatever ChatGPT has selected.
    "--browser-model-strategy",
    process.env.ORACLE_E2E_MODEL_STRATEGY || "current",
    "--model",
    model,
    "--prompt",
    prompt,
    "--slug",
    slug,
    "--force",
  ];
  if (remoteChrome) {
    args.push("--remote-chrome", remoteChrome);
    log(`using --remote-chrome ${remoteChrome}`);
  } else {
    args.push(
      "--browser-keep-browser",
      "--browser-port",
      String(process.env.ORACLE_E2E_BROWSER_PORT || "9333"),
    );
    // Linux CI/Docker: hide the window under Xvfb. Do not enable headless;
    // Cloudflare blocks headless ChatGPT automation.
    if (process.env.ORACLE_E2E_HIDE_WINDOW === "1") {
      args.push("--browser-hide-window");
      log("using --browser-hide-window (Xvfb / non-interactive host)");
    }
    log(`using launch + cookie sync (port ${process.env.ORACLE_E2E_BROWSER_PORT || "9333"})`);
  }
  const cookiesFile = process.env.ORACLE_BROWSER_COOKIES_FILE || "";
  if (cookiesFile) {
    args.push("--browser-inline-cookies-file", cookiesFile);
    log(`using --browser-inline-cookies-file`);
  }

  log("starting Oracle browser run");
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    const s = String(d);
    process.stdout.write(s);
    logStream.write(s);
  });
  child.stderr.on("data", (d) => {
    const s = String(d);
    process.stderr.write(s);
    logStream.write(s);
  });

  let childExit = null;
  child.on("exit", (code, signal) => {
    childExit = { code, signal };
    log(`oracle exited code=${code} signal=${signal}`);
  });

  let forcedDetach = false;
  try {
    const ready = await waitFor(
      (meta) =>
        Boolean(
          meta?.browser?.runtime?.chromePort &&
            meta?.browser?.runtime?.promptSubmitted === true,
        ),
      {
        timeoutMs: 240_000,
        intervalMs: 200,
        label: "promptSubmitted + chromePort",
        shouldAbort: () => childExit != null && childExit.code !== 0,
      },
    );
    const runtime = ready.browser.runtime;
    log(
      `runtime ready port=${runtime.chromePort} target=${String(runtime.chromeTargetId || "").slice(0, 8)}… status=${ready.status}`,
    );

    if (childExit != null) {
      throw new Error(
        `Oracle exited before forced CDP detach (code=${childExit.code}); use a longer prompt`,
      );
    }

    // Steal the CDP socket while the answer is still in flight.
    const detachDelayMs = Number(process.env.ORACLE_E2E_DETACH_DELAY_MS || "500");
    if (detachDelayMs > 0) {
      await new Promise((r) => setTimeout(r, detachDelayMs));
    }
    if (childExit != null) {
      throw new Error(
        `Oracle exited before forced CDP detach (code=${childExit.code}); answer finished too fast`,
      );
    }
    await forceDetachOracleClient(
      runtime.chromePort,
      runtime.controllerPid || child.pid,
    );
    forcedDetach = true;

    const completed = await waitFor(
      (meta) => meta?.status === "completed",
      {
        timeoutMs: 300_000,
        intervalMs: 1000,
        label: "session status=completed after disconnect",
      },
    );

    const answer =
      completed?.response?.text ||
      completed?.response?.markdown ||
      completed?.answer ||
      "";
    const answerPreview = String(answer).slice(0, 120).replace(/\s+/g, " ");
    log(`session completed; answerPreview=${JSON.stringify(answerPreview)}`);

    // Drain a moment so late auto-reattach log lines land.
    await new Promise((r) => setTimeout(r, 1500));
    const fullLog = await readFile(logPath, "utf8");
    const signals = proofSignals(fullLog, completed);
    const harvested =
      fullLog.includes(token) ||
      String(answer).includes(token) ||
      signals.sawAutoReattach;

    if (!forcedDetach) {
      throw new Error("forced CDP detach never ran");
    }
    if (!signals.sawAutoReattach && !signals.sawRecoverableMessage && !signals.sawRecoverableMeta) {
      throw new Error(
        "completed without recoverable-disconnect / auto-reattach evidence (run finished before detach?)",
      );
    }
    if (!harvested) {
      throw new Error("completed without harvest evidence (token missing from answer/log)");
    }

    console.log("\nE2E_PROOF_OK");
    console.log(
      JSON.stringify(
        {
          slug,
          finalStatus: completed.status,
          incompleteReason: completed.response?.incompleteReason ?? null,
          forcedDetach,
          ...signals,
          tokenPresentInLog: fullLog.includes(token),
          tokenPresentInAnswer: String(answer).includes(token),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("\nE2E_PROOF_FAILED", err);
    const meta = await readMeta();
    if (meta) {
      console.error("meta.status=", meta.status);
      console.error("meta.response=", JSON.stringify(meta.response ?? null));
      console.error("meta.errorMessage=", meta.errorMessage ?? null);
    }
    process.exitCode = 1;
  } finally {
    if (childExit == null && child.pid) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    logStream.end();
    if (process.env.ORACLE_E2E_CLEANUP === "1") {
      await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

await main();
