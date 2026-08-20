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

API mode supports OpenAI, Azure OpenAI, Anthropic, Gemini, xAI, OpenRouter, and compatible endpoints. Browser mode uses Chrome automation for ChatGPT and a cookie-based Gemini client. See [browser mode](docs/browser-mode.md) and [provider endpoints](docs/openai-endpoints.md) for setup and limits.

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

## Bring your ChatGPT history into your knowledge graph

**The pain.** If you run Codex or Claude Code and keep their session logs in an Obsidian vault, you already know the payoff: every decision, dead end and working snippet becomes a node in a knowledge graph you can link, search and revisit. Productivity compounds. But the years of thinking you did in ChatGPT _before_ agents arrived sit outside that graph. Merging them is miserable: long threads have scrolled out of context, the built-in export is one giant JSON, and copy-pasting hundreds of turns by hand is exactly the kind of work nobody finishes.

**The fix.** Let the agent do it. `oracle conversation export` reuses the one thing Oracle already has — a signed-in ChatGPT Chrome tab — to read an existing conversation **read-only** (no prompt is sent, nothing is clicked, nothing navigates) and write it out as Markdown, **one note per query/answer pair**, straight into a Git-tracked folder. Obsidian picks the notes up as-is: frontmatter, wikilinks, an `INDEX.md` per conversation. Your pre-agent ChatGPT history becomes part of the same graph as your agent logs.

You don't need Obsidian for this to be useful. It is also simply a faithful, greppable, diff-able archive of your ChatGPT conversations — byte-exact text with SHA-256 provenance — that lives in a repo you own instead of a vendor UI.

Works from **Codex and Claude Code** alike (it is just a CLI), and from your own shell.

```bash
# 1. One-time: start a Chrome with DevTools remote debugging and sign in to
#    ChatGPT (see "Remote Chrome Sessions" in docs/browser-mode.md).

# 2. Archive a conversation into your vault's inbox. Any signed-in ChatGPT tab
#    is enough; the conversation does not have to be open.
oracle conversation export "https://chatgpt.com/c/<conversation-id>" \
  --format obsidian --out ./00_Inbox

# 3. Commit it like any other note.
git add 00_Inbox/ChatGPT-* && git commit -m "archive: chatgpt conversation"
```

What you get:

```
00_Inbox/ChatGPT-685b5c1d/
├── INDEX.md                         # summary + wikilinks to every note
├── 001-2025-06-25-turn-001.md       # one query + its answer(s), verbatim
├── 002-2025-06-25-turn-003.md
└── …
```

Each note carries `conversation_id`, `source_url`, the original timestamps (in your timezone), turn ids, and `query_sha256` / `answer_sha256`, so you can always prove a note is untouched. Nothing is summarized at capture time — **raw first, organize later** — which is the property that makes the archive trustworthy as a primary source.

Under the hood it reads the same `/backend-api/conversation/<id>` JSON the ChatGPT UI renders from, so it sees the whole thread in one shot: branches, model per answer, canvas documents, and "thinking-only" turns the UI never displays. The older DOM-scrolling approach is still available as `--source dom`. JSON, Markdown and the raw backend body are available via `--format`; see [CLI reference](docs/cli-reference.md#conversation-export).

If you're handing this to an agent, an instruction that works well:

> Archive this ChatGPT conversation raw-first: run `oracle conversation export <url> --format obsidian --out ./00_Inbox`, do not summarize or edit anything it writes, and leave the notes under `00_Inbox` — promoting them into the rest of the vault is a separate, later pass.

## Multiple models and automation

`--models` runs an API panel and records per-model usage, cost, output, and partial failures in one session. `oracle doctor --providers` inspects readiness for the selected models without exposing credentials. The [multi-model guide](docs/multimodel.md) covers routing and output files.

For agent integrations, run the `oracle-mcp` stdio server or install the Oracle skill from this repository. See [MCP setup](docs/mcp.md) and [agent setup](docs/agents.md) for Claude Code, Codex, Cursor, and other MCP clients.

## Documentation

| Topic                      | Guide                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation and first run | [Install](docs/install.md) · [Quickstart](docs/quickstart.md)                                                                               |
| Browser automation         | [Browser mode](docs/browser-mode.md) · [Linux](docs/linux.md) · [Windows](docs/windows.md)                                                  |
| Providers                  | [OpenAI and Azure](docs/openai-endpoints.md) · [Anthropic](docs/anthropic.md) · [Gemini](docs/gemini.md) · [OpenRouter](docs/openrouter.md) |
| Runs and models            | [Sessions](docs/sessions.md) · [Follow-ups](docs/followup.md) · [Multi-model](docs/multimodel.md)                                           |
| Configuration and commands | [Configuration](docs/configuration.md) · [CLI reference](docs/cli-reference.md)                                                             |
| Agent integrations         | [Agents](docs/agents.md) · [MCP](docs/mcp.md) · [Bridge](docs/bridge.md)                                                                    |

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
