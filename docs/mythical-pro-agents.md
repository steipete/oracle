---
title: Mythical Pro Agents
description: "The frontier 'Pro' model lineup Oracle speaks to — GPT-5.5 Pro, Gemini 3 Pro, Claude Opus, Deep Research — and when to reach for each."
---

The headline frontier models — the ones marked **Pro** — are slow, expensive, and gated behind separate consumer subscriptions or per-token bills. Oracle is the single CLI that talks to all of them with the same flags, the same session store, and the same bundling rules.

## The lineup

| Model             | Engine         | API id                  | Browser model picker          | Speciality                                      |
| ----------------- | -------------- | ----------------------- | ----------------------------- | ----------------------------------------------- |
| GPT-5.5 Pro       | API or browser | `gpt-5.5-pro` (default) | "GPT-5.5 Pro" / "5.5 Pro"     | Long-form code review, planning                 |
| GPT-5.5           | API or browser | `gpt-5.5`               | "GPT-5.5"                     | Fast everyday consults                          |
| GPT-5.4 Pro       | API or browser | `gpt-5.4-pro`           | "5.4 Pro"                     | Mature Pro workflow                             |
| GPT-5.4           | API or browser | `gpt-5.4`               | "GPT-5.4"                     | Mid-tier general                                |
| GPT-5.2 Pro       | API or browser | `gpt-5.2-pro`           | "5.2 Pro"                     | Heavy reasoning                                 |
| GPT-5.2           | API or browser | `gpt-5.2`               | "GPT-5.2"                     | Mid-tier                                        |
| GPT-5.1 Pro       | API or browser | `gpt-5.1-pro`           | "5.1 Pro"                     | Long context                                    |
| GPT-5.1           | API or browser | `gpt-5.1`               | "GPT-5.1"                     | General                                         |
| GPT-5.1 Codex     | API only       | `gpt-5.1-codex`         | —                             | Code generation                                 |
| Gemini 3.1 Pro    | API only       | `gemini-3.1-pro`        | —                             | Long-context multimodal                         |
| Gemini 3 Pro      | API or browser | `gemini-3-pro`          | (auto on `gemini.google.com`) | Multimodal, image gen, YouTube, free in browser |
| Claude Opus 4.1   | API only       | `claude-4.1-opus`       | —                             | Deepest single-shot reasoning                   |
| Claude Sonnet 4.6 | API only       | `claude-4.6-sonnet`     | —                             | Fast Claude                                     |

Plus any **OpenRouter** id — e.g. `minimax/minimax-m2`, `openai/gpt-4o-mini`, `qwen/qwen-2.5-coder-32b-instruct` — when you set `OPENROUTER_API_KEY`.

## When to reach for which

### GPT-5.5 Pro (default)

The current "Oracle of last resort." Slow (10 minutes typical, hour+ for huge bundles), expensive on API, free if you have ChatGPT Pro. Best for: **long-form architecture review, multi-file refactors, gnarly bugs that need to chew on the whole repo.**

```bash
oracle --engine browser --model gpt-5.5-pro \
  -p "Plan the auth migration end-to-end" \
  --file "src/auth/**" --file "docs/auth.md"
```

### Gemini 3 Pro

Free in browser mode if you're signed into `gemini.google.com` in Chrome. Also the path for **YouTube transcript analysis** (`--youtube`) and **image generation/edit** (`--generate-image`, `--edit-image`).

```bash
oracle --engine browser --model gemini-3-pro \
  --prompt "a minimalist eye-of-providence logo, vector" \
  --generate-image out.png --aspect 1:1
```

### Claude Opus 4.1

API-only. Best at sustained reasoning over a single tightly-scoped problem; lower hallucination rate on tricky code than Pro GPT models in our experience. Use when the task is "reason carefully" rather than "write a lot."

```bash
oracle -p "Audit this state machine for unreachable transitions" \
  --model claude-4.1-opus --file "src/state/**"
```

### Multi-model triangulation

When the answer matters, ask three:

```bash
oracle -p "Will this migration corrupt user data under concurrent writes?" \
  --models gpt-5.5-pro,gemini-3.1-pro,claude-4.1-opus \
  --file "migrations/0042_user_schema.sql" \
  --file "src/db/**"
```

Oracle aggregates per-model cost in the run summary. See [Multi-model](multimodel.md).

## Deep Research (browser only)

Browser mode can flip ChatGPT into Deep Research mode for cited reports:

```bash
oracle --engine browser --model gpt-5.5-pro \
  --browser-research deep \
  -p "Survey approaches for embedded vector search in a Rust app, with citations"
```

The captured report lands at `~/.oracle/sessions/<id>/artifacts/deep-research-report.md`. Deep Research can run for an hour or more — Oracle stores the session and reattaches.

## Thinking time

Pro / Thinking models in browser mode accept a `--browser-thinking-time` knob:

| Level      | What it maps to in ChatGPT       |
| ---------- | -------------------------------- |
| `light`    | Quick                            |
| `standard` | Default                          |
| `extended` | Pro Extended / Thinking Extended |
| `heavy`    | Heavy thinking                   |

```bash
oracle --engine browser --model gpt-5.5-pro \
  --browser-thinking-time extended \
  -p "Refactor this hot path" --file "src/render/**"
```

## Pricing notes (rough heuristics, not contracts)

- **GPT-5.x Pro** (API): tokens cost meaningfully more than non-Pro. Watch the run summary.
- **GPT-5.x Pro** (browser): "free" with ChatGPT Pro / Plus subscription, but slow.
- **Gemini 3 Pro** (browser): free with a Google account.
- **Claude Opus 4.1**: per-token API only.
- **OpenRouter ids**: pricing varies wildly per provider; always preview with `--dry-run summary`.

`--files-report` plus `--dry-run summary` is the right reflex before any Pro run on a large bundle. Token counts ≠ dollars, but they're a close-enough proxy.

## Engine compatibility

| Capability                 | API               | Browser (ChatGPT)    | Browser (Gemini) |
| -------------------------- | ----------------- | -------------------- | ---------------- |
| GPT-5.x family             | ✅                | ✅                   | —                |
| Gemini 3 / 3.1 Pro         | ✅                | —                    | ✅               |
| Claude Sonnet / Opus       | ✅                | —                    | —                |
| OpenRouter ids             | ✅                | —                    | —                |
| Multi-model in one run     | ✅                | —                    | —                |
| Followup / lineage         | ✅ (OpenAI/Azure) | partial (multi-turn) | —                |
| Image generation           | —                 | ✅                   | ✅               |
| YouTube analysis           | —                 | —                    | ✅               |
| Deep Research              | —                 | ✅                   | —                |
| `--render --copy` fallback | ✅                | ✅                   | ✅               |

See provider-specific docs for the gory details: [OpenAI / Azure / OpenRouter](openai-endpoints.md), [Gemini](gemini.md), [Anthropic](anthropic.md), [Grok](grok.md).
