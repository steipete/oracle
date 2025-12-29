import { describe, expect, test, vi } from 'vitest';

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
