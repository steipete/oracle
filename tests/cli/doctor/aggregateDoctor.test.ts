import { Command } from "commander";
import { describe, expect, test } from "vitest";
import {
  runAggregateDoctor,
  type AggregateDoctorCheck,
} from "../../../src/cli/commands/doctor/aggregate.js";
import { registerDoctorCommand } from "../../../src/cli/commands/doctor/index.js";
import type { ProviderDoctorEnvelope } from "../../../src/cli/commands/doctor/chatgpt.js";

function providerEnvelope(provider: "chatgpt" | "gemini", ok = true): ProviderDoctorEnvelope {
  return {
    schema_version: "provider_doctor.v1",
    provider,
    ok,
    status: ok ? "ready" : "blocked",
    requested: {},
    checks: [],
    blockers: [],
    warnings: [],
    next_command: ok ? null : `oracle doctor ${provider} --json`,
    fix_command: null,
  };
}

function check(
  component: string,
  status: AggregateDoctorCheck["status"] = "pass",
  code = `${component}_${status}`,
  overrides: Partial<AggregateDoctorCheck> = {},
): AggregateDoctorCheck {
  return {
    component,
    status,
    code,
    message: `${component} ${status}`,
    retry_safe: status !== "fail",
    ...overrides,
  };
}

const fakeStore = {
  ensureStorage: async () => {},
  sessionsDir: () => "/tmp/oracle/sessions",
  listSessions: async () => [],
};

describe("aggregate doctor", () => {
  test("emits a healthy json_envelope.v1 preflight", async () => {
    const output: string[] = [];
    const result = await runAggregateDoctor(
      {
        json: true,
        now: () => new Date("2026-05-13T00:00:00.000Z"),
        chatgptDoctor: async () => providerEnvelope("chatgpt"),
        geminiDoctor: async () => providerEnvelope("gemini"),
        remoteBridgeDoctor: async () => check("remote_bridge"),
        sessionStorageCheck: async () => check("session_storage"),
        providerDocsCheck: async () => check("provider_docs"),
        browserLeasesCheck: async () => check("browser_leases"),
        evidenceStorageCheck: async () => check("evidence_storage"),
      },
      { stdout: (text) => output.push(text) },
    );

    expect(result).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      blocked_reason: null,
      data: { schema_version: "oracle_doctor.v1", status: "ready" },
      meta: { command: "oracle doctor --json", generated_at: "2026-05-13T00:00:00.000Z" },
    });
    expect(result.data.checks.map((entry) => entry.component)).toEqual([
      "chatgpt_doctor",
      "gemini_doctor",
      "remote_bridge",
      "session_storage",
      "provider_docs",
      "browser_leases",
      "evidence_storage",
    ]);
    expect(JSON.parse(output[0])).toMatchObject({ ok: true });
  });

  test("surfaces remote token missing with recovery commands", async () => {
    const result = await runAggregateDoctor({
      chatgptDoctor: async () => providerEnvelope("chatgpt"),
      geminiDoctor: async () => providerEnvelope("gemini"),
      remoteBridgeDoctor: async () =>
        check("remote_bridge", "fail", "remote_token_missing", {
          message: "Remote host is configured but ORACLE_REMOTE_TOKEN is missing.",
          next_command: "oracle remote doctor --json",
          fix_command: "export ORACLE_REMOTE_TOKEN=<token>",
          retry_safe: false,
        }),
      sessionStorageCheck: async () => check("session_storage"),
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_reason).toBe("remote_token_missing");
    expect(result.next_command).toBe("oracle remote doctor --json");
    expect(result.fix_command).toBe("export ORACLE_REMOTE_TOKEN=<token>");
    expect(result.retry_safe).toBe(false);
  });

  test("blocks on stale provider docs freshness", async () => {
    const result = await runAggregateDoctor({
      chatgptDoctor: async () => providerEnvelope("chatgpt"),
      geminiDoctor: async () => providerEnvelope("gemini"),
      remoteBridgeDoctor: async () => check("remote_bridge"),
      sessionStorageCheck: async () => check("session_storage"),
      providerDocsCheck: async () =>
        check("provider_docs", "fail", "provider_docs_stale", {
          message: "Provider docs snapshot is stale.",
          next_command: "oracle capabilities --json",
          fix_command: "Refresh provider docs snapshot before protected route use.",
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_reason).toBe("provider_docs_stale");
    expect(result.next_command).toBe("oracle capabilities --json");
  });

  test("routes lease conflicts to browser lease recovery", async () => {
    const result = await runAggregateDoctor({
      chatgptDoctor: async () => providerEnvelope("chatgpt"),
      geminiDoctor: async () => providerEnvelope("gemini"),
      remoteBridgeDoctor: async () => check("remote_bridge"),
      sessionStorageCheck: async () => check("session_storage"),
      browserLeasesCheck: async () =>
        check("browser_leases", "fail", "browser_lease_conflict", {
          message: "A provider browser lease is already active.",
          next_command: "oracle browser leases recover --json",
          retry_safe: true,
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_reason).toBe("browser_lease_conflict");
    expect(result.next_command).toBe("oracle browser leases recover --json");
    expect(result.retry_safe).toBe(true);
  });

  test("blocks when evidence storage is unavailable", async () => {
    const result = await runAggregateDoctor({
      chatgptDoctor: async () => providerEnvelope("chatgpt"),
      geminiDoctor: async () => providerEnvelope("gemini"),
      remoteBridgeDoctor: async () => check("remote_bridge"),
      sessionStorageCheck: async () => check("session_storage"),
      evidenceStorageCheck: async () =>
        check("evidence_storage", "fail", "evidence_storage_unavailable", {
          message: "Evidence artifact path is not writable.",
          fix_command: "mkdir -p ~/.oracle/sessions",
          next_command: "oracle evidence verify <session>",
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_reason).toBe("evidence_storage_unavailable");
    expect(result.fix_command).toBe("mkdir -p ~/.oracle/sessions");
    expect(result.next_command).toBe("oracle evidence verify <session>");
  });

  test("registers aggregate doctor without removing provider subcommands", () => {
    const program = new Command();
    registerDoctorCommand(program, {
      aggregate: {
        sessionStore: fakeStore,
        chatgptDoctor: async () => providerEnvelope("chatgpt"),
        geminiDoctor: async () => providerEnvelope("gemini"),
        remoteBridgeDoctor: async () => check("remote_bridge"),
      },
    });

    const doctor = program.commands.find((command) => command.name() === "doctor");
    expect(doctor?.commands.map((command) => command.name()).sort()).toEqual(["chatgpt", "gemini"]);
  });
});
