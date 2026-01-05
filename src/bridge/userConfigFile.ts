import fs from 'node:fs/promises';
import path from 'node:path';
import JSON5 from 'json5';
import type { UserConfig } from '../config.js';

export async function readUserConfigFile(configPath: string): Promise<{ config: UserConfig; loaded: boolean }> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON5.parse(raw) as UserConfig;
    return { config: parsed ?? {}, loaded: true };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      return { config: {}, loaded: false };
    }
    throw new Error(`Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeUserConfigFile(configPath: string, config: UserConfig): Promise<void> {
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const contents = `${JSON.stringify(config, null, 2)}\n`;
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, configPath);
  if (process.platform !== 'win32') {
    await fs.chmod(configPath, 0o600).catch(() => undefined);
  }
}

