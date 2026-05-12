import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserAutomationError } from "../oracle/errors.js";

export function resolveManualLoginWaitMs(timeoutMs: number | undefined, keepBrowser: boolean) {
  const configured = Math.min(timeoutMs ?? 1_200_000, 20 * 60_000);
  if (keepBrowser) {
    return configured;
  }
  return Math.min(configured, 30_000);
}

export async function assertManualLoginProfileReadyForRun({
  userDataDir,
  keepBrowser,
}: {
  userDataDir: string;
  keepBrowser: boolean;
}): Promise<void> {
  if (keepBrowser) {
    return;
  }
  if (await isManualLoginProfileInitialized(userDataDir)) {
    return;
  }
  const setupCommand = formatManualLoginSetupCommand(userDataDir);
  throw new BrowserAutomationError(
    "ChatGPT browser manual-login profile is not initialized. " +
      `Browser mode is using Oracle's private Chrome profile at ${userDataDir}, separate from your normal Chrome profile. ` +
      `Run first-time setup, sign in there, then retry: ${setupCommand}. ` +
      "If you want to reuse an already signed-in Chrome instead, use --browser-attach-running.",
    {
      stage: "browser-login-setup",
      details: {
        profileDir: userDataDir,
        setupCommand,
        sessionStatus: "needs_login",
      },
      reuseProfileHint: setupCommand,
    },
  );
}

export async function isManualLoginProfileInitialized(profileDir: string): Promise<boolean> {
  const entries = await readdir(profileDir, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => {
    if (!entry.name) return false;
    if (entry.name === "Default" || entry.name === "Local State") return true;
    if (entry.name.startsWith("Profile ")) return true;
    return false;
  });
}

export function formatManualLoginSetupCommand(profileDir: string): string {
  return [
    "oracle --engine browser --browser-manual-login --browser-keep-browser",
    `--browser-manual-login-profile-dir ${JSON.stringify(profileDir)}`,
    '-p "HI"',
  ].join(" ");
}

export function defaultManualLoginProfileDir() {
  return path.join(os.homedir(), ".oracle", "browser-profile");
}
