import os from 'node:os';
import chalk from 'chalk';
import { getCliVersion } from '../../version.js';
import { loadUserConfig } from '../../config.js';
import { resolveRemoteServiceConfig } from '../../remote/remoteServiceConfig.js';
import { checkTcpConnection, checkRemoteHealth } from '../../remote/health.js';
import { detectChromeBinary, detectChromeCookieDb } from '../../browser/detect.js';
import { formatCodexMcpSnippet } from './codexConfig.js';

export interface BridgeDoctorCliOptions {
  verbose?: boolean;
}

export async function runBridgeDoctor(_options: BridgeDoctorCliOptions): Promise<void> {
  const { config: userConfig, path: configPath, loaded } = await loadUserConfig();
  const version = getCliVersion();

  const resolvedRemote = resolveRemoteServiceConfig({
    cliHost: undefined,
    cliToken: undefined,
    userConfig,
    env: process.env,
  });

  const lines: string[] = [];
  const fail: string[] = [];
  const warn: string[] = [];

  lines.push(chalk.bold('Bridge doctor'));
  lines.push(chalk.dim(`OS: ${process.platform} ${os.release()} (${process.arch})`));
  lines.push(chalk.dim(`Node: ${process.version}`));
  lines.push(chalk.dim(`Oracle: ${version}`));
  lines.push(chalk.dim(`Config: ${loaded ? configPath : '(missing)'}`));
  if (userConfig.engine) {
    lines.push(chalk.dim(`Default engine: ${userConfig.engine}`));
  }
  if (userConfig.model) {
    lines.push(chalk.dim(`Default model: ${userConfig.model}`));
  }

  lines.push('');
  lines.push(chalk.bold('Browser mode'));

  if (resolvedRemote.host) {
    lines.push(`Remote service: ${chalk.green('configured')}`);
    lines.push(chalk.dim(`remoteHost: ${resolvedRemote.host} (${resolvedRemote.sources.host})`));
    lines.push(chalk.dim(`remoteToken: ${resolvedRemote.token ? 'set' : 'missing'} (${resolvedRemote.sources.token})`));

    const tcp = await checkTcpConnection(resolvedRemote.host, 2000);
    if (tcp.ok) {
      lines.push(chalk.dim(`TCP connect: ${chalk.green('ok')}`));
    } else {
      fail.push(`Cannot reach ${resolvedRemote.host} (${tcp.error ?? 'unknown error'}).`);
      lines.push(chalk.dim(`TCP connect: ${chalk.red(`failed (${tcp.error ?? 'unknown error'})`)}`));
    }

    if (!resolvedRemote.token) {
      fail.push('Remote token is missing. Run `oracle bridge client --connect <...> --write-config` or set ORACLE_REMOTE_TOKEN.');
    } else if (tcp.ok) {
      const health = await checkRemoteHealth({ host: resolvedRemote.host, token: resolvedRemote.token, timeoutMs: 5000 });
      if (health.ok) {
        const meta = health.version ? `oracle ${health.version}` : 'ok';
        lines.push(chalk.dim(`Auth (/health): ${chalk.green(meta)}`));
      } else {
        const detail = health.error ?? 'unknown error';
        fail.push(`Remote auth failed: ${detail}`);
        const suffix = health.statusCode ? `HTTP ${health.statusCode}` : 'network';
        lines.push(chalk.dim(`Auth (/health): ${chalk.red(`${suffix} (${detail})`)}`));
      }
    }
  } else {
    lines.push(`Remote service: ${chalk.yellow('not configured')}`);
    const chrome = await detectChromeBinary();
    if (chrome.path) {
      lines.push(chalk.dim(`Chrome: ${chalk.green(chrome.path)}`));
    } else {
      fail.push('No Chrome installation detected. Install Chrome/Chromium or set --browser-chrome-path.');
      lines.push(chalk.dim(`Chrome: ${chalk.red('not found')}`));
    }

    if (process.platform === 'win32') {
      warn.push('Cookie sync is disabled on Windows; use --browser-manual-login or run browser automation on another host.');
      lines.push(chalk.dim('Cookies: (cookie sync disabled on Windows)'));
    } else {
      const cookieDb = await detectChromeCookieDb({ profile: 'Default' });
      if (cookieDb) {
        lines.push(chalk.dim(`Cookies DB: ${chalk.green(cookieDb)}`));
      } else {
        warn.push('Chrome cookies DB not detected. You may need --browser-cookie-path or --browser-manual-login.');
        lines.push(chalk.dim(`Cookies DB: ${chalk.yellow('not found')}`));
      }
    }
  }

  lines.push('');
  lines.push(chalk.bold('Codex MCP'));
  lines.push(formatCodexMcpSnippet({ remoteHost: resolvedRemote.host, remoteToken: resolvedRemote.token, includeToken: false }));

  if (warn.length) {
    lines.push('');
    lines.push(chalk.yellowBright('Warnings:'));
    for (const message of warn) {
      lines.push(chalk.yellow(`- ${message}`));
    }
  }
  if (fail.length) {
    lines.push('');
    lines.push(chalk.redBright('Problems:'));
    for (const message of fail) {
      lines.push(chalk.red(`- ${message}`));
    }
  }

  console.log(lines.join('\n'));

  process.exitCode = fail.length ? 1 : 0;
}

