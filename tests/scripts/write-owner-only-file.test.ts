import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

// Proof helper lives beside the cookie exporter as plain ESM (.mjs).
// @ts-expect-error -- no ambient types for scripts/*.mjs
const { writeOwnerOnlyFile } = (await import("../../scripts/write-owner-only-file.mjs")) as {
  writeOwnerOnlyFile: (filePath: string, contents: string) => void;
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oracle-owner-only-"));
  tempDirs.push(dir);
  return dir;
}

describe("writeOwnerOnlyFile", () => {
  test("creates a new file with owner-only 0600 permissions", () => {
    if (process.platform === "win32") return;

    const filePath = path.join(makeTempDir(), "cookies-new.json");
    writeOwnerOnlyFile(filePath, JSON.stringify([{ name: "demo", value: "x" }]));

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual([{ name: "demo", value: "x" }]);
  });

  test("repairs permissive mode bits when overwriting an existing file", () => {
    if (process.platform === "win32") return;

    const filePath = path.join(makeTempDir(), "cookies-existing.json");
    writeFileSync(filePath, "[]", { mode: 0o644 });
    chmodSync(filePath, 0o644);
    expect(statSync(filePath).mode & 0o777).toBe(0o644);

    writeOwnerOnlyFile(filePath, JSON.stringify([{ name: "session", value: "secret" }]));

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual([{ name: "session", value: "secret" }]);
  });
});
