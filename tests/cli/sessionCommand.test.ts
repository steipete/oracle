import { afterEach, describe, expect, test, vi } from 'vitest';
import { Command } from 'commander';
import { handleSessionCommand, type StatusOptions } from '../../src/cli/sessionCommand.ts';

function createCommandWithOptions(options: StatusOptions): Command {
  const command = new Command();
  command.setOptionValueWithSource('hours', options.hours, 'cli');
  command.setOptionValueWithSource('limit', options.limit, 'cli');
  command.setOptionValueWithSource('all', options.all, 'cli');
  if (options.path !== undefined) {
    command.setOptionValueWithSource('path', options.path, 'cli');
  }
  if (options.clear !== undefined) {
    command.setOptionValueWithSource('clear', options.clear, 'cli');
  }
  if (options.clean !== undefined) {
    command.setOptionValueWithSource('clean', options.clean, 'cli');
  }
  return command;
}

describe('handleSessionCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test('lists sessions when no id provided', async () => {
    const command = createCommandWithOptions({ hours: 12, limit: 5, all: false });
    const showStatus = vi.fn();
    await handleSessionCommand(undefined, command, {
      showStatus,
      attachSession: vi.fn(),
      usesDefaultStatusFilters: vi.fn().mockReturnValue(true),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths: vi.fn(),
    });
    expect(showStatus).toHaveBeenCalledWith({
      hours: 12,
      includeAll: false,
      limit: 5,
      showExamples: true,
    });
  });

  test('attaches when id provided', async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false });
    const attachSession = vi.fn();
    await handleSessionCommand('abc', command, {
      showStatus: vi.fn(),
      attachSession,
      usesDefaultStatusFilters: vi.fn(),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths: vi.fn(),
    });
    expect(attachSession).toHaveBeenCalledWith('abc', expect.objectContaining({ renderMarkdown: false }));
  });

  test('ignores unrelated root-only flags and logs a note when attaching by id', async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 400, all: false });
    // Simulate passing a root-only flag (preview) that the session handler should ignore.
    command.setOptionValueWithSource('preview', true, 'cli');

    const attachSession = vi.fn();
    const showStatus = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleSessionCommand('swiftui-menubarextra-on-macos-15', command, {
      showStatus,
      attachSession,
      usesDefaultStatusFilters: vi.fn(),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths: vi.fn(),
    });

    expect(attachSession).toHaveBeenCalledWith(
      'swiftui-menubarextra-on-macos-15',
      expect.objectContaining({ renderMarkdown: false }),
    );
    expect(showStatus).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Ignoring flags on session attach: preview');
    expect(process.exitCode).toBeUndefined();
  });

  test('prints paths when --path is provided with an id', async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false, path: true } as StatusOptions);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const getSessionPaths = vi.fn().mockResolvedValue({
      dir: '/tmp/.oracle/sessions/abc',
      metadata: '/tmp/.oracle/sessions/abc/session.json',
      request: '/tmp/.oracle/sessions/abc/request.json',
      log: '/tmp/.oracle/sessions/abc/output.log',
    });

    await handleSessionCommand('abc', command, {
      showStatus: vi.fn(),
      attachSession: vi.fn(),
      usesDefaultStatusFilters: vi.fn(),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths,
    });

    expect(getSessionPaths).toHaveBeenCalledWith('abc');
    expect(logSpy).toHaveBeenCalledWith('Session dir: /tmp/.oracle/sessions/abc');
    expect(logSpy).toHaveBeenCalledWith('Metadata: /tmp/.oracle/sessions/abc/session.json');
    expect(logSpy).toHaveBeenCalledWith('Request: /tmp/.oracle/sessions/abc/request.json');
    expect(logSpy).toHaveBeenCalledWith('Log: /tmp/.oracle/sessions/abc/output.log');
    expect(process.exitCode).toBeUndefined();
  });

  test('errors when --path is provided without an id', async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false, path: true } as StatusOptions);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleSessionCommand(undefined, command, {
      showStatus: vi.fn(),
      attachSession: vi.fn(),
      usesDefaultStatusFilters: vi.fn(),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths: vi.fn(),
    });

    expect(errorSpy).toHaveBeenCalledWith('The --path flag requires a session ID.');
    expect(process.exitCode).toBe(1);
  });

  test('errors when session files are missing', async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false, path: true } as StatusOptions);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const getSessionPaths = vi.fn().mockRejectedValue(new Error('Session "abc" is missing: session.json'));

    await handleSessionCommand('abc', command, {
      showStatus: vi.fn(),
      attachSession: vi.fn(),
      usesDefaultStatusFilters: vi.fn(),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths,
    });

    expect(errorSpy).toHaveBeenCalledWith('Session "abc" is missing: session.json');
    expect(process.exitCode).toBe(1);
  });

  test('passes render flag through to attachSession', async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false });
    command.setOptionValueWithSource('render', true, 'cli');

    const attachSession = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleSessionCommand('abc', command, {
      showStatus: vi.fn(),
      attachSession,
      usesDefaultStatusFilters: vi.fn(),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths: vi.fn(),
    });
    expect(attachSession).toHaveBeenCalledWith('abc', expect.objectContaining({ renderMarkdown: true }));
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('forces infinite range when --all set', async () => {
    const command = createCommandWithOptions({ hours: 1, limit: 25, all: true });
    const showStatus = vi.fn();
    await handleSessionCommand(undefined, command, {
      showStatus,
      attachSession: vi.fn(),
      usesDefaultStatusFilters: vi.fn().mockReturnValue(false),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths: vi.fn(),
    });
    expect(showStatus).toHaveBeenCalledWith({
      hours: Infinity,
      includeAll: true,
      limit: 25,
      showExamples: false,
    });
  });

  test('clears sessions when --clear is provided', async () => {
    const command = createCommandWithOptions({ hours: 6, limit: 5, all: false, clear: true });
    const deleteSessionsOlderThan = vi.fn().mockResolvedValue({ deleted: 3, remaining: 2 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleSessionCommand(undefined, command, {
      showStatus: vi.fn(),
      attachSession: vi.fn(),
      usesDefaultStatusFilters: vi.fn(),
      deleteSessionsOlderThan,
      getSessionPaths: vi.fn(),
    });
    expect(deleteSessionsOlderThan).toHaveBeenCalledWith({ hours: 6, includeAll: false });
    expect(logSpy).toHaveBeenCalledWith(
      'Deleted 3 sessions (sessions older than 6h). 2 sessions remain.\nRun "oracle session --clear --all" to delete everything.',
    );
  });

  test('rejects slug-style "clear" ids with guidance', async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleSessionCommand('clear', command, {
      showStatus: vi.fn(),
      attachSession: vi.fn(),
      usesDefaultStatusFilters: vi.fn(),
      deleteSessionsOlderThan: vi.fn(),
      getSessionPaths: vi.fn(),
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'Session cleanup now uses --clear. Run "oracle session --clear --hours <n>" instead.',
    );
    expect(process.exitCode).toBe(1);
  });
});
