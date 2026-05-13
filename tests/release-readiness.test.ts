import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const RELEASE_READINESS_GATES = [
  "format:check",
  "typecheck",
  "test",
  "test:v18-conformance",
] as const;

describe("v18 release readiness gate wiring", () => {
  test("package script fails closed for every required gate category", async () => {
    const script = await releaseReadinessScript();

    expect(script).not.toMatch(/\|\|\s*true|continue-on-error/i);
    expect(parseGateChain(script)).toEqual(RELEASE_READINESS_GATES);
    for (const gate of RELEASE_READINESS_GATES) {
      expect(simulateGateChain(script, gate)).toBe(1);
    }
    expect(simulateGateChain(script, null)).toBe(0);
  });

  test("GitHub Actions workflow runs the release readiness script as an enforcing job", async () => {
    const workflow = await readFile(
      path.join(process.cwd(), ".github", "workflows", "v18-readiness.yml"),
      "utf8",
    );

    expect(workflow).toContain("name: v18 release readiness");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("release-readiness:");
    expect(workflow).toContain("run: pnpm run release:readiness");
    expect(workflow).not.toMatch(/continue-on-error:\s*true/i);
    expect(workflow).not.toMatch(/pnpm run release:readiness\s*\|\|\s*true/);
  });
});

async function releaseReadinessScript(): Promise<string> {
  const raw = await readFile(path.join(process.cwd(), "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
  const script = parsed.scripts?.["release:readiness"];
  expect(script).toBeTruthy();
  return script as string;
}

function parseGateChain(script: string): string[] {
  return script.split(/\s+&&\s+/).map((command) => {
    const match = command.match(/^pnpm run ([\w:-]+)$/);
    expect(match, `unexpected release gate command: ${command}`).not.toBeNull();
    return match![1];
  });
}

function simulateGateChain(script: string, failingGate: string | null): number {
  for (const gate of parseGateChain(script)) {
    if (gate === failingGate) {
      return 1;
    }
  }
  return 0;
}
