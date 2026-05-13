import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runBrowserSessionExecution } from "../../src/browser/sessionRunner.js";
import { readBrowserLease } from "../../src/browser/leases.js";
import type { BrowserRunResult } from "../../src/browser/types.js";
import { readEvidenceLedger } from "../../src/oracle/evidence_ledger.js";
import type { RunOracleOptions } from "../../src/oracle.js";
import type { BrowserSessionConfig } from "../../src/sessionStore.js";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ebv-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe("Gemini production browser session leases", () => {
  test("acquires a browser_lease.v1 record when Gemini URL is implicit", async () => {
    const sessionId = "session-ebv-gemini-success";
    const executeBrowser = vi.fn(async () => geminiBrowserResult());

    await runBrowserSessionExecution(
      {
        runOptions: runOptions(sessionId),
        browserConfig: geminiConfig(),
        cwd: "/repo",
        log: vi.fn(),
      },
      {
        assemblePrompt: async () => promptArtifacts(),
        executeBrowser,
        v18EmitHomeDir: homeDir,
      },
    );

    expect(executeBrowser).toHaveBeenCalledOnce();

    const ledger = await readEvidenceLedger(sessionId, { homeDir });
    expect(ledger.chainValid).toBe(true);
    expect(ledger.entries.map((entry) => entry.event.metadata?.action).filter(Boolean)).toEqual([
      "browser_lease_acquired",
      "browser_lease_released",
    ]);

    const acquired = ledger.entries.find(
      (entry) => entry.event.metadata?.action === "browser_lease_acquired",
    );
    const released = ledger.entries.find(
      (entry) => entry.event.metadata?.action === "browser_lease_released",
    );
    expect(acquired?.event.metadata?.browser_lease).toMatchObject({
      schema_version: "browser_lease.v1",
      provider: "gemini",
      status: "acquired",
    });
    expect(released?.event.metadata?.browser_lease).toMatchObject({
      schema_version: "browser_lease.v1",
      provider: "gemini",
      status: "released",
    });

    const stored = await readBrowserLease("gemini", {
      leaseDir: path.join(homeDir, "browser-leases"),
    });
    expect(stored.state).toBe("released");
  });

  test("releases the Gemini lease when provider execution fails before URL resolution", async () => {
    const sessionId = "session-ebv-gemini-failure";
    const executeBrowser = vi.fn(async () => {
      throw new Error("fake gemini provider failed");
    });

    await expect(
      runBrowserSessionExecution(
        {
          runOptions: runOptions(sessionId),
          browserConfig: geminiConfig(),
          cwd: "/repo",
          log: vi.fn(),
        },
        {
          assemblePrompt: async () => promptArtifacts(),
          executeBrowser,
          v18EmitHomeDir: homeDir,
        },
      ),
    ).rejects.toThrow("fake gemini provider failed");

    const ledger = await readEvidenceLedger(sessionId, { homeDir });
    expect(ledger.chainValid).toBe(true);
    expect(ledger.entries.map((entry) => entry.event.metadata?.action).filter(Boolean)).toEqual([
      "browser_lease_acquired",
      "browser_lease_released",
    ]);

    const stored = await readBrowserLease("gemini", {
      leaseDir: path.join(homeDir, "browser-leases"),
    });
    expect(stored.state).toBe("released");
  });
});

function runOptions(sessionId: string): RunOracleOptions {
  return {
    prompt: "Lease the implicit Gemini Deep Think browser slot.",
    model: "gemini-3-pro-deep-think",
    file: [],
    sessionId,
    silent: true,
  };
}

function geminiConfig(): BrowserSessionConfig {
  return {
    desiredModel: "gemini-3-deep-think",
  } as BrowserSessionConfig;
}

function promptArtifacts() {
  return {
    markdown: "Lease the implicit Gemini Deep Think browser slot.",
    composerText: "Lease the implicit Gemini Deep Think browser slot.",
    estimatedInputTokens: 8,
    attachments: [],
    inlineFileCount: 0,
    tokenEstimateIncludesInlineFiles: false,
    attachmentsPolicy: "auto" as const,
    attachmentMode: "inline" as const,
    fallback: null,
  };
}

function geminiBrowserResult(): BrowserRunResult {
  return {
    answerText: "gemini leased ok",
    answerMarkdown: "gemini leased ok",
    artifacts: [{ kind: "transcript", path: "/tmp/gemini-transcript.md" }],
    tookMs: 10,
    answerTokens: 3,
    answerChars: 16,
    tabUrl: "https://gemini.google.com/app",
  };
}
