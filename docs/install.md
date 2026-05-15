---
title: Install
description: "Install Oracle via Homebrew, npm, or run on demand with npx. Node 24+ required."
---

## Homebrew (macOS / Linux)

```bash
brew install steipete/tap/oracle
```

The tap also publishes the `oracle-notifier` macOS helper used by long-running browser runs.

## npm / pnpm

```bash
npm install -g @steipete/oracle
# or
pnpm add -g @steipete/oracle
```

Requires Node **24 or newer**. After install:

```bash
oracle --help
oracle --version
```

## Run without installing

```bash
npx -y @steipete/oracle --help
pnpx @steipete/oracle --help
```

`npx` is fine for CI, ad-hoc scripts, or when you don't want a global binary on the box. Cache the package in CI by pinning the version (`@steipete/oracle@0.12.0`) so you don't re-download on every job.

## API keys (optional)

API mode is opt-in and reads keys from the environment. Set whichever providers you'll use:

| Provider     | Env var                                                           | Models                                        |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------- |
| OpenAI       | `OPENAI_API_KEY`                                                  | GPT-5.x, GPT-5.x Pro, GPT-5.1 Codex           |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `..._DEPLOYMENT` | Same models, hosted on Azure                  |
| Google       | `GEMINI_API_KEY`                                                  | Gemini 3.1 Pro (API-only), Gemini 3 Pro       |
| Anthropic    | `ANTHROPIC_API_KEY`                                               | Claude Sonnet 4.6, Claude Opus 4.1            |
| OpenRouter   | `OPENROUTER_API_KEY`                                              | Any OpenRouter id (e.g. `minimax/minimax-m2`) |

If no key is set, Oracle defaults to **browser mode** and drives ChatGPT directly — see [Browser Mode](browser-mode.md) for the manual-login flow.

## Where Oracle stores state

| Path                       | Contents                                                 |
| -------------------------- | -------------------------------------------------------- |
| `~/.oracle/config.json`    | Defaults (JSON5). See [Configuration](configuration.md). |
| `~/.oracle/sessions/<id>/` | Run logs, bundles, transcripts, generated artifacts      |
| `~/.oracle/cookies.json`   | (Optional) inline ChatGPT cookies for browser mode       |

Override the root with `ORACLE_HOME_DIR=/some/path` if you'd rather keep state under XDG config or per-project.

## Updating

```bash
brew upgrade oracle      # Homebrew
npm update -g @steipete/oracle
```

`oracle --version` reports the current build. Releases land on [GitHub Releases](https://github.com/steipete/oracle/releases) with notes copied from the [changelog](https://github.com/steipete/oracle/blob/main/CHANGELOG.md).
