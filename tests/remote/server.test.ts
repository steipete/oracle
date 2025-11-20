import { describe, expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createRemoteServer } from '../../src/remote/server.js';
import { createRemoteBrowserExecutor } from '../../src/remote/client.js';
import type { BrowserRunResult } from '../../src/browserMode.js';

describe('remote browser service', () => {
  test('streams logs and returns results via client executor', async () => {
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

    await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
