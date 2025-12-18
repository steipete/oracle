import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { getCliVersion } from '../../src/version.js';

const execFileAsync = promisify(execFile);

describe('oracle --version', () => {
  test('prints the package.json version', async () => {
    const cliEntrypoint = path.join(process.cwd(), 'bin', 'oracle-cli.ts');
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', 'tsx', cliEntrypoint, '--version'], {
      // biome-ignore lint/style/useNamingConvention: environment variable name
      env: { ...process.env, FORCE_COLOR: '0', ORACLE_DISABLE_KEYTAR: '1' },
    });
    const output = (stdout.trim() || stderr.trim()).trim();
    expect(output).toBe(getCliVersion());
  }, 30000);
});
