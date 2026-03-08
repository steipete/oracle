# Deep Research Browser Automation — Implementation Plan

## Goal

Add ChatGPT Deep Research support to Oracle's browser automation engine, enabling users to trigger Deep Research from the CLI and receive structured research reports — all using their existing ChatGPT subscription (no API cost).

## Motivation

- ChatGPT Deep Research is a powerful autonomous research agent that browses the web for 5-30 minutes and produces comprehensive cited reports
- OpenAI offers a Deep Research API (`o3-deep-research`, `o4-mini-deep-research`), but it costs ~$10/M input + $40/M output tokens per run
- Users with ChatGPT Plus/Pro subscriptions already have Deep Research included — browser automation lets them use it programmatically at no extra cost
- Oracle already has mature ChatGPT browser automation; extending it for Deep Research is a natural fit

## Usage

```bash
# Basic Deep Research
oracle --deep-research -p "Research the latest trends in AI agent frameworks in 2026"

# With file context
oracle --deep-research -p "Analyze this codebase architecture" --file "src/**/*.ts"

# With custom timeout (default 40 minutes)
oracle --deep-research --timeout 60m -p "Comprehensive market analysis of EV industry"
```

## Architecture Decision: Iframe Handling

The research plan confirmation UI renders in a **cross-origin iframe** (640x400px), making direct DOM manipulation from the main page impossible. Three options were evaluated:

| Option | Approach | Complexity | Robustness |
|--------|----------|------------|------------|
| **A. Wait for auto-confirm** | Start button has ~60s countdown that auto-confirms | Low | High |
| B. CDP iframe targeting | Use `Target.getTargets()` to find iframe execution context | High | Medium |
| C. Coordinate-based clicking | Use `Input.dispatchMouseEvent` at computed coordinates | Medium | Low |

**Decision: Option A.** The auto-confirm countdown eliminates the need to interact with the iframe at all. After detecting the iframe appears, simply wait ~70 seconds for auto-confirmation. This is the most robust approach and matches natural user behavior.

## Implementation Phases

| Phase | Scope | Doc |
|-------|-------|-----|
| 1 | Types, Config, CLI Flag | [01-types-and-config.md](01-types-and-config.md) |
| 2 | Core Action Module (`deepResearch.ts`) | [02-core-actions.md](02-core-actions.md) |
| 3 | Main Flow Integration (`index.ts`) | [03-flow-integration.md](03-flow-integration.md) |
| 4 | Reattach & Session Support | [04-reattach-and-sessions.md](04-reattach-and-sessions.md) |
| 5 | Testing Strategy | [05-testing.md](05-testing.md) |

## UI Flow (Discovered via Live Exploration)

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Activate Deep Research Mode                        │
│                                                             │
│  [+] button → radix dropdown → "Deep research" item         │
│  Result: "Thinking" pill → "Deep research" pill             │
│          + "Apps" and "Sites" buttons appear                 │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Phase 2: Submit Prompt                                      │
│                                                             │
│  Type prompt in textbox → click [send-button]               │
│  URL changes to /c/{conversation-id}                        │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Phase 3: Research Plan (CROSS-ORIGIN IFRAME)                │
│                                                             │
│  ┌──────────────────────────────────────┐                   │
│  │ "AI agent frameworks trends"         │                   │
│  │ ○ Survey academic papers...          │                   │
│  │ ○ Review documentation...            │                   │
│  │ ○ Analyze blog posts...              │                   │
│  │                                      │                   │
│  │ [Edit]  [Cancel]  [Start (53)]       │                   │
│  └──────────────────────────────────────┘                   │
│  Auto-confirms after ~60 second countdown                   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Phase 4: Research Execution (5-30 minutes)                  │
│                                                             │
│  Status updates in iframe: "Researching..."                 │
│  "Considering methods for framework comparison..."          │
│  [Update] button visible in iframe                          │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Phase 5: Report Complete                                    │
│                                                             │
│  Iframe disappears, full markdown report in conversation    │
│  Copy/Rate buttons appear (FINISHED_ACTIONS_SELECTOR)       │
│  Extract text via existing assistantResponse.ts             │
└─────────────────────────────────────────────────────────────┘
```

## Key DOM Selectors

| Element | Selector | Notes |
|---------|----------|-------|
| "+" button | `[data-testid="composer-plus-btn"]` | Opens radix dropdown |
| Deep Research menu item | `[data-radix-collection-item]` text="Deep research" | No `data-testid` |
| Deep Research pill | `.__composer-pill-composite` with aria "Deep research" | Replaces Thinking pill |
| Send button | `[data-testid="send-button"]` | Same as normal chat |
| Research plan iframe | `iframe.h-full.w-full` inside assistant turn | Cross-origin |
| Completion indicator | `FINISHED_ACTIONS_SELECTOR` (copy/rate buttons) | Existing constant |

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| ChatGPT changes Deep Research UI selectors | Use text-match "Deep research" as primary; multiple fallback selectors |
| Auto-confirm timer changes | Detect confirmation via iframe state change, not fixed timer |
| Research exceeds timeout | Default 40min timeout; `--timeout` override; reattach mechanism for interrupted runs |
| "+" button `data-testid` changes | Fallback: `button[aria-label*="Add files"]`, positional matching |
| Deep Research unavailable for account tier | Clear error message with subscription requirement info |
