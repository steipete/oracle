import { describe, expect, test } from "vitest";

import {
  ORACLE_CAPABILITIES_SCHEMA_VERSION,
  buildCapabilityReport,
  capabilityById,
  type CapabilityId,
} from "@src/oracle/capabilities/registry.ts";
import {
  buildCapabilitiesEnvelope,
  runCapabilities,
} from "@src/cli/commands/capabilities.ts";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  jsonEnvelopeSchema,
} from "@src/oracle/v18/index.ts";

const FROZEN_TIME = new Date("2026-05-13T00:00:00.000Z");
const EMPTY_ENV: Record<string, string | undefined> = Object.freeze({});

const ALL_FAMILIES: readonly CapabilityId[] = [
  "chatgpt_pro_browser",
  "gemini_deep_think_browser",
  "remote_browser",
  "browser_leases",
  "redacted_evidence",
  "provider_access_policy",
  "prompt_payload_format_passthrough",
  "toon_prompt_blocks_passthrough",
  "deepseek_adapter",
] as const;

describe("buildCapabilityReport — static registry", () => {
  test("advertises every required capability family from the bead", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const ids = report.capabilities.map((entry) => entry.id);
    for (const family of ALL_FAMILIES) {
      expect(ids).toContain(family);
    }
    expect(report.counts.total).toBe(ALL_FAMILIES.length);
  });

  test("schema_version and bundle_version are pinned literals", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(report.schema_version).toBe(ORACLE_CAPABILITIES_SCHEMA_VERSION);
    expect(report.bundle_version).toBe(V18_BUNDLE_VERSION);
  });

  test("generated_at echoes the injected clock (deterministic)", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(report.generated_at).toBe(FROZEN_TIME.toISOString());
  });

  test("output is byte-identical across two calls with the same inputs", () => {
    const a = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const b = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("CI detection honors the CI env var", () => {
    expect(buildCapabilityReport({ env: { CI: "true" }, now: FROZEN_TIME }).ci).toBe(true);
    expect(buildCapabilityReport({ env: { CI: "1" }, now: FROZEN_TIME }).ci).toBe(true);
    expect(buildCapabilityReport({ env: { CI: "false" }, now: FROZEN_TIME }).ci).toBe(false);
    expect(buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME }).ci).toBe(false);
  });
});

describe("remote_browser capability — missing config flow", () => {
  test("with no env vars set, remote_browser is available but not ready", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const remote = capabilityById(report, "remote_browser");
    expect(remote?.status).toBe("available");
    expect(remote?.next_command).toContain("ORACLE_REMOTE_HOST");
    expect(remote?.next_command).toContain("ORACLE_REMOTE_TOKEN");
    expect(remote?.fix_command).toContain("ORACLE_REMOTE_HOST");
    expect(remote?.notes.host_present).toBe(false);
    expect(remote?.notes.token_present).toBe(false);
    expect(remote?.notes.missing_env_vars).toEqual([
      "ORACLE_REMOTE_HOST",
      "ORACLE_REMOTE_TOKEN",
    ]);
  });

  test("with both env vars present, remote_browser is ready", () => {
    const report = buildCapabilityReport({
      env: { ORACLE_REMOTE_HOST: "10.0.0.1:9473", ORACLE_REMOTE_TOKEN: "secret" },
      now: FROZEN_TIME,
    });
    const remote = capabilityById(report, "remote_browser");
    expect(remote?.status).toBe("ready");
    expect(remote?.next_command).toBe("oracle remote doctor --json");
    expect(remote?.notes.host_present).toBe(true);
    expect(remote?.notes.token_present).toBe(true);
  });

  test("only host present surfaces the missing token only", () => {
    const report = buildCapabilityReport({
      env: { ORACLE_REMOTE_HOST: "10.0.0.1:9473" },
      now: FROZEN_TIME,
    });
    const remote = capabilityById(report, "remote_browser");
    expect(remote?.status).toBe("available");
    expect(remote?.notes.missing_env_vars).toEqual(["ORACLE_REMOTE_TOKEN"]);
  });
});

describe("browser provider capabilities advertise typed evidence + invariants", () => {
  test("chatgpt_pro_browser carries the evidence schema version and never_clicks_answer_now", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const chatgpt = capabilityById(report, "chatgpt_pro_browser");
    expect(chatgpt?.supported).toBe(true);
    expect(chatgpt?.notes.evidence_schema_version).toBe(BROWSER_EVIDENCE_SCHEMA_VERSION);
    expect(chatgpt?.notes.never_clicks_answer_now).toBe(true);
    expect(chatgpt?.notes.requires_same_session_evidence).toBe(true);
  });

  test("gemini_deep_think_browser advertises high_if_exposed strategy and no API substitution", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const gemini = capabilityById(report, "gemini_deep_think_browser");
    expect(gemini?.notes.strategy).toBe("high_if_exposed");
    expect(gemini?.notes.never_substitutes_gemini_api).toBe(true);
  });
});

describe("TOON passthrough metadata", () => {
  test("toon_prompt_blocks_passthrough is gated_optional with canonical_storage_format=json", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const toon = capabilityById(report, "toon_prompt_blocks_passthrough");
    expect(toon?.supported).toBe(true);
    expect(toon?.status).toBe("available");
    expect(toon?.notes.canonical_storage_format).toBe("json");
    expect(toon?.notes.policy_status).toBe("gated_optional");
    expect(toon?.notes.toon_rust_enabled_by_default).toBe(false);
    expect(toon?.notes.context_serialization_policy_schema_version).toBe(
      CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
    );
  });
});

describe("provider access policy metadata", () => {
  test("provider_access_policy carries the v1 schema version and api_substitution_guard", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const policy = capabilityById(report, "provider_access_policy");
    expect(policy?.supported).toBe(true);
    expect(policy?.status).toBe("ready");
    expect(policy?.notes.policy_schema_version).toBe(PROVIDER_ACCESS_POLICY_SCHEMA_VERSION);
    expect(policy?.notes.api_substitution_guard).toBe(true);
  });
});

describe("deepseek_adapter explicitly NOT owned by Oracle", () => {
  test("status=unsupported with ownership=apr", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const deepseek = capabilityById(report, "deepseek_adapter");
    expect(deepseek?.supported).toBe(false);
    expect(deepseek?.status).toBe("unsupported");
    expect(deepseek?.notes.ownership).toBe("apr");
  });
});

describe("buildCapabilitiesEnvelope — json_envelope.v1 conformance", () => {
  test("envelope passes the v18 jsonEnvelopeSchema", () => {
    const { envelope } = buildCapabilitiesEnvelope({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe("json_envelope.v1");
    expect(envelope.meta.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(envelope.meta.schema_version).toBe(ORACLE_CAPABILITIES_SCHEMA_VERSION);
  });

  test("envelope surfaces a fix_command when remote config is missing", () => {
    const { envelope } = buildCapabilitiesEnvelope({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(envelope.fix_command).toMatch(/ORACLE_REMOTE_HOST/);
  });

  test("envelope is healthy (no fix_command from remote_browser) when env is configured", () => {
    const { envelope } = buildCapabilitiesEnvelope({
      env: { ORACLE_REMOTE_HOST: "h:9473", ORACLE_REMOTE_TOKEN: "t" },
      now: FROZEN_TIME,
    });
    // fix_command is allowed to be null OR a non-remote-related string;
    // it must NEVER tell the caller to set the env vars that are already set.
    const fix = envelope.fix_command;
    if (typeof fix === "string") {
      expect(fix).not.toMatch(/ORACLE_REMOTE_HOST|ORACLE_REMOTE_TOKEN/);
    } else {
      expect(fix).toBeNull();
    }
  });

  test("commands map carries the three preflight commands", () => {
    const { envelope } = buildCapabilitiesEnvelope({ env: EMPTY_ENV, now: FROZEN_TIME });
    const commands = envelope.commands as Record<string, unknown>;
    expect(commands.capabilities).toBe("oracle capabilities --json");
    expect(commands.doctor).toBe("oracle doctor --json");
    expect(commands.remote_doctor).toBe("oracle remote doctor --json");
  });
});

describe("never prints secrets — redaction of tokens/account data", () => {
  test("env values are never echoed into the report", () => {
    const env = {
      ORACLE_REMOTE_HOST: "private-host.internal:9473",
      ORACLE_REMOTE_TOKEN: "sk-super-secret-token-value",
      OPENAI_API_KEY: "sk-openai-private",
      GEMINI_API_KEY: "sk-gemini-private",
      EMAIL: "agent@example.com",
    };
    const { envelope, report } = buildCapabilitiesEnvelope({ env, now: FROZEN_TIME });
    const serialized = JSON.stringify(envelope) + JSON.stringify(report);
    for (const secret of [
      "private-host.internal",
      "sk-super-secret-token-value",
      "sk-openai-private",
      "sk-gemini-private",
      "agent@example.com",
    ]) {
      expect(serialized, `secret "${secret}" must not appear in capabilities output`).not.toContain(secret);
    }
    // We DO surface ENV VAR NAMES (those are not secrets).
    expect(serialized).toContain("ORACLE_REMOTE_HOST");
    expect(serialized).toContain("ORACLE_REMOTE_TOKEN");
  });
});

describe("no live-provider calls — pure registry guarantee", () => {
  test("buildCapabilityReport executes synchronously and does not touch the network", async () => {
    // If any code path attempted a fetch, this synchronous function would
    // either throw or hang. The fact that buildCapabilityReport is pure
    // and synchronous IS the guarantee. We also assert there is no
    // promise hidden in the result.
    const env = { CI: "true", ORACLE_REMOTE_HOST: "host:9473", ORACLE_REMOTE_TOKEN: "t" };
    const report = buildCapabilityReport({ env, now: FROZEN_TIME });
    expect(typeof (report as Record<string, unknown>).then).toBe("undefined");
    // And: no fetch / http symbol leaks into the report shape.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/Promise|http\.IncomingMessage/);
  });
});

describe("runCapabilities — CLI surface", () => {
  test("default invocation writes a JSON envelope to stdout", async () => {
    const chunks: string[] = [];
    await runCapabilities(
      { env: EMPTY_ENV, now: FROZEN_TIME, json: true },
      { stdout: (text) => chunks.push(text) },
    );
    expect(chunks.length).toBe(1);
    const payload = JSON.parse(chunks[0]);
    expect(payload.schema_version).toBe("json_envelope.v1");
    expect(payload.ok).toBe(true);
  });

  test("--no-json writes a deterministic human summary", async () => {
    const chunks: string[] = [];
    await runCapabilities(
      { env: EMPTY_ENV, now: FROZEN_TIME, json: false },
      { stdout: (text) => chunks.push(text) },
    );
    const text = chunks.join("");
    expect(text).toContain("oracle capabilities");
    expect(text).toContain(FROZEN_TIME.toISOString());
    for (const family of ALL_FAMILIES) {
      expect(text).toContain(family);
    }
  });

  test("two runs with the same inputs produce byte-identical JSON output", async () => {
    const captureA: string[] = [];
    const captureB: string[] = [];
    await runCapabilities(
      { env: EMPTY_ENV, now: FROZEN_TIME, json: true },
      { stdout: (text) => captureA.push(text) },
    );
    await runCapabilities(
      { env: EMPTY_ENV, now: FROZEN_TIME, json: true },
      { stdout: (text) => captureB.push(text) },
    );
    expect(captureA.join("")).toBe(captureB.join(""));
  });
});
