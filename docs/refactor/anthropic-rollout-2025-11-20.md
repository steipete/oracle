---
title: Anthropic rollout follow-ups
summary: Lessons, gaps, and next steps after shipping Claude support.
date: 2025-11-20
description: Notes and cleanup tasks after adding Claude 4.5 Sonnet / 4.1 Opus.
---

## What changed
- Added Anthropic API support (Sonnet 4.5, Opus 4.1) with tokenizer wrapper, per-provider env/base URL handling, and background/search opt-outs.
- Updated CLI docs, config handling, and model aliases; cost estimation marks Claude as approximate.
- Introduced per-model `supportsBackground`/`supportsSearch` flags to avoid forcing the OpenAI Responses flow on providers that lack it.
- Added tests for Anthropic streaming, multi-model background gating, and CLI routing.
- CI fix pending for Ubuntu (`libsecret-1-0` needed for keytar).

## What I'd do differently next time
- Add a provider-agnostic tool layer first so search/tooling could be toggled on per provider without adapter-specific branches.
- Build a shared tokenizer harness that accepts `{role, content}` messages and raw strings to avoid per-provider glue.
- Wire a small “run smoke with fake provider” test shim to avoid needing real API keys for sanity checks.
- Start with CI dependency audit (keytar/libsecret) earlier to keep Ubuntu runners green while iterating.

## Follow-ups
- Land the Ubuntu CI `libsecret-1-0` install or gate keytar when `CI=1`.
- Monitor Anthropic model IDs; add resolver if dated IDs start appearing.
- Add prompt-caching-aware cost estimation once the API exposes cached token counts.
