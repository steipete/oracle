import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { runGeminiWebOnce } from '../../src/gemini-web/client.js';

function makeRawResponseWithBody(body: unknown): string {
  const responseJson = [[null, null, JSON.stringify(body)]];
  return `)]}'\n\n${JSON.stringify(responseJson)}`;
}

describe('gemini-web uploads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends mime metadata for image and non-image uploads', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-gemini-upload-'));
    const imagePath = path.join(tempDir, 'input.png');
    const textPath = path.join(tempDir, 'notes.txt');
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/Pm2zXwAAAABJRU5ErkJggg==', 'base64'));
    await writeFile(textPath, 'hello from oracle', 'utf8');

    const uploadBodies: Array<{ name: string; type: string }> = [];
    let requestPayload: unknown[] | null = null;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === 'https://gemini.google.com/app') {
          return new Response('<html>"SNlM0e":"test-access-token"</html>', { status: 200 });
        }
        if (url === 'https://content-push.googleapis.com/upload') {
          const form = init?.body as FormData;
          const file = form.get('file');
          expect(file).toBeInstanceOf(Blob);
          uploadBodies.push({
            name: file instanceof File ? file.name : '',
            type: file instanceof Blob ? file.type : '',
          });
          return new Response(`upload-${uploadBodies.length}`, { status: 200 });
        }
        if (url.includes('/StreamGenerate')) {
          const params = new URLSearchParams(String(init?.body ?? ''));
          const fReq = params.get('f.req');
          expect(fReq).toBeTruthy();
          const outer = JSON.parse(fReq ?? '[]') as [unknown, string];
          requestPayload = JSON.parse(outer[1]) as unknown[];
          const candidate: unknown[] = [];
          candidate[0] = 'rcid-1';
          candidate[1] = ['Upload ok'];
          const body: unknown[] = [];
          body[1] = ['cid', 'rid', 'rcid-1'];
          body[4] = [candidate];
          return new Response(makeRawResponseWithBody(body), { status: 200 });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

    try {
      const result = await runGeminiWebOnce({
        prompt: 'Describe the attachments.',
        files: [imagePath, textPath],
        model: 'gemini-3-pro',
        cookieMap: { sid: 'cookie' },
      });

      expect(result.text).toBe('Upload ok');
      expect(uploadBodies).toEqual([
        { name: 'input.png', type: 'image/png' },
        { name: 'notes.txt', type: 'application/octet-stream' },
      ]);
      expect(requestPayload).toEqual([
        [
          'Describe the attachments.',
          0,
          null,
          [
            [['upload-1', 1, null, 'image/png'], 'input.png'],
            [['upload-2', 1, null, 'application/octet-stream'], 'notes.txt'],
          ],
        ],
        null,
        null,
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
