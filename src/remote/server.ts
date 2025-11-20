import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import chalk from 'chalk';
import type { BrowserAttachment, BrowserLogger, CookieParam } from '../browser/types.js';
import { runBrowserMode } from '../browserMode.js';
import type { BrowserRunResult } from '../browserMode.js';
import type { RemoteRunPayload, RemoteRunEvent } from './types.js';
import { loadChromeCookies } from '../browser/chromeCookies.js';
import { CHATGPT_URL } from '../browser/constants.js';
import { normalizeChatgptUrl } from '../browser/utils.js';

export interface RemoteServerOptions {
  host?: string;
  port?: number;
  token?: string;
  logger?: (message: string) => void;
}

interface RemoteServerDeps {
  runBrowser?: typeof runBrowserMode;
}

interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
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
  const eye = '🧿';
  // Single-flight guard: remote Chrome can only host one run at a time, so we serialize requests.
  let busy = false;
  let cachedInlineCookies: CookieParam[] | null = null;

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
    // biome-ignore lint/nursery/noUnnecessaryConditions: busy guard protects single-run host
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

      // Refresh cookies if we don't have any cached yet
      const targetUrl = payload?.browserConfig?.url ?? CHATGPT_URL;
      const hostCookies = cachedInlineCookies?.length
        ? cachedInlineCookies
        : await loadLocalChatgptCookies(logger, targetUrl);
      if (hostCookies && hostCookies.length > 0 && payload.browserConfig) {
        cachedInlineCookies = hostCookies;
        payload.browserConfig.inlineCookies = hostCookies;
        payload.browserConfig.inlineCookiesSource = 'remote-host';
        payload.browserConfig.cookieSync = true;
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
  logger(color(chalk.cyanBright.bold, `${eye} Remote Oracle listening at ${primary}${extras.length ? ` [${extras.join(', ')}]` : ''}`));
  logger(color(chalk.yellowBright, `Access token: ${authToken}`));

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
  const server = await createRemoteServer(options);
  // Warm-up: check if we already have local ChatGPT cookies; if not, open login prompt and leave it open.
  const cookies = await loadLocalChatgptCookies(console.log, CHATGPT_URL);
  if (cookies?.length) {
    console.log(`🧿 Detected ${cookies.length} ChatGPT cookies on this host; runs should stay signed in.`);
  } else {
    console.log('🧿 No ChatGPT cookies detected; opened chatgpt.com for login. Sign in once, leave the window open, then rerun.');
  }
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

async function loadLocalChatgptCookies(logger: (message: string) => void, targetUrl: string): Promise<CookieParam[] | null> {
  try {
    logger('Loading ChatGPT cookies from this host\'s Chrome profile...');
    const cookies = await Promise.resolve(
      loadChromeCookies({
        targetUrl,
        profile: 'Default',
      }),
    ).catch((error) => {
      logger(`Unable to load local ChatGPT cookies on this host: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    if (!cookies || cookies.length === 0) {
      logger('No local ChatGPT cookies found on this host. Please log in once; opening ChatGPT...');
      triggerLocalLoginPrompt(logger, targetUrl);
      return null;
    }
    logger(`Loaded ${cookies.length} local ChatGPT cookies on this host.`);
    return cookies;
  } catch (error) {
    logger(`Unable to load local ChatGPT cookies on this host: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function triggerLocalLoginPrompt(logger: (message: string) => void, url: string): void {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  try {
    // Fire and forget; user completes login in the opened browser window.
    void import('node:child_process').then(({ spawn }) => {
      spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    });
    logger(`Opened ${url} locally. Please sign in; subsequent runs will reuse the session.`);
  } catch {
    logger(`Please open ${url} in this host's browser and sign in; then rerun.`);
  }
}
