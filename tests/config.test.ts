import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadUserConfig } from '../src/config.js';

const ORIGINAL_HOME = process.env.ORACLE_HOME_DIR;

describe('loadUserConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-config-'));
    process.env.ORACLE_HOME_DIR = tempDir;
  });

  it('parses JSON5 config with comments', async () => {
    const configPath = path.join(tempDir, 'config.json');
    await fs.writeFile(
      configPath,
      `// comment\n{
        engine: "browser",
        notify: { sound: true },
        heartbeatSeconds: 15,
      }`,
      'utf8',
    );

    const result = await loadUserConfig();
    expect(result.loaded).toBe(true);
    expect(result.config.engine).toBe('browser');
    expect(result.config.notify?.sound).toBe(true);
    expect(result.config.heartbeatSeconds).toBe(15);
  });

  it('returns empty config when file is missing', async () => {
    const result = await loadUserConfig();
    expect(result.loaded).toBe(false);
    expect(result.config).toEqual({});
  });

  afterAll(() => {
    process.env.ORACLE_HOME_DIR = ORIGINAL_HOME;
  });
});
