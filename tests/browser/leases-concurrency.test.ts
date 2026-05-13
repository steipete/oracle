import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  BrowserLeaseStateError,
  browserLeasePath,
  releaseBrowserLease,
} from "../../src/browser/leases.js";
import {
  assertAllLeaseRequirementsCovered,
  CHATGPT_PROFILE,
  GEMINI_PROFILE,
  LEASE_CONCURRENCY_REQUIREMENTS,
  raceAcquireLeases,
  withLeaseHarness,
  type LeaseRequirementId,
} from "../_helpers/leaseConcurrency.js";

const COVERED_REQUIREMENTS = [
  "LEASE-CONCURRENCY-001",
  "LEASE-CONCURRENCY-002",
  "LEASE-CONCURRENCY-003",
  "LEASE-CONCURRENCY-004",
  "LEASE-CONCURRENCY-005",
] satisfies LeaseRequirementId[];

describe("browser lease concurrency conformance", () => {
  test("coverage matrix enumerates every lease concurrency requirement", () => {
    expect(LEASE_CONCURRENCY_REQUIREMENTS).toEqual([
      expect.objectContaining({ id: "LEASE-CONCURRENCY-001", level: "MUST" }),
      expect.objectContaining({ id: "LEASE-CONCURRENCY-002", level: "MUST" }),
      expect.objectContaining({ id: "LEASE-CONCURRENCY-003", level: "MUST" }),
      expect.objectContaining({ id: "LEASE-CONCURRENCY-004", level: "MUST" }),
      expect.objectContaining({ id: "LEASE-CONCURRENCY-005", level: "MUST" }),
    ]);
    expect(() => assertAllLeaseRequirementsCovered(COVERED_REQUIREMENTS)).not.toThrow();
  });

  test("simultaneous first acquire has one persisted winner", async () => {
    await withLeaseHarness(async (harness) => {
      const outcomes = await raceAcquireLeases(harness, {
        provider: "chatgpt",
        profileIdHash: CHATGPT_PROFILE,
        count: 48,
        leaseIdPrefix: "chatgpt-first-contender",
      });
      const successes = outcomes.flatMap((outcome) => (outcome.ok ? [outcome] : []));
      const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome]));

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(47);
      const winner = successes[0]!.lease;

      const current = await harness.read("chatgpt", CHATGPT_PROFILE);
      expect(current.state).toBe("active");
      if (current.state === "active") {
        expect(current.record.lease_id).toBe(winner.lease_id);
      }

      for (const outcome of failures) {
        expect(outcome.error).toBeInstanceOf(BrowserLeaseStateError);
        const result = (outcome.error as BrowserLeaseStateError).result;
        expect(result.state).toBe("active");
        if (result.state === "active") {
          expect(result.record.lease_id).toBe(winner.lease_id);
        }
      }
    });
  });

  test("LEASE-CONCURRENCY-001: active same-provider lock rejects all contenders", async () => {
    await withLeaseHarness(async (harness) => {
      await harness.acquire({
        provider: "chatgpt",
        profileIdHash: CHATGPT_PROFILE,
        leaseId: "chatgpt-holder",
        pid: 4101,
      });
      harness.markPidAlive(4101);

      const outcomes = await raceAcquireLeases(harness, {
        provider: "chatgpt",
        profileIdHash: CHATGPT_PROFILE,
        count: 8,
        leaseIdPrefix: "chatgpt-contender",
      });

      expect(outcomes).toHaveLength(8);
      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.error).toBeInstanceOf(BrowserLeaseStateError);
          expect((outcome.error as BrowserLeaseStateError).result.state).toBe("active");
        }
      }

      const current = await harness.read("chatgpt", CHATGPT_PROFILE);
      expect(current.state).toBe("active");
      if (current.state === "active") {
        expect(current.record.lease_id).toBe("chatgpt-holder");
      }
    });
  });

  test("LEASE-CONCURRENCY-002: ChatGPT and Gemini leases do not share lock files", async () => {
    await withLeaseHarness(async (harness) => {
      const [chatgpt, gemini] = await Promise.all([
        harness.acquire({
          provider: "chatgpt",
          profileIdHash: CHATGPT_PROFILE,
          leaseId: "chatgpt-isolated",
          pid: 4201,
        }),
        harness.acquire({
          provider: "gemini",
          profileIdHash: GEMINI_PROFILE,
          leaseId: "gemini-isolated",
          pid: 4202,
        }),
      ]);
      harness.markPidAlive(4201);
      harness.markPidAlive(4202);

      expect(chatgpt.provider).toBe("chatgpt");
      expect(gemini.provider).toBe("gemini");
      const chatgptState = await harness.read("chatgpt", CHATGPT_PROFILE);
      const geminiState = await harness.read("gemini", GEMINI_PROFILE);

      expect(chatgptState.state).toBe("active");
      expect(geminiState.state).toBe("active");
      if (chatgptState.state === "active" && geminiState.state === "active") {
        expect(chatgptState.path).not.toBe(geminiState.path);
        expect(chatgptState.record.lease_id).toBe("chatgpt-isolated");
        expect(geminiState.record.lease_id).toBe("gemini-isolated");
      }
    });
  });

  test("LEASE-CONCURRENCY-003: expired TTL blocks contenders until explicit recovery", async () => {
    await withLeaseHarness(async (harness) => {
      await harness.acquire({
        provider: "chatgpt",
        profileIdHash: CHATGPT_PROFILE,
        leaseId: "chatgpt-expired",
        ttlSeconds: 1,
        pid: 4301,
      });
      harness.markPidAlive(4301);
      harness.setNow("2026-01-01T00:00:02.000Z");

      const expired = await harness.read("chatgpt", CHATGPT_PROFILE);
      expect(expired.state).toBe("expired");
      if (expired.state === "expired") {
        expect(expired.recoveryCommand).toContain("chatgpt-expired");
      }

      const outcomes = await raceAcquireLeases(harness, {
        provider: "chatgpt",
        profileIdHash: CHATGPT_PROFILE,
        count: 4,
        leaseIdPrefix: "chatgpt-expired-contender",
      });
      expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          expect(outcome.error).toBeInstanceOf(BrowserLeaseStateError);
          expect((outcome.error as BrowserLeaseStateError).result.state).toBe("expired");
        }
      }

      await releaseBrowserLease(
        { provider: "chatgpt", profileIdHash: CHATGPT_PROFILE, leaseId: "chatgpt-expired" },
        harness.storeOptions(),
      );
      const recovered = await harness.acquire({
        provider: "chatgpt",
        profileIdHash: CHATGPT_PROFILE,
        leaseId: "chatgpt-after-expired-recovery",
      });
      expect(recovered.lease_id).toBe("chatgpt-after-expired-recovery");
    });
  });

  test("LEASE-CONCURRENCY-004: stale dead-pid lock blocks contenders and preserves holder", async () => {
    await withLeaseHarness(async (harness) => {
      harness.markPidAlive(4401);
      await harness.acquire({
        provider: "gemini",
        profileIdHash: GEMINI_PROFILE,
        leaseId: "gemini-stale",
        ttlSeconds: 300,
        pid: 4401,
      });
      harness.markPidDead(4401);

      const stale = await harness.read("gemini", GEMINI_PROFILE);
      expect(stale.state).toBe("stale");
      if (stale.state === "stale") {
        expect(stale.recoveryCommand).toContain("gemini-stale");
      }

      const outcomes = await raceAcquireLeases(harness, {
        provider: "gemini",
        profileIdHash: GEMINI_PROFILE,
        count: 6,
        leaseIdPrefix: "gemini-stale-contender",
      });

      expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          expect(outcome.error).toBeInstanceOf(BrowserLeaseStateError);
          expect((outcome.error as BrowserLeaseStateError).result.state).toBe("stale");
        }
      }

      const current = await harness.read("gemini", GEMINI_PROFILE);
      expect(current.state).toBe("stale");
      if (current.state === "stale") {
        expect(current.record.lease_id).toBe("gemini-stale");
      }
    });
  });

  test("LEASE-CONCURRENCY-005: corrupt lock blocks acquisition and reports recovery command", async () => {
    await withLeaseHarness(async (harness) => {
      await harness.writeCorrupt("gemini");

      const corrupt = await harness.read("gemini", GEMINI_PROFILE);
      expect(corrupt.state).toBe("corrupt");
      if (corrupt.state === "corrupt") {
        expect(corrupt.recoveryCommand).toBe("oracle browser leases recover --provider gemini");
        expect(corrupt.error).toMatch(/json/i);
      }

      const outcomes = await raceAcquireLeases(harness, {
        provider: "gemini",
        profileIdHash: GEMINI_PROFILE,
        count: 4,
        leaseIdPrefix: "gemini-corrupt-contender",
      });

      expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          expect(outcome.error).toBeInstanceOf(BrowserLeaseStateError);
          expect((outcome.error as BrowserLeaseStateError).result.state).toBe("corrupt");
        }
      }
    });
  });

  test("wrong lease id cannot release another active holder", async () => {
    await withLeaseHarness(async (harness) => {
      await harness.acquire({
        provider: "chatgpt",
        profileIdHash: CHATGPT_PROFILE,
        leaseId: "chatgpt-release-holder",
      });

      await expect(
        releaseBrowserLease(
          { provider: "chatgpt", profileIdHash: CHATGPT_PROFILE, leaseId: "other-lease" },
          harness.storeOptions(),
        ),
      ).rejects.toBeInstanceOf(BrowserLeaseStateError);

      const current = await harness.read("chatgpt", CHATGPT_PROFILE);
      expect(current.state).toBe("active");
      if (current.state === "active") {
        expect(current.record.lease_id).toBe("chatgpt-release-holder");
      }
    });
  });

  test("profile mismatch blocks same-provider takeover without touching lock contents", async () => {
    await withLeaseHarness(async (harness) => {
      await harness.acquire({
        provider: "chatgpt",
        profileIdHash: CHATGPT_PROFILE,
        leaseId: "chatgpt-profile-holder",
      });
      const before = await harness.read("chatgpt", CHATGPT_PROFILE);
      expect(before.state).toBe("active");

      const outcomes = await raceAcquireLeases(harness, {
        provider: "chatgpt",
        profileIdHash: GEMINI_PROFILE,
        count: 3,
        leaseIdPrefix: "chatgpt-profile-mismatch-contender",
      });

      expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          expect(outcome.error).toBeInstanceOf(BrowserLeaseStateError);
          expect((outcome.error as BrowserLeaseStateError).result.state).toBe("profile_mismatch");
        }
      }
      const after = await harness.read("chatgpt", CHATGPT_PROFILE);
      expect(after.state).toBe("active");
      if (after.state === "active") {
        expect(after.record.lease_id).toBe("chatgpt-profile-holder");
      }
    });
  });

  test("malformed storage shape is treated as corrupt for recovery", async () => {
    await withLeaseHarness(async (harness) => {
      await writeFile(
        browserLeasePath("chatgpt", { leaseDir: harness.leaseDir }),
        JSON.stringify({ provider: "chatgpt", lease_id: "shape-only" }),
        "utf8",
      );

      const result = await harness.read("chatgpt", CHATGPT_PROFILE);
      expect(result.state).toBe("corrupt");
      if (result.state === "corrupt") {
        expect(result.error).toContain("browser_lease.v1");
        expect(result.recoveryCommand).toBe("oracle browser leases recover --provider chatgpt");
      }
    });
  });
});
