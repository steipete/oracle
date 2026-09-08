---
name: oracle-advisor
description: Request a second-model consultation with explicit API, browser, or render transport and per-run provenance. Use when transport choice or model/effort evidence is part of the request; the existing oracle skill remains the browser-first workflow.
---

# Oracle advisor

Use Oracle to ask an advisory model about selected context. The advisor returns
advice; the calling agent remains responsible for checking it and making edits.
This skill reuses the existing Oracle CLI and MCP tools. It does not add a new
command, MCP method, or native desktop adapter.

## Select the allowed transport

Honor the caller's transport, model, effort, files, output requirements, and
choice of a fresh consultation or an explicit follow-up. Existing authorization
persists; do not ask again when a permitted route is already clear.

- **API:** use an explicitly configured and authorized provider. Pass
  `--engine api` and the requested model; preserve required reasoning settings.
- **Browser:** use the authorized signed-in browser route. Pass
  `--engine browser`; confirm the requested model and effort through Oracle's
  selection evidence. Browser availability alone does not authorize a fallback.
- **Render:** use `--render` to prepare a bundle for manual handoff. This creates
  no model answer or completed consultation; report the bundle as ready to send.
- **Native desktop:** unavailable in this skill. Chat, Work, and Codex sharing a
  UI is not evidence of an agent-callable delegation interface. Do not improvise
  private IPC, cookie extraction, or UI automation as a native adapter.

If the requested route is unavailable, use an alternative only when the caller
has already allowed it. Otherwise explain the missing capability and ask for
the transport choice. Never silently reduce the required model or effort.

## Run the consultation

Inspect `oracle --help --verbose` for the installed version. For an execution
route, preview the exact bundle with the chosen engine and `--dry-run full`;
for render, inspect the rendered bundle directly. Use `--files-report` for token
estimates. A preview's predicted route is not execution evidence. Include the problem,
relevant constraints, and the requested answer format in the prompt. Send only
the selected task context, with credentials excluded.

Examples using an installed Oracle:

```bash
oracle --engine api --model gpt-5.4 --wait \
  --prompt "Review this package metadata for compatibility risks." --file package.json

oracle --engine browser --model gpt-5.6-sol --browser-thinking-time pro \
  --prompt "Review this package metadata for compatibility risks." --file package.json

oracle --render \
  --prompt "Review this package metadata for compatibility risks." --file package.json
```

MCP callers can use `consult` with explicit `engine`, `model`, and browser
controls, and inspect `sessions` with `detail:true`. If a call detaches or times
out, inspect its existing session before retrying; do not create a duplicate
consultation. Use `--followup <session-id>` only when continuing that conversation
is intended. Preserve a browser conversation with the existing explicit
archive/keep controls when the caller requests it.

## Return evidence with the advice

Keep required model and effort separate. Report the answer (or the incomplete state), transport, session reference,
available conversation reference, requested model/effort, observed or effective
values, and the evidence supporting each observation. Use session metadata and
logs; mark missing observations as unknown.

A configured API model is a requested/effective route, not independent proof of
the backend that served it. A browser picker label proves UI selection, not
server-side execution identity. A completed answer alone cannot prove an effort
constraint. If a required constraint is contradicted or remains unverified,
report that the consultation did not satisfy it, even if text was returned.

Keep uncertainty attached to the relevant claim. Verify the advice against the
repository and tests before acting on it.
