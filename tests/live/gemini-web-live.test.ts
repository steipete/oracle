import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createGeminiWebExecutor } from '../../src/gemini-web/executor.js';
import type { ChromeCookiesSecureModule } from '../../src/browser/types.js';

const live = process.env.ORACLE_LIVE_TEST === '1';

async function assertHasGeminiChromeCookies(): Promise<void> {
  const mod = (await import('chrome-cookies-secure')) as unknown;
  const chromeCookies = (mod as { default?: unknown }).default ?? mod;

  const cookies = (await (chromeCookies as ChromeCookiesSecureModule).getCookiesPromised(
    'https://gemini.google.com',
    'puppeteer',
  )) as Array<{ name: string; value: string }>;

  const map = new Map(cookies.map((c) => [c.name, c.value]));
  if (!map.get('__Secure-1PSID') || !map.get('__Secure-1PSIDTS')) {
    throw new Error(
      'Gemini web live tests require signed-in Chrome cookies for google.com (missing __Secure-1PSID/__Secure-1PSIDTS). Open Chrome, sign into gemini.google.com, then retry.',
    );
  }
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

(live ? describe : describe.skip)('Gemini web (cookie) live smoke', () => {
  it('generate-image writes an output file', async () => {
    await assertHasGeminiChromeCookies();

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-gemini-web-live-'));
    const outputPath = path.join(tempDir, 'generated.jpg');

    const exec = createGeminiWebExecutor({
      generateImage: outputPath,
      aspectRatio: '1:1',
    });

    await exec({
      prompt: 'a cute robot holding a banana',
      config: { chromeProfile: 'Default', desiredModel: 'Gemini 3 Pro' },
      log: () => {},
    });

    const bytes = new Uint8Array(await readFile(outputPath));
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(looksLikeJpeg(bytes)).toBe(true);
  }, 180_000);

  it('edit-image writes an output file', async () => {
    await assertHasGeminiChromeCookies();

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-gemini-web-live-'));
    const inputPath = path.join(tempDir, 'input.png');
    const outputPath = path.join(tempDir, 'edited.jpg');

    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/Pm2zXwAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(inputPath, png);

    const exec = createGeminiWebExecutor({
      editImage: inputPath,
      outputPath,
    });

    await exec({
      prompt: 'add sunglasses',
      config: { chromeProfile: 'Default', desiredModel: 'Gemini 3 Pro' },
      log: () => {},
    });

    const bytes = new Uint8Array(await readFile(outputPath));
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(looksLikeJpeg(bytes)).toBe(true);
  }, 240_000);
});
