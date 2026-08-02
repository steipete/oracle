#!/usr/bin/env bash
# Ubuntu/Debian parity smoke for scripts/cdp-disconnect-proof.mjs
# (classification proof against real Chromium CDP; no ChatGPT login).
#
# Usage (from repo root, Docker required):
#   bash scripts/run-cdp-disconnect-proof-linux.sh
#
# Prints a redacted-ready transcript ending in PROOF_OK on success.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${ORACLE_LINUX_PROOF_IMAGE:-node:24-bookworm}"

echo "[linux-proof] image=${IMAGE}"
echo "[linux-proof] mounting ${ROOT} read-only; clean install inside container"

docker run --rm \
  --name "oracle-cdp-linux-proof-$$" \
  -v "${ROOT}:/src:ro" \
  -w /tmp/oracle-proof \
  "${IMAGE}" \
  bash -lc '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq chromium fonts-liberation ca-certificates >/tmp/apt-chromium.log
    CHROME_BIN="$(command -v chromium || command -v chromium-browser || true)"
    if [[ -z "${CHROME_BIN}" ]]; then
      echo "PROOF_FAILED: chromium not installed in container" >&2
      exit 1
    fi
    echo "[linux-proof] chromium=${CHROME_BIN}"
    # Copy sources without host node_modules / dist (darwin binaries).
    mkdir -p /tmp/oracle-proof
    tar -C /src --exclude=node_modules --exclude=dist --exclude=.git -cf - . \
      | tar -C /tmp/oracle-proof -xf -
    corepack enable
    corepack prepare pnpm@latest --activate
    pnpm install --frozen-lockfile
    pnpm run build
    export CHROME_PATH="${CHROME_BIN}"
    node scripts/cdp-disconnect-proof.mjs
  '
