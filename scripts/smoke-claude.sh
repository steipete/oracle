#!/usr/bin/env bash
set -euo pipefail
SESSION_NAME=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      SESSION_NAME=$2; shift 2;;
    *) break;;
  esac
done
SESSION_NAME=${SESSION_NAME:-claude-smoke}
cd "$(dirname "$0")/.."
export OPENAI_API_KEY=${OPENAI_API_KEY:-}
if [[ -z "${OPENAI_API_KEY}" ]]; then
  echo "OPENAI_API_KEY is required for API engine default" >&2
  exit 1
fi
tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
tmux new-session -d -s "$SESSION_NAME" "cd $(pwd) && OPENAI_API_KEY=$OPENAI_API_KEY claude --permission-mode bypassPermissions --mcp-config ~/.mcp/oracle.json"
# give claude a moment to start
sleep 1
bun scripts/agent-send.ts --session "$SESSION_NAME" --wait-ms 800 --entry double -- 'Call the oracle sessions MCP tool with {"limit":1,"detail":true} and show the result'
 tmux attach -t "$SESSION_NAME"
