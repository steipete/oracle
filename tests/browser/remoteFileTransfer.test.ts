import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uploadAttachmentViaDataTransfer } from "../../src/browser/actions/remoteFileTransfer.js";

// Each case walks up to ~15 s of faked waits, one real I/O turn per step; a loaded full-suite
// run can need more than the default 5 s of wall-clock time to do that.
vi.setConfig({ testTimeout: 20_000 });

// A fake remote page. The transfer expression carries the file bytes ("const base64Data") and
// fills the input. ChatGPT takes the file from transfer `pickedUpOnTransfer` on: its change
// handler empties the input and the chip shows `chipDelayMs` later. An earlier transfer is
// dropped. With `dropped: "held"` no handler runs and the input keeps Oracle's own FileList,
// which the visibility probe reports unless told not to count file inputs, as the real probe
// does. With `dropped: "emptied"` the handler empties the input but keeps nothing, as live
// ChatGPT did while its composer was still loading. Everything else succeeds.
interface FakePageOptions {
  inputAfterLookups?: number;
  pickedUpOnTransfer?: number;
  chipDelayMs?: number;
  dropped?: "held" | "emptied";
}
function fakePage({
  inputAfterLookups = 0,
  pickedUpOnTransfer = 1,
  chipDelayMs = 0,
  dropped = "held",
}: FakePageOptions = {}) {
  let lookups = 0;
  let transfers = 0;
  let takenAt: number | undefined;
  let holding = false;
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const base64Data")) {
        transfers += 1;
        if (takenAt === undefined && transfers >= pickedUpOnTransfer) takenAt = Date.now();
        holding = takenAt === undefined && dropped === "held";
        return { result: { value: { success: true, fileName: "synthetic.txt", size: 20 } } };
      }
      if (expression.includes("source: 'attachments'")) {
        const chip = takenAt !== undefined && Date.now() >= takenAt + chipDelayMs;
        const countsInput = !expression.includes("const countFileInput = false");
        return { result: { value: { found: chip || (countsInput && holding) } } };
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

test.each(["held", "emptied"] as const)(
  "does not accept or replay a dropped %s transfer",
  async (dropped) => {
    const page = fakePage({ pickedUpOnTransfer: 2, dropped });
    expect(await upload(page)).toMatchObject({
      ok: false,
      error: { message: "Attachment did not appear in ChatGPT composer." },
    });
    expect(page.transfers()).toBe(1);
  },
);

test("waits for a slow accepted chip without sending a duplicate", async () => {
  const page = fakePage({ chipDelayMs: 4_000 });
  expect(await upload(page)).toEqual({ ok: true });
  expect(page.transfers()).toBe(1);
});
