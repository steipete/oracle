import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  runBrowserLeasesAcquire,
  runBrowserLeasesPlan,
  runBrowserLeasesRecover,
  runBrowserLeasesRelease,
  runBrowserLeasesStatus,
} from "../../../src/cli/commands/leases/index.js";
import { createBrowserLease } from "../../../src/browser/leases.js";

const PROFILE_A = `sha256:${"a".repeat(64)}`;

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
      const acquiredLease = (acquired.data?.leases as Array<{ lease_id: string }>)[0];
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
      expect((status.data?.leases as Array<{ state: string }>)[0].state).toBe("active");

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
      expect((released.data?.leases as Array<{ status: string }>)[0].status).toBe("released");
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
      const lease = (status.data?.leases as Array<{ lease: { lease_id: string } }>)[0].lease;
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
      expect((status.data?.leases as Array<{ state: string }>)[0].state).toBe("stale");

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
      const guidance = (recover.data?.recoveries as Array<Record<string, unknown>>)[0];
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
