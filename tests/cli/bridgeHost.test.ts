import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveBridgeHostToken } from "../../src/cli/bridge/host.js";

let dir: string;
let artifact: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-"));
  artifact = path.join(dir, "bridge-connection.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedArtifact(token: string): Promise<void> {
  await writeFile(artifact, JSON.stringify({ remoteHost: "127.0.0.1:9473", remoteToken: token }));
}

describe("resolveBridgeHostToken", () => {
  test("uses the explicit token when provided", async () => {
    await seedArtifact("artifact-token");
    expect(await resolveBridgeHostToken("explicit-token", true, artifact)).toBe("explicit-token");
  });

  test("explicit --token auto generates a fresh token even on the respawn path", async () => {
    await seedArtifact("artifact-token");
    const generated = await resolveBridgeHostToken("auto", true, artifact);
    expect(generated).not.toBe("artifact-token");
    expect(generated).toMatch(/^[0-9a-f]{32}$/);
  });

  test("auto regenerates on each call", async () => {
    const a = await resolveBridgeHostToken("auto", false, artifact);
    const b = await resolveBridgeHostToken("auto", false, artifact);
    expect(a).not.toBe(b);
  });

  test("the internal --respawn child reuses the artifact token", async () => {
    await seedArtifact("handoff-token");
    expect(await resolveBridgeHostToken(undefined, true, artifact)).toBe("handoff-token");
  });

  test("respawn generates a fresh token when the artifact is missing or invalid", async () => {
    expect(await resolveBridgeHostToken(undefined, true, artifact)).toMatch(/^[0-9a-f]{32}$/);
    await writeFile(artifact, "not json");
    expect(await resolveBridgeHostToken(undefined, true, artifact)).toMatch(/^[0-9a-f]{32}$/);
    await writeFile(artifact, JSON.stringify({ remoteToken: "  " }));
    expect(await resolveBridgeHostToken(undefined, true, artifact)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an ordinary restart rotates the credential even when an artifact exists", async () => {
    await seedArtifact("previous-run-token");
    const generated = await resolveBridgeHostToken(undefined, false, artifact);
    expect(generated).not.toBe("previous-run-token");
    expect(generated).toMatch(/^[0-9a-f]{32}$/);
  });
});
