import { describe, expect, test } from "vitest";

import {
  ORACLE_ROBOT_TOOL_NAME,
  ROBOT_COMMANDS,
  ROBOT_ERROR_FIELDS_REQUIRED,
  ROBOT_RECOVERY_FIELDS,
  buildRobotSurfacePayload,
  findRobotCommand,
  listRobotCommands,
  type RobotCommandEntry,
} from "@src/cli/robotRegistry.ts";
import {
  buildRobotDocsEnvelope,
  runRobotDocs,
} from "@src/cli/commands/robotDocs.ts";
import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  ROBOT_SURFACE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  jsonEnvelopeSchema,
  robotSurfaceSchema,
} from "@src/oracle/v18/index.ts";

// Bead acceptance: these commands MUST be present in robot-docs output.
const REQUIRED_COMMAND_NAMES = [
  "capabilities",
  "doctor",
  "doctor-chatgpt",
  "doctor-gemini",
  "browser-leases-plan",
  "browser-leases-status",
  "browser-leases-recover",
  "evidence-show",
  "evidence-verify",
  "remote-doctor",
  "remote-status",
  "remote-attach",
] as const;

describe("ROBOT_COMMANDS — bead-required surface coverage", () => {
  test.each(REQUIRED_COMMAND_NAMES)("includes %s", (name) => {
    const entry = findRobotCommand(name);
    expect(entry, `command "${name}" missing from robot registry`).not.toBeNull();
  });

  test("registry advertises robot-docs itself (self-describing)", () => {
    expect(findRobotCommand("robot-docs")).not.toBeNull();
  });

  test("listRobotCommands returns a stable list with unique names", () => {
    const names = listRobotCommands().map((cmd) => cmd.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("each RobotCommandEntry carries the required v18 metadata", () => {
  test.each(ROBOT_COMMANDS as readonly RobotCommandEntry[])(
    "entry $name has typed metadata",
    (entry) => {
      expect(typeof entry.name).toBe("string");
      expect(entry.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(typeof entry.command).toBe("string");
      expect(entry.command).toMatch(/^oracle /);
      expect(typeof entry.purpose).toBe("string");
      expect(entry.purpose.length).toBeGreaterThan(8);
      expect(typeof entry.paid_calls).toBe("boolean");
      expect(typeof entry.dry_run).toBe("boolean");
      expect(Array.isArray(entry.required_env)).toBe(true);
      expect(typeof entry.output_schema_version).toBe("string");
      expect(entry.output_schema_version.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.recovery_fields)).toBe(true);
      expect(typeof entry.touches_network).toBe("boolean");
      expect(typeof entry.touches_chrome).toBe("boolean");
      // Every entry must surface the v18 recovery contract.
      for (const field of ROBOT_ERROR_FIELDS_REQUIRED) {
        expect(entry.recovery_fields).toContain(field);
      }
    },
  );

  test("no entry currently exposes paid_calls=true", () => {
    // Oracle's robot-facing CLI is gating-only; live paid runs go through
    // the unguarded `oracle` invocation, not a robot-docs-advertised
    // command. Guard against regressions.
    for (const entry of ROBOT_COMMANDS) {
      expect(entry.paid_calls).toBe(false);
    }
  });

  test("required_env carries env NAMES only (no leaked secret-looking strings)", () => {
    const secretLikeRe = /sk-[a-z0-9-]{6,}|bearer\s|token=|password=/i;
    for (const entry of ROBOT_COMMANDS) {
      for (const env of entry.required_env) {
        expect(env).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(env).not.toMatch(secretLikeRe);
      }
    }
  });
});

describe("buildRobotSurfacePayload — robot_surface.v1 shape", () => {
  test("schema_version, tool, json_envelope_required, error_fields_required are pinned", () => {
    const payload = buildRobotSurfacePayload();
    expect(payload.schema_version).toBe(ROBOT_SURFACE_SCHEMA_VERSION);
    expect(payload.tool).toBe(ORACLE_ROBOT_TOOL_NAME);
    expect(payload.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(payload.json_envelope_required).toBe(true);
    expect(payload.error_fields_required).toEqual(ROBOT_ERROR_FIELDS_REQUIRED);
    expect(payload.robot_recovery_fields).toEqual(ROBOT_RECOVERY_FIELDS);
  });

  test("payload conforms to v18 robotSurfaceSchema", () => {
    const payload = buildRobotSurfacePayload();
    expect(() => robotSurfaceSchema.parse(payload)).not.toThrow();
  });

  test("each emitted command record carries the bundle's robots.json shape", () => {
    const payload = buildRobotSurfacePayload();
    for (const cmd of payload.commands) {
      expect(typeof cmd.name).toBe("string");
      expect(typeof cmd.command).toBe("string");
      expect(typeof cmd.paid_calls).toBe("boolean");
    }
  });

  test("mock_command appears only on entries that declare it (registry stays honest)", () => {
    const payload = buildRobotSurfacePayload();
    for (const cmd of payload.commands) {
      const name = cmd.name as string;
      const entry = findRobotCommand(name);
      if (entry?.mock_command !== undefined) {
        expect(cmd.mock_command).toBe(entry.mock_command);
      } else {
        expect("mock_command" in cmd).toBe(false);
      }
    }
  });
});

describe("buildRobotDocsEnvelope — json_envelope.v1 conformance", () => {
  test("envelope passes the v18 jsonEnvelopeSchema", () => {
    const { envelope } = buildRobotDocsEnvelope();
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(envelope.meta.schema_version).toBe(ROBOT_SURFACE_SCHEMA_VERSION);
    expect(envelope.meta.tool).toBe(ORACLE_ROBOT_TOOL_NAME);
  });

  test("envelope's data is the robot_surface.v1 payload, intact", () => {
    const { envelope, payload } = buildRobotDocsEnvelope();
    expect(envelope.data).toEqual(payload);
  });

  test("commands map advertises the three preflight commands", () => {
    const { envelope } = buildRobotDocsEnvelope();
    const commands = envelope.commands as Record<string, unknown>;
    expect(commands.capabilities).toBe("oracle capabilities --json");
    expect(commands.doctor).toBe("oracle doctor --json");
    expect(commands.robot_docs).toBe("oracle robot-docs --json");
  });
});

describe("runRobotDocs — CLI surface behavior", () => {
  test("default JSON invocation writes a single envelope to stdout", async () => {
    const chunks: string[] = [];
    await runRobotDocs(
      { json: true },
      { stdout: (text) => chunks.push(text) },
    );
    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.tool).toBe(ORACLE_ROBOT_TOOL_NAME);
    expect(Array.isArray(parsed.data.commands)).toBe(true);
  });

  test("--no-json writes a deterministic human summary listing every command", async () => {
    const chunks: string[] = [];
    await runRobotDocs(
      { json: false },
      { stdout: (text) => chunks.push(text) },
    );
    const text = chunks.join("");
    for (const name of REQUIRED_COMMAND_NAMES) {
      expect(text).toContain(name);
    }
  });

  test("two JSON runs produce byte-identical output (deterministic)", async () => {
    const a: string[] = [];
    const b: string[] = [];
    await runRobotDocs({ json: true }, { stdout: (text) => a.push(text) });
    await runRobotDocs({ json: true }, { stdout: (text) => b.push(text) });
    expect(a.join("")).toBe(b.join(""));
  });
});

describe("robot-docs does not leak secrets", () => {
  test("output never contains common secret patterns", async () => {
    const chunks: string[] = [];
    await runRobotDocs(
      { json: true },
      { stdout: (text) => chunks.push(text) },
    );
    const text = chunks.join("");
    for (const pattern of [/sk-[a-z0-9-]{6,}/i, /Bearer\s+\w/i, /token=/i, /password=/i]) {
      expect(text).not.toMatch(pattern);
    }
  });
});
