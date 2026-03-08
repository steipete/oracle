# Phase 1: Types, Config, and CLI Flag

## Overview

Add the `deepResearch` boolean flag throughout the configuration pipeline: TypeScript types → browser config defaults → CLI option → session persistence.

## File Changes

### 1.1 `src/browser/types.ts`

Add `deepResearch` to `BrowserAutomationConfig` (after `thinkingTime` on line 61):

```typescript
/** Enable ChatGPT Deep Research mode (browser engine only). */
deepResearch?: boolean;
```

Add to `ResolvedBrowserConfig` (after `thinkingTime` on line 113):

```typescript
deepResearch?: boolean;
```

Add to `BrowserRunOptions` (after `verbose` on line 75):

```typescript
/** Whether this is a Deep Research run (affects timeouts and response detection). */
deepResearch?: boolean;
```

### 1.2 `src/browser/config.ts`

In `DEFAULT_BROWSER_CONFIG`, add:

```typescript
deepResearch: false,
```

In `resolveBrowserConfig`, propagate the value and override timeouts when Deep Research is active:

```typescript
const deepResearch = config.deepResearch ?? false;

// Deep Research runs take 5-30 minutes; use generous default timeout
const effectiveTimeoutMs = deepResearch && !config.timeoutMs
  ? 2_400_000 // 40 minutes
  : resolvedTimeoutMs;
```

### 1.3 `src/browser/constants.ts`

Add a new section for Deep Research selectors:

```typescript
// Deep Research selectors
export const DEEP_RESEARCH_PLUS_BUTTON = '[data-testid="composer-plus-btn"]';
export const DEEP_RESEARCH_DROPDOWN_ITEM_TEXT = 'Deep research';
export const DEEP_RESEARCH_PILL_LABEL = 'Deep research';
// Polling interval for Deep Research completion (5 seconds)
export const DEEP_RESEARCH_POLL_INTERVAL_MS = 5_000;
// Auto-confirm wait time (countdown ~60s + 10s safety margin)
export const DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS = 70_000;
// Default timeout for Deep Research completion (40 minutes)
export const DEEP_RESEARCH_DEFAULT_TIMEOUT_MS = 2_400_000;
```

### 1.4 `src/sessionStore.ts` (or `src/sessionManager.ts`)

Add `deepResearch?: boolean` to `BrowserSessionConfig`:

```typescript
export interface BrowserSessionConfig {
  // ... existing fields ...
  thinkingTime?: ThinkingTimeLevel;
  deepResearch?: boolean; // <-- add
}
```

This ensures the session can be resumed with the correct Deep Research flag.

### 1.5 `src/config.ts` (top-level)

Add `deepResearch?: boolean` to `BrowserConfigDefaults`:

```typescript
export interface BrowserConfigDefaults {
  // ... existing fields ...
  thinkingTime?: ThinkingTimeLevel;
  deepResearch?: boolean; // <-- add
}
```

### 1.6 `src/cli/browserConfig.ts`

Add to `BrowserFlagOptions`:

```typescript
deepResearch?: boolean;
```

In `buildBrowserConfig`, propagate:

```typescript
deepResearch: options.deepResearch ?? defaults?.deepResearch ?? false,
```

When `deepResearch` is true, override model strategy:

```typescript
// Deep Research has its own mode; skip model picker interaction
if (deepResearch) {
  modelStrategy = 'ignore';
}
```

### 1.7 `src/cli/browserDefaults.ts`

In `applyBrowserDefaultsFromConfig`, read from config file:

```typescript
deepResearch: config.deepResearch ?? undefined,
```

### 1.8 `bin/oracle-cli.ts`

Register the CLI flag (after `--browser-thinking-time`):

```typescript
.addOption(
  new Option(
    "--deep-research",
    "Use ChatGPT Deep Research mode (browser engine only). " +
    "Activates autonomous web research that takes 5-30 minutes. " +
    "Requires ChatGPT Plus or Pro subscription."
  ).default(false)
)
```

In the options processing logic:

```typescript
// --deep-research implies browser engine
if (options.deepResearch) {
  if (!options.engine) {
    options.engine = 'browser';
  }
  if (options.engine !== 'browser') {
    console.error('--deep-research requires --engine browser');
    process.exit(1);
  }
}
```

Wire to browser config:

```typescript
const browserConfig = buildBrowserConfig({
  // ... existing options ...
  deepResearch: options.deepResearch,
});
```

### 1.9 `~/.oracle/config.json` Support

Users can set Deep Research as default in their config:

```json5
{
  "deepResearch": false,
  // When deepResearch is true, these defaults make sense:
  "timeout": "40m",
  "engine": "browser"
}
```

## Validation Rules

1. `--deep-research` is mutually exclusive with `--models` (multi-model runs don't make sense for Deep Research)
2. `--deep-research` forces `engine: "browser"` — API mode does not support this feature
3. `--deep-research` skips model selection (`modelStrategy: "ignore"`)
4. `--deep-research` skips thinking time selection (Deep Research replaces the Thinking pill)
5. When `--deep-research` is active and no explicit `--timeout` is given, default to 40 minutes

## Dependencies

None — this phase is pure type/config plumbing with no runtime logic.
