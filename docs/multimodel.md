# Multi-Model Execution

Status: **shipped** (November 21, 2025)  
Owner: Oracle CLI

This document describes the architecture for Oracle’s multi-model mode. A single CLI invocation can fan out the same prompt/files to multiple models (GPT-5 variants, Gemini, Claude, etc.), run them in parallel, and capture outputs side-by-side.

---

## Goals

1. **Consistent UX** – users type the prompt once and get a compact summary showing how each model responded (status, cost, elapsed time, answer snippet).
2. **Safe concurrency** – API requests run in parallel but everything else (file attachment, prompt rendering, logging, session writes) stays deterministic.
3. **Disk clarity** – session artifacts stay human-readable and forward-compatible.
4. **Filterable history** – `oracle session --status` and `oracle session <id>` can filter by model, show partial completion, and recover from interrupted runs.
5. **Extensible** – adding another model alias requires no schema migrations.

---

## CLI Surface

| Flag                                      | Description                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--model <name>`                          | When multi-model is not requested, behavior is unchanged.                                                         |
| `--models <comma-separated>`              | Multi-model fan-out. Accepts `MODEL_CONFIGS` keys and aliases (“5.1 instant”). Mutually exclusive with `--model`. |
| `--allow-partial`, `--partial <fail\|ok>` | Default `fail` exits 1 if any model fails. `ok` exits 0 when at least one model succeeds.                         |
| `oracle session --status --model <name>`  | Filters the status table to only show sessions that touched `<name>`.                                             |
| `oracle session <id> --model <name>`      | Shows only the metadata/log for `<name>`; omit the flag to display all models sequentially.                       |

Execution flow: CLI normalizes the `--models` list, builds the prompt/files once, then dispatches per-model runs with isolated logs. Standard output prints each model section sequentially (`[gpt-5.1-pro] …`, then `[gemini-3-pro] …`).

When some models fail, Oracle prints a structured multi-model result. If `--write-output` is set, saved outputs are listed before failures so agents and humans can recover the usable answers first.

---

## Session Storage

Sessions live under `~/.oracle/sessions/<sessionId>`:

```
sessionId/
├── meta.json             # shared session metadata + request
├── output.log            # combined view (headers + concatenated model logs)
└── models/
    ├── gpt-5.1-pro.json    # per-model metadata
    ├── gpt-5.1-pro.log     # per-model log
    ├── gemini-3-pro.json
    ├── gemini-3-pro.log
    └── …
```

The CLI renders per-model logs without interleaving tokens. Aggregate cost/tokens are derived from the per-model usage files.

---

## Implementation Notes

- Storage helpers live in `src/sessionManager.ts` and `src/sessionStore.ts`; callers never touch paths directly.
- Multi-model orchestration runs through `src/cli/sessionRunner.ts` and `src/oracle/multiModelRunner.ts`, which schedule per-model runs and emit model-specific logs.
- Background mode still applies per model (e.g., GPT-5 Pro defaults to background; Claude is forced foreground).
- MCP server and TUI honor the multi-model layout: `oracle session --status` shows compact per-model icons; `oracle session <id> --model foo` renders a single model log.

---

## Testing

- Unit tests cover session storage + log rendering.
- Manual checklist: see `docs/manual-tests.md` (multi-model section) for cross-model smoke steps.
