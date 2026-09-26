import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uploadAttachmentViaDataTransfer } from "../../src/browser/actions/remoteFileTransfer.js";

// Each case walks up to ~15 s of faked waits, one real I/O turn per step; a loaded full-suite
// run can need more than the default 5 s of wall-clock time to do that.
vi.setConfig({ testTimeout: 20_000 });

// A fake remote page: the transfer expression carries the file bytes ("const base64Data"), the
// visibility probe reports where it found the file ("source: 'file-input'"), and everything else
// (attachment evidence bookkeeping) just succeeds.
function fakePage({ inputAfterLookups = 0, pickedUpOnTransfer = 1 } = {}) {
  let lookups = 0;
  let transfers = 0;
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const base64Data")) {
        transfers += 1;
        return { result: { value: { success: true, fileName: "synthetic.txt", size: 20 } } };
      }
      if (expression.includes("source: 'file-input'")) {
        return { result: { value: { found: transfers >= pickedUpOnTransfer } } };
      }
      return { result: { value: true } };
    }),
  };
  const dom = {
    getDocument: vi.fn(async () => {
      lookups += 1;
      return { root: { nodeId: 1 } };
    }),
    querySelector: vi.fn(async () => ({ nodeId: lookups > inputAfterLookups ? 2 : 0 })),
  };
  return { runtime, dom, transfers: () => transfers };
}

let root: string;
let file: string;
beforeEach(async () => {
  // Only the upload's own waits are faked; the file read still needs real I/O turns.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-remote-transfer-"));
  file = path.join(root, "synthetic.txt");
  await fs.writeFile(file, "synthetic attachment");
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

async function upload(page: ReturnType<typeof fakePage>, logs: string[] = []) {
  const pending = uploadAttachmentViaDataTransfer(
    { runtime: page.runtime as never, dom: page.dom as never },
    { path: file, displayPath: "synthetic.txt" },
    (message) => logs.push(message),
    { inputWaitMs: 2_000, pickupWaitMs: 1_000 },
  );
  let done = false;
  const settled = pending.then(
    (): { ok: true } => ({ ok: true }),
    (error: Error): { ok: false; error: Error } => ({ ok: false, error }),
  );
  void settled.then(() => {
    done = true;
  });
  // Step until the upload settles: its file read is real I/O, so a fixed step count can run out
  // while the read is still pending under load and then leave a faked wait unadvanced forever.
  // Every wait in the upload has a faked deadline, so this ends; the test timeout backstops it.
  while (!done) {
    await vi.advanceTimersByTimeAsync(250);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return settled;
}

test("waits for a composer file input that mounts after the prompt box", async () => {
  const page = fakePage({ inputAfterLookups: 3 });
  const outcome = await upload(page);
  expect(outcome).toEqual({ ok: true });
  expect(page.transfers()).toBe(1);
  expect(page.dom.getDocument.mock.calls.length).toBeGreaterThan(3);
});

test("still reports a missing input once the wait is over", async () => {
  const page = fakePage({ inputAfterLookups: Number.POSITIVE_INFINITY });
  const outcome = await upload(page);
  expect(outcome).toMatchObject({
    ok: false,
    error: { message: "Unable to locate ChatGPT file attachment input." },
  });
  expect(page.transfers()).toBe(0);
});

test("repeats a transfer ChatGPT never picked up", async () => {
  const page = fakePage({ pickedUpOnTransfer: 2 });
  const logs: string[] = [];
  const outcome = await upload(page, logs);
  expect(outcome).toEqual({ ok: true });
  expect(page.transfers()).toBe(2);
  expect(logs).toContain("ChatGPT did not pick up synthetic.txt; transferring it again (2/3).");
});

test("never repeats a transfer ChatGPT picked up", async () => {
  const page = fakePage({ pickedUpOnTransfer: 1 });
  const outcome = await upload(page);
  expect(outcome).toEqual({ ok: true });
  expect(page.transfers()).toBe(1);
});

test("gives up after three transfers with the existing error", async () => {
  const page = fakePage({ pickedUpOnTransfer: Number.POSITIVE_INFINITY });
  const outcome = await upload(page);
  expect(outcome).toMatchObject({
    ok: false,
    error: { message: "Attachment did not appear in ChatGPT composer." },
  });
  expect(page.transfers()).toBe(3);
});
