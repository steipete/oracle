import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { expect, test } from "vitest";

const run = promisify(execFile);

test("built MCP entrypoints preserve detached workers across caller lifecycle changes", async () => {
  const { stdout } = await run(
    process.execPath,
    [path.join(process.cwd(), "scripts/mcp-lifecycle-proof.mjs")],
    {
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const proof = JSON.parse(stdout);
  expect(proof.provider).toBe("local Chat Completions fixture");
  expect(proof.results).toHaveLength(6);
  for (const result of proof.results) {
    expect(result).toMatchObject({
      waitTimeout: true,
      cancellation: true,
      reconnect: true,
      completed: true,
      requests: 1,
    });
  }
}, 100_000);
