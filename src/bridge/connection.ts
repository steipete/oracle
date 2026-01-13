import fs from 'node:fs/promises';
import path from 'node:path';

export interface BridgeTunnelInfo {
  ssh?: string;
  remotePort?: number;
  localPort?: number;
  identity?: string;
  extraArgs?: string;
}

export interface BridgeConnectionArtifact {
  remoteHost: string;
  remoteToken: string;
  createdAt?: string;
  updatedAt?: string;
  tunnel?: BridgeTunnelInfo;
}

export function normalizeHostPort(hostname: string, port: number): string {
  const trimmed = hostname.trim();
  const unwrapped = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (unwrapped.includes(':')) {
    return `[${unwrapped}]:${port}`;
  }
  return `${unwrapped}:${port}`;
}

export function parseHostPort(raw: string): { hostname: string; port: number } {
  const target = raw.trim();
  if (!target) {
    throw new Error('Expected host:port but received an empty value.');
  }

  const ipv6Match = target.match(/^\[(.+)]:(\d+)$/);
  let hostname: string | undefined;
  let portSegment: string | undefined;
  if (ipv6Match) {
    hostname = ipv6Match[1]?.trim();
    portSegment = ipv6Match[2]?.trim();
  } else {
    const lastColon = target.lastIndexOf(':');
    if (lastColon === -1) {
      throw new Error(`Invalid host:port format: ${target}. Expected host:port (IPv6 must use [host]:port notation).`);
    }
    hostname = target.slice(0, lastColon).trim();
    portSegment = target.slice(lastColon + 1).trim();
    if (hostname.includes(':')) {
      throw new Error(`Invalid host:port format: ${target}. Wrap IPv6 addresses in brackets, e.g. "[2001:db8::1]:9473".`);
    }
  }

  if (!hostname) {
    throw new Error(`Invalid host:port format: ${target}. Host portion is missing.`);
  }
  const port = Number.parseInt(portSegment ?? '', 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port: "${portSegment ?? ''}". Expected a number between 1 and 65535.`);
  }

  return { hostname, port };
}

export function parseBridgeConnectionString(input: string): { remoteHost: string; remoteToken: string } {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Missing connection string.');
  }

  let url: URL;
  try {
    url = raw.includes('://') ? new URL(raw) : new URL(`oracle+tcp://${raw}`);
  } catch (error) {
    throw new Error(`Invalid connection string: ${error instanceof Error ? error.message : String(error)}`);
  }

  const hostname = url.hostname?.trim();
  const port = Number.parseInt(url.port ?? '', 10);
  if (!hostname || !Number.isFinite(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid connection string host: ${raw}. Expected host:port.`);
  }

  const token = url.searchParams.get('token')?.trim() ?? '';
  if (!token) {
    throw new Error('Connection string is missing token. Expected "?token=...".');
  }

  const remoteHost = normalizeHostPort(hostname, port);
  return { remoteHost, remoteToken: token };
}

export function formatBridgeConnectionString(
  connection: { remoteHost: string; remoteToken: string },
  options: { includeToken?: boolean } = {},
): string {
  const { hostname, port } = parseHostPort(connection.remoteHost);
  const base = `oracle+tcp://${normalizeHostPort(hostname, port)}`;
  if (!options.includeToken) {
    return base;
  }
  const params = new URLSearchParams({ token: connection.remoteToken });
  return `${base}?${params.toString()}`;
}

export function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.endsWith('.json');
}

export async function readBridgeConnectionArtifact(filePath: string): Promise<BridgeConnectionArtifact> {
  const resolved = path.resolve(process.cwd(), filePath);
  const raw = await fs.readFile(resolved, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse connection artifact JSON at ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid connection artifact at ${resolved}: expected an object.`);
  }
  const remoteHost = (parsed as { remoteHost?: unknown }).remoteHost;
  const remoteToken = (parsed as { remoteToken?: unknown }).remoteToken;
  if (typeof remoteHost !== 'string' || remoteHost.trim().length === 0) {
    throw new Error(`Invalid connection artifact at ${resolved}: remoteHost is missing.`);
  }
  if (typeof remoteToken !== 'string' || remoteToken.trim().length === 0) {
    throw new Error(`Invalid connection artifact at ${resolved}: remoteToken is missing.`);
  }
  // Validate host formatting early so downstream checks don't crash.
  parseHostPort(remoteHost);
  return parsed as BridgeConnectionArtifact;
}
