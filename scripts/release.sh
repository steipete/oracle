#!/usr/bin/env bash
set -euo pipefail

# Oracle release helper (npm)
# Phases: gates | artifacts | publish | smoke | tag | all
# Defaults to using the guardrail runner (MCP_RUNNER or ./runner).

RUNNER="${MCP_RUNNER:-./runner}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}" 

if [[ "${CODEX_MANAGED_BY_NPM:-}" == "1" ]]; then
  export NPM_CONFIG_PROGRESS=false
  export npm_config_progress=false
fi

banner() { printf "\n==== %s ====" "$1"; printf "\n"; }
run() { echo ">> $*"; "$@"; }

phase_gates() {
  banner "Gates (check/lint/test/build)"
  run "$RUNNER" pnpm run check
  run "$RUNNER" pnpm run lint
  run "$RUNNER" pnpm run test
  run "$RUNNER" pnpm run build
}

phase_artifacts() {
  banner "Artifacts (npm pack + checksums)"
  run "$RUNNER" pnpm run build
  run "$RUNNER" npm pack --pack-destination /tmp

  # npm pack tarballs are not consistent for scoped packages:
  # - @scope/name -> scope-name-x.y.z.tgz
  # - name        -> name-x.y.z.tgz
  local packed
  packed=$(ls -1 "/tmp/"*"${VERSION}.tgz" 2>/dev/null | head -n1 || true)
  if [[ -z "${packed:-}" ]]; then
    echo "No tgz found in /tmp after npm pack" >&2
    exit 1
  fi

  local tgz="oracle-${VERSION}.tgz"
  mv "$packed" "$tgz"
  run shasum "$tgz" > "${tgz}.sha1"
  run shasum -a 256 "$tgz" > "${tgz}.sha256"
}

phase_publish() {
  banner "Publish to npm"
  run "$RUNNER" pnpm publish --tag latest --access public
  run "$RUNNER" npm view @steipete/oracle version
  run "$RUNNER" npm view @steipete/oracle time
}

phase_smoke() {
  banner "Smoke test in empty dir"
  local tmp=/tmp/oracle-empty
  rm -rf "$tmp" && mkdir -p "$tmp"
  ( cd "$tmp" && npx -y @steipete/oracle@"$VERSION" "Smoke from empty dir" --dry-run )
}

phase_tag() {
  banner "Tag and push"
  git tag "v${VERSION}"
  git push --tags
}

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [phase]

Phases (run individually or all):
  gates      pnpm check, lint, test, build
  artifacts  npm pack + sha1/sha256
  publish    pnpm publish --tag latest --access public, verify npm view
  smoke      empty-dir npx @steipete/oracle@<version> --dry-run
  tag        git tag v<version> && push tags
  all        run everything in order

Environment:
  MCP_RUNNER (default ./runner) - guardrail wrapper
  VERSION    (default from package.json)
EOF
}

main() {
  local phase="${1:-all}"
  case "$phase" in
    gates) phase_gates ;;
    artifacts) phase_artifacts ;;
    publish) phase_publish ;;
    smoke) phase_smoke ;;
    tag) phase_tag ;;
    all) phase_gates; phase_artifacts; phase_publish; phase_smoke; phase_tag ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
