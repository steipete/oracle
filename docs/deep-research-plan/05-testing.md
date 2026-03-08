# Phase 5: Testing Strategy

## Overview

Testing follows Oracle's existing patterns: unit tests with mocked CDP, integration tests for full flows, and optional live tests against real Chrome + ChatGPT.

## Test Files

### 5.1 Unit Tests: `tests/browser/deepResearch.test.ts`

Following the pattern from `thinkingTime.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  activateDeepResearch,
  waitForResearchPlanAutoConfirm,
  waitForDeepResearchCompletion,
  checkDeepResearchStatus,
} from "../../src/browser/actions/deepResearch.js";

// Mock CDP Runtime
const mockRuntime = {
  evaluate: vi.fn(),
};
const mockInput = {};
const mockLogger = Object.assign(vi.fn(), { verbose: false, sessionLog: vi.fn() });
```

#### Test Cases for `activateDeepResearch`:

```typescript
describe("activateDeepResearch", () => {
  it("activates Deep Research when all steps succeed", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "activated" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as any, mockInput as any, mockLogger),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith("Deep Research mode activated");
  });

  it("returns early when already active", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "already-active" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as any, mockInput as any, mockLogger),
    ).resolves.toBeUndefined();
  });

  it("throws when plus button is missing", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "plus-button-missing" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as any, mockInput as any, mockLogger),
    ).rejects.toThrow(/composer plus button/);
  });

  it("throws with available options when Deep Research item missing", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          status: "dropdown-item-missing",
          available: ["Create image", "Web search", "Shopping research"],
        },
      },
    });
    await expect(
      activateDeepResearch(mockRuntime as any, mockInput as any, mockLogger),
    ).rejects.toThrow(/Deep research.*not found.*Available.*Create image/);
  });

  it("throws when pill does not confirm", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "pill-not-confirmed" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as any, mockInput as any, mockLogger),
    ).rejects.toThrow(/pill did not appear/);
  });
});
```

#### Test Cases for `waitForResearchPlanAutoConfirm`:

```typescript
describe("waitForResearchPlanAutoConfirm", () => {
  it("detects research plan and waits for auto-confirm", async () => {
    // First poll: plan detected
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { hasResearchIframe: true, hasResearchText: false } },
    });
    // Subsequent polls: research started
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { hasLargeIframe: false, isResearching: true } },
    });

    await expect(
      waitForResearchPlanAutoConfirm(mockRuntime as any, mockLogger, 1000),
    ).resolves.toBeUndefined();
  });

  it("handles plan not detected gracefully", async () => {
    // All polls: nothing detected
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { hasResearchIframe: false, hasResearchText: false } },
    });

    await expect(
      waitForResearchPlanAutoConfirm(mockRuntime as any, mockLogger, 100),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith(
      expect.stringContaining("not detected"),
    );
  });
});
```

#### Test Cases for `waitForDeepResearchCompletion`:

```typescript
describe("waitForDeepResearchCompletion", () => {
  it("detects completion via finished actions", async () => {
    // First poll: still in progress
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { finished: false, stopVisible: true, textLength: 100, hasIframe: true } },
    });
    // Second poll: completed
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { finished: true, stopVisible: false, textLength: 5000, hasIframe: false } },
    });
    // Extract result
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { text: "Research report...", turnId: "t1", messageId: "m1" } },
    });

    const result = await waitForDeepResearchCompletion(
      mockRuntime as any, mockLogger, 60_000,
    );
    expect(result.text).toContain("Research report");
  });

  it("throws on timeout with metadata", async () => {
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { finished: false, stopVisible: true, textLength: 500, hasIframe: true } },
    });

    await expect(
      waitForDeepResearchCompletion(mockRuntime as any, mockLogger, 500),
    ).rejects.toThrow(/did not complete/);
  });
});
```

#### Test Cases for `checkDeepResearchStatus`:

```typescript
describe("checkDeepResearchStatus", () => {
  it("reports completed when finished actions visible", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { completed: true, inProgress: false, hasIframe: false, textLength: 5000 } },
    });
    const status = await checkDeepResearchStatus(mockRuntime as any, mockLogger);
    expect(status.completed).toBe(true);
    expect(status.inProgress).toBe(false);
  });

  it("reports in-progress when iframe present", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { completed: false, inProgress: true, hasIframe: true, textLength: 0 } },
    });
    const status = await checkDeepResearchStatus(mockRuntime as any, mockLogger);
    expect(status.completed).toBe(false);
    expect(status.inProgress).toBe(true);
  });
});
```

### 5.2 DOM Expression Tests: `tests/browser/deepResearchExpressions.test.ts`

Test the generated DOM expressions in isolation (following `promptComposerExpressions.test.ts` pattern):

```typescript
describe("Deep Research DOM expressions", () => {
  it("buildActivateDeepResearchExpression generates valid JavaScript", () => {
    const expr = buildActivateDeepResearchExpression();
    // Verify it contains expected selectors
    expect(expr).toContain('composer-plus-btn');
    expect(expr).toContain('Deep research');
    expect(expr).toContain('data-radix-collection-item');
  });
});
```

### 5.3 Integration Test: `tests/browser/deepResearchFlow.test.ts`

Full flow test with mocked CDP client:

```typescript
describe("Deep Research full flow", () => {
  it("completes end-to-end: activate, submit, plan, research, extract", async () => {
    const mockClient = createMockCDPClient();

    // Setup mock responses for each phase:
    // 1. Activation succeeds
    // 2. Prompt submission succeeds
    // 3. Plan appears and auto-confirms
    // 4. Research completes
    // 5. Text extraction succeeds

    // Run the full browser mode flow with deepResearch: true
    const result = await runBrowserMode({
      prompt: "Test research query",
      config: { deepResearch: true, timeoutMs: 10_000 },
      log: mockLogger,
    });

    expect(result.answerText).toBeTruthy();
    expect(result.tookMs).toBeGreaterThan(0);
  });
});
```

### 5.4 CLI Tests: `tests/cli/deepResearchConfig.test.ts`

```typescript
describe("--deep-research CLI flag", () => {
  it("forces browser engine", () => {
    const config = buildBrowserConfig({ deepResearch: true });
    expect(config.deepResearch).toBe(true);
  });

  it("sets model strategy to ignore", () => {
    const config = buildBrowserConfig({ deepResearch: true });
    expect(config.modelStrategy).toBe("ignore");
  });

  it("sets extended default timeout", () => {
    const config = buildBrowserConfig({ deepResearch: true });
    expect(config.timeoutMs).toBeGreaterThanOrEqual(2_400_000);
  });

  it("is mutually exclusive with --models", () => {
    expect(() => {
      validateOptions({ deepResearch: true, models: ["gpt-5.2", "gemini-3-pro"] });
    }).toThrow();
  });
});
```

### 5.5 Live Test: `tests/live/deep-research-live.test.ts`

Following the pattern from `gemini-deep-think-live.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

const LIVE = process.env.ORACLE_LIVE_TESTS === "1";

describe.skipIf(!LIVE)("Deep Research live", () => {
  it(
    "submits a research query and receives a report",
    async () => {
      // This test requires:
      // - Chrome with active ChatGPT session
      // - ChatGPT Plus or Pro subscription
      // - ORACLE_LIVE_TESTS=1 environment variable

      const result = await runBrowserMode({
        prompt: "What are the top 3 programming languages by GitHub usage in 2026? Brief summary only.",
        config: {
          deepResearch: true,
          timeoutMs: 1_800_000, // 30 minutes
        },
        log: console.log,
      });

      expect(result.answerText).toBeTruthy();
      expect(result.answerText.length).toBeGreaterThan(500);
      expect(result.tookMs).toBeGreaterThan(60_000);
    },
    1_800_000, // 30 minute test timeout
  );
});
```

### 5.6 Manual Test Checklist

Append to `docs/manual-tests.md`:

```markdown
## Deep Research (Browser)

### Prerequisites
- Chrome signed into ChatGPT (Plus or Pro)
- Oracle installed globally or via npx

### Test 1: Basic Deep Research
oracle --deep-research -p "Summarize the top 3 AI agent frameworks in 2026" -v

Expected:
- Activates Deep Research pill in composer
- Submits prompt
- Research plan appears (cross-origin iframe)
- Auto-confirms after ~60 seconds
- Research runs for 5-15 minutes
- Final report extracted as markdown

### Test 2: Deep Research with file context
oracle --deep-research -p "Analyze this project architecture" --file "src/**/*.ts" -v

Expected:
- Files uploaded first
- Deep Research activated after upload
- Prompt includes file context

### Test 3: Reattach to interrupted Deep Research
# Start, then Ctrl+C during research
oracle --deep-research -p "Comprehensive market analysis" --timeout 2m -v
# Reattach
oracle session <slug>

Expected:
- Session saved with deepResearch flag
- Reattach detects Deep Research in progress
- Monitors until completion or timeout

### Test 4: Error - Deep Research unavailable
# Test with a free-tier account
oracle --deep-research -p "Test query" -v

Expected:
- Clear error message about subscription requirement
- Lists available dropdown options

### Test 5: Custom timeout
oracle --deep-research --timeout 60m -p "Very detailed research topic" -v

Expected:
- Timeout set to 60 minutes
- Session does not expire prematurely
```

## Test Coverage Targets

| Area | Coverage Goal | Method |
|------|--------------|--------|
| `activateDeepResearch` | All 5 status codes | Unit test |
| `waitForResearchPlanAutoConfirm` | Plan detected, plan missed, early confirm | Unit test |
| `waitForDeepResearchCompletion` | Completion, timeout, progress tracking | Unit test |
| `checkDeepResearchStatus` | All 3 states | Unit test |
| CLI flag parsing | Mutual exclusion, defaults, engine forcing | CLI test |
| Config propagation | All config layers | CLI test |
| Full flow | End-to-end with mocks | Integration test |
| Real ChatGPT | Actual Deep Research run | Live test (manual) |
