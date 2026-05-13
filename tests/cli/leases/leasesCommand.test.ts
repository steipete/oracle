import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import {
  registerBrowserLeasesCommand,
  runBrowserLeasesAcquire,
  runBrowserLeasesPlan,
  runBrowserLeasesRecover,
  runBrowserLeasesRelease,
  runBrowserLeasesStatus,
} from "../../../src/cli/commands/leases/index.js";
import { createBrowserLease } from "../../../src/browser/leases.js";

const PROFILE_A = `sha256:${"a".repeat(64)}`;

function dataArray<T>(data: unknown, key: string): T[] {
  expect(data).toEqual(expect.any(Object));
  const value = (data as Record<string, unknown>)[key];
  expect(Array.isArray(value)).toBe(true);
  return value as T[];
}

async function withLeaseDir<T>(fn: (leaseDir: string) => Promise<T>): Promise<T> {
  const leaseDir = await mkdtemp(path.join(os.tmpdir(), "oracle-cli-leases-"));
  try {
    return await fn(leaseDir);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
}

describe("browser leases command surface", () => {
  test("plan emits dry-run browser_lease-compatible records for requested providers", async () => {
    await withLeaseDir(async (leaseDir) => {
      const output: string[] = [];
      const envelope = await runBrowserLeasesPlan(
        {
          leaseDir,
          providers: "gemini,chatgpt",
          profile: "balanced",
          remoteBrowser: "preferred",
          require: "pro",
          profileIdHash: PROFILE_A,
          ttlSeconds: 120,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        },
        { stdout: (text) => output.push(text) },
      );

      expect(envelope.ok).toBe(true);
      expect(envelope.schema_version).toBe("json_envelope.v1");
      const parsed = JSON.parse(output[0]);
      expect(parsed.data.dry_run).toBe(true);
      expect(parsed.data.options).toMatchObject({
        profile: "balanced",
        remote_browser: "preferred",
        require: "pro",
        profile_id_hash: PROFILE_A,
      });
      expect(parsed.data.leases.map((lease: { provider: string }) => lease.provider)).toEqual([
        "gemini",
        "chatgpt",
      ]);
      expect(parsed.data.leases[0]).toMatchObject({
        schema_version: "browser_lease.v1",
        status: "available",
        ttl_seconds: 120,
        issued_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-01-01T00:02:00.000Z",
      });
    });
  });

  test("registered command accepts singular --provider and plural --providers", async () => {
    await withLeaseDir(async (leaseDir) => {
      const singular = await runRegisteredPlan(leaseDir, ["--provider", "chatgpt"]);
      const plural = await runRegisteredPlan(leaseDir, ["--providers", "chatgpt"]);

      expect(singular.data.leases.map((lease: { provider: string }) => lease.provider)).toEqual([
        "chatgpt",
      ]);
      expect(plural.data.leases.map((lease: { provider: string }) => lease.provider)).toEqual([
        "chatgpt",
      ]);
    });
  });

  test("acquires and releases a lease by lease id", async () => {
    await withLeaseDir(async (leaseDir) => {
      const acquired = await runBrowserLeasesAcquire(
        {
          leaseDir,
          providers: "chatgpt",
          profileIdHash: PROFILE_A,
          ttlSeconds: 300,
          holder: "pane-2",
          uuid: () => "lease-cli-1",
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          isProcessAlive: () => true,
        },
        { stdout: () => undefined },
      );

      expect(acquired.ok).toBe(true);
      const acquiredLease = dataArray<{ lease_id: string }>(acquired.data, "leases")[0];
      expect(acquiredLease.lease_id).toBe("lease-cli-1");

      const status = await runBrowserLeasesStatus(
        {
          leaseDir,
          providers: "chatgpt",
          profileIdHash: PROFILE_A,
          now: () => new Date("2026-01-01T00:00:01.000Z"),
          isProcessAlive: () => true,
        },
        { stdout: () => undefined },
      );
      expect(dataArray<{ state: string }>(status.data, "leases")[0].state).toBe("active");

      const released = await runBrowserLeasesRelease(
        {
          leaseDir,
          providers: "chatgpt",
          profileIdHash: PROFILE_A,
          leaseId: "lease-cli-1",
          now: () => new Date("2026-01-01T00:00:02.000Z"),
          isProcessAlive: () => true,
        },
        { stdout: () => undefined },
      );

      expect(released.ok).toBe(true);
      expect(dataArray<{ status: string }>(released.data, "leases")[0].status).toBe("released");
    });
  });

  test("reports acquire conflicts without replacing an active lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      await createBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_A, holder: "pane-1" },
        {
          leaseDir,
          uuid: () => "lease-existing",
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          isProcessAlive: () => true,
        },
      );

      const envelope = await runBrowserLeasesAcquire(
        {
          leaseDir,
          providers: "chatgpt",
          profileIdHash: PROFILE_A,
          uuid: () => "lease-new",
          now: () => new Date("2026-01-01T00:00:01.000Z"),
          isProcessAlive: () => true,
        },
        { stdout: () => undefined },
      );

      expect(envelope.ok).toBe(false);
      expect(envelope.blocked_reason).toBe("browser_lease_conflict");
      expect(envelope.next_command).toContain("oracle browser leases recover --provider chatgpt");

      const status = await runBrowserLeasesStatus(
        {
          leaseDir,
          providers: "chatgpt",
          profileIdHash: PROFILE_A,
          now: () => new Date("2026-01-01T00:00:02.000Z"),
          isProcessAlive: () => true,
        },
        { stdout: () => undefined },
      );
      const lease = dataArray<{ lease: { lease_id: string } }>(status.data, "leases")[0].lease;
      expect(lease.lease_id).toBe("lease-existing");
    });
  });

  test("status reports stale locks and recover prints safe manual guidance", async () => {
    await withLeaseDir(async (leaseDir) => {
      await createBrowserLease(
        { provider: "gemini", profileIdHash: PROFILE_A, holder: "pane-1" },
        {
          leaseDir,
          pid: 987_654,
          uuid: () => "lease-stale",
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          isProcessAlive: () => true,
        },
      );

      const status = await runBrowserLeasesStatus(
        {
          leaseDir,
          providers: "gemini",
          profileIdHash: PROFILE_A,
          now: () => new Date("2026-01-01T00:00:01.000Z"),
          isProcessAlive: () => false,
        },
        { stdout: () => undefined },
      );
      expect(dataArray<{ state: string }>(status.data, "leases")[0].state).toBe("stale");

      const recover = await runBrowserLeasesRecover(
        {
          leaseDir,
          providers: "gemini",
          profileIdHash: PROFILE_A,
          now: () => new Date("2026-01-01T00:00:01.000Z"),
          isProcessAlive: () => false,
        },
        { stdout: () => undefined },
      );
      const guidance = dataArray<Record<string, unknown>>(recover.data, "recoveries")[0];
      expect(guidance.state).toBe("stale");
      expect(guidance.safe_to_auto_recover).toBe(false);
      expect(guidance.suggested_command).toContain("--confirm-lease-id lease-stale");
    });
  });

  test("invalid providers return a structured failure envelope", async () => {
    await withLeaseDir(async (leaseDir) => {
      const output: string[] = [];
      const envelope = await runBrowserLeasesStatus(
        { leaseDir, providers: "chatgpt,claude", profileIdHash: PROFILE_A },
        { stdout: (text) => output.push(text) },
      );

      expect(envelope.ok).toBe(false);
      expect(envelope.blocked_reason).toBe("invalid_provider");
      expect(envelope.fix_command).toBe("--providers chatgpt,gemini");
      expect(JSON.parse(output[0]).errors[0].details.provider).toBe("claude");
    });
  });
});

async function runRegisteredPlan(
  leaseDir: string,
  providerArgs: readonly string[],
): Promise<{ data: { leases: Array<{ provider: string }> } }> {
  const output: string[] = [];
  const consoleLog = vi.spyOn(console, "log").mockImplementation((text?: unknown) => {
    output.push(String(text ?? ""));
  });
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
    registerBrowserLeasesCommand(program, {
      leaseDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await program.parseAsync(
      [
        "browser",
        "leases",
        "plan",
        ...providerArgs,
        "--profile-id-hash",
        PROFILE_A,
        "--json",
      ],
      { from: "user" },
    );
  } finally {
    consoleLog.mockRestore();
  }

  expect(output).toHaveLength(1);
  return JSON.parse(output[0]) as { data: { leases: Array<{ provider: string }> } };
}
