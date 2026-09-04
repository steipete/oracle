# oracle 🧿 — Bring a second brain, not a second briefing

<p align="center">
  <img src="./README-header.png" alt="Oracle CLI header banner" width="1100">
</p>

<p align="center">
  <a href="https://github.com/steipete/oracle/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/steipete/oracle/ci.yml?branch=main&style=flat-square&label=ci" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@steipete/oracle"><img src="https://img.shields.io/npm/v/@steipete/oracle?style=flat-square" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/@steipete/oracle?style=flat-square" alt="Node.js version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/steipete/oracle?style=flat-square" alt="License"></a>
  <a href="https://github.com/steipete/homebrew-tap/blob/main/Formula/oracle.rb"><img src="https://img.shields.io/badge/homebrew-steipete%2Ftap-orange?style=flat-square" alt="Homebrew tap"></a>
</p>

Oracle is a CLI and MCP server that bundles a prompt with the files you select, sends that context to an AI model through an API or a signed-in browser, and stores the result as a session. It is for developers and coding agents that need a second-model review grounded in the actual project.

Full documentation is at [askoracle.sh](https://askoracle.sh).

## Install

With Homebrew on macOS or Linux:

```bash
brew install steipete/tap/oracle
```

Or install the npm package globally:

```bash
npm install -g @steipete/oracle
```

Oracle requires Node.js 24 or newer. To try it without installing:

```bash
npx -y @steipete/oracle --help
```

See the [installation guide](docs/install.md) for pnpm, updates, API keys, and storage paths.

## Quick start

Build a review bundle locally before connecting any model:

```bash
oracle --render \
  -p "Review the package metadata for release risks" \
  --file package.json
```

This prints the exact prompt and numbered file contents Oracle would send. It does not need credentials and does not contact a model.

When an engine is configured, remove `--render` to request an answer:

```bash
oracle \
  -p "Audit the model runner for race conditions" \
  --file "src/oracle/**/*.ts" \
  --file "!**/*.test.ts"
```

Oracle chooses API mode when an OpenAI key is available and browser mode otherwise. Use `--engine api` or `--engine browser` to make the choice explicit. The [quickstart](docs/quickstart.md) covers the first API and browser runs.

## Choose an engine

| Path    | Use it when                                                                 | Setup                                                |
| ------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| API     | You want provider APIs, reliable automation, or multiple models in one run. | Set the key for the provider you use.                |
| Browser | You want Oracle to use a signed-in ChatGPT or Gemini browser session.       | Install Chrome and complete the one-time login flow. |
| Render  | You want to inspect, copy, or paste the bundle yourself.                    | No account or key is required.                       |

API mode supports OpenAI, Azure OpenAI, Anthropic, Gemini, xAI, OpenRouter, OrcaRouter, and compatible endpoints. Browser mode uses Chrome automation for ChatGPT and a cookie-based Gemini client. See [browser mode](docs/browser-mode.md) and [provider endpoints](docs/openai-endpoints.md) for setup and limits.

## Control the context

`--file` accepts files, directories, globs, and `!` exclusions. Repeat it to compose the context you want reviewed. Preview the resolved files and token estimate before sending:

```bash
oracle --dry-run summary --files-report \
  -p "Audit the model runner for race conditions" \
  --file "src/oracle/**/*.ts" \
  --file "!**/*.test.ts"
```

Generated text bundles include stable line numbers so answers can cite `path:line`. Binary and large browser inputs can be uploaded or bundled without converting their contents. The [CLI reference](docs/cli-reference.md) lists the file, size, output, and browser controls.

## Sessions and follow-ups

Oracle stores runs under `~/.oracle/sessions` so long responses can finish in the background and completed answers can be replayed. List recent work with:

```bash
oracle status --hours 72
```

Use `oracle session` to reattach to a run, `oracle restart` to repeat one, or `--followup` to continue a supported API or ChatGPT conversation with more context. See [sessions](docs/sessions.md) and [follow-ups](docs/followup.md) for the lifecycle and provider limits.

## Multiple models and automation

`--models` runs an API panel and records per-model usage, cost, output, and partial failures in one session. `oracle doctor --providers` inspects readiness for the selected models without exposing credentials. The [multi-model guide](docs/multimodel.md) covers routing and output files.

For agent integrations, run the `oracle-mcp` stdio server or install the Oracle skill from this repository. See [MCP setup](docs/mcp.md) and [agent setup](docs/agents.md) for Claude Code, Codex, Cursor, and other MCP clients.

## Documentation

| Topic                      | Guide                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installation and first run | [Install](docs/install.md) · [Quickstart](docs/quickstart.md)                                                                                                                  |
| Browser automation         | [Browser mode](docs/browser-mode.md) · [Linux](docs/linux.md) · [Windows](docs/windows.md)                                                                                     |
| Providers                  | [OpenAI and Azure](docs/openai-endpoints.md) · [Anthropic](docs/anthropic.md) · [Gemini](docs/gemini.md) · [OpenRouter](docs/openrouter.md) · [OrcaRouter](docs/orcarouter.md) |
| Runs and models            | [Sessions](docs/sessions.md) · [Follow-ups](docs/followup.md) · [Multi-model](docs/multimodel.md)                                                                              |
| Configuration and commands | [Configuration](docs/configuration.md) · [CLI reference](docs/cli-reference.md)                                                                                                |
| Agent integrations         | [Agents](docs/agents.md) · [MCP](docs/mcp.md) · [Bridge](docs/bridge.md)                                                                                                       |

## Related projects

- [Trimmy](https://trimmy.app) — Flatten multiline shell snippets so they paste and run once.
- [CodexBar](https://codexbar.app) — Keep Codex token windows visible in the macOS menu bar.
- [MCPorter](https://mcporter.dev) — TypeScript toolkit and CLI for Model Context Protocol servers.

The name was inspired by [Amp's Oracle](https://ampcode.com/news/oracle).

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm docs:check
```

Manual browser and provider tests are documented in [docs/manual-tests.md](docs/manual-tests.md).

## License

MIT. See [LICENSE](LICENSE).
