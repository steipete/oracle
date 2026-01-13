#!/usr/bin/env bash
set -euo pipefail

: "${ORACLE_HOME_DIR:=$HOME/.oracle-local}"
: "${ORACLE_BROWSER_PROFILE_DIR:=$ORACLE_HOME_DIR/browser-profile}"

export ORACLE_HOME_DIR
export ORACLE_BROWSER_PROFILE_DIR

exec oracle --engine browser --browser-manual-login --browser-keep-browser "$@"
