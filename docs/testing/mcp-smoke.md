# MCP Smoke Tests (local oracle-mcp)

Use these steps to validate CLI + MCP end-to-end before releasing.

## Checklist (run all four lanes)
1) CLI (API engine)
2) CLI (browser engine)
3) MCP via mcporter (API + browser)
4) Claude Code via MCP (API defaults)

Shared prereqs
- `pnpm build` (ensures `dist/bin/oracle-mcp.js` exists)
- `OPENAI_API_KEY` set in env
- `config/mcporter.json` contains the `oracle` entry pointing to `npx -y @steipete/oracle oracle-mcp` (already committed).
- mcporter available at `/Users/steipete/Library/pnpm/global/5/node_modules/.bin/mcporter`
- For browser runs: Chrome installed; macOS host (headful).
- macOS notifications: `vendor/oracle-notifier/OracleNotifier.app` ships with the package (preferred); falls back to toasted-notifier if missing/broken.

## CLI smokes
- API:
  ```bash
  pnpm run oracle -- --engine api --model gpt-5.1 --prompt "API smoke: say two words"
  ```
- Browser:
  ```bash
  pnpm run oracle -- --engine browser --model "5.1 Instant" --prompt "Browser smoke: say two words"
  ```

## MCP via mcporter
1) List tools/schema to confirm discovery:
   ```bash
   mcporter list oracle --schema --config config/mcporter.json
   ```

2) API consult (GPT-5.1):
   ```bash
   mcporter call oracle.consult \
     prompt:"Say hello from GPT-5.1" \
     model:"gpt-5.1" \
     engine:"api" \
     --config config/mcporter.json
   ```

3) Sessions list:
   ```bash
   mcporter call oracle.sessions hours:12 limit:3 --config config/mcporter.json
   ```

4) Session detail:
   ```bash
   mcporter call oracle.sessions id:"say-hello-from-gpt-5" detail:true --config config/mcporter.json
   ```

5) Browser smoke:
   ```bash
   mcporter call oracle.consult \
     prompt:"Browser smoke" \
     model:"5.1 Instant" \
     engine:"browser" \
     --config config/mcporter.json
   ```
   Uses a built-in browserConfig (ChatGPT URL + cookie sync) and the provided model label for the picker (heads-up: if the ChatGPT UI renames the model label, this may need an update).

## Claude Code smoke (tmux + cli)

Use this to verify Claude Code can reach the Oracle MCP server end-to-end.

Prereqs
- `pnpm build`
- `OPENAI_API_KEY` exported (for the API engine default)
- Oracle MCP registered with Claude (once per project):  
  `claude mcp add --transport stdio oracle -- oracle-mcp`

Steps
1) Start Claude in tmux:
   ```bash
   tmux new -s claude-smoke 'cd /Users/steipete/Projects/oracle && OPENAI_API_KEY=$OPENAI_API_KEY claude --permission-mode bypassPermissions --mcp-config ~/.mcp/oracle.json'
   ```
2) From another shell, use the helper to drive it:
   ```bash
   bun scripts/agent-send.ts --session claude-smoke --wait-ms 800 --entry double -- \
     'Call the oracle sessions MCP tool with {"limit":1,"detail":true} and show the result'
   ```
3) Validate the pane shows a successful `oracle sessions` tool call (or adjust `--mcp-config` if it reports no tools). When finished, `tmux kill-session -t claude-smoke`.

See `docs/mcp.md` for full tool/resource schemas and behavior.

Tip: The MCP consult tool pulls defaults from your `~/.oracle/config.json` (engine/model/search/prompt suffix/heartbeat/background/filesReport) when the call doesn’t override them.
