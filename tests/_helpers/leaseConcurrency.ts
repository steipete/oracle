import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  browserLeasePath,
  createBrowserLease,
  readBrowserLease,
  type BrowserLeaseReadResult,
  type BrowserLeaseStoreOptions,
} from "../../src/browser/leases.js";
import type {
  BrowserLeaseProvider,
  StoredBrowserLeaseRecord,
} from "../../src/oracle/v18/browser_lease.js";

export const CHATGPT_PROFILE = `sha256:${"c".repeat(64)}`;
export const GEMINI_PROFILE = `sha256:${"d".repeat(64)}`;

export type LeaseRequirementId =
  | "LEASE-CONCURRENCY-001"
  | "LEASE-CONCURRENCY-002"
  | "LEASE-CONCURRENCY-003"
  | "LEASE-CONCURRENCY-004"
  | "LEASE-CONCURRENCY-005";

export interface LeaseRequirement {
  id: LeaseRequirementId;
  level: "MUST";
  description: string;
}

export const LEASE_CONCURRENCY_REQUIREMENTS: readonly LeaseRequirement[] = [
  {
    id: "LEASE-CONCURRENCY-001",
    level: "MUST",
    description: "An active provider lease rejects same-provider contenders.",
  },
  {
    id: "LEASE-CONCURRENCY-002",
    level: "MUST",
    description: "Provider lease files are isolated by provider.",
  },
  {
    id: "LEASE-CONCURRENCY-003",
    level: "MUST",
    description: "TTL-expired leases are recoverable and not overwritten silently.",
  },
  {
    id: "LEASE-CONCURRENCY-004",
    level: "MUST",
    description: "Dead local-pid leases are recoverable and not overwritten silently.",
  },
  {
    id: "LEASE-CONCURRENCY-005",
    level: "MUST",
    description: "Corrupt lock files expose recovery guidance and block acquisition.",
  },
];

export interface LeaseHarness {
  leaseDir: string;
  now: () => Date;
  setNow: (iso: string) => void;
  markPidAlive: (pid: number) => void;
  markPidDead: (pid: number) => void;
  storeOptions: (overrides?: BrowserLeaseStoreOptions) => BrowserLeaseStoreOptions;
  acquire: (input: AcquireLeaseHarnessInput) => Promise<StoredBrowserLeaseRecord>;
  read: (provider: BrowserLeaseProvider, profileIdHash?: string) => Promise<BrowserLeaseReadResult>;
  writeCorrupt: (provider: BrowserLeaseProvider, body?: string) => Promise<void>;
}

export interface AcquireLeaseHarnessInput {
  provider: BrowserLeaseProvider;
  profileIdHash: string;
  leaseId: string;
  ttlSeconds?: number;
  pid?: number;
  holder?: string;
}

export type LeaseAcquireOutcome =
  | {
      ok: true;
      index: number;
      lease: StoredBrowserLeaseRecord;
    }
  | {
      ok: false;
      index: number;
      error: unknown;
    };

export async function withLeaseHarness<T>(fn: (harness: LeaseHarness) => Promise<T>): Promise<T> {
  const leaseDir = await mkdtemp(path.join(os.tmpdir(), "oracle-lease-concurrency-"));
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const deadPids = new Set<number>();
  const harness: LeaseHarness = {
    leaseDir,
    now: () => new Date(nowMs),
    setNow: (iso) => {
      nowMs = Date.parse(iso);
    },
    markPidAlive: (pid) => {
      deadPids.delete(pid);
    },
    markPidDead: (pid) => {
      deadPids.add(pid);
    },
    storeOptions: (overrides = {}) => ({
      leaseDir,
      now: () => new Date(nowMs),
      isProcessAlive: (pid) => !deadPids.has(pid),
      ...overrides,
    }),
    acquire: (input) =>
      createBrowserLease(
        {
          provider: input.provider,
          profileIdHash: input.profileIdHash,
          ttlSeconds: input.ttlSeconds,
          holder: input.holder ?? `holder-${input.leaseId}`,
          commandSummary: `test acquire ${input.leaseId}`,
        },
        harness.storeOptions({
          pid: input.pid,
          uuid: () => input.leaseId,
        }),
      ),
    read: (provider, profileIdHash) =>
      readBrowserLease(provider, {
        ...harness.storeOptions(),
        expectedProfileIdHash: profileIdHash,
      }),
    writeCorrupt: async (provider, body = "{not json") => {
      await mkdir(leaseDir, { recursive: true });
      await writeFile(browserLeasePath(provider, { leaseDir }), body, "utf8");
    },
  };

  try {
    return await fn(harness);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
}

export async function raceAcquireLeases(
  harness: LeaseHarness,
  input: Omit<AcquireLeaseHarnessInput, "leaseId"> & {
    count: number;
    leaseIdPrefix: string;
  },
): Promise<LeaseAcquireOutcome[]> {
  return Promise.all(
    Array.from({ length: input.count }, async (_, index): Promise<LeaseAcquireOutcome> => {
      try {
        const lease = await harness.acquire({
          provider: input.provider,
          profileIdHash: input.profileIdHash,
          ttlSeconds: input.ttlSeconds,
          pid: input.pid,
          holder: input.holder,
          leaseId: `${input.leaseIdPrefix}-${index}`,
        });
        return { ok: true, index, lease };
      } catch (error) {
        return { ok: false, index, error };
      }
    }),
  );
}

export function assertAllLeaseRequirementsCovered(covered: readonly LeaseRequirementId[]): void {
  const coveredSet = new Set(covered);
  const missing = LEASE_CONCURRENCY_REQUIREMENTS.filter(
    (requirement) => !coveredSet.has(requirement.id),
  );
  if (missing.length > 0) {
    throw new Error(
      `Lease concurrency conformance gaps: ${missing.map((entry) => entry.id).join(", ")}`,
    );
  }
}
