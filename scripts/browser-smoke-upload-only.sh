#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD=(node "$ROOT/dist/bin/oracle-cli.js" --engine browser --wait --heartbeat 0 --timeout 900 --browser-input-timeout 120000)

tmpfile="$(mktemp -t oracle-browser-smoke)"
echo "smoke-attachment" >"$tmpfile"

echo "[browser-smoke-upload-only] pro upload attachment (non-inline)"
"${CMD[@]}" --model gpt-5.1-pro --prompt "Read the attached file and return exactly one markdown bullet '- upload: <content>' where <content> is the file text." --file "$tmpfile" --slug browser-smoke-upload --force

rm -f "$tmpfile"
