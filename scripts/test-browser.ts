#!/usr/bin/env tsx
/**
 * Lightweight browser connectivity smoke test.
 * - Launches Chrome headful with a fixed DevTools port (default 45871 or env ORACLE_BROWSER_PORT/ORACLE_BROWSER_DEBUG_PORT).
 * - Verifies the DevTools /json/version endpoint responds.
 * - Prints a WSL-friendly firewall hint if the port is unreachable.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "chrome-launcher";
import { isWsl, resolveWslHost } from "../src/browser/wslHost.js";

const DEFAULT_PORT = 45871;
const port =
  normalizePort(process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT) ??
  DEFAULT_PORT;
const hostHint = resolveWslHost();
const targetHost = hostHint ?? "127.0.0.1";

function normalizePort(raw?: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) return null;
  return value;
}

function firewallHint(host: string, devtoolsPort: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${devtoolsPort} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${devtoolsPort}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${devtoolsPort}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run ./runner pnpm test:browser after adding the rule.",
  ].join("\n");
}

async function fetchVersion(
  host: string,
  devtoolsPort: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${devtoolsPort}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { webSocketDebuggerUrl?: string };
    return Boolean(json.webSocketDebuggerUrl);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDevToolsShutdown(host: string, devtoolsPort: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await fetchVersion(host, devtoolsPort, 250))) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`DevTools did not stop listening at ${host}:${devtoolsPort}`);
}

async function main() {
  console.log(`[browser-test] launching Chrome on ${targetHost}:${port} (headful)…`);
  const chrome = await launch({
    port,
    chromeFlags: ["--remote-debugging-address=0.0.0.0"],
  });

  let ok = await fetchVersion(targetHost, chrome.port);
  if (!ok) {
    await sleep(500);
    ok = await fetchVersion(targetHost, chrome.port);
  }

  await chrome.kill();
  await waitForDevToolsShutdown(targetHost, chrome.port);

  if (ok) {
    console.log(`[browser-test] PASS: DevTools responding on ${targetHost}:${chrome.port}`);
    process.exit(0);
  }

  const hint = firewallHint(targetHost, chrome.port);
  console.error(`[browser-test] FAIL: DevTools not reachable at ${targetHost}:${chrome.port}`);
  if (hint) {
    console.error(hint);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(
    "[browser-test] Unexpected failure:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
