import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const TSX_BIN = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_ENTRY = path.join(process.cwd(), 'bin', 'oracle-cli.ts');

let ptyAvailable = process.platform !== 'linux';
// biome-ignore lint/suspicious/noExplicitAny: third-party module without types
let pty: any | null = null;
try {
  // Prefer the bundled multiarch build; fall back to the legacy package if needed.
  // biome-ignore lint/suspicious/noExplicitAny: third-party module without types
  const mod: any = await import('@cdktf/node-pty-prebuilt-multiarch').catch(() =>
    import('@homebridge/node-pty-prebuilt-multiarch')
  );
  pty = mod.default ?? mod;
} catch {
  ptyAvailable = false;
}

const ptyDescribe =
  process.platform === 'linux' ? describe.skip : ptyAvailable ? describe : describe.skip;

// biome-ignore lint/complexity/useRegexLiterals: constructor form avoids control-char lint noise.
const ansiRegex = new RegExp('\\x1B\\[[0-9;]*m', 'g');
const stripAnsi = (text: string): string => text.replace(ansiRegex, '');

async function runCliPty(args: string[]): Promise<{ output: string; code: number | null; signal: string | null }> {
  if (!ptyAvailable || !pty) {
    throw new Error('PTY not available in this environment');
  }

  const oracleHome = await mkdtemp(path.join(os.tmpdir(), 'oracle-pty-cli-'));
  const env = {
    ...process.env,
    // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
    OPENAI_API_KEY: 'sk-pty',
    // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
    ORACLE_HOME_DIR: oracleHome,
    // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
    ORACLE_NO_DETACH: '1',
    // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
    ORACLE_DISABLE_KEYTAR: '1',
    // Force color so we cover rich-TTY output path.
    // biome-ignore lint/style/useNamingConvention: env keys intentionally uppercase
    FORCE_COLOR: '1',
  } satisfies Record<string, string | undefined>;

  const ps = pty.spawn(process.execPath, [TSX_BIN, CLI_ENTRY, ...args], {
    cols: 120,
    rows: 30,
    env,
  });

  let output = '';
  ps.onData((data: string) => {
    output += data;
  });

  const exitPromise = once(ps, 'exit') as Promise<[number | null, number | null]>;
  const timeout = setTimeout(() => ps.kill(), 10_000);
  const [code, signal] = await exitPromise;
  clearTimeout(timeout);

  await rm(oracleHome, { recursive: true, force: true });

  return { output, code, signal: signal == null ? null : signal.toString() };
}

ptyDescribe('oracle CLI browser guard (PTY)', () => {
  it('fails fast when grok is paired with --engine browser', async () => {
    const { output, code } = await runCliPty([
      '--engine',
      'browser',
      '--model',
      'grok',
      '--prompt',
      'TTY guard prompt for grok browser path',
    ]);
    expect(code).not.toBe(0);
    expect(stripAnsi(output)).toMatch(/Browser engine only supports GPT and Gemini models/i);
  }, 15_000);

  it('fails fast when multi-model list includes non-GPT under browser engine', async () => {
    const { output, code } = await runCliPty([
      '--engine',
      'browser',
      '--models',
      'gpt-5.1,grok',
      '--prompt',
      'TTY guard prompt for mixed models',
    ]);
    expect(code).not.toBe(0);
    expect(stripAnsi(output)).toMatch(/Browser engine only supports GPT and Gemini models/i);
  }, 15_000);
});
