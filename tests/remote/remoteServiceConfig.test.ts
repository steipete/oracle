import { describe, expect, it } from 'vitest';
import { resolveRemoteServiceConfig } from '../../src/remote/remoteServiceConfig.js';

describe('resolveRemoteServiceConfig', () => {
  it('prefers CLI values over config and env', () => {
    const env = {} as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env['ORACLE_REMOTE_HOST'] = 'env:4';
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env['ORACLE_REMOTE_TOKEN'] = 'env-token';

    const resolved = resolveRemoteServiceConfig({
      cliHost: 'cli:1',
      cliToken: 'cli-token',
      userConfig: {
        browser: { remoteHost: 'config:2', remoteToken: 'config-token' },
        remote: { host: 'legacy:3', token: 'legacy-token' },
      },
      env,
    });

    expect(resolved.host).toBe('cli:1');
    expect(resolved.token).toBe('cli-token');
    expect(resolved.sources.host).toBe('cli');
    expect(resolved.sources.token).toBe('cli');
  });

  it('prefers browser.remoteHost/browser.remoteToken when present', () => {
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteHost: 'cfg:9473', remoteToken: 'cfg-token' },
        remoteHost: 'legacy:9999',
        remoteToken: 'legacy-token',
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.host).toBe('cfg:9473');
    expect(resolved.token).toBe('cfg-token');
    expect(resolved.sources.host).toBe('config.browser');
    expect(resolved.sources.token).toBe('config.browser');
  });

  it('falls back to legacy token when browser.remoteToken is missing', () => {
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteHost: 'cfg:9473' },
        remoteToken: 'legacy-token',
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.host).toBe('cfg:9473');
    expect(resolved.token).toBe('legacy-token');
    expect(resolved.sources.host).toBe('config.browser');
    expect(resolved.sources.token).toBe('config.legacy');
  });

  it('uses env when config is empty', () => {
    const env = {} as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env['ORACLE_REMOTE_HOST'] = 'env:9473';
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env['ORACLE_REMOTE_TOKEN'] = 'env-token';

    const resolved = resolveRemoteServiceConfig({
      userConfig: {},
      env,
    });

    expect(resolved.host).toBe('env:9473');
    expect(resolved.token).toBe('env-token');
    expect(resolved.sources.host).toBe('env');
    expect(resolved.sources.token).toBe('env');
  });
});
