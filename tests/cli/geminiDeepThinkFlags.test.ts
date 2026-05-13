import { Command, type OptionValues } from "commander";
import { describe, expect, test } from "vitest";

import {
  GEMINI_DEEP_THINK_BROWSER_MODEL,
  normalizeGeminiDeepThinkModelOption,
  parseGeminiDeepThinkEvidenceOption,
  parseGeminiDeepThinkFallbackOption,
} from "../../src/cli/options.js";
import {
  addGeminiDeepThinkDoctorFlags,
  addGeminiDeepThinkLeaseFlags,
  addGeminiDeepThinkRunFlags,
  buildGeminiDeepThinkRunEnvelope,
  normalizeGeminiDeepThinkDoctorOptions,
  normalizeGeminiDeepThinkLeaseOptions,
  normalizeGeminiDeepThinkRunOptions,
  runGeminiDeepThinkDryRun,
} from "../../src/cli/commands/run/geminiDeepThink.js";

function parseOptions(addFlags: (command: Command) => Command, argv: string[]): OptionValues {
  const command = new Command();
  command.exitOverride();
  command.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  addFlags(command);
  command.parse(argv, { from: "user" });
  return command.opts();
}

describe("Gemini Deep Think CLI flag helpers", () => {
  test("doctor flags accept Deep Think and remote browser policy", () => {
    const opts = parseOptions(addGeminiDeepThinkDoctorFlags, [
      "--deep-think",
      "--remote-browser",
      "required",
      "--json",
    ]);

    expect(normalizeGeminiDeepThinkDoctorOptions(opts)).toEqual({
      deep_think: true,
      remote_browser: "required",
      json: true,
    });
  });

  test("lease flags parse a duration TTL for the Gemini provider", () => {
    const opts = parseOptions(addGeminiDeepThinkLeaseFlags, [
      "--gemini-deep-think",
      "--ttl",
      "30m",
      "--json",
    ]);

    expect(opts.ttl).toBe(1_800_000);
    expect(normalizeGeminiDeepThinkLeaseOptions(opts)).toMatchObject({
      provider: "gemini",
      require: "deep_think",
      ttl_ms: 1_800_000,
      ttl_seconds: 1_800,
      deep_think: true,
    });
  });

  test("run flags produce the protected browser route without changing prompt semantics", () => {
    const opts = parseOptions(addGeminiDeepThinkRunFlags, [
      "--engine",
      "browser",
      "--provider",
      "gemini",
      "--model",
      "gemini-3.1-pro-deep-think",
      "--gemini-deep-think",
      "--gemini-deep-think-fallback",
      "fail",
      "--remote-browser",
      "preferred",
      "--evidence",
      "redacted",
      "--prompt-file",
      "PROMPT.md",
      "--dry-run",
      "json",
      "--json",
    ]);

    const plan = normalizeGeminiDeepThinkRunOptions(opts);
    expect(plan).toMatchObject({
      schema_version: "gemini_deep_think_run.v1",
      dry_run: true,
      live_call: false,
      provider: "gemini",
      engine: "browser",
      model: GEMINI_DEEP_THINK_BROWSER_MODEL,
      deep_think: true,
      fallback: "fail",
      remote_browser: "preferred",
      evidence: { mode: "redacted", redacted: true },
      prompt_source: { kind: "file", path: "PROMPT.md", redacted: true },
    });
    expect(plan.protected_route.doctor_command).toBe(
      "oracle doctor gemini --deep-think --remote-browser preferred --json",
    );
    expect(plan.protected_route.lease_command).toBe(
      "oracle browser leases acquire --providers gemini --require deep_think --remote-browser preferred --ttl-seconds 1800 --json",
    );
    expect(plan.protected_route.run_command).toContain("--prompt-file PROMPT.md");
  });

  test.each(["preferred", "required", "off"] as const)(
    "accepts remote browser mode %s",
    (remoteBrowser) => {
      const plan = normalizeGeminiDeepThinkRunOptions({
        geminiDeepThink: true,
        remoteBrowser,
        promptFile: "PROMPT.md",
      });

      expect(plan.remote_browser).toBe(remoteBrowser);
    },
  );

  test("defaults evidence and fallback to fail-closed redacted mode", () => {
    expect(
      normalizeGeminiDeepThinkRunOptions({
        geminiDeepThink: true,
        promptFile: "PROMPT.md",
      }),
    ).toMatchObject({
      evidence: { mode: "redacted", redacted: true },
      fallback: "fail",
    });
    expect(() => parseGeminiDeepThinkEvidenceOption("raw")).toThrow("raw evidence is not allowed");
    expect(() => parseGeminiDeepThinkFallbackOption("allow")).toThrow("cannot silently downgrade");
  });

  test("maps Gemini Deep Think browser aliases to the protected route model", () => {
    expect(normalizeGeminiDeepThinkModelOption("Gemini Deep Think")).toBe(
      GEMINI_DEEP_THINK_BROWSER_MODEL,
    );
    expect(normalizeGeminiDeepThinkModelOption("gemini-3-deep-think")).toBe(
      GEMINI_DEEP_THINK_BROWSER_MODEL,
    );
    expect(normalizeGeminiDeepThinkModelOption("gemini-3-pro-deep-think")).toBe(
      GEMINI_DEEP_THINK_BROWSER_MODEL,
    );
  });
});

describe("Gemini Deep Think run preflight envelope", () => {
  test("reports missing prompt as a typed blocker", () => {
    const envelope = buildGeminiDeepThinkRunEnvelope(
      { geminiDeepThink: true },
      { now: () => new Date("2026-05-13T00:00:00.000Z") },
    );

    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: false,
      blocked_reason: "gemini_deep_think_prompt_required",
      retry_safe: false,
    });
    expect(envelope.fix_command).toBe("--prompt-file PROMPT.md");
  });

  test.each([
    [{ engine: "api" }, "gemini_deep_think_requires_browser_engine"],
    [{ provider: "chatgpt" }, "gemini_deep_think_requires_gemini_provider"],
    [{ model: "gemini-3.1-pro" }, "gemini_deep_think_api_substitution_forbidden"],
    [{ geminiDeepThink: false, deepThink: false }, "gemini_deep_think_flag_required"],
  ] as const)("blocks forbidden downgrade %j", (overrides, blockedReason) => {
    const envelope = buildGeminiDeepThinkRunEnvelope({
      geminiDeepThink: true,
      promptFile: "PROMPT.md",
      ...overrides,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe(blockedReason);
  });

  test("blocks when Gemini login has not been verified", () => {
    const envelope = buildGeminiDeepThinkRunEnvelope({
      geminiDeepThink: true,
      promptFile: "PROMPT.md",
      loginVerified: false,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("provider_login_required");
    expect(envelope.next_command).toBe(
      "oracle doctor gemini --deep-think --remote-browser preferred --json",
    );
  });

  test("blocks when Deep Think is not verified in the browser session", () => {
    const envelope = buildGeminiDeepThinkRunEnvelope({
      geminiDeepThink: true,
      promptFile: "PROMPT.md",
      deepThinkAvailable: false,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("gemini_deep_think_unverified");
    expect(envelope.fix_command).toBe("--gemini-deep-think-fallback fail");
  });

  test("JSON dry-run output redacts inline prompt text", async () => {
    const output: string[] = [];
    const envelope = await runGeminiDeepThinkDryRun(
      {
        geminiDeepThink: true,
        prompt: "private reviewer prompt",
        json: true,
      },
      { stdout: (text) => output.push(text) },
    );

    expect(envelope.ok).toBe(true);
    expect(output[0]).not.toContain("private reviewer prompt");
    expect(JSON.parse(output[0])).toMatchObject({
      ok: true,
      data: {
        prompt_source: { kind: "inline", redacted: true },
        evidence: { mode: "redacted" },
        fallback: "fail",
      },
    });
  });
});
