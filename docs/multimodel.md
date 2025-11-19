# Multi-Model Execution

Status: **in progress** (November 19, 2025)  
Owner: Oracle CLI

This document describes the planned architecture for Oracle’s upcoming “multi-model” mode. The goal is to let a single CLI invocation fan out the same prompt/files to multiple foundation models (OpenAI GPT-5 variants, Gemini, future Anthropic entries, etc.), monitor them in parallel, and capture the outputs side-by-side.

The plan below is intentionally detailed so we can coordinate code changes across the CLI, session store, and user documentation.

---

## Goals

1. **Consistent UX** – users type the prompt once and get a compact summary showing how each model responded (status, cost, elapsed time, answer snippet).
2. **Safe concurrency** – API requests run in parallel but everything else (file attachment, prompt rendering, logging, session writes) stays deterministic.
3. **Disk clarity** – session artifacts must stay understandable by humans (inspectable directory tree) and by new CLI versions; we do *not* need old CLI builds to read the new format.
4. **Filterable history** – `oracle session --status` and `oracle session <id>` can filter by model, show partial completion, and recover from interrupted runs.
5. **Extensible** – adding another model alias requires no schema migrations; we just drop another file next to the existing ones.

Non-goals: batching unrelated prompts, merging responses, or performing auto-debates between models. This is strictly “ask the same question to N models.”

---

## CLI Surface

| Flag | Description |
| --- | --- |
| `--model <name>` | Existing flag; when multi-model is not requested, behavior is unchanged. |
| `--models <comma-separated>` | New flag. Accepts `MODEL_CONFIGS` keys and aliases (“5.1 instant”). Mutually exclusive with `--model`. |
| `--model` + `--models` | Error if both provided. |
| `oracle session --status --model <name>` | Filters the status table to only show sessions that touched `<name>`. |
| `oracle session <id> --model <name>` | Shows only the metadata/log for `<name>`; omit the flag to display all models sequentially with headers. |

**Execution flow**

1. CLI normalizes `--models` into an ordered `ModelName[]`.
2. Shared prompt/files resolved once (build prompt, token estimates).
3. Controller kicks off `runOracleSingle(model)` for each model using the existing streaming pipeline but with dedicated log sinks (one per model).
4. Output printed to stdout sequentially: `[gpt-5.1-pro] ...answer...` followed by `[gemini-3-pro] ...`. Live streaming uses the per-model logs so viewing tools never see interleaved tokens.

---

## Session Storage Layout

Every session keeps the same top-level directory (`~/.oracle/sessions/<sessionId>`), but the contents change:

```
sessionId/
├── meta.json             # shared session metadata + request payload
├── output.log            # combined view (headers + concatenated model logs)
└── models/
    ├── gpt-5.1-pro.json    # per-model metadata snapshot
    ├── gpt-5.1-pro.log     # streaming log (append-only, plain text)
    ├── gemini-3-pro.json
    ├── gemini-3-pro.log
    └── ...               # repeat for every model in the run
```

Properties:

- `meta.json` mirrors the old `session.json` payload (prompt, files, flags, effective model ids), so replay tools can load context without parsing every per-model file.
- `output.log` remains the human-readable combined transcript. We append a header (`=== gpt-5.1-pro ===`) before each per-model log dump so `oracle session <id>` can replay everything sequentially without interleaving tokens.
- `models/<name>.json` stores:
  ```json5
  {
    "model": "gpt-5.1-pro",
    "status": "completed",
    "queuedAt": "2025-11-19T00:00:00.000Z",
    "startedAt": "2025-11-19T00:00:02.123Z",
    "completedAt": "2025-11-19T00:00:32.456Z",
    "usage": { "inputTokens": 12345, "outputTokens": 678, "reasoningTokens": 0, "totalTokens": 13023, "cost": 0.97 },
    "response": { "id": "resp_...", "requestId": "req_..." },
    "transport": { "reason": null },
    "error": null,
    "log": { "path": "models/gpt-5.1-pro.log", "bytes": 18234 }
  }
  ```
- `models/<name>.log` is the raw stream. We append “header” lines (e.g., `🧿 oracle summons gpt-5.1-pro…`) so replays look identical to the live run. Logs stay on disk indefinitely so we can reattach/watch old sessions without embedding huge strings into JSON.

Backward compatibility: new CLI loads `models/*.json`. If none exist (old session), it falls back to the legacy `session.json` layout.

---

## State Machine

Each per-model JSON moves through:

1. `pending` – stub written by `initializeSession` before execution starts.
2. `running` – `queuedAt` + `startedAt` set right before dispatch; log file is created and begins streaming.
3. `completed` – final timestamps, usage, response metadata written; log stays on disk. `runController` aggregates totals for CLI display but no longer needs a combined JSON.
4. `error` – same as completed but with `error` + `transport` details.
5. `cancelled` – optional future state.

The overall session status is implicit: if any model is `running`, we render the session as running; once all are `completed`, we render “completed”; if every model either completed or errored, the session is “error” when at least one failed.

---

## CLI Rendering Rules

- **Status table**: one row per session. The “Model” column becomes a compact string of `<alias><state-icon>` pairs (e.g., `5.1-pro✓ 5.1⌛ gem3❌`). Icons reflect each model’s current state.
- **Session attach**:
  - Without `--model`: iterate models in alphabetical order, printing a header and then the corresponding log file (entire contents once completed; live tail when still running).
  - With `--model foo`: only print metadata and log for `foo`.
  - When a log exceeds the render limit, fall back to raw text (same behavior as today).

## TUI / Session Detail UX

- Launch `oracle` with no args to open the TUI. Selecting a session now shows a `Models:` summary that lists each model, status, and token usage totals.
- Actions include “View combined log” plus one entry per model (`View gpt-5.1-pro log (completed)` etc.). This keeps the combined log deterministic while still letting you inspect an individual log in isolation.
- Refreshing the detail screen re-reads metadata/logs so partial completions (some models done, others still running) are accurately reflected without restarting the TUI.

---

## Implementation Checklist

1. **Session storage**
   - Add helpers in `sessionManager.ts` to write/read `meta.json`, `models/<model>.json`, and `models/<model>.log`.
   - Ensure `initializeSession` creates the directory tree upfront.
   - Implement upgrade path: when `models/` is empty but `session.json` exists, convert the legacy record into memory so CLI output still works.

2. **Run orchestration**
   - Introduce `runOracleMulti` helper that accepts shared prompt/files and kicks off per-model `runOracle`.
   - Provide per-model log writers so streaming text never interleaves.
   - Update session metadata when each model switches states.

3. **CLI**
   - Add `--models` flag (comma-separated) and validation logic.
   - Expand `session --status` / `attachSession` / `showStatus` to read the new per-model files, format compact status strings, and honor `--model` filters.
   - Update notifications to send one alert per session summarizing all models (or future enhancement: per-model alerts).

4. **Docs & Tests**
   - Keep this document updated as implementation evolves.
   - Add unit tests covering storage helpers and CLI filters.
   - Extend manual test plan (docs/manual-tests.md) with multi-model scenarios.

---

## Open Questions

1. Should we auto-delete per-model logs after some retention period? (Default: keep indefinitely.)
2. Do we need to stream stdout live for *all* models, or is it enough to show one at a time and buffer the rest?
3. Should `oracle session --status` include cost totals per model, or keep the current compact “model + icon” display?

Feedback welcome—this document should evolve alongside the implementation.
