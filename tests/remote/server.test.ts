import { describe, expect, test } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createRemoteServer } from '../../src/remote/server.js';
import { createRemoteBrowserExecutor } from '../../src/remote/client.js';
import type { BrowserRunResult } from '../../src/browserMode.js';

const CAN_LISTEN_LOCALHOST = spawnSync(
  process.execPath,
  [
    '-e',
    `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
  ],
  { stdio: 'ignore' },
).status === 0;

describe('remote browser service', () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)('streams logs and returns results via client executor', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-remote-test-'));
    const attachmentPath = path.join(tmpDir, 'note.txt');
    await writeFile(attachmentPath, 'hello world', 'utf8');

    const runLog: string[] = [];
    const server = await createRemoteServer(
      { host: '127.0.0.1', port: 0, token: 'secret', logger: () => {} },
      {
        runBrowser: async (options) => {
          runLog.push(options.prompt);
          expect(options.attachments).toHaveLength(1);
          const attachment = options.attachments?.[0];
          if (!attachment) {
            throw new Error('missing attachment');
          }
          const stored = await readFile(attachment.path, 'utf8');
          expect(stored).toBe('hello world');
          options.log?.('uploading attachment');
          const result: BrowserRunResult = {
            answerText: 'hi',
            answerMarkdown: 'hi',
            tookMs: 1000,
            answerTokens: 42,
            answerChars: 2,
          };
          return result;
        },
      },
    );

    const executor = createRemoteBrowserExecutor({ host: `127.0.0.1:${server.port}`, token: 'secret' });
    const clientLogs: string[] = [];
    const result = await executor({
      prompt: 'remote',
      attachments: [{ path: attachmentPath, displayPath: 'note.txt', sizeBytes: 11 }],
      config: {},
      log: (message?: string) => {
        if (message) clientLogs.push(message);
      },
    });

    expect(clientLogs.some((entry) => entry.includes('uploading attachment'))).toBe(true);
    expect(result.answerText).toBe('hi');
    expect(runLog).toEqual(['remote']);

    const healthUnauthorized = await httpGetJson({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/health',
    });
    expect(healthUnauthorized.statusCode).toBe(401);

    const healthOk = await httpGetJson({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/health',
      token: 'secret',
    });
    expect(healthOk.statusCode).toBe(200);
    expect(healthOk.json?.ok).toBe(true);
    expect(typeof healthOk.json?.version).toBe('string');

    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

async function httpGetJson({
  hostname,
  port,
  path,
  token,
}: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
}): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path,
        method: 'GET',
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          let json: Record<string, unknown> | null = null;
          try {
            const parsed = body.length ? JSON.parse(body) : null;
            json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
