import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { saveFirstGeminiImageFromOutput } from '../../src/gemini-web/client.js';

describe('gemini-web image download', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves cookies across redirects when downloading generated images', async () => {
    const calls: Array<{ url: string; cookie?: string }> = [];

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, cookie: headers?.cookie });

      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://work.fife.usercontent.google.com/rd-gg-dl/somewhere=s2048',
          },
        });
      }

      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-gemini-'));
    const outputPath = path.join(tempDir, 'generated.png');

    const output = {
      rawResponseText: '',
      text: '',
      thoughts: null,
      metadata: null,
      images: [
        {
          kind: 'generated' as const,
          url: 'https://lh3.googleusercontent.com/gg-dl/somewhere',
          title: '[Generated Image]',
          alt: '',
        },
      ],
    };

    const result = await saveFirstGeminiImageFromOutput(output, { a: 'b' }, outputPath);
    expect(result.saved).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1]?.cookie).toContain('a=b');
    expect(new Uint8Array(await readFile(outputPath))).toEqual(new Uint8Array([1, 2, 3]));
  });
});
