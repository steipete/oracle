import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  BrowserLeaseStateError,
  browserLeasePath,
  createBrowserLease,
  expireBrowserLease,
  readBrowserLease,
  releaseBrowserLease,
  renewBrowserLease,
} from "../../src/browser/leases.js";
import { redactBrowserLeaseMetadata } from "../../src/oracle/v18/browser_lease.js";

const PROFILE_A = `sha256:${"a".repeat(64)}`;
const PROFILE_B = `sha256:${"b".repeat(64)}`;

async function withLeaseDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-leases-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("browser lease storage", () => {
  test("creates and reads an active provider lease with TTL metadata", async () => {
    await withLeaseDir(async (leaseDir) => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const record = await createBrowserLease(
        {
          provider: "chatgpt",
          profileIdHash: PROFILE_A,
          ttlSeconds: 300,
          holder: "pane-2",
          commandSummary: "oracle --engine browser",
        },
        {
          leaseDir,
          now: () => now,
          pid: 1234,
          uuid: () => "lease-chatgpt-1",
          isProcessAlive: () => true,
        },
      );

      expect(record).toMatchObject({
        lease_id: "lease-chatgpt-1",
        provider: "chatgpt",
        profile_id_hash: PROFILE_A,
        local_pid: 1234,
        holder: "pane-2",
        command_summary: "oracle --engine browser",
        status: "acquired",
        ttl_seconds: 300,
        issued_at: "2026-01-01T00:00:00.000Z",
        acquired_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-01-01T00:05:00.000Z",
        safe_recovery_command:
          "oracle browser leases recover --provider chatgpt --lease-id lease-chatgpt-1",
      });

      const result = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now: () => now,
        isProcessAlive: () => true,
      });
      expect(result.state).toBe("active");
      if (result.state === "active") {
        expect(result.record.lease_id).toBe("lease-chatgpt-1");
        expect(result.profileMatches).toBe(true);
      }
    });
  });

  test("renews active leases by extending expires_at from the renewal time", async () => {
    await withLeaseDir(async (leaseDir) => {
      let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      const now = () => new Date(nowMs);
      const record = await createBrowserLease(
        {
          provider: "gemini",
          profileIdHash: PROFILE_A,
          ttlSeconds: 60,
          holder: "pane-2",
          commandSummary: "oracle --engine browser --model gemini-3-pro",
        },
        { leaseDir, now, pid: 2222, uuid: () => "lease-gemini-1", isProcessAlive: () => true },
      );

      nowMs = Date.parse("2026-01-01T00:00:30.000Z");
      const renewed = await renewBrowserLease(
        {
          provider: "gemini",
          profileIdHash: PROFILE_A,
          leaseId: record.lease_id,
          ttlSeconds: 120,
        },
        { leaseDir, now, isProcessAlive: () => true },
      );

      expect(renewed.expires_at).toBe("2026-01-01T00:02:30.000Z");
      expect(renewed.updated_at).toBe("2026-01-01T00:00:30.000Z");
      expect(renewed.acquired_at).toBe("2026-01-01T00:00:00.000Z");
      expect(renewed.ttl_seconds).toBe(120);
    });
  });

  test("expires and releases leases without deleting lock files", async () => {
    await withLeaseDir(async (leaseDir) => {
      let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      const now = () => new Date(nowMs);
      const record = await createBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_A, holder: "pane-2" },
        { leaseDir, now, uuid: () => "lease-expire-1", isProcessAlive: () => true },
      );

      nowMs = Date.parse("2026-01-01T00:01:00.000Z");
      await expireBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_A, leaseId: record.lease_id },
        { leaseDir, now, isProcessAlive: () => true },
      );
      const expired = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now,
        isProcessAlive: () => true,
      });
      expect(expired.state).toBe("expired");
      expect(await readFile(browserLeasePath("chatgpt", { leaseDir }), "utf8")).toContain(
        '"status": "expired"',
      );

      await releaseBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_A, leaseId: record.lease_id },
        { leaseDir, now, isProcessAlive: () => true },
      );
      const released = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now,
        isProcessAlive: () => true,
      });
      expect(released.state).toBe("released");
    });
  });

  test("detects TTL-expired leases without mutating the lock file", async () => {
    await withLeaseDir(async (leaseDir) => {
      const createdAt = new Date("2026-01-01T00:00:00.000Z");
      await createBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_A, ttlSeconds: 1, holder: "pane-2" },
        {
          leaseDir,
          now: () => createdAt,
          uuid: () => "lease-ttl-1",
          isProcessAlive: () => true,
        },
      );
      const beforeRead = await readFile(browserLeasePath("chatgpt", { leaseDir }), "utf8");
      const result = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now: () => new Date("2026-01-01T00:00:02.000Z"),
        isProcessAlive: () => true,
      });
      const afterRead = await readFile(browserLeasePath("chatgpt", { leaseDir }), "utf8");

      expect(result.state).toBe("expired");
      expect(afterRead).toBe(beforeRead);
    });
  });

  test("detects stale local pid leases and refuses to overwrite them silently", async () => {
    await withLeaseDir(async (leaseDir) => {
      await createBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_A, ttlSeconds: 300, holder: "pane-2" },
        {
          leaseDir,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          pid: 999_999,
          uuid: () => "lease-stale-1",
          isProcessAlive: () => true,
        },
      );

      const stale = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now: () => new Date("2026-01-01T00:01:00.000Z"),
        isProcessAlive: () => false,
      });
      expect(stale.state).toBe("stale");

      await expect(
        createBrowserLease(
          { provider: "chatgpt", profileIdHash: PROFILE_A, holder: "pane-2" },
          {
            leaseDir,
            now: () => new Date("2026-01-01T00:01:00.000Z"),
            uuid: () => "lease-new",
            isProcessAlive: () => false,
          },
        ),
      ).rejects.toBeInstanceOf(BrowserLeaseStateError);

      const raw = await readFile(browserLeasePath("chatgpt", { leaseDir }), "utf8");
      expect(raw).toContain("lease-stale-1");
      expect(raw).not.toContain("lease-new");
    });
  });

  test("surfaces corrupt lock files with a recovery command", async () => {
    await withLeaseDir(async (leaseDir) => {
      await mkdir(leaseDir, { recursive: true });
      await writeFile(browserLeasePath("gemini", { leaseDir }), "{not json", "utf8");

      const result = await readBrowserLease("gemini", { leaseDir });

      expect(result.state).toBe("corrupt");
      if (result.state === "corrupt") {
        expect(result.raw).toBe("{not json");
        expect(result.recoveryCommand).toBe("oracle browser leases recover --provider gemini");
        expect(result.error).toMatch(/json/i);
      }
    });
  });

  test("detects profile hash mismatches without treating the lock as active", async () => {
    await withLeaseDir(async (leaseDir) => {
      await createBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_A, holder: "pane-2" },
        {
          leaseDir,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          uuid: () => "lease-profile-1",
          isProcessAlive: () => true,
        },
      );

      const result = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_B,
        now: () => new Date("2026-01-01T00:00:01.000Z"),
        isProcessAlive: () => true,
      });

      expect(result.state).toBe("profile_mismatch");
      if (result.state === "profile_mismatch") {
        expect(result.profileMatches).toBe(false);
        expect(result.record.profile_id_hash).toBe(PROFILE_A);
      }
    });
  });

  test("redacts sensitive holder, command, remote session, and remote browser metadata", async () => {
    await withLeaseDir(async (leaseDir) => {
      const record = await createBrowserLease(
        {
          provider: "chatgpt",
          profileIdHash: PROFILE_A,
          holder: "alice@example.com",
          commandSummary: "oracle --remote-token secret-token --browser-inline-cookies cookie",
          remoteSessionId: "remote-session-secret",
          remoteBrowser: {
            host: "remote.internal",
            auth_profile_id_hash: PROFILE_B,
            token: "secret-token",
          },
        },
        {
          leaseDir,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          uuid: () => "lease-redact-1",
        },
      );

      const redacted = redactBrowserLeaseMetadata(record);
      const serialized = JSON.stringify(redacted);
      expect(serialized).not.toContain("alice@example.com");
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("remote-session-secret");
      expect(serialized).not.toContain("remote.internal");
      expect(redacted.provider).toBe("chatgpt");
      expect(redacted.profile_id_hash).toBe(PROFILE_A);
      expect(redacted.remote_browser.auth_profile_id_hash).toBe(PROFILE_B);
    });
  });
});
