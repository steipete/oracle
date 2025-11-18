import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { once } from 'node:events';

function startOracleMcp(): { proc: ReturnType<typeof spawn>; waitReady: () => Promise<void> } {
  const entry = path.join(process.cwd(), 'dist/bin/oracle-mcp.js');
  const proc = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waitReady = async () => {
    // Give the stdio transport a moment to attach; MCP stdio has no explicit ready signal.
    await new Promise((resolve) => setTimeout(resolve, 200));
  };
  return { proc, waitReady };
}

describe('oracle-mcp stdio smoke', () => {
  let proc: ReturnType<typeof spawn>;

  beforeAll(async () => {
    // @ts-expect-error built artifact has no d.ts
    await import('../dist/bin/oracle-mcp.js'); // ensure built artifacts exist
    const started = startOracleMcp();
    proc = started.proc;
    await started.waitReady();
  }, 10_000);

  afterAll(async () => {
    if (proc) {
      const exitPromise = once(proc, 'exit');
      proc.kill('SIGTERM');
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  });

  it('exposes stdio (process stays alive)', () => {
    expect(proc.killed).toBe(false);
    expect(proc.pid).toBeDefined();
  });
});
