import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

let oracleHomeDirOverride: string | null = null;

/**
 * Test-only hook: avoid mutating process.env (shared across Vitest worker threads).
 * This override is scoped to the current Node worker.
 */
export function setOracleHomeDirOverrideForTest(dir: string | null): void {
  oracleHomeDirOverride = dir;
}

function normalizeOracleHomeDir(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

export function getOracleHomeDir(): string {
  return (
    normalizeOracleHomeDir(oracleHomeDirOverride) ??
    normalizeOracleHomeDir(process.env.ORACLE_HOME_DIR) ??
    path.join(os.homedir(), ".oracle")
  );
}

export async function ensureOracleHomeDir(): Promise<string> {
  const dir = getOracleHomeDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }
  return dir;
}
