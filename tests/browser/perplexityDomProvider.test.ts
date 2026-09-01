import { describe, it, expect, vi } from "vitest";
import {
  perplexityDomProvider,
  extractPerplexitySources,
  extractPerplexityImages,
  uploadPerplexityAttachments,
  PERPLEXITY_SELECTORS,
} from "../../src/browser/providers/perplexityDomProvider.js";
import type { ProviderDomFlowContext } from "../../src/browser/providerDomFlow.js";

interface FakeCtxOptions {
  /** Queued JSON payloads returned to the waitForResponse poll, in order. */
  pollPayloads?: string[];
  /** Values returned for the "already in this mode" probe. */
  alreadyActive?: boolean;
  state?: Record<string, unknown>;
}

function createCtx(options: FakeCtxOptions = {}): {
  ctx: ProviderDomFlowContext;
  expressions: string[];
} {
  const expressions: string[] = [];
  const polls = [...(options.pollPayloads ?? [])];

  const evaluate = vi.fn(async (expression: string) => {
    expressions.push(expression);
    // The response poll is the only expression that classifies a turn as 'settling'.
    if (expression.includes("'settling'")) {
      return polls.shift() ?? JSON.stringify({ status: "waiting", turns: 0, length: 0 });
    }
    if (expression.includes("startsWith(") && expression.includes("trigger")) {
      return options.alreadyActive ?? false;
    }
    if (expression.includes("getBoundingClientRect")) {
      return { x: 10, y: 20 };
    }
    return undefined;
  });

  const ctx = {
    prompt: "hello",
    evaluate: evaluate as ProviderDomFlowContext["evaluate"],
    delay: vi.fn(async () => undefined),
    log: vi.fn(),
    state: { baselineTurns: 1, timeoutMs: 5_000, ...(options.state ?? {}) },
  } as unknown as ProviderDomFlowContext;

  return { ctx, expressions };
}

describe("perplexityDomProvider.waitForResponse", () => {
  it("completes once a new turn settles at a stable length", async () => {
    const settled = JSON.stringify({ status: "settling", turns: 2, length: 5, text: "Lisbon" });
    const { ctx } = createCtx({
      pollPayloads: [
        JSON.stringify({ status: "generating", turns: 2, length: 2, text: "Li" }),
        settled,
        settled,
      ],
    });

    const result = await perplexityDomProvider.waitForResponse(ctx);
    expect(result.text).toBe("Lisbon");
  });

  it("does not accept a settled turn until its length stops growing", async () => {
    // Perplexity clears its Stop button before the text finishes rendering, so a
    // single 'settling' poll must not be treated as completion.
    const { ctx } = createCtx({
      pollPayloads: [
        JSON.stringify({ status: "settling", turns: 2, length: 3, text: "Lis" }),
        JSON.stringify({ status: "settling", turns: 2, length: 6, text: "Lisbon" }),
        JSON.stringify({ status: "settling", turns: 2, length: 6, text: "Lisbon" }),
      ],
    });

    const result = await perplexityDomProvider.waitForResponse(ctx);
    expect(result.text).toBe("Lisbon");
  });

  it("ignores a settled state that belongs to the previous turn", async () => {
    // The prior answer's footer stays on the page; only a turn count above the
    // baseline means this run's answer has appeared.
    const stale = JSON.stringify({ status: "settling", turns: 1, length: 9, text: "old answer" });
    const fresh = JSON.stringify({ status: "settling", turns: 2, length: 3, text: "new" });
    const { ctx } = createCtx({ pollPayloads: [stale, stale, fresh, fresh] });

    const result = await perplexityDomProvider.waitForResponse(ctx);
    expect(result.text).toBe("new");
  });

  it("fails fast when Cloudflare challenges the tab after submitting", async () => {
    // The challenge tears down the app shell mid-run, so no turn ever appears and
    // the poll would otherwise spin for the full ten-minute timeout.
    const challenged = JSON.stringify({ status: "waiting", turns: 0, length: 0, botCheck: true });
    const { ctx } = createCtx({
      pollPayloads: [challenged, challenged, challenged],
      state: { baselineTurns: 0, timeoutMs: 600_000 },
    });

    await expect(perplexityDomProvider.waitForResponse(ctx)).rejects.toThrow(
      /Cloudflare bot check/i,
    );
  });

  it("does not fail on a single transient challenge poll", async () => {
    const settled = JSON.stringify({ status: "settling", turns: 1, length: 3, text: "hi" });
    const { ctx } = createCtx({
      pollPayloads: [
        JSON.stringify({ status: "waiting", turns: 0, length: 0, botCheck: true }),
        settled,
        settled,
      ],
      state: { baselineTurns: 0, timeoutMs: 600_000 },
    });

    const result = await perplexityDomProvider.waitForResponse(ctx);
    expect(result.text).toBe("hi");
  });

  it("completes an image-only answer that renders no prose turn", async () => {
    // Perplexity generates images inline from a descriptive prompt and produces no
    // .prose element, so keying completion on prose alone hangs until timeout.
    const imageSettling = JSON.stringify({
      status: "image-settling",
      turns: 0,
      length: 0,
      imageCount: 1,
    });
    const { ctx } = createCtx({
      pollPayloads: [
        JSON.stringify({ status: "generating", turns: 0, length: 0, imageCount: 0 }),
        imageSettling,
        imageSettling,
      ],
      state: { baselineTurns: 0, timeoutMs: 600_000 },
    });

    const result = await perplexityDomProvider.waitForResponse(ctx);
    expect(result.text).toBe("");
  });

  it("throws when no answer arrives before the timeout", async () => {
    const { ctx } = createCtx({
      pollPayloads: [],
      state: { baselineTurns: 1, timeoutMs: 1 },
    });
    await expect(perplexityDomProvider.waitForResponse(ctx)).rejects.toThrow(/timed out/i);
  });
});

describe("perplexityDomProvider.selectMode", () => {
  it("scopes the mode trigger to the composer toggle", async () => {
    // The page also renders "Filter projects", "Apps and more" and "Model" menu
    // triggers; picking the first visible one opens the wrong menu.
    const { ctx, expressions } = createCtx({ alreadyActive: false, state: { mode: "research" } });
    await perplexityDomProvider.selectMode?.(ctx).catch(() => undefined);

    const scoped = expressions.filter((expression) =>
      expression.includes("ask-input-mode-toggle-width-wrapper"),
    );
    expect(scoped.length).toBeGreaterThan(0);
  });

  it("skips the menu when the requested mode is already active", async () => {
    const { ctx, expressions } = createCtx({ alreadyActive: true, state: { mode: "search" } });
    await perplexityDomProvider.selectMode?.(ctx);

    expect(expressions.some((expression) => expression.includes("getBoundingClientRect"))).toBe(
      false,
    );
  });
});

describe("extractPerplexitySources", () => {
  function ctxReturning(payloads: string[]): ProviderDomFlowContext {
    const queue = [...payloads];
    const evaluate = vi.fn(async (expression: string) => {
      if (expression.includes("data-context-pane")) {
        return queue.length > 1 ? queue.shift() : queue[0];
      }
      return undefined;
    });
    return {
      prompt: "hello",
      evaluate: evaluate as ProviderDomFlowContext["evaluate"],
      delay: vi.fn(async () => undefined),
      log: vi.fn(),
      state: {},
    } as unknown as ProviderDomFlowContext;
  }

  it("keeps polling while the sources pane is still filling in", async () => {
    // Deep research settles the answer with a few inline citations, then populates
    // the full pane a beat later. Reading once loses most of the sources.
    const inlineOnly = JSON.stringify([{ title: "github", url: "https://github.com/nodejs/node" }]);
    const full = JSON.stringify([
      { title: "github", url: "https://github.com/nodejs/node" },
      { title: "bun", url: "https://bun.com/" },
      { title: "endoflife", url: "https://endoflife.date/nodejs" },
    ]);

    const sources = await extractPerplexitySources(ctxReturning([inlineOnly, full, full]));
    expect(sources).toHaveLength(3);
    expect(sources.map((s) => s.url)).toContain("https://endoflife.date/nodejs");
  });

  it("returns an empty list when the answer cites nothing", async () => {
    const sources = await extractPerplexitySources(ctxReturning([JSON.stringify([])]));
    expect(sources).toEqual([]);
  });

  it("tolerates malformed payloads", async () => {
    const sources = await extractPerplexitySources(ctxReturning(["not json"]));
    expect(sources).toEqual([]);
  });
});

describe("perplexityDomProvider.submitPrompt", () => {
  function submitCtx(options: { submittedAfter: number; input?: Record<string, unknown> }): {
    ctx: ProviderDomFlowContext;
    calls: { submitChecks: number };
  } {
    const calls = { submitChecks: 0 };
    const evaluate = vi.fn(async (expression: string) => {
      if (expression.includes("getBoundingClientRect")) return { x: 5, y: 5 };
      if (expression.includes("onConversation")) {
        calls.submitChecks += 1;
        return calls.submitChecks > options.submittedAfter;
      }
      return undefined;
    });
    const ctx = {
      prompt: "hi",
      evaluate: evaluate as ProviderDomFlowContext["evaluate"],
      delay: vi.fn(async () => undefined),
      log: vi.fn(),
      state: { baselineTurns: 0, input: options.input },
    } as unknown as ProviderDomFlowContext;
    return { ctx, calls };
  }

  it("returns as soon as the send is confirmed", async () => {
    const { ctx } = submitCtx({ submittedAfter: 0 });
    await expect(perplexityDomProvider.submitPrompt(ctx)).resolves.toBeUndefined();
  });

  it("retries with a real Enter keypress when the click does not register", async () => {
    // Clicking Submit is a no-op while the composer settles after attachments are
    // added, which silently dropped multi-file runs until the send was verified.
    const dispatchKeyEvent = vi.fn(async () => undefined);
    const { ctx } = submitCtx({ submittedAfter: 6, input: { dispatchKeyEvent } });

    await expect(perplexityDomProvider.submitPrompt(ctx)).resolves.toBeUndefined();
    expect(dispatchKeyEvent).toHaveBeenCalled();
  });

  it("throws when the composer never sends", async () => {
    const { ctx } = submitCtx({ submittedAfter: 999, input: { dispatchKeyEvent: vi.fn() } });
    await expect(perplexityDomProvider.submitPrompt(ctx)).rejects.toThrow(/did not send/i);
  });
});

describe("perplexityDomProvider attachments", () => {
  function uploadCtx(composerText: string) {
    const setFileInputFiles = vi.fn(async () => undefined);
    const setIntercept = vi.fn(async () => undefined);
    let chooserHandler: ((event: { backendNodeId: number }) => unknown) | undefined;
    const unsubscribe = vi.fn();

    const evaluate = vi.fn(async (expression: string) => {
      if (expression.includes("getBoundingClientRect")) return { x: 1, y: 1 };
      if (expression.includes("innerText")) return composerText;
      return undefined;
    });

    const ctx = {
      prompt: "hi",
      evaluate: evaluate as ProviderDomFlowContext["evaluate"],
      delay: vi.fn(async () => undefined),
      log: vi.fn(),
      state: {
        attachments: [{ path: "/tmp/teapot.png", displayPath: "teapot.png" }],
        attachmentTimeoutMs: 1_000,
        input: { dispatchMouseEvent: vi.fn(async () => undefined) },
        dom: { setFileInputFiles },
        page: {
          setInterceptFileChooserDialog: setIntercept,
          fileChooserOpened: (handler: (event: { backendNodeId: number }) => unknown) => {
            chooserHandler = handler;
            return unsubscribe;
          },
        },
      },
    } as unknown as ProviderDomFlowContext;

    return { ctx, setFileInputFiles, setIntercept, unsubscribe, fire: () => chooserHandler };
  }

  it("matches a chip whose extension changed during upload", async () => {
    // Perplexity transcodes uploads: teapot.png comes back as "teapot.jpg", so
    // confirmation matches the file name stem rather than the full basename.
    const { ctx, setIntercept, unsubscribe } = uploadCtx("teapot.jpg 656.5 KB");
    await expect(uploadPerplexityAttachments(ctx)).resolves.toBeUndefined();
    expect(setIntercept).toHaveBeenCalledWith({ enabled: true });
    expect(setIntercept).toHaveBeenLastCalledWith({ enabled: false });
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("times out with the missing file named when no chip appears", async () => {
    const { ctx, setIntercept } = uploadCtx("no attachments here");
    await expect(uploadPerplexityAttachments(ctx)).rejects.toThrow(/teapot/i);
    // Interception must be turned back off even when the upload fails.
    expect(setIntercept).toHaveBeenLastCalledWith({ enabled: false });
  });
});

describe("extractPerplexityImages", () => {
  function ctxReturningImages(payload: string): ProviderDomFlowContext {
    const evaluate = vi.fn(async (expression: string) =>
      expression.includes("user-gen-media-assets") ? payload : undefined,
    );
    return {
      prompt: "hello",
      evaluate: evaluate as ProviderDomFlowContext["evaluate"],
      delay: vi.fn(async () => undefined),
      log: vi.fn(),
      state: {},
    } as unknown as ProviderDomFlowContext;
  }

  it("returns generated images with their dimensions", async () => {
    const images = await extractPerplexityImages(
      ctxReturningImages(
        JSON.stringify([
          {
            url: "https://user-gen-media-assets.s3.amazonaws.com/gpt4o_images/a.png",
            width: 1536,
            height: 1024,
          },
        ]),
      ),
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.width).toBe(1536);
  });

  it("drops entries without a url and tolerates malformed payloads", async () => {
    expect(await extractPerplexityImages(ctxReturningImages(JSON.stringify([{}])))).toEqual([]);
    expect(await extractPerplexityImages(ctxReturningImages("not json"))).toEqual([]);
  });
});

describe("PERPLEXITY_SELECTORS", () => {
  it("targets the stable composer id discovered in the live UI", () => {
    expect(PERPLEXITY_SELECTORS.input).toContain("#ask-input");
    expect(PERPLEXITY_SELECTORS.submit).toContain('button[aria-label="Submit"]');
  });
});
