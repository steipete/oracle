import { describe, expect, test, vi } from 'vitest';
import { handleSessionAlias, handleStatusFlag } from '../../src/cli/rootAlias.ts';

const createDeps = () => {
  return {
    attachSession: vi.fn().mockResolvedValue(undefined),
    showStatus: vi.fn().mockResolvedValue(undefined),
  };
};

describe('handleStatusFlag', () => {
  test('returns false when status flag not set', async () => {
    const deps = createDeps();
    const handled = await handleStatusFlag({ status: false }, deps);
    expect(handled).toBe(false);
    expect(deps.attachSession).not.toHaveBeenCalled();
    expect(deps.showStatus).not.toHaveBeenCalled();
  });

  test('attaches session when status + session provided', async () => {
    const deps = createDeps();
    const handled = await handleStatusFlag({ status: true, session: 'abc' }, deps);
    expect(handled).toBe(true);
    expect(deps.attachSession).toHaveBeenCalledWith('abc');
    expect(deps.showStatus).not.toHaveBeenCalled();
  });

  test('shows status list when status flag set without session', async () => {
    const deps = createDeps();
    const handled = await handleStatusFlag({ status: true }, deps);
    expect(handled).toBe(true);
    expect(deps.showStatus).toHaveBeenCalledWith({ hours: 24, includeAll: false, limit: 100, showExamples: true });
    expect(deps.attachSession).not.toHaveBeenCalled();
  });
});

describe('handleSessionAlias', () => {
  test('returns false when session flag not set', async () => {
    const deps = createDeps();
    const handled = await handleSessionAlias({ session: undefined }, deps);
    expect(handled).toBe(false);
    expect(deps.attachSession).not.toHaveBeenCalled();
  });

  test('attaches session when flag is provided', async () => {
    const deps = createDeps();
    const handled = await handleSessionAlias({ session: 'sess-123' }, deps);
    expect(handled).toBe(true);
    expect(deps.attachSession).toHaveBeenCalledWith('sess-123');
  });
});
