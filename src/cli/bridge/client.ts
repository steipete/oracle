import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { configPath as defaultConfigPath } from '../../config.js';
import type { UserConfig } from '../../config.js';
import {
  parseBridgeConnectionString,
  readBridgeConnectionArtifact,
  looksLikePath,
} from '../../bridge/connection.js';
import type { BridgeTunnelInfo } from '../../bridge/connection.js';
import { readUserConfigFile, writeUserConfigFile } from '../../bridge/userConfigFile.js';
import { checkRemoteHealth } from '../../remote/health.js';

export interface BridgeClientCliOptions {
  connect?: string;
  writeConfig?: boolean;
  config?: string;
  test?: boolean;
  printEnv?: boolean;
}

export async function runBridgeClient(options: BridgeClientCliOptions): Promise<void> {
  const connectRaw = options.connect?.trim();
  if (!connectRaw) {
    throw new Error('Missing --connect. Provide a connection string or a bridge-connection.json path.');
  }

  const { remoteHost, remoteToken, tunnel } = await resolveConnection(connectRaw);

  if (options.test !== false) {
    const health = await checkRemoteHealth({ host: remoteHost, token: remoteToken, timeoutMs: 5000 });
    if (!health.ok) {
      const suffix = health.statusCode ? ` (HTTP ${health.statusCode})` : '';
      throw new Error(`Remote service health check failed: ${health.error ?? 'unknown error'}${suffix}`);
    }
    console.log(chalk.green(`Remote service OK (${remoteHost})${health.version ? ` — oracle ${health.version}` : ''}`));
  }

  const configFilePath = options.config?.trim() || defaultConfigPath();
  if (options.writeConfig !== false) {
    const { config } = await readUserConfigFile(configFilePath);
    const next: UserConfig = { ...config, browser: { ...(config.browser ?? {}) } };
    next.browser = { ...(next.browser ?? {}) };
    next.browser.remoteHost = remoteHost;
    next.browser.remoteToken = remoteToken;
    if (tunnel) {
      next.browser.remoteViaSshReverseTunnel = {
        ssh: tunnel.ssh,
        remotePort: tunnel.remotePort,
        localPort: tunnel.localPort,
        identity: tunnel.identity,
        extraArgs: tunnel.extraArgs,
      };
    }
    await writeUserConfigFile(configFilePath, next);
    console.log(chalk.green(`Wrote remote config to ${configFilePath}`));
  }

  console.log('');
  console.log('Next:');
  console.log(chalk.dim(`- oracle --engine browser -p "hello" --file README.md`));

  if (options.printEnv) {
    console.log('');
    console.log('# Optional env overrides (paste into your shell):');
    console.log(`export ORACLE_ENGINE=browser`);
    console.log(`export ORACLE_REMOTE_HOST=${shellQuote(remoteHost)}`);
    console.log(`export ORACLE_REMOTE_TOKEN=${shellQuote(remoteToken)}`);
  }
}

async function resolveConnection(input: string): Promise<{ remoteHost: string; remoteToken: string; tunnel?: BridgeTunnelInfo }> {
  if (input.includes('://')) {
    return { ...parseBridgeConnectionString(input) };
  }

  const resolvedPath = looksLikePath(input) ? path.resolve(process.cwd(), input) : null;
  if (resolvedPath) {
    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (stat?.isFile()) {
      const artifact = await readBridgeConnectionArtifact(resolvedPath);
      return { remoteHost: artifact.remoteHost, remoteToken: artifact.remoteToken, tunnel: artifact.tunnel };
    }
    if (stat) {
      throw new Error(`--connect points to ${resolvedPath}, but it is not a file.`);
    }
    throw new Error(`Connection artifact not found at ${resolvedPath}`);
  }

  return { ...parseBridgeConnectionString(input) };
}

function shellQuote(value: string): string {
  // Single-quote for POSIX shells; safe for tokens/host strings.
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
