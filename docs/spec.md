---
title: Spec
description: "What Oracle is, what it isn't, and the design constraints behind the CLI."
---

This page captures the design constraints. The README and the rest of the docs describe how Oracle behaves; this page describes _why_.

## Goals

1. **One CLI to every Pro model.** Same flags, same session store, same bundling rules whether the answer comes from GPT-5.5 Pro, Gemini 3 Pro, or Claude Opus.
2. **Runs on every box.** macOS first, Linux and Windows supported. Browser mode optional.
3. **Stable artifacts.** `--render` is contracted; session metadata stays machine-readable; stderr is for humans.
4. **Bundles, not chats.** Oracle assembles a deterministic prompt+files bundle and ships it once. Chat-style interactivity is the agent's job, not Oracle's.
5. **Storage owned by the user.** Sessions are local files under `~/.oracle/sessions/` (override with `ORACLE_HOME_DIR`). No cloud account, no telemetry.
6. **Built for agents.** Coding agents (Claude Code, Codex, Cursor) and any MCP host should be able to call Oracle without friction.

## Non-goals

- **Not a chat client.** Oracle doesn't try to replace ChatGPT's UI. Browser mode drives ChatGPT; it doesn't reimplement it.
- **Not a model.** Oracle has no opinions about reasoning quality. It bundles, ships, and stores.
- **Not a security boundary.** API keys live in your environment. Cookies live in your browser profile or in a JSON file you control.
- **Not a quota manager.** API mode bills go to your provider account directly. Oracle reports usage, doesn't gate.

## Bundling rules

The bundle Oracle ships is deterministic given the same args and same files. That means:

- Files are read in glob expansion order, then de-duplicated.
- `.gitignore` is honored.
- Default-ignored dirs: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp`. Pass them explicitly to override.
- Symlinks are not followed.
- Dotfiles are filtered unless the glob has a dot-segment (`--file ".github/**"`).
- File size cap defaults to 1 MB. Override with `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` in config.

## Engine selection

Auto-pick rules:

1. If `--engine` is set, use it.
2. Else if `engine` is set in `~/.oracle/config.json`, use it.
3. Else if `OPENAI_API_KEY` (or another supported API key) is set, use API.
4. Else use browser.

Browser engine handles ChatGPT (GPT-\* models) and Gemini (Gemini-\*); everything else is API only.

## Session lifecycle states

| State       | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `pending`   | Created, not started yet (rare; usually a transient state).   |
| `running`   | In progress.                                                  |
| `completed` | Final answer captured.                                        |
| `failed`    | Error captured; partial output may still be in `response.md`. |
| `zombie`    | No activity past `--zombie-timeout`; process likely gone.     |

## Compatibility commitments

- Session metadata schema is stable across minor releases. Keys may be added; existing keys won't change shape without a major bump.
- Session folder layout (`meta.json` / `prompt.md` / `response.md` / `log.jsonl` / `artifacts/`) is stable.
- Top-level commands (`status`, `session`, `restart`, `serve`, `bridge`, `tui`) are stable.
- Flag names are stable; deprecated flags get compatibility warnings before removal.

## Versioning

[Semver](https://semver.org/). The CLI surface is the public API. The internal Node modules are not — don't import from `dist/` directly.

## Source of truth

- Recent changes: [CHANGELOG.md](https://github.com/steipete/oracle/blob/main/CHANGELOG.md).
- Open issues / direction: [GitHub Issues](https://github.com/steipete/oracle/issues).
- Release process: [Releasing](RELEASING.md).
