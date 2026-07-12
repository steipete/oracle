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

## What's in this PR

Discovery + data-driven match are now **wired into the live selection path** as the
preferred route for `strategy: "select"`, with a safety net: any discovery/match/apply/verify
failure returns null and falls through to the untouched legacy engine. Worst case is one extra
discovery round-trip, then exactly today's behavior — so this can only improve outcomes.

| File | Purpose |
|------|---------|
| `src/oracle/modelInventory.ts` | Types + pure `buildInventoryFromRawItems` (classify/clean/current) |
| `src/oracle/modelMatch.ts` | Pure `matchModelToInventory` + `parseRequest` (generic version, effort synonyms) |
| `src/browser/actions/modelInventoryScrape.ts` | `enumerateModelInventory` / `applyInventorySelection` / `readCurrentSelection` (grounded DOM ops) |
| `src/browser/actions/modelSelection.ts` | `selectViaInventory` orchestrator, tried before the legacy engine |
| `src/browser/types.ts`, `src/cli/browserConfig.ts`, `src/sessionManager.ts` | thread the raw `-m` request as `modelRequest` |
| `tests/oracle/*`, `tests/browser/*` | 26 unit tests incl. the 0.15.2 failures, a future-model case, and a `new Function()` parse-check of every browser expression |

Flow: `ensureModelSelection` → `selectViaInventory` (discover → match → apply → verify) → on any
miss, the existing `buildModelSelectionExpression` loop.

## Live verification (GPT-5.6 "Sol", 2026-07-12)

Driven against a signed-in ChatGPT via the CLI running from source:

- `-m "GPT-5.6 Sol"` → `Model picker (inventory): GPT-5.6 Sol` — the exact input that collapses to
  `gpt-5.2` and fails on published 0.15.2 now resolves correctly (already-selected short-circuit).
- `-m gpt-5.5-pro` → `Model picker (inventory): Pro GPT-5.5` — a real version switch (5.6 Sol → 5.5),
  applied via the version submenu and verified.

Two DOM quirks were found and handled during live testing (both in the tests):
- The composer pill merges version+effort for non-default versions (`5.5Pro`), so verification reads
  the top-menu **version-trigger label** + **checked effort radio**, not the pill.
- After a switch, a **spurious empty** `aria-haspopup="menu"` item can precede the real version
  trigger — trigger detection now requires version-like text.

## Follow-ups (separate commits/PRs)

1. Optional LLM fallback for `ambiguous` / `not-found`: send the enumerated options (as an **enum
   constraint** so it can't hallucinate) to a cheap model; gated behind API-key availability or an
   opt-in flag, cached, off by default (browser users often have no API key).
2. Once discovery is proven in the field, retire the hard-coded version ladder / testid tokens in
   `buildModelSelectionExpression` and keep it only as a deep fallback.
3. Thread the *pre-inference* `-m` literal (today `modelRequest` is the CLI-resolved id) so a brand-new
   version the CLI doesn't recognize still matches purely from the live menu.

## Notes / edge cases handled

- Text noise: `"Instant5.5"` → `Instant`, `"GPT-5.4Leaving on July 23"` → `GPT-5.4`.
- `o3` classified as a version, never mangled to effort `o`.
- Version-agnostic `-m Pro` keeps the current version, switches only the effort (today's behavior).
- Bare `thinking` (no level) → flagged `ambiguous` (a natural LLM-fallback trigger).
