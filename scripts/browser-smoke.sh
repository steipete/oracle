#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD=(node "$ROOT/dist/bin/oracle-cli.js" --engine browser --wait --heartbeat 0 --timeout 900 --browser-input-timeout 120000)

tmpfile="$(mktemp -t oracle-browser-smoke)"
echo "smoke-attachment" >"$tmpfile"

echo "[browser-smoke] pro upload attachment (non-inline)"
"${CMD[@]}" --model gpt-5.1-pro --prompt "Read the attached file and return exactly one markdown bullet '- upload: <content>' where <content> is the file text." --file "$tmpfile" --slug browser-smoke-upload --force

echo "[browser-smoke] pro simple"
"${CMD[@]}" --model gpt-5.1-pro --prompt "Return exactly one markdown bullet: '- pro-ok'." --slug browser-smoke-pro --force

echo "[browser-smoke] instant with attachment preview (inline)"
"${CMD[@]}" --model "5.1 Instant" --browser-inline-files --prompt "Read the attached file and return exactly one markdown bullet '- file: <content>' where <content> is the file text." --file "$tmpfile" --slug browser-smoke-file --preview --force

echo "[browser-smoke] standard markdown check"
"${CMD[@]}" --model gpt-5.1 --prompt "Return two markdown bullets and a fenced code block labeled js that logs 'thinking-ok'." --slug browser-smoke-thinking --force

echo "[browser-smoke] reattach flow after controller loss"
slug="browser-reattach-smoke"
meta="$HOME/.oracle/sessions/$slug/meta.json"
logfile="$(mktemp -t oracle-browser-reattach)"

# Start a browser run in the background and wait for runtime hints to appear.
"${CMD[@]}" --model gpt-5.1-pro --prompt "Return exactly 'reattach-ok'." --slug "$slug" --browser-keep-browser --heartbeat 0 --timeout 900 --force >"$logfile" 2>&1 &
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
