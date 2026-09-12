import { expect, test, vi } from "vitest";
import { ensureModelSelection } from "../../src/browser/actions/modelSelection.js";
import type { ChromeClient } from "../../src/browser/types.js";

test.each(["GPT-5.6 Sol", "6 Pro", "Latest", "最新", "최신"])(
  "warns before an implicit switch from %s without changing the target",
  async (label) => {
    const events: string[] = [];
    const evaluate = vi
      .fn()
      .mockImplementationOnce(async () => ({
        result: { value: { status: "already-selected", label } },
      }))
      .mockImplementationOnce(async () => {
        events.push("select");
        return { result: { value: { status: "switched", label: "GPT-5.5" } } };
      });
    const result = await ensureModelSelection(
      { evaluate } as unknown as ChromeClient["Runtime"],
      "GPT-5.5",
      (line) => events.push(line),
      "select",
      { implicitDefault: true, buttonWaitMs: 0 },
    );
    expect(events[0]).toContain("Model selection warning:");
    expect(events[0]).toContain("--browser-model-strategy current");
    expect(events[1]).toBe("select");
    expect(result).toMatchObject({
      requestedModel: "GPT-5.5",
      resolvedLabel: "GPT-5.5",
      verified: true,
    });
  },
);

test.each(["GPT-5.5", "5.5Pro", "Thinking 5.4", "Pro", "Extra High", null])(
  "does not warn for unchanged, older, or unidentified selection %s",
  async (label) => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ result: { value: { status: "already-selected", label } } })
      .mockResolvedValue({ result: { value: { status: "already-selected", label: "GPT-5.5" } } });
    const log = vi.fn();
    await ensureModelSelection(
      { evaluate } as unknown as ChromeClient["Runtime"],
      "GPT-5.5",
      log,
      "select",
      { implicitDefault: true, buttonWaitMs: 0 },
    );
    expect(log.mock.calls.flat().some((line) => line.includes("warning"))).toBe(false);
  },
);

test.each([false, undefined])(
  "explicit/configured selection does not run an implicit probe (%s)",
  async (implicitDefault) => {
    const evaluate = vi.fn(async () => ({
      result: { value: { status: "switched", label: "GPT-5.5" } },
    }));
    await ensureModelSelection(
      { evaluate } as unknown as ChromeClient["Runtime"],
      "GPT-5.5",
      vi.fn((_message: string) => {}),
      "select",
      { implicitDefault },
    );
    expect(evaluate).toHaveBeenCalledOnce();
  },
);

test("current strategy stays unchanged even with saved default provenance", async () => {
  const evaluate = vi.fn(async () => ({
    result: { value: { status: "already-selected", label: "GPT-5.6 Sol" } },
  }));
  const log = vi.fn();
  await ensureModelSelection(
    { evaluate } as unknown as ChromeClient["Runtime"],
    "GPT-5.5",
    log,
    "current",
    { implicitDefault: true, buttonWaitMs: 0 },
  );
  expect(evaluate).toHaveBeenCalledOnce();
  expect(log.mock.calls.flat().some((line) => line.includes("warning"))).toBe(false);
});

test("waits for a late-rendered model label before warning and switching", async () => {
  const events: string[] = [];
  const evaluate = vi
    .fn()
    .mockResolvedValueOnce({ result: { value: { status: "already-selected", label: null } } })
    .mockResolvedValueOnce({
      result: { value: { status: "already-selected", label: "GPT-5.6 Sol" } },
    })
    .mockImplementationOnce(async () => {
      events.push("select");
      return { result: { value: { status: "switched", label: "GPT-5.5" } } };
    });
  await ensureModelSelection(
    { evaluate } as unknown as ChromeClient["Runtime"],
    "GPT-5.5",
    (line) => events.push(line),
    "select",
    { implicitDefault: true, buttonWaitMs: 1000, buttonPollMs: 1 },
  );
  expect(events[0]).toContain("Model selection warning:");
  expect(events[1]).toBe("select");
  expect(evaluate).toHaveBeenCalledTimes(3);
});

test("retains the selection wait budget after an unavailable-label probe", async () => {
  const evaluate = vi
    .fn()
    .mockResolvedValueOnce({ result: { value: { status: "already-selected", label: null } } })
    .mockResolvedValueOnce({ result: { value: { status: "already-selected", label: null } } })
    .mockResolvedValueOnce({ result: { value: { status: "button-missing" } } })
    .mockResolvedValueOnce({
      result: { value: { status: "already-selected", label: "GPT-5.6 Sol" } },
    })
    .mockResolvedValueOnce({ result: { value: { status: "switched", label: "GPT-5.5" } } });
  const log = vi.fn((_message: string) => {});
  const selected = await ensureModelSelection(
    { evaluate } as unknown as ChromeClient["Runtime"],
    "GPT-5.5",
    log,
    "select",
    { implicitDefault: true, buttonWaitMs: 10, buttonPollMs: 15 },
  );
  expect(selected.status).toBe("switched");
  expect(log.mock.calls.flat().some((line) => line.includes("Model selection warning:"))).toBe(
    true,
  );
});
