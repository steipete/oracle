import { describe, expect, test, vi } from 'vitest';

vi.mock('../../src/cli/tui/index.ts', () => ({
  launchTui: vi.fn().mockResolvedValue(undefined),
}));

const launchTuiMock = vi.mocked(await import('../../src/cli/tui/index.ts')).launchTui;

describe('zero-arg TUI entry', () => {
  test('invokes launchTui when no args and TTY', async () => {
    const originalArgv = process.argv;
    const originalTty = process.stdout.isTTY;
    process.argv = ['node', 'bin/oracle-cli.js']; // mimics zero-arg user input
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    await import('../../bin/oracle-cli.js');

    expect(launchTuiMock).toHaveBeenCalled();

    // restore
    process.argv = originalArgv;
    Object.defineProperty(process.stdout, 'isTTY', { value: originalTty, configurable: true });
  });
});
