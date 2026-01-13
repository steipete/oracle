import http from 'node:http';
import net from 'node:net';
import { parseHostPort } from '../bridge/connection.js';

export interface RemoteHealthResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  version?: string;
  uptimeSeconds?: number;
}

export async function checkTcpConnection(host: string, timeoutMs = 2000): Promise<{ ok: boolean; error?: string }> {
  const { hostname, port } = parseHostPort(host);
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const onError = (err: Error) => {
      cleanup();
      resolve({ ok: false, error: err.message });
    };
    const onConnect = () => {
      cleanup();
      resolve({ ok: true });
    };
    const onTimeout = () => {
      cleanup();
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
    };
    const cleanup = () => {
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
      socket.unref();
    };
    socket.setTimeout(timeoutMs);
    socket.once('error', onError);
    socket.once('connect', onConnect);
    socket.once('timeout', onTimeout);
  });
}

export async function checkRemoteHealth({
  host,
  token,
  timeoutMs = 5000,
}: {
  host: string;
  token?: string;
  timeoutMs?: number;
}): Promise<RemoteHealthResult> {
  const { hostname, port } = parseHostPort(host);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  try {
    const response = await requestJson({
      hostname,
      port,
      path: '/health',
      headers,
      timeoutMs,
    });
    if (response.statusCode === 200 && typeof response.json === 'object' && response.json) {
      const ok = (response.json as { ok?: unknown }).ok === true;
      const version = (response.json as { version?: unknown }).version;
      const uptimeSeconds = (response.json as { uptimeSeconds?: unknown }).uptimeSeconds;
      return {
        ok,
        statusCode: response.statusCode,
        version: typeof version === 'string' ? version : undefined,
        uptimeSeconds: typeof uptimeSeconds === 'number' ? uptimeSeconds : undefined,
      };
    }
    if (response.statusCode === 404) {
      return {
        ok: false,
        statusCode: response.statusCode,
        error: 'remote host does not expose /health (upgrade oracle on the host and retry)',
      };
    }
    const error = extractErrorMessage(response.json, response.bodyText) ?? `HTTP ${response.statusCode}`;
    return { ok: false, statusCode: response.statusCode, error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function extractErrorMessage(json: unknown, bodyText: string): string | null {
  if (json && typeof json === 'object') {
    const err = (json as { error?: unknown }).error;
    if (typeof err === 'string' && err.trim().length > 0) {
      return err.trim();
    }
  }
  const trimmed = bodyText.trim();
  return trimmed.length ? trimmed : null;
}

async function requestJson({
  hostname,
  port,
  path,
  headers,
  timeoutMs,
}: {
  hostname: string;
  port: number;
  path: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<{ statusCode: number; json: unknown; bodyText: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          let json: unknown = null;
          try {
            json = body.length ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode, json, bodyText: body });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}
