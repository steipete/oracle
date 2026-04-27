#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD=(node "$ROOT/dist/bin/oracle-cli.js" --engine browser --wait --heartbeat 0 --timeout 900 --browser-input-timeout 120000)
FAST_MODEL="${ORACLE_BROWSER_SMOKE_FAST_MODEL:-gpt-5.2-instant}"
PRO_MODEL="${ORACLE_BROWSER_SMOKE_PRO_MODEL:-gpt-5.4-pro}"
# FAST_MODEL is for quick browser-path health checks only.
# PRO_MODEL is kept separate for real Pro/reattach coverage.

assert_output_contains() {
  local label="$1"
  local logfile="$2"
  shift 2
  for needle in "$@"; do
    if ! grep -Fq -- "$needle" "$logfile"; then
      echo "[browser-smoke] ${label}: expected output missing: $needle"
      cat "$logfile"
      rm -f "$logfile"
      exit 1
    fi
  done
}

run_and_check_contains() {
  local label="$1"
  shift
  local expectations=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    expectations+=("$1")
    shift
  done
  shift
  local logfile
  logfile="$(mktemp -t oracle-browser-smoke-log)"
  if ! "$@" >"$logfile" 2>&1; then
    echo "[browser-smoke] ${label}: command failed"
    cat "$logfile"
    rm -f "$logfile"
    exit 1
  fi
  assert_output_contains "$label" "$logfile" "${expectations[@]}"
  cat "$logfile"
  rm -f "$logfile"
}

tmpfile="$(mktemp -t oracle-browser-smoke)"
echo "smoke-attachment" >"$tmpfile"

echo "[browser-smoke][fast] upload attachment (non-inline)"
run_and_check_contains \
  "fast upload attachment (non-inline)" \
  "upload=smoke-attachment" \
  -- \
  "${CMD[@]}" --model "$FAST_MODEL" --browser-attachments always \
  --prompt "Return exactly one line and nothing else: upload=smoke-attachment" \
  --file "$tmpfile" --slug browser-smoke-upload --force

echo "[browser-smoke][fast] simple"
run_and_check_contains \
  "fast simple" \
  "pro-ok" \
  -- \
  "${CMD[@]}" --model "$FAST_MODEL" \
  --prompt "Return exactly one line and nothing else: pro-ok" \
  --slug browser-smoke-pro --force

echo "[browser-smoke][fast] attachment preview (inline)"
run_and_check_contains \
  "fast with attachment preview (inline)" \
  "file=smoke-attachment" \
  -- \
  "${CMD[@]}" --model "$FAST_MODEL" --browser-inline-files \
  --prompt "Return exactly one line and nothing else: file=smoke-attachment" \
  --file "$tmpfile" --slug browser-smoke-file --preview --force

echo "[browser-smoke][pro] standard markdown check"
run_and_check_contains \
  "pro standard markdown check" \
  '```js' \
  "console.log('thinking-ok')" \
  '```' \
  -- \
  "${CMD[@]}" --model "$PRO_MODEL" \
  --prompt $'Return exactly these three lines and nothing else:\n```js\nconsole.log('\''thinking-ok'\'')\n```' \
  --slug browser-smoke-thinking --force

echo "[browser-smoke][pro] reattach flow after controller loss"
slug="browser-reattach-smoke"
meta="$HOME/.oracle/sessions/$slug/meta.json"
logfile="$(mktemp -t oracle-browser-reattach)"

# Start a browser run in the background and wait for runtime hints to appear.
"${CMD[@]}" --model "$PRO_MODEL" --prompt "Return exactly 'reattach-ok'." --slug "$slug" --browser-keep-browser --heartbeat 0 --timeout 900 --force >"$logfile" 2>&1 &
runner_pid=$!

runtime_ready=0
for _ in {1..40}; do
  if [ -f "$meta" ] && node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.browser?.runtime?.chromePort){process.exit(0);}process.exit(1);" "$meta"; then
    runtime_ready=1
    break
  fi
  sleep 1
done

if [ "$runtime_ready" -ne 1 ]; then
  echo "[browser-smoke] reattach: runtime hint never appeared"
  cat "$logfile"
  kill "$runner_pid" 2>/dev/null || true
  exit 1
fi

# Give ChatGPT time to finish after we have a runtime hint.
sleep 30

# Simulate controller loss.
kill "$runner_pid" 2>/dev/null || true
wait "$runner_pid" 2>/dev/null || true

reattach_log="$(mktemp -t oracle-browser-reattach-log)"
if ! node "$ROOT/dist/bin/oracle-cli.js" session "$slug" --render-plain >"$reattach_log" 2>&1; then
  echo "[browser-smoke] reattach: session command failed"
  cat "$reattach_log"
  exit 1
fi

if ! grep -q "reattach-ok" "$reattach_log"; then
  echo "[browser-smoke] reattach: expected response not found"
  cat "$reattach_log"
  exit 1
fi

# Cleanup Chrome if it was left running.
chrome_pid=$(node -e "const fs=require('fs');try{const j=JSON.parse(fs.readFileSync('$meta','utf8'));if(j.browser?.runtime?.chromePid){console.log(j.browser.runtime.chromePid);} }catch{}")
if [ -n "${chrome_pid:-}" ]; then
  kill "$chrome_pid" 2>/dev/null || true
fi
rm -rf "$HOME/.oracle/sessions/$slug" "$logfile" "$reattach_log"

rm -f "$tmpfile"
