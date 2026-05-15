---
title: Sessions
description: "Every Oracle run is a stored session you can list, replay, follow up on, or prune. Background API runs detach by default; reattach later."
---

Every Oracle run gets an id, a slug, and a folder. You can list runs, render the prompts you sent, replay the answer, and continue from any of them. This page is the lifecycle reference.

## Where sessions live

```
~/.oracle/sessions/<id>/
├── meta.json                # status, model(s), cost, lineage
├── prompt.md                # assembled bundle (what was sent)
├── response.md              # the model's answer (when complete)
├── log.jsonl                # per-event log
└── artifacts/               # browser-only: transcript, generated images, deep-research-report.md
```

Override the root with `ORACLE_HOME_DIR=/some/path`.

## Listing

```bash
oracle status                  # last 20 sessions
oracle status --hours 168      # last week
oracle status --json           # for scripts
```

`status` shows status, model, mode, timestamp, character count, cost, and slug — with a tree of `--followup` lineage:

```
Recent Sessions
Status    Model         Mode    Timestamp           Chars    Cost  Slug
completed gpt-5.2-pro   api     03/01 09:00 AM      1800   $2.110  architecture-review-parent
completed gpt-5.2-pro   api     03/01 09:14 AM      2200   $2.980  ├─ architecture-review-followup
running   gpt-5.2-pro   api     03/01 09:22 AM      1400        -  │  └─ implementation-pass
pending   gpt-5.2-pro   api     03/01 09:25 AM       900        -  └─ risk-check
```

## Replaying

```bash
oracle session <id>            # print metadata + answer
oracle session <id> --render   # print the prompt that was sent
oracle session <id> --json     # structured output
```

Use the slug or a unique id prefix; Oracle resolves both.

## Reattach

GPT-5.x Pro answers can take 10–60 minutes. API runs detach by default — Oracle returns the session id, you reattach later:

```bash
oracle status                  # find the running one
oracle session <id>            # blocks until done, then prints the answer
```

Every new run prints a lifecycle block so foreground and detached behavior is explicit:

```text
Session: 20260515-name-panel
Mode: api background
Models: 3 parallel
Detach: yes, polling
Reattach: oracle session 20260515-name-panel
```

`oracle status` uses compact mode labels such as `api/fg`, `api/bg`, and `br/fg`; `oracle session <id>` shows the persisted execution state.

To block in the original command, pass `--wait`:

```bash
oracle --wait --model gpt-5.5-pro -p "Long architecture review" --file "src/**"
```

For browser runs, ChatGPT sometimes redirects mid-page-load. The auto-reattach flags poll the existing tab without manual intervention:

```bash
oracle --engine browser \
  --browser-timeout 6m \
  --browser-auto-reattach-delay 30s \
  --browser-auto-reattach-interval 2m \
  --browser-auto-reattach-timeout 2m \
  -p "Long UI audit" --file "src/**"
```

See [Browser Mode](browser-mode.md) for the full set.

## Restart

```bash
oracle restart <id>            # re-run with the same prompt + files
```

Useful when a transient browser/API error truncated the answer. Restart copies the bundle, opens a new session, and links lineage back.

## Follow up

Continue an OpenAI / Azure Responses API session with new context:

```bash
oracle --followup <id> -p "Re-evaluate with these files" \
  --file "src/migrations/**"
```

For multi-model parents, pick the lineage with `--followup-model`. See [Followup](followup.md) for the full flow and the formats `--followup` accepts (session ids, slugs, or `resp_…` response ids).

## Background mode

Force a Responses API run into background mode (create + retrieve) regardless of model defaults:

```bash
oracle --background --model gpt-5.5-pro -p "..." --file "src/**"
oracle --no-background --model gpt-5.5 -p "..." --file "src/**"
```

GPT-5.x Pro defaults to background; non-Pro models block by default. Override per-run when needed.

## Pruning

```bash
oracle status --clear --hours 168   # delete sessions older than a week
oracle status --clear --slug pattern   # delete by slug match
```

`--clear` is destructive — preview without it first. Sessions are local files, so `rm -rf ~/.oracle/sessions/<id>` works too.

## Stale / zombie detection

`oracle status` flags stale sessions (process gone, no recent log activity). Tune with:

- `--zombie-timeout <ms|s|m|h>` — cutoff for "stale."
- `--zombie-last-activity` — use last log entry instead of session start.

## Slugs

Every run gets a default slug derived from the prompt. Override with `--slug "my-thing"` for stable names you can reference later (`oracle session my-thing`).

## Naming conventions

Pair `--slug` with conventional prefixes for browseability:

- `arch-…` — architecture / design review
- `bug-…` — debugging session
- `refactor-…` — refactor cross-check
- `plan-…` — planning consult
- `dr-…` — Deep Research run

Then `oracle status --hours 720 | grep arch-` shows your last month of architecture work.
