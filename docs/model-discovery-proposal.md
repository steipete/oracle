# Robust model selection via live inventory discovery

## Problem

Browser-mode model selection is hard-coded in three layers:

1. `cli/options.ts` `inferModelFromLabel` — text → known model id
2. `cli/browserConfig.ts` `BROWSER_MODEL_LABELS` — model id → UI label
3. `browser/actions/modelSelection.ts` `scoreOption` — a per-version ladder
   (`desiredVersion`, `versionFromLabel`, `if (desiredVersion === '5-6' …)`, per-version
   `includes` guards, testid tokens `model-switcher-gpt-5-5` …)

Every new ChatGPT model requires editing all three. GPT-5.6 "Sol" landed in `main` as
~10 hand-added `'5-6'` tokens across `modelSelection.ts`. On the *published* 0.15.2 (no 5.6
tokens), `-m "GPT-5.6 Sol"` silently collapses to `gpt-5.2` and fails:

```
[retry] Unable to find model option matching "GPT-5.2" in the model switcher.
Available: Instant5.5, Medium, High, Extra High, Pro, GPT-5.6 Sol.
```

## Evidence (captured live, 2026-07-12)

The GPT-5.6-era picker **dropped every `data-testid`** and is now a clean
version × effort matrix keyed on `role` + text + `aria-checked`. Full capture and selectors
in `DOM-FINDINGS.md`; raw dump in `model-menu-dom.json`. Structure:

- trigger `button.__composer-pill[aria-haspopup="menu"]` (text = current effort)
- top menu `[role="menuitemradio"]` efforts + one `[role="menuitem"][aria-haspopup="menu"]`
  version trigger
- version submenu `[role="menuitemradio"]` version options
- current selection = `aria-checked="true"`

## Approach: Discover → Match → Apply → Verify

Invert the flow: read what the picker *actually offers*, then match against it — instead of
precomputing a rigid target from a hard-coded ladder.

- **Discover** — `enumerateModelInventory()` scrapes the live menu (incl. version submenu)
  into a structured `ModelInventory` (`versions`, `efforts`, current markers).
- **Match** — `matchModelToInventory(request, inventory)` parses the request generically
  (any version number, effort synonyms) and resolves it against the live options.
- **Apply/Verify** — click the chosen option(s), verify via the resulting label.

Because version parsing is generic, a brand-new model (gpt-5.7, gpt-6, o4) resolves the moment
ChatGPT lists it — **zero code change**. Unavailable requests fail loud with the real candidate
list instead of clicking a phantom.

## What's in this PR (prototype, additive, zero-regression)

| File | Purpose |
|------|---------|
| `src/oracle/modelInventory.ts` | Types + pure `buildInventoryFromRawItems` (classify/clean/current) |
| `src/oracle/modelMatch.ts` | Pure `matchModelToInventory` + `parseRequest` (generic version, effort synonyms) |
| `src/browser/actions/modelInventoryScrape.ts` | `enumerateModelInventory(Runtime)` — grounded DOM scraper |
| `tests/oracle/modelInventory.test.ts` | 6 cases incl. the real 5.6 DOM |
| `tests/oracle/modelMatch.test.ts` | 11 cases incl. the 0.15.2 failures + a future-model case |

`npx vitest run tests/oracle/modelInventory.test.ts tests/oracle/modelMatch.test.ts` → **17 passed**.
Nothing is wired into the live path yet, so there is no behavior change.

## Follow-ups (separate commits)

1. Wire discovery+match into `ensureModelSelection` for `strategy: "select"`, with **fallback to the
   existing `buildModelSelectionExpression`** when discovery fails (keeps all current cases safe).
2. Optional LLM fallback for ambiguous/not-found: send the enumerated options (as an **enum
   constraint** so it can't hallucinate) to a cheap model; gated behind API-key availability or an
   opt-in flag, cached, off by default (browser users often have no API key).
3. Retire the hard-coded version ladder / testid tokens once discovery is the default path.

## Notes / edge cases handled

- Text noise: `"Instant5.5"` → `Instant`, `"GPT-5.4Leaving on July 23"` → `GPT-5.4`.
- `o3` classified as a version, never mangled to effort `o`.
- Version-agnostic `-m Pro` keeps the current version, switches only the effort (today's behavior).
- Bare `thinking` (no level) → flagged `ambiguous` (a natural LLM-fallback trigger).
