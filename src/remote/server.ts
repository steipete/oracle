import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import type { BrowserAttachment, BrowserLogger } from '../browser/types.js';
import { runBrowserMode } from '../browserMode.js';
import type { BrowserRunResult } from '../browserMode.js';
import type { RemoteRunPayload, RemoteRunEvent } from './types.js';
import { defaultProfileRoot } from '../browser/chromeCookies.js';
import { CHATGPT_URL } from '../browser/constants.js';
import { normalizeChatgptUrl } from '../browser/utils.js';

export interface RemoteServerOptions {
  host?: string;
  port?: number;
  token?: string;
  logger?: (message: string) => void;
  manualLoginDefault?: boolean;
  manualLoginProfileDir?: string;
}

interface RemoteServerDeps {
  runBrowser?: typeof runBrowserMode;
}

interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', (err) => reject(err));
    srv.listen(0, () => {
      const address = srv.address();
      if (typeof address === 'object' && address?.port) {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Unable to allocate port')));
      }
    });
  });
}

export async function createRemoteServer(
  options: RemoteServerOptions = {},
  deps: RemoteServerDeps = {},
): Promise<RemoteServerInstance> {
  const runBrowser = deps.runBrowser ?? runBrowserMode;
  const server = http.createServer();
  const logger = options.logger ?? console.log;
  const authToken = options.token ?? randomBytes(16).toString('hex');
  const verbose = process.argv.includes('--verbose') || process.env.ORACLE_SERVE_VERBOSE === '1';
  const color = process.stdout.isTTY
    ? (formatter: (msg: string) => string, msg: string) => formatter(msg)
    : (_formatter: (msg: string) => string, msg: string) => msg;
  // Single-flight guard: remote Chrome can only host one run at a time, so we serialize requests.
  let busy = false;

  if (!process.listenerCount('unhandledRejection')) {
    process.on('unhandledRejection', (reason) => {
      logger(`Unhandled promise rejection in remote server: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
  }

  server.on('request', async (req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      logger('[serve] Health check /status');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/runs') {
      res.statusCode = 404;
      res.end();
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    if (authHeader !== `Bearer ${authToken}`) {
      if (verbose) {
        logger(`[serve] Unauthorized /runs attempt from ${formatSocket(req)} (missing/invalid token)`);
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (busy) {
      if (verbose) {
        logger(`[serve] Busy: rejecting new run from ${formatSocket(req)} while another run is active`);
      }
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'busy' }));
      return;
    }
    busy = true;
    const runStartedAt = Date.now();

    let payload: RemoteRunPayload | null = null;
    try {
      const body = await readRequestBody(req);
      payload = JSON.parse(body) as RemoteRunPayload;
      if (payload?.browserConfig) {
        payload.browserConfig.url = normalizeChatgptUrl(payload.browserConfig.url, CHATGPT_URL);
      }
    } catch (_error) {
      busy = false;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

    const runId = randomUUID();
    logger(`[serve] Accepted run ${runId} from ${formatSocket(req)} (prompt ${payload?.prompt?.length ?? 0} chars)`);
    // Each run gets an isolated temp dir so attachments/logs don't collide.
    const runDir = await mkdtemp(path.join(os.tmpdir(), `oracle-serve-${runId}-`));
    const attachmentDir = path.join(runDir, 'attachments');
    await mkdir(attachmentDir, { recursive: true });

    const sendEvent = (event: RemoteRunEvent) => {
      res.write(`${JSON.stringify(event)}\n`);
    };

    const attachments: BrowserAttachment[] = [];
    try {
      const attachmentsPayload = Array.isArray(payload.attachments) ? payload.attachments : [];
      for (const [index, attachment] of attachmentsPayload.entries()) {
        const safeName = sanitizeName(attachment.fileName ?? `attachment-${index + 1}`);
        const filePath = path.join(attachmentDir, safeName);
        await writeFile(filePath, Buffer.from(attachment.contentBase64, 'base64'));
        attachments.push({
          path: filePath,
          displayPath: attachment.displayPath,
          sizeBytes: attachment.sizeBytes,
        });
      }

      // Reuse the existing browser logger surface so clients see the same log stream.
      const automationLogger: BrowserLogger = ((message?: string) => {
        if (typeof message === 'string') {
          sendEvent({ type: 'log', message });
        }
      }) as BrowserLogger;
      automationLogger.verbose = Boolean(payload.options.verbose);

      // Remote runs always rely on the host's own Chrome profile; ignore any inline cookie transfer.
      if (payload.browserConfig) {
        payload.browserConfig.inlineCookies = null;
        payload.browserConfig.inlineCookiesSource = null;
        payload.browserConfig.cookieSync = true;
      } else {
        payload.browserConfig = {} as typeof payload.browserConfig;
      }

      // Enforce manual-login profile when cookie sync is unavailable (e.g., Windows/WSL).
      if (options.manualLoginDefault) {
        payload.browserConfig.manualLogin = true;
        payload.browserConfig.manualLoginProfileDir = options.manualLoginProfileDir;
        payload.browserConfig.keepBrowser = true;
        if (verbose) {
          logger(
            `[serve] Enforcing manual-login profile at ${options.manualLoginProfileDir ?? 'default'} for remote run ${runId}`,
          );
        }
      }

      const result = await runBrowser({
        prompt: payload.prompt,
        attachments,
        config: payload.browserConfig,
        log: automationLogger,
        heartbeatIntervalMs: payload.options.heartbeatIntervalMs,
        verbose: payload.options.verbose,
      });

      sendEvent({ type: 'result', result: sanitizeResult(result) });
      logger(`[serve] Run ${runId} completed in ${Date.now() - runStartedAt}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendEvent({ type: 'error', message });
      logger(`[serve] Run ${runId} failed after ${Date.now() - runStartedAt}ms: ${message}`);
    } finally {
      busy = false;
      res.end();
      try {
        await rm(runDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine server address.');
  }
  const reachable = formatReachableAddresses(address.address, address.port);
  const primary = reachable[0] ?? `${address.address}:${address.port}`;
  const extras = reachable.slice(1);
  const also = extras.length ? `, also [${extras.join(', ')}]` : '';
  logger(color(chalk.cyanBright.bold, `Listening at ${primary}${also}`));
  logger(color(chalk.yellowBright, `Access token: ${authToken}`));
  logger('Leave this terminal running; press Ctrl+C to stop oracle serve.');

  return {
    port: address.port,
    token: authToken,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function serveRemote(options: RemoteServerOptions = {}): Promise<void> {
  const manualProfileDir = options.manualLoginProfileDir ?? path.join(os.homedir(), '.oracle', 'browser-profile');
  const preferManualLogin = options.manualLoginDefault ?? false;

  if (isWsl() && process.env.ORACLE_ALLOW_WSL_SERVE !== '1') {
    console.log('WSL detected. For reliable browser automation, run `oracle serve` from Windows PowerShell/Command Prompt so we can use your Windows Chrome profile.');
    console.log('If you want to stay in WSL anyway, set ORACLE_ALLOW_WSL_SERVE=1 and ensure a Linux Chrome is installed, then rerun.');
    console.log('Alternatively, start Windows Chrome with --remote-debugging-port=9222 and use `--remote-chrome <windows-ip>:9222`.');
    return;
  }

  if (preferManualLogin) {
    await mkdir(manualProfileDir, { recursive: true });
    console.log(
      `Manual-login mode enabled. Remote runs will reuse ${manualProfileDir}; sign in once when the browser opens.`,
    );
    const devtoolsPortFile = path.join(manualProfileDir, 'DevToolsActivePort');
    const alreadyRunning = existsSync(devtoolsPortFile);
    if (alreadyRunning) {
      console.log('Detected an existing automation Chrome session; will reuse it for manual login.');
    } else {
      void launchManualLoginChrome(manualProfileDir, CHATGPT_URL, console.log);
    }
  } else {
    try {
      const base = await defaultProfileRoot();
      const defaultProfile = path.join(base, 'Default');
      console.log(
        `Remote runs will sync your Chrome profile from ${defaultProfile}. Make sure you are signed into ChatGPT there.`,
      );
    } catch {
      console.log('Remote runs will try to sync your default Chrome profile. Ensure ChatGPT is signed in, or rerun with --manual-login.');
    }
  }

  const server = await createRemoteServer({
    ...options,
    manualLoginDefault: preferManualLogin,
    manualLoginProfileDir: manualProfileDir,
  });
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log('Shutting down remote service...');
      server
        .close()
        .catch((error) => console.error('Failed to close remote server:', error))
        .finally(() => resolve());
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sanitizeResult(result: BrowserRunResult): BrowserRunResult {
  return {
    answerText: result.answerText,
    answerMarkdown: result.answerMarkdown,
    answerHtml: result.answerHtml,
    tookMs: result.tookMs,
    answerTokens: result.answerTokens,
    answerChars: result.answerChars,
    chromePid: undefined,
    chromePort: undefined,
    userDataDir: undefined,
  };
}

function formatSocket(req: http.IncomingMessage): string {
  const socket = req.socket;
  const host = socket.remoteAddress ?? 'unknown';
  const port = socket.remotePort ?? '0';
  return `${host}:${port}`;
}

function formatReachableAddresses(bindAddress: string, port: number): string[] {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  if (bindAddress && bindAddress !== '::' && bindAddress !== '0.0.0.0') {
    if (bindAddress.includes(':')) {
      ipv6.push(`[${bindAddress}]:${port}`);
    } else {
      ipv4.push(`${bindAddress}:${port}`);
    }
  }
  try {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        const iface = entry as { family?: string | number; address: string; internal?: boolean } | undefined;
        if (!iface || iface.internal) continue;
        const family = typeof iface.family === 'string' ? iface.family : iface.family === 4 ? 'IPv4' : iface.family === 6 ? 'IPv6' : '';
        if (family === 'IPv4') {
          const addr = iface.address;
          if (addr.startsWith('127.')) continue;
          if (addr.startsWith('169.254.')) continue; // APIPA/link-local
          ipv4.push(`${addr}:${port}`);
        } else if (family === 'IPv6') {
          const addr = iface.address.toLowerCase();
          if (addr === '::1' || addr.startsWith('fe80:')) continue; // loopback/link-local
          ipv6.push(`[${iface.address}]:${port}`);
        }
      }
    }
  } catch {
    // network interface probing can fail in locked-down environments; ignore
  }
  // de-dup
  return Array.from(new Set([...ipv4, ...ipv6]));
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  return Boolean(process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes('microsoft'));
}

async function launchManualLoginChrome(profileDir: string, url: string, logger: (msg: string) => void): Promise<void> {
  const timeoutMs = 7000;
  let finished = false;
  const timeout = setTimeout(() => {
    if (!finished) {
      logger(
        `Timed out launching Chrome for manual login. Launch Chrome manually with --user-data-dir=${profileDir} and log in to ${url}.`,
      );
    }
  }, timeoutMs);

  try {
    const chromeLauncher = await import('chrome-launcher');
    const { launch } = chromeLauncher;
    const debugPort = await findAvailablePort();
    logger(`Planned manual-login Chrome DevTools port: ${debugPort}`);
    const chrome = await launch({
      // Expose DevTools so later runs can attach instead of spawning a second Chrome.
      // Use a per-serve free port so the login window stays stable for all runs.
      port: debugPort,
      userDataDir: profileDir,
      startingUrl: url,
      chromeFlags: [
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        '--remote-allow-origins=*',
        `--remote-debugging-port=${debugPort}`, // ensure DevToolsActivePort is written even on Windows
      ],
    });

    const chosenPort = chrome?.port ?? debugPort ?? null;
    if (chosenPort) {
      // Write DevToolsActivePort eagerly so maybeReuseRunningChrome can attach on the next run
      const devtoolsFile = path.join(profileDir, 'DevToolsActivePort');
      const devtoolsFileDefault = path.join(profileDir, 'Default', 'DevToolsActivePort');
      const contents = `${chosenPort}\n/devtools/browser`;
      await writeFile(devtoolsFile, contents).catch(() => undefined);
      await writeFile(devtoolsFileDefault, contents).catch(() => undefined);
      logger(`Manual-login Chrome DevTools port: ${chosenPort}`);
      logger(`If needed, DevTools JSON at http://127.0.0.1:${chosenPort}/json/version`);
    } else {
      logger('Warning: unable to determine manual-login Chrome DevTools port. Remote runs may fail to attach.');
    }

    finished = true;
    clearTimeout(timeout);
    const portInfo = chosenPort ? ` (DevTools port ${chosenPort})` : '';
    logger(`Opened Chrome with manual-login profile at ${profileDir}${portInfo}. Complete login, then rerun remote sessions.`);
  } catch (error) {
    finished = true;
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Unable to open Chrome for manual login (${message}). Launch Chrome manually with --user-data-dir=${profileDir} and log in to ${url}.`,
    );
  }
}
