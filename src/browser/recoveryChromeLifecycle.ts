import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  readChromePid,
  readProcessStartTimeMs,
  terminateRecordedChromeForProfile,
} from "./profileState.js";
import type { BrowserLogger } from "./types.js";

const ownershipPath = (profileDir: string) => path.join(profileDir, "oracle-recovery-chrome.json");

export async function recordRecoveryChromeOwnership(
  profileDir: string,
  pid: number,
  launchedAt = Date.now(),
): Promise<void> {
  const startedAt = await readProcessStartTimeMs(pid);
  if (startedAt === null) return;
  const target = ownershipPath(profileDir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ pid, startedAt, launchedAt }), { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function preserveRecoveryChrome(profileDir: string): Promise<void> {
  // Separate from ownership publication: a keep request may finish while the
  // launching recovery is still waiting for process identity.
  await writeFile(
    path.join(profileDir, "oracle-recovery-preserved.json"),
    JSON.stringify({ preservedAt: Date.now() }),
    { mode: 0o600 },
  );
}

// Called under the final tab-lease release lock. A later recovery can finish
// cleanup for the launching recovery, without claiming a pre-existing browser.
export async function terminateRecoveryChrome(
  profileDir: string,
  logger: BrowserLogger,
): Promise<boolean> {
  const target = ownershipPath(profileDir);
  let owner: { pid?: number; startedAt?: number; launchedAt?: number };
  try {
    owner = JSON.parse(await readFile(target, "utf8"));
  } catch {
    return false;
  }
  if (
    !owner ||
    !Number.isInteger(owner.pid) ||
    !Number.isFinite(owner.startedAt) ||
    !Number.isFinite(owner.launchedAt)
  )
    return false;
  try {
    const preserved = JSON.parse(
      await readFile(path.join(profileDir, "oracle-recovery-preserved.json"), "utf8"),
    );
    if (!Number.isFinite(preserved?.preservedAt) || preserved.preservedAt >= owner.launchedAt!)
      return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const pid = owner.pid!;
  if (
    (await readChromePid(profileDir)) !== pid ||
    (await readProcessStartTimeMs(pid)) !== owner.startedAt
  )
    return false;
  if (!(await terminateRecordedChromeForProfile(profileDir, logger))) return false;
  await rm(target, { force: true });
  return true;
}
