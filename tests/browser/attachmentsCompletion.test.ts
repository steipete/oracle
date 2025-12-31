import { describe, expect, test, vi } from 'vitest';
import { waitForAttachmentCompletion, waitForUserTurnAttachments } from '../../src/browser/pageActions.js';
import type { ChromeClient } from '../../src/browser/types.js';

const useFakeTime = () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
};

const useRealTime = () => {
  vi.useRealTimers();
};

describe('attachment completion fallbacks', () => {
  test('waitForAttachmentCompletion resolves when file input contains expected name (no UI chip)', async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: 'ready',
            uploading: false,
            filesAttached: true,
            attachedNames: [],
            inputNames: ['oracle-attach-verify.txt'],
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ['oracle-attach-verify.txt']);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test('waitForAttachmentCompletion resolves even when uploading is flagged, once input match is stable', async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: 'ready',
            uploading: true,
            filesAttached: false,
            attachedNames: [],
            inputNames: ['oracle-attach-verify.txt'],
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ['oracle-attach-verify.txt']);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test('waitForAttachmentCompletion can resolve when send button is missing (input match fallback)', async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: 'missing',
            uploading: false,
            filesAttached: true,
            attachedNames: [],
            inputNames: ['oracle-attach-verify.txt'],
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ['oracle-attach-verify.txt']);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test('waitForAttachmentCompletion times out when send button stays disabled (upload likely in progress)', async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: 'disabled',
            uploading: false,
            filesAttached: true,
            attachedNames: ['oracle-attach-verify.txt'],
            inputNames: [],
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    const promise = waitForAttachmentCompletion(runtime, 800, ['oracle-attach-verify.txt']);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test('waitForAttachmentCompletion times out when neither UI nor file input matches', async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: 'ready',
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: [],
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    const promise = waitForAttachmentCompletion(runtime, 800, ['oracle-attach-verify.txt']);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });
});

describe('sent turn attachment verification', () => {
  test('waitForUserTurnAttachments resolves when last user turn includes filename', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: 'You said:\noracle-attach-verify.txt\nDocument',
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    await expect(waitForUserTurnAttachments(runtime, ['oracle-attach-verify.txt'], 1000)).resolves.toBe(true);
  });

  test('waitForUserTurnAttachments times out when filename never appears', async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: 'You said:\n(no attachment name here)',
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    const promise = waitForUserTurnAttachments(runtime, ['oracle-attach-verify.txt'], 600);
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test('waitForUserTurnAttachments skips when user turn lacks attachment UI', async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: 'You said:\n(no attachment UI here)',
            attrs: [],
            hasAttachmentUi: false,
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    const promise = waitForUserTurnAttachments(runtime, ['oracle-attach-verify.txt'], 600);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test('waitForUserTurnAttachments resolves when attachment UI count satisfies expected files (no filename text)', async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: 'You said:\n(no attachment name here)',
            attrs: [],
            hasAttachmentUi: true,
            attachmentUiCount: 2,
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient['Runtime'];

    await expect(
      waitForUserTurnAttachments(runtime, ['oracle-attach-verify-a.txt', 'oracle-attach-verify-b.txt'], 1000),
    ).resolves.toBe(true);
  });
});
