# Phase 3: Main Flow Integration — `index.ts`

## Overview

Wire the Deep Research actions into Oracle's main browser automation flow in `src/browser/index.ts`. The changes insert Deep Research activation before prompt submission and replace the standard response waiting with Deep Research-specific monitoring.

## Changes to `src/browser/index.ts`

### 3.1 New Imports

Add at the top of the file (after existing action imports):

```typescript
import {
  activateDeepResearch,
  waitForResearchPlanAutoConfirm,
  waitForDeepResearchCompletion,
} from "./actions/deepResearch.js";
```

### 3.2 Flow Modification Point: After Model/Thinking Selection

**Current flow** (lines ~438-486):

```
1. Model selection (ensureModelSelection)
2. Thinking time selection (ensureThinkingTime)
3. Submit prompt (submitOnce)
4. Wait for response (waitForAssistantResponse)
```

**New flow** when `config.deepResearch === true`:

```
1. Model selection → SKIPPED (modelStrategy already set to "ignore" in config)
2. Thinking time → SKIPPED (Deep Research replaces thinking pill)
3. Activate Deep Research mode (NEW)
4. Submit prompt (submitOnce — unchanged)
5. Wait for research plan auto-confirm (NEW)
6. Wait for Deep Research completion (NEW — replaces waitForAssistantResponse)
```

### 3.3 Insert Deep Research Activation

After the thinking time block (line ~486), add:

```typescript
// Handle Deep Research activation if specified
const deepResearch = config.deepResearch ?? false;
if (deepResearch) {
  await raceWithDisconnect(
    withRetries(
      () => activateDeepResearch(Runtime, Input, logger),
      {
        retries: 2,
        delayMs: 500,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Deep Research activation attempt ${attempt + 1}: ${
                error instanceof Error ? error.message : error
              }`,
            );
          }
        },
      },
    ),
  );
  // Ensure prompt textarea is still ready after Deep Research activation
  await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
  logger(
    `Prompt textarea ready (after Deep Research activation, ${promptText.length.toLocaleString()} chars queued)`,
  );
}
```

### 3.4 Conditional Skip of Model Selection and Thinking Time

Wrap the existing model selection and thinking time blocks:

```typescript
// Model selection: skip for Deep Research (handled via pill activation)
if (!deepResearch) {
  if (config.desiredModel && modelStrategy !== "ignore") {
    // ... existing model selection code ...
  }
  // Thinking time: skip for Deep Research
  if (thinkingTime) {
    // ... existing thinking time code ...
  }
}
```

Alternatively, this can be handled in `browserConfig.ts` by forcing `modelStrategy: "ignore"` and `thinkingTime: undefined` when `deepResearch` is true.

### 3.5 Replace Response Waiting for Deep Research

The existing flow after prompt submission (simplified):

```typescript
const { answerText, answerMarkdown, answerHtml, tookMs, answerTokens } =
  await waitForAssistantResponseWithReload(...);
```

Add conditional Deep Research flow:

```typescript
let answerText: string;
let answerMarkdown: string;
let answerHtml: string | undefined;
let tookMs: number;
let answerTokens: number;

if (deepResearch) {
  // Phase A: Wait for research plan auto-confirm
  await raceWithDisconnect(
    waitForResearchPlanAutoConfirm(Runtime, logger),
  );

  // Phase B: Monitor research completion (5-30 minutes)
  const researchResult = await raceWithDisconnect(
    waitForDeepResearchCompletion(Runtime, logger, config.timeoutMs),
  );

  // Phase C: Capture final markdown
  const markdown = await raceWithDisconnect(
    captureAssistantMarkdown(Runtime, logger),
  );

  answerText = researchResult.text;
  answerMarkdown = markdown || researchResult.text;
  answerHtml = researchResult.html;
  tookMs = Date.now() - startedAt;
  answerTokens = estimateTokenCount(answerText);
} else {
  // ... existing normal response waiting flow ...
}
```

### 3.6 Update Session Header Message

In `sessionRunner.ts` (line ~91), modify the timing hint:

```typescript
const timingHint = deepResearch
  ? "This Deep Research run can take 5-30 minutes."
  : "This run can take up to an hour (usually ~10 minutes).";
log(chalk.dim(timingHint));
```

### 3.7 Error Handling Adjustments

For Deep Research timeout errors, include reattach-friendly metadata:

```typescript
if (deepResearch && error instanceof BrowserAutomationError) {
  // Enrich error with session info for reattach
  error.metadata = {
    ...error.metadata,
    deepResearch: true,
    conversationUrl: lastUrl,
    elapsedMs: Date.now() - startedAt,
  };
}
```

### 3.8 Update `pageActions.ts` Re-exports

In `src/browser/pageActions.ts`, add re-exports:

```typescript
export {
  activateDeepResearch,
  waitForResearchPlanAutoConfirm,
  waitForDeepResearchCompletion,
} from "./actions/deepResearch.js";
```

## Flow Diagram

```
runBrowserMode(options)
  │
  ├── connectChrome / syncCookies / navigate (unchanged)
  │
  ├── if (!deepResearch):
  │     ├── ensureModelSelection(...)
  │     └── ensureThinkingTime(...)
  │
  ├── if (deepResearch):
  │     └── activateDeepResearch(Runtime, Input, logger)
  │
  ├── ensurePromptReady(...)  (unchanged)
  │
  ├── submitOnce(prompt, attachments)  (unchanged)
  │
  ├── if (deepResearch):
  │     ├── waitForResearchPlanAutoConfirm(...)  ← NEW (wait ~70s)
  │     ├── waitForDeepResearchCompletion(...)   ← NEW (poll 5-30min)
  │     └── captureAssistantMarkdown(...)        ← EXISTING
  │
  ├── if (!deepResearch):
  │     └── waitForAssistantResponseWithReload(...)  ← EXISTING
  │
  └── return BrowserRunResult
```

## Interaction with Existing Features

### Attachments

File uploads happen BEFORE Deep Research activation, so no conflicts:
1. Upload files (existing `uploadAttachmentFile`)
2. Activate Deep Research pill
3. Submit prompt
4. Wait for research

### Auto-Reattach

The existing `autoReattachDelayMs` / `autoReattachIntervalMs` mechanism works for Deep Research, but the defaults should be longer. When `deepResearch` is true:
- `autoReattachDelayMs`: 120_000 (2 minutes, vs default 60s)
- `autoReattachIntervalMs`: 60_000 (1 minute checks)
- `autoReattachTimeoutMs`: 300_000 (5 minutes per attempt)

### Heartbeat

The existing heartbeat mechanism (`heartbeatIntervalMs`) keeps the session alive during long Deep Research runs. No changes needed.

### Conversation URL Tracking

The `/c/` URL appears immediately after prompt submission (same as normal chat). The existing `scheduleConversationHint` call works unchanged.
