import type { UserConfig } from '../config.js';

export type RemoteServiceConfigSource =
  | 'cli'
  | 'config.browser'
  | 'config.legacy'
  | 'config.remoteObject'
  | 'env'
  | 'unset';

export interface ResolvedRemoteServiceConfig {
  host?: string;
  token?: string;
  sources: {
    host: RemoteServiceConfigSource;
    token: RemoteServiceConfigSource;
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function resolveRemoteServiceConfig({
  cliHost,
  cliToken,
  userConfig,
  env = process.env,
}: {
  cliHost?: string;
  cliToken?: string;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}): ResolvedRemoteServiceConfig {
  const configBrowserHost = normalizeString(userConfig?.browser?.remoteHost);
  const configBrowserToken = normalizeString(userConfig?.browser?.remoteToken);

  const legacyHost = normalizeString(userConfig?.remoteHost);
  const legacyToken = normalizeString(userConfig?.remoteToken);

  const remoteObjectHost = normalizeString(userConfig?.remote?.host);
  const remoteObjectToken = normalizeString(userConfig?.remote?.token);

  const envHost = normalizeString(env.ORACLE_REMOTE_HOST);
  const envToken = normalizeString(env.ORACLE_REMOTE_TOKEN);

  const cliHostValue = normalizeString(cliHost);
  const cliTokenValue = normalizeString(cliToken);

  const host =
    cliHostValue ?? configBrowserHost ?? legacyHost ?? remoteObjectHost ?? envHost;
  const token =
    cliTokenValue ?? configBrowserToken ?? legacyToken ?? remoteObjectToken ?? envToken;

  const hostSource: RemoteServiceConfigSource = cliHostValue
    ? 'cli'
    : configBrowserHost
      ? 'config.browser'
      : legacyHost
        ? 'config.legacy'
        : remoteObjectHost
          ? 'config.remoteObject'
          : envHost
            ? 'env'
            : 'unset';

  const tokenSource: RemoteServiceConfigSource = cliTokenValue
    ? 'cli'
    : configBrowserToken
      ? 'config.browser'
      : legacyToken
        ? 'config.legacy'
        : remoteObjectToken
          ? 'config.remoteObject'
          : envToken
            ? 'env'
            : 'unset';

  return { host, token, sources: { host: hostSource, token: tokenSource } };
}

