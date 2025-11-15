# Agent Instructions

This repository relies on autonomous agents to run the `oracle` CLI safely. When you update the runner or CLI behavior, add a short note here so future agents inherit the latest expectations. These guidelines supplement the existing system/developer instructions.

## Current Expectations

- When a user pastes a CLI command that is failing and you implement a fix, only execute that command yourself as the *final* verification step. (Skip the rerun entirely if the command would be destructive or dangerous—ask the user instead.)
 - Browser runs now exist (`oracle --browser`). They spin up a Chrome helper process, log its PID in the session output, and shouldn't be combined with `--preview`. If you modify this flow, keep `docs/browser-mode.md` updated.
 - Browser mode inherits the `--model` flag as its picker target—pass strings like `--model "ChatGPT 5.1 Instant"` to hit UI-only variants; canonical API names still map to their default labels automatically.
