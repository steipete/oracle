import { beforeEach, describe, expect, test, vi } from 'vitest';

const cdpNewMock = vi.fn();
const cdpCloseMock = vi.fn();
const cdpMock = Object.assign(vi.fn(), {
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  New: cdpNewMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  Close: cdpCloseMock,
});

vi.mock('chrome-remote-interface', () => ({ default: cdpMock }));

vi.doMock('../../src/browser/profileState.js', async () => {
  const original = await vi.importActual<typeof import('../../src/browser/profileState.js')>(
    '../../src/browser/profileState.js',
  );
  return {
    ...original,
    cleanupStaleProfileState: vi.fn(async () => undefined),
  };
});

describe('registerTerminationHooks', () => {
  test('clears stale DevToolsActivePort hints when preserving userDataDir', async () => {
    const { registerTerminationHooks } = await import('../../src/browser/chromeLifecycle.js');
    const profileState = await import('../../src/browser/profileState.js');
    const cleanupMock = vi.mocked(profileState.cleanupStaleProfileState);

    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const logger = vi.fn();
    const userDataDir = '/tmp/oracle-manual-login-profile';

    const removeHooks = registerTerminationHooks(
      chrome as unknown as import('chrome-launcher').LaunchedChrome,
      userDataDir,
      false,
      logger,
      {
        isInFlight: () => false,
        preserveUserDataDir: true,
      },
    );

    process.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 10));

    removeHooks();

    expect(chrome.kill).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalledWith(userDataDir, logger, { lockRemovalMode: 'never' });
  });
});

describe('connectWithNewTab', () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
  });

  test('falls back to default target when new tab cannot be opened', async () => {
    cdpNewMock.mockRejectedValue(new Error('boom'));
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import('../../src/browser/chromeLifecycle.js');
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: '127.0.0.1' });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Failed to open isolated browser tab'));
  });

  test('closes unused tab when attach fails', async () => {
    cdpNewMock.mockResolvedValue({ id: 'target-1' });
    cdpMock.mockRejectedValueOnce(new Error('attach fail')).mockResolvedValueOnce({});
    cdpCloseMock.mockResolvedValue(undefined);

    const { connectWithNewTab } = await import('../../src/browser/chromeLifecycle.js');
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).toHaveBeenCalledWith({ host: '127.0.0.1', port: 9222, id: 'target-1' });
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: '127.0.0.1' });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Failed to attach to isolated browser tab'));
  });

  test('throws when strict mode disallows fallback', async () => {
    cdpNewMock.mockRejectedValue(new Error('boom'));

    const { connectWithNewTab } = await import('../../src/browser/chromeLifecycle.js');
    const logger = vi.fn();

    await expect(connectWithNewTab(9222, logger, undefined, undefined, { fallbackToDefault: false })).rejects.toThrow(
      /isolated browser tab/i,
    );
    expect(cdpMock).not.toHaveBeenCalled();
  });

  test('returns isolated target when attach succeeds', async () => {
    cdpNewMock.mockResolvedValue({ id: 'target-2' });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import('../../src/browser/chromeLifecycle.js');
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe('target-2');
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ host: '127.0.0.1', port: 9222, target: 'target-2' });
  });
});
