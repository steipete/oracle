# Phase 2: Core Action Module — `deepResearch.ts`

## Overview

Create `src/browser/actions/deepResearch.ts` — the core automation logic for activating, monitoring, and completing Deep Research runs. This module follows the same pattern as `thinkingTime.ts` and `modelSelection.ts`.

## New File: `src/browser/actions/deepResearch.ts`

### Imports

```typescript
import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  DEEP_RESEARCH_PLUS_BUTTON,
  DEEP_RESEARCH_DROPDOWN_ITEM_TEXT,
  DEEP_RESEARCH_PILL_LABEL,
  DEEP_RESEARCH_POLL_INTERVAL_MS,
  DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
  DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
```

### Function 1: `activateDeepResearch`

Activates the Deep Research mode by clicking the "+" button and selecting "Deep research" from the dropdown.

```typescript
export async function activateDeepResearch(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<void>
```

**DOM Expression Logic** (runs inside Chrome via `Runtime.evaluate`):

```
Step 1: Find and click [data-testid="composer-plus-btn"]
  - Fallback: button with aria-label containing "Add files"
  - If not found, throw "composer-plus-btn not found"

Step 2: Wait for radix dropdown to appear
  - Poll for [data-radix-collection-item] elements (up to 3s)
  - If no dropdown items found, throw "dropdown did not open"

Step 3: Find item with text "Deep research"
  - Iterate [data-radix-collection-item] elements
  - Match textContent.trim() === "Deep research" (case-insensitive fallback)
  - If not found, collect all item texts and throw descriptive error:
    "Deep research option not found in dropdown. Available: [Create image, Shopping research, ...]"

Step 4: Click the Deep Research item
  - Use dispatchClickSequence for React compatibility

Step 5: Verify activation
  - Poll for Deep Research pill in composer (up to 5s)
  - Check: .__composer-pill-composite with aria-label containing "Deep research"
  - Alternative: button text "Deep research" in composer footer area
  - If pill not found, throw "Deep Research mode did not activate"
```

**Implementation Pattern** — following `ensureThinkingTime` from `thinkingTime.ts`:

```typescript
export async function activateDeepResearch(
  Runtime: ChromeClient["Runtime"],
  _Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<void> {
  const expression = buildActivateDeepResearchExpression();
  const outcome = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = outcome.result?.value as
    | { status: "activated" }
    | { status: "already-active" }
    | { status: "plus-button-missing" }
    | { status: "dropdown-item-missing"; available?: string[] }
    | { status: "pill-not-confirmed" }
    | undefined;

  switch (result?.status) {
    case "activated":
      logger("Deep Research mode activated");
      return;
    case "already-active":
      logger("Deep Research mode already active");
      return;
    case "plus-button-missing":
      throw new BrowserAutomationError(
        "Could not find the composer plus button to activate Deep Research.",
        { stage: "deep-research-activate", code: "plus-button-missing" },
      );
    case "dropdown-item-missing": {
      const hint = result.available?.length
        ? ` Available options: ${result.available.join(", ")}`
        : "";
      throw new BrowserAutomationError(
        `"Deep research" option not found in composer dropdown.${hint} ` +
        "This feature may require a ChatGPT Plus or Pro subscription.",
        { stage: "deep-research-activate", code: "dropdown-item-missing" },
      );
    }
    case "pill-not-confirmed":
      throw new BrowserAutomationError(
        "Deep Research pill did not appear after selection. The UI may have changed.",
        { stage: "deep-research-activate", code: "pill-not-confirmed" },
      );
    default:
      throw new BrowserAutomationError(
        "Unexpected result from Deep Research activation.",
        { stage: "deep-research-activate" },
      );
  }
}
```

**DOM Expression Builder**:

```typescript
function buildActivateDeepResearchExpression(): string {
  const plusBtnSelector = JSON.stringify(DEEP_RESEARCH_PLUS_BUTTON);
  const targetText = JSON.stringify(DEEP_RESEARCH_DROPDOWN_ITEM_TEXT);
  const pillLabel = JSON.stringify(DEEP_RESEARCH_PILL_LABEL);

  return `(async () => {
    ${buildClickDispatcher()}

    // Step 0: Check if already active
    const existingPill = document.querySelector('.__composer-pill-composite');
    if (existingPill) {
      const pillText = existingPill.textContent?.trim() || '';
      const pillAria = existingPill.querySelector('button')?.getAttribute('aria-label') || '';
      if (pillText.toLowerCase().includes('deep research') ||
          pillAria.toLowerCase().includes('deep research')) {
        return { status: 'already-active' };
      }
    }

    // Step 1: Click plus button
    const plusBtn = document.querySelector(${plusBtnSelector}) ||
      Array.from(document.querySelectorAll('button')).find(
        b => (b.getAttribute('aria-label') || '').toLowerCase().includes('add files')
      );
    if (!plusBtn) return { status: 'plus-button-missing' };
    dispatchClickSequence(plusBtn);

    // Step 2: Wait for dropdown
    const waitForDropdown = () => new Promise((resolve) => {
      let elapsed = 0;
      const tick = () => {
        const items = document.querySelectorAll('[data-radix-collection-item]');
        if (items.length > 0) { resolve(items); return; }
        elapsed += 150;
        if (elapsed > 3000) { resolve(null); return; }
        setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    });
    const items = await waitForDropdown();
    if (!items) return { status: 'dropdown-item-missing', available: [] };

    // Step 3: Find "Deep research" item
    const target = ${targetText}.toLowerCase();
    let match = null;
    const available = [];
    for (const item of items) {
      const text = (item.textContent || '').trim();
      available.push(text);
      if (text.toLowerCase() === target) {
        match = item;
      }
    }
    if (!match) return { status: 'dropdown-item-missing', available };

    // Step 4: Click it
    dispatchClickSequence(match);

    // Step 5: Verify pill appeared
    const waitForPill = () => new Promise((resolve) => {
      let elapsed = 0;
      const tick = () => {
        const pills = document.querySelectorAll('.__composer-pill-composite');
        for (const pill of pills) {
          const text = pill.textContent?.trim() || '';
          const aria = pill.querySelector('button')?.getAttribute('aria-label') || '';
          if (text.toLowerCase().includes('deep research') ||
              aria.toLowerCase().includes('deep research')) {
            resolve(true); return;
          }
        }
        elapsed += 200;
        if (elapsed > 5000) { resolve(false); return; }
        setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
    });
    const pillConfirmed = await waitForPill();
    return pillConfirmed ? { status: 'activated' } : { status: 'pill-not-confirmed' };
  })()`;
}
```

### Function 2: `waitForResearchPlanAutoConfirm`

After prompt submission, waits for the research plan to appear and auto-confirm.

```typescript
export async function waitForResearchPlanAutoConfirm(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  autoConfirmWaitMs: number = DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
): Promise<void>
```

**Logic**:

```
1. Poll (every 2s, up to 30s) for research plan indicator:
   - Check for iframe in assistant response area
   - Check for text containing "research plan" or status like "Researching..."
   - The plan appears quickly after submit (usually within 5-10s)

2. Once plan detected:
   - Log "Research plan generated, waiting for auto-confirm..."
   - Wait autoConfirmWaitMs (default 70s)
   - During this wait, periodically check if already confirmed
     (iframe might disappear early if user clicks Start manually)

3. After wait, verify research has started:
   - Check for active research indicators ("Researching...", status text changes)
   - If still showing plan after 90s, log warning but continue

4. Log "Research started, monitoring progress..."
```

**Implementation**:

```typescript
export async function waitForResearchPlanAutoConfirm(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  autoConfirmWaitMs: number = DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
): Promise<void> {
  // Phase A: Detect research plan appearance
  const planDeadline = Date.now() + 60_000; // 60s to see plan
  let planDetected = false;

  while (Date.now() < planDeadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        // Check for iframe (research plan container)
        const iframes = document.querySelectorAll('iframe');
        const hasResearchIframe = Array.from(iframes).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        // Check for research status text in assistant area
        const assistantText = (document.querySelector('[data-message-author-role="assistant"]')?.textContent || '').toLowerCase();
        const hasResearchText = assistantText.includes('researching') ||
          assistantText.includes('research plan') ||
          assistantText.includes('survey') ||
          assistantText.includes('analyze');
        return { hasResearchIframe, hasResearchText };
      })()`,
      returnByValue: true,
    });

    const val = result?.value as { hasResearchIframe?: boolean; hasResearchText?: boolean } | undefined;
    if (val?.hasResearchIframe || val?.hasResearchText) {
      planDetected = true;
      logger("Research plan detected, waiting for auto-confirm countdown...");
      break;
    }
    await delay(2_000);
  }

  if (!planDetected) {
    logger("Warning: Research plan not detected within 60s; continuing (may have auto-confirmed already)");
    return;
  }

  // Phase B: Wait for auto-confirm
  const confirmStart = Date.now();
  while (Date.now() - confirmStart < autoConfirmWaitMs) {
    // Check if research already started (early confirmation)
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const iframes = document.querySelectorAll('iframe');
        const hasLargeIframe = Array.from(iframes).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        const text = (document.body?.innerText || '').toLowerCase();
        const isResearching = text.includes('researching...') ||
          text.includes('reading sources') ||
          text.includes('considering');
        return { hasLargeIframe, isResearching };
      })()`,
      returnByValue: true,
    });
    const val = result?.value as { hasLargeIframe?: boolean; isResearching?: boolean } | undefined;

    // If research status text appeared, the plan was confirmed
    if (val?.isResearching) {
      logger("Research plan confirmed, execution started");
      return;
    }

    await delay(5_000);
  }

  logger("Auto-confirm wait complete, proceeding to monitor research progress");
}
```

### Function 3: `waitForDeepResearchCompletion`

Polls for Deep Research completion over 5-30 minutes.

```typescript
export async function waitForDeepResearchCompletion(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs: number = DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}>
```

**Logic**:

```
Poll every DEEP_RESEARCH_POLL_INTERVAL_MS (5s), up to timeoutMs:

1. Check for FINISHED_ACTIONS_SELECTOR (copy/thumbs buttons)
   → Definitive completion signal

2. Check for stop button
   → Still generating = research in progress

3. Read assistant response text length
   → Track progress, detect stalls

4. Every 60s, log status update:
   "Deep Research in progress... {elapsed}s elapsed, {textLength} chars so far"

5. On completion:
   → Extract full text via existing captureAssistantMarkdown/readAssistantSnapshot
   → Return structured result

6. On timeout:
   → Throw BrowserAutomationError with stage: "deep-research-timeout"
   → Include partial text and runtime metadata for reattach
```

**Implementation**:

```typescript
export async function waitForDeepResearchCompletion(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs: number = DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const start = Date.now();
  let lastLogTime = start;
  let lastTextLength = 0;
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);

  logger(`Monitoring Deep Research (timeout: ${Math.round(timeoutMs / 60_000)}min)...`);

  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const finished = Boolean(document.querySelector(${finishedSelector}));
        const stopVisible = Boolean(document.querySelector(${stopSelector}));
        // Get assistant response text length
        const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
        const lastTurn = turns[turns.length - 1];
        const textLength = (lastTurn?.textContent || '').length;
        // Check for iframe (research still in plan/execution phase)
        const hasIframe = Array.from(document.querySelectorAll('iframe')).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        return { finished, stopVisible, textLength, hasIframe };
      })()`,
      returnByValue: true,
    });

    const val = result?.value as {
      finished?: boolean;
      stopVisible?: boolean;
      textLength?: number;
      hasIframe?: boolean;
    } | undefined;

    // Completion detected
    if (val?.finished) {
      logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      // Extract the full response using existing patterns
      return await extractDeepResearchResult(Runtime, logger);
    }

    // Progress logging every 60 seconds
    const now = Date.now();
    if (now - lastLogTime >= 60_000) {
      const elapsed = Math.round((now - start) / 1000);
      const chars = val?.textLength ?? 0;
      const phase = val?.hasIframe ? "researching" : val?.stopVisible ? "generating" : "waiting";
      logger(`Deep Research ${phase}... ${elapsed}s elapsed, ~${chars} chars`);
      lastLogTime = now;
    }

    lastTextLength = val?.textLength ?? lastTextLength;
    await delay(DEEP_RESEARCH_POLL_INTERVAL_MS);
  }

  // Timeout — try to extract partial result
  const elapsed = Math.round((Date.now() - start) / 1000);
  throw new BrowserAutomationError(
    `Deep Research did not complete within ${Math.round(timeoutMs / 60_000)} minutes (${elapsed}s elapsed). ` +
    `Use 'oracle session <id>' to reattach later, or increase --timeout.`,
    {
      stage: "deep-research-timeout",
      code: "deep-research-timeout",
      elapsedMs: Date.now() - start,
      lastTextLength,
    },
  );
}
```

### Helper: `extractDeepResearchResult`

Reuses existing assistant response extraction logic:

```typescript
async function extractDeepResearchResult(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  // Use the same extraction logic as waitForAssistantResponse
  // but target the last assistant turn which contains the Deep Research report
  // ... delegates to existing captureAssistantMarkdown / readAssistantSnapshot
}
```

## Exports

```typescript
export {
  activateDeepResearch,
  waitForResearchPlanAutoConfirm,
  waitForDeepResearchCompletion,
};
```

## Key Design Decisions

1. **Text matching for "Deep research"**: Use exact text match (`textContent.trim() === "Deep research"`) with case-insensitive fallback. More robust than relying on missing `data-testid`.

2. **Auto-confirm over iframe interaction**: The ~60s countdown auto-confirms the research plan. This avoids the complexity of cross-origin iframe DOM manipulation entirely.

3. **5-second poll interval**: Longer than normal response polling (100ms) because Deep Research runs for minutes. Reduces unnecessary CDP calls while still detecting completion promptly.

4. **Progress logging every 60s**: Keeps the user informed during the long wait without spamming output.

5. **Reuse existing extraction**: The final Deep Research report is standard markdown in the conversation. `captureAssistantMarkdown` and `readAssistantSnapshot` from `assistantResponse.ts` should work unchanged.
