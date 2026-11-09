import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { discoverDevToolsActivePortCandidates } from "../../src/browser/detect.js";

// @ts-expect-error -- no ambient types for scripts/*.mjs
const fixture = await import("../../scripts/serve-attach-fixture.mjs");
const { expectRefusal, fixtureEnvironment } = fixture as {
  expectRefusal: (child: ChildProcess, label: string, timeoutMs?: number) => Promise<string>;
  fixtureEnvironment: (home: string, inherited?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

afterEach(() => vi.unstubAllEnvs());

test("Windows discovery cannot escape the proof's home through inherited LOCALAPPDATA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-fixture-"));
  try {
    const inheritedAppData = path.join(root, "runner-app-data");
    const outsideProfile = path.join(inheritedAppData, "Unrelated", "Profile");
    await mkdir(outsideProfile, { recursive: true });
    await writeFile(
      path.join(outsideProfile, "DevToolsActivePort"),
      "9222\n/devtools/browser/outside\n",
    );
    const home = path.join(root, "proof-home");
    vi.stubEnv("LOCALAPPDATA", inheritedAppData);

    // A homedir override alone still scans the runner's application data on Windows.
    const leaked = await discoverDevToolsActivePortCandidates({ platform: "win32", homeDir: home });
    expect(leaked).toHaveLength(1);
    expect(leaked[0]?.profileRoot).toBe(outsideProfile);

    const env = fixtureEnvironment(home);
    vi.stubEnv("LOCALAPPDATA", env.LOCALAPPDATA);
    expect(
      await discoverDevToolsActivePortCandidates({ platform: "win32", homeDir: home }),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a synthetic refusal requires exit 1 and captures final output", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.stdout.write('SERVE_ATTACH_ROUTED'); process.stderr.write('final diagnostic'); process.exitCode = 1;",
  ]);
  const output = await expectRefusal(child, "fixture");
  expect(output).toContain("SERVE_ATTACH_ROUTED");
  expect(output).toContain("final diagnostic");
});

test("a successful child exit cannot satisfy a synthetic refusal", async () => {
  const child = spawn(process.execPath, ["-e", "process.exitCode = 0"]);
  await expect(expectRefusal(child, "fixture")).rejects.toThrow(
    "expected synthetic endpoint refusal",
  );
});

test("a hung child fails with an explicit timeout instead of a null refusal status", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await expect(expectRefusal(child, "fixture", 100)).rejects.toThrow(
    "fixture: timed out after 100ms",
  );
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});
