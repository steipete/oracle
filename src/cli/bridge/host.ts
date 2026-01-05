import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import { getOracleHomeDir } from '../../oracleHome.js';
import { parseHostPort, normalizeHostPort, formatBridgeConnectionString } from '../../bridge/connection.js';
import type { BridgeConnectionArtifact } from '../../bridge/connection.js';
import { serveRemote } from '../../remote/server.js';

export interface BridgeHostCliOptions {
  bind?: string;
  token?: string;
  writeConnection?: string;
  ssh?: string;
  sshRemotePort?: number;
  sshIdentity?: string;
  sshExtraArgs?: string;
  background?: boolean;
  foreground?: boolean;
  print?: boolean;
  printToken?: boolean;
}

interface ReverseTunnelHandle {
  stop: () => void;
}

export async function runBridgeHost(options: BridgeHostCliOptions): Promise<void> {
  const bindRaw = options.bind?.trim() || '127.0.0.1:9473';
  const { hostname: bindHost, port: bindPort } = parseHostPort(bindRaw);

  const tokenRaw = options.token?.trim() || 'auto';
  const token = tokenRaw === 'auto' ? randomBytes(16).toString('hex') : tokenRaw;
  if (!token.trim()) {
    throw new Error('Token is required (use --token auto to generate one).');
  }

  const writeConnectionPath =
    options.writeConnection?.trim() || path.join(getOracleHomeDir(), 'bridge-connection.json');

  const sshTarget = options.ssh?.trim();
  const sshRemotePort = typeof options.sshRemotePort === 'number' ? options.sshRemotePort : bindPort;
  if (sshRemotePort <= 0 || sshRemotePort > 65_535) {
    throw new Error(`Invalid --ssh-remote-port: ${sshRemotePort}. Expected 1-65535.`);
  }

  const connectionHostForClient = sshTarget ? normalizeHostPort('127.0.0.1', sshRemotePort) : normalizeHostPort(
    bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost,
    bindPort,
  );

  const artifact = await upsertConnectionArtifact(writeConnectionPath, {
    remoteHost: connectionHostForClient,
    remoteToken: token,
    tunnel: sshTarget
      ? {
          ssh: sshTarget,
          remotePort: sshRemotePort,
          localPort: bindPort,
          identity: options.sshIdentity?.trim() || undefined,
          extraArgs: options.sshExtraArgs?.trim() || undefined,
        }
      : undefined,
  });

  if (options.printToken) {
    console.log(token);
  }
  if (options.print) {
    console.log(formatBridgeConnectionString({ remoteHost: artifact.remoteHost, remoteToken: token }, { includeToken: true }));
  }

  if (options.background) {
    await spawnBridgeHostInBackground({
      bind: bindRaw,
      token,
      writeConnectionPath,
      sshTarget,
      sshRemotePort,
      sshIdentity: options.sshIdentity?.trim(),
      sshExtraArgs: options.sshExtraArgs?.trim(),
    });
    return;
  }

  console.log(chalk.cyanBright('Bridge host starting...'));
  console.log(chalk.dim(`- Local bind: ${normalizeHostPort(bindHost, bindPort)}`));
  console.log(chalk.dim(`- Connection artifact: ${writeConnectionPath}`));
  console.log(chalk.dim(`- Client remoteHost: ${artifact.remoteHost}`));
  console.log(chalk.dim('Token stored in connection artifact (not printed). Use --print or --print-token if needed.'));

  let tunnel: ReverseTunnelHandle | null = null;
  if (sshTarget) {
    tunnel = startReverseTunnel({
      sshTarget,
      remotePort: sshRemotePort,
      localPort: bindPort,
      identity: options.sshIdentity?.trim() || undefined,
      extraArgs: options.sshExtraArgs?.trim() || undefined,
      log: (msg) => console.log(chalk.dim(msg)),
    });
    console.log(chalk.dim(`Reverse SSH tunnel active (remote 127.0.0.1:${sshRemotePort} -> local 127.0.0.1:${bindPort})`));
  }

  const filteredServeLogger = (message: string) => {
    if (message.includes('Access token:')) {
      return;
    }
    console.log(message);
  };

  try {
    await serveRemote({
      host: bindHost,
      port: bindPort,
      token,
      logger: filteredServeLogger,
    });
  } finally {
    tunnel?.stop();
  }
}

async function upsertConnectionArtifact(
  filePath: string,
  input: Pick<BridgeConnectionArtifact, 'remoteHost' | 'remoteToken' | 'tunnel'>,
): Promise<BridgeConnectionArtifact> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const now = new Date().toISOString();
  const existing = await fs.readFile(filePath, 'utf8').catch(() => null);
  let createdAt = now;
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { createdAt?: unknown };
      if (typeof parsed.createdAt === 'string' && parsed.createdAt.trim().length > 0) {
        createdAt = parsed.createdAt;
      }
    } catch {
      // ignore invalid previous content
    }
  }

  const artifact: BridgeConnectionArtifact = {
    remoteHost: input.remoteHost,
    remoteToken: input.remoteToken,
    createdAt,
    updatedAt: now,
    tunnel: input.tunnel,
  };

  const contents = `${JSON.stringify(artifact, null, 2)}\n`;
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  }
  return artifact;
}

function startReverseTunnel({
  sshTarget,
  remotePort,
  localPort,
  identity,
  extraArgs,
  log,
}: {
  sshTarget: string;
  remotePort: number;
  localPort: number;
  identity?: string;
  extraArgs?: string;
  log: (message: string) => void;
}): ReverseTunnelHandle {
  let stopped = false;
  let child: ChildProcess | null = null;
  let attempt = 0;
  let timer: NodeJS.Timeout | null = null;

  const spawnOnce = () => {
    if (stopped) return;
    const args: string[] = [
      '-N',
      '-R',
      `${remotePort}:127.0.0.1:${localPort}`,
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
    ];
    if (identity) {
      args.push('-i', identity);
    }
    if (extraArgs) {
      args.push(...splitArgs(extraArgs));
    }
    args.push(sshTarget);

    child = spawn('ssh', args, { stdio: 'ignore' });
    const pid = child.pid;
    log(`[bridge host] ssh tunnel started${pid ? ` (pid ${pid})` : ''}: ${sshTarget}`);

    child.once('exit', (code, signal) => {
      child = null;
      if (stopped) return;
      const label = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
      attempt += 1;
      log(`[bridge host] ssh tunnel exited (${label}); restarting in ${delayMs}ms`);
      timer = setTimeout(spawnOnce, delayMs);
      timer.unref?.();
    });
  };

  spawnOnce();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (child) {
        child.removeAllListeners();
        child.kill();
        child = null;
      }
    },
  };
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed.length) args.push(trimmed);
    current = '';
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? '';
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return args;
}

async function spawnBridgeHostInBackground({
  bind,
  token,
  writeConnectionPath,
  sshTarget,
  sshRemotePort,
  sshIdentity,
  sshExtraArgs,
}: {
  bind: string;
  token: string;
  writeConnectionPath: string;
  sshTarget?: string;
  sshRemotePort?: number;
  sshIdentity?: string;
  sshExtraArgs?: string;
}): Promise<void> {
  const oracleHome = getOracleHomeDir();
  await fs.mkdir(oracleHome, { recursive: true, mode: 0o700 });
  const logPath = path.join(oracleHome, 'bridge-host.log');
  const pidPath = path.join(oracleHome, 'bridge-host.pid');

  const logHandle = await fs.open(logPath, 'a');
  const stdio: Array<'ignore' | number> = ['ignore', logHandle.fd, logHandle.fd];

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('Unable to determine CLI entrypoint for background mode.');
  }
  const args: string[] = [
    scriptPath,
    'bridge',
    'host',
    '--foreground',
    '--bind',
    bind,
    '--token',
    token,
    '--write-connection',
    writeConnectionPath,
  ];
  if (sshTarget) {
    args.push('--ssh', sshTarget);
  }
  if (typeof sshRemotePort === 'number') {
    args.push('--ssh-remote-port', String(sshRemotePort));
  }
  if (sshIdentity) {
    args.push('--ssh-identity', sshIdentity);
  }
  if (sshExtraArgs) {
    args.push('--ssh-extra-args', sshExtraArgs);
  }

  const child = spawn(process.execPath, args, { detached: true, stdio });
  child.unref();
  await fs.writeFile(pidPath, `${child.pid ?? ''}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await fs.chmod(pidPath, 0o600).catch(() => undefined);
  }
  await logHandle.close();

  console.log(chalk.green(`Bridge host running in background (pid ${child.pid ?? '?'})`));
  console.log(chalk.dim(`- Log: ${logPath}`));
  console.log(chalk.dim(`- PID: ${pidPath}`));
}
