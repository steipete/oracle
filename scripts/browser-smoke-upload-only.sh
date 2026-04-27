#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD=(node "$ROOT/dist/bin/oracle-cli.js" --engine browser --wait --heartbeat 0 --timeout 900 --browser-input-timeout 120000)
FAST_MODEL="gpt-5.2-instant"

run_and_check_contains() {
  local label="$1"
  local expected="$2"
  shift 2
  local logfile
  logfile="$(mktemp -t oracle-browser-smoke-log)"
  if ! "$@" >"$logfile" 2>&1; then
    echo "[browser-smoke-upload-only] ${label}: command failed"
    cat "$logfile"
    rm -f "$logfile"
    exit 1
  fi
  if ! grep -Fq -- "$expected" "$logfile"; then
    echo "[browser-smoke-upload-only] ${label}: expected output missing: $expected"
    cat "$logfile"
    rm -f "$logfile"
    exit 1
  fi
  cat "$logfile"
  rm -f "$logfile"
}

tmpfile="$(mktemp -t oracle-browser-smoke)"
echo "smoke-attachment" >"$tmpfile"

echo "[browser-smoke-upload-only] fast upload attachment (non-inline)"
run_and_check_contains \
  "fast upload attachment (non-inline)" \
  "upload=smoke-attachment" \
  "${CMD[@]}" --model "$FAST_MODEL" \
  --prompt "Return exactly one line and nothing else: upload=smoke-attachment" \
  --file "$tmpfile" --slug browser-smoke-upload --force

rm -f "$tmpfile"
