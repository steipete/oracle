import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

async function callResource(proc: ReturnType<typeof spawn>, method: string, id: number, params: object) {
  if (!proc.stdin || !proc.stdout) {
    throw new Error('stdio unavailable');
  }
  // Simple one-request/one-response framing over stdio JSON-RPC.
  const req = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
  proc.stdin.write(req);
  const [data] = (await once(proc.stdout, 'data')) as [Buffer];
  const parsed = JSON.parse(data.toString());
  return parsed;
}

describe('oracle-session resources via stdio', () => {
  let proc: ReturnType<typeof spawn>;

  beforeAll(async () => {
    const entry = path.join(process.cwd(), 'dist/bin/oracle-mcp.js');
    proc = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve) => setTimeout(resolve, 200)); // give stdio transport time
  }, 10_000);

  afterAll(async () => {
    if (proc) {
      proc.kill('SIGTERM');
      await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 500))]);
    }
  });

  it('responds to resource/read (metadata)', async () => {
    const res = await callResource(proc, 'resource/read', 1, { uri: 'oracle-session://nonexistent/metadata' });
    expect(res.error?.message || res.result?.contents).toBeDefined();
  });
});
