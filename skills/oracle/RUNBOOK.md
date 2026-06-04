# Oracle Runbook

## Waiting out long browser consults (`oracle-await`)

Browser GPT-5.5 Pro / Pro Extended consults can outlive MCP client request
timeouts. An MCP `-32001` timeout does not prove the ChatGPT run stopped. The
browser tab may continue, finish, and still leave local metadata stale if the
MCP/controller process was killed before finalization.

Do not trust `meta.json` `status:"running"` as authoritative after a client
timeout. Render every poll cycle:

```bash
oracle-await <slug-or-id>
# defaults: first wait 5m, render every 3m, cap 22m
# override: oracle-await <id> [first_wait_s] [interval_s] [max_s]
```

Exit codes:

- `0`: READY, transcript path and answer printed.
- `2`: still running or not captured by the cap.
- `3`: session reported an error.
- `4`: unknown session or missing wrapper.

Manual equivalent:

```bash
oracle session <slug-or-id> --render
```

`--render` is both check and recovery: it reattaches to the stored ChatGPT tab,
captures `artifacts/transcript.md`, and flips the session to `completed` when a
stable answer is present.

If metadata says `status:"error"` but `artifacts/transcript.md` exists and is
non-empty, treat the transcript as the result. This can happen when Node/undici
crashes during wrapper cleanup (for example `setTypeOfService EINVAL`) after
the browser answer was already captured. Do not rerun; read/render the saved
session.

## Continuing a saved browser conversation (`oracle follow-up`)

Use `follow-up` when the saved ChatGPT conversation has useful context and you
want one more turn:

```bash
oracle follow-up <parent-session-id> --prompt "Ask the next question" --slug "next review turn"
oracle follow-up <parent-session-id> "Ask the next question" --wait
```

This creates a new child session with its own metadata, log, lifecycle, and
`artifacts/transcript.md`. The parent session remains the audit record for the
earlier run. `oracle session --harvest` and `oracle session --live` stay
read-only recovery/inspection tools; they do not add turns.

Follow-up v1 is prompt-only. Start a new `oracle consult` if the next turn needs
fresh files or attachments.

## MCP timeout triage

MCP `consult` browser runs block by default for compatibility. If an agent needs
recoverable early-return behavior for a long browser consult, pass
`browserDetached:true` in the MCP `consult` input or set
`ORACLE_MCP_BROWSER_DETACHED=1` for that MCP host.

If an MCP browser consult times out after opening Chrome:

1. Do not rerun immediately.
2. List sessions with `oracle status --hours 72`.
3. Run `oracle-await <slug>` if the session exists.
4. If no session exists, restart the MCP host and verify it points at the
   canonical wrapper/build, not a stale checkout path.

Always pass an explicit `slug` for long MCP browser consults so the session is
easy to recover after a timeout.
