# Phase 4: Reattach & Session Support

## Overview

Deep Research runs take 5-30 minutes. If a run is interrupted (timeout, network issue, user Ctrl+C), the research continues in ChatGPT. Oracle's reattach mechanism should support reconnecting to in-progress Deep Research sessions and extracting results.

## How Reattach Works Today

Oracle's reattach flow (`src/browser/reattach.ts`):

1. User runs `oracle session <slug>` or auto-reattach triggers
2. Load session metadata (chrome port, conversation URL, target ID)
3. Reconnect to Chrome via CDP
4. Navigate to the conversation URL
5. Call `waitForAssistantResponse` with a short timeout
6. Extract the response text

## Changes Needed

### 4.1 `src/browser/reattach.ts`

#### In `resumeBrowserSession` and `resumeBrowserSessionViaNewChrome`:

When the session config has `deepResearch: true`:

```typescript
if (sessionConfig.deepResearch) {
  // Deep Research may still be running — use extended timeout
  const deepResearchTimeout = sessionConfig.timeoutMs ?? DEEP_RESEARCH_DEFAULT_TIMEOUT_MS;

  // First check if research is already complete
  const quickCheck = await checkDeepResearchStatus(Runtime, logger);

  if (quickCheck.completed) {
    // Research finished while we were disconnected — extract result
    logger("Deep Research already completed, extracting result...");
    return await extractDeepResearchResult(Runtime, logger);
  }

  // Research still in progress — resume monitoring
  logger(`Deep Research still in progress, resuming monitoring (timeout: ${Math.round(deepResearchTimeout / 60_000)}min)...`);
  return await waitForDeepResearchCompletion(Runtime, logger, deepResearchTimeout);
}
```

### 4.2 New Helper: `checkDeepResearchStatus`

Add to `src/browser/actions/deepResearch.ts`:

```typescript
export async function checkDeepResearchStatus(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<{
  completed: boolean;
  inProgress: boolean;
  hasIframe: boolean;
  textLength: number;
}> {
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const finishedBtns = document.querySelector(${JSON.stringify(FINISHED_ACTIONS_SELECTOR)});
      const stopBtn = document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)});
      const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
        const rect = f.getBoundingClientRect();
        return rect.width > 200 && rect.height > 200;
      });
      const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastTurn = turns[turns.length - 1];
      const textLength = (lastTurn?.textContent || '').length;
      return {
        completed: Boolean(finishedBtns),
        inProgress: Boolean(stopBtn) || iframes.length > 0,
        hasIframe: iframes.length > 0,
        textLength,
      };
    })()`,
    returnByValue: true,
  });

  const val = result?.value as {
    completed?: boolean;
    inProgress?: boolean;
    hasIframe?: boolean;
    textLength?: number;
  } | undefined;

  return {
    completed: val?.completed ?? false,
    inProgress: val?.inProgress ?? false,
    hasIframe: val?.hasIframe ?? false,
    textLength: val?.textLength ?? 0,
  };
}
```

### 4.3 Session Store: Persist Deep Research Flag

In `src/sessionStore.ts`, ensure `deepResearch` is persisted with the session:

```typescript
// When saving session
session.browserConfig.deepResearch = runOptions.deepResearch;

// When loading session for reattach
const isDeepResearch = session.browserConfig?.deepResearch ?? false;
```

### 4.4 Auto-Reattach Adjustments

In `src/browser/index.ts`, when building auto-reattach config for Deep Research:

```typescript
if (deepResearch) {
  // Override auto-reattach timing for Deep Research
  effectiveAutoReattachDelay = Math.max(
    config.autoReattachDelayMs ?? 0,
    120_000, // Wait at least 2 minutes before first reattach attempt
  );
  effectiveAutoReattachInterval = Math.max(
    config.autoReattachIntervalMs ?? 0,
    60_000, // Check every minute
  );
  effectiveAutoReattachTimeout = Math.max(
    config.autoReattachTimeoutMs ?? 0,
    300_000, // 5 minutes per attempt
  );
}
```

### 4.5 `oracle status` Command

The `oracle status` command shows running sessions. For Deep Research sessions, display the mode:

```typescript
const modeLabel = session.browserConfig?.deepResearch
  ? " [Deep Research]"
  : "";
console.log(`  ${session.slug}${modeLabel} — ${session.status} (${elapsed})`);
```

### 4.6 Zombie Session Detection

In `src/browser/index.ts` or session management code, adjust zombie timeout for Deep Research:

```typescript
// Deep Research sessions should not be considered zombies for at least 40 minutes
const effectiveZombieTimeout = session.browserConfig?.deepResearch
  ? Math.max(zombieTimeoutMs, DEEP_RESEARCH_DEFAULT_TIMEOUT_MS)
  : zombieTimeoutMs;
```

## Reattach Flow Diagram

```
oracle session <slug>
  │
  ├── Load session metadata
  │     └── deepResearch: true, conversationUrl: /c/xxx
  │
  ├── Reconnect to Chrome (existing logic)
  │
  ├── Navigate to conversation URL (existing logic)
  │
  ├── checkDeepResearchStatus()
  │     │
  │     ├── completed: true
  │     │     └── extractDeepResearchResult() → return report
  │     │
  │     ├── inProgress: true
  │     │     └── waitForDeepResearchCompletion() → return report
  │     │
  │     └── neither (error state)
  │           └── Try normal waitForAssistantResponse as fallback
  │
  └── Return result
```

## Edge Cases

### Research completed but page not refreshed
- On reattach, the page is already at the conversation URL
- `FINISHED_ACTIONS_SELECTOR` should be visible immediately
- `checkDeepResearchStatus` handles this case

### Chrome was closed during research
- Research continues server-side in ChatGPT
- On reattach, launch new Chrome, sync cookies, navigate to conversation URL
- Research result should be waiting (ChatGPT preserves it)

### Multiple Deep Research sessions
- Oracle's session management already handles multiple sessions
- Each session has its own slug and conversation URL
- Reattach targets a specific session

### Rate limits
- ChatGPT Plus has limited Deep Research uses per month
- If Deep Research is unavailable, `activateDeepResearch` will throw when the dropdown item is missing
- Error message should mention subscription tier requirements
