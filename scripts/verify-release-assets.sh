#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

if [[ $# -ne 1 || ! "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  fail 'Usage: scripts/verify-release-assets.sh <tag>; tag must have the form v0.18.0 or v0.18.0-beta.1 (v prefix required).'
fi

tag="$1"
version="${tag#v}"
REPO="${REPO:-steipete/oracle}"
attempts="${RELEASE_ASSET_ATTEMPTS:-12}"
delay="${RELEASE_ASSET_DELAY:-15}"
public_check="${RELEASE_ASSET_PUBLIC_URL_CHECK:-1}"
expected_sha256="${RELEASE_ASSET_EXPECT_SHA256:-}"
[[ "$attempts" =~ ^[1-9][0-9]*$ ]] || fail 'RELEASE_ASSET_ATTEMPTS must be a positive integer.'
[[ "$delay" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail 'RELEASE_ASSET_DELAY must be a nonnegative number of seconds.'
[[ "$public_check" == 0 || "$public_check" == 1 ]] || fail 'RELEASE_ASSET_PUBLIC_URL_CHECK must be 0 or 1.'
if [[ -n "$expected_sha256" && ! "$expected_sha256" =~ ^[[:xdigit:]]{64}$ ]]; then
  fail 'RELEASE_ASSET_EXPECT_SHA256 must be a 64-character hex digest.'
fi
for tool in gh shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required."
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$tmp"
tgz="oracle-${version}.tgz"
assets=("$tgz" "$tgz.sha1" "$tgz.sha256")
url="https://github.com/$REPO/releases/download/$tag/$tgz"

for ((attempt = 1; attempt <= attempts; attempt++)); do
  missing=()
  if release_info=$(gh release view "$tag" --repo "$REPO" --json isDraft,assets --jq '.isDraft, .assets[].name'); then
    is_draft="${release_info%%$'\n'*}"
    [[ "$is_draft" == true || "$is_draft" == false ]] || fail 'Invalid release metadata from gh.'
    for asset in "${assets[@]}"; do
      if [[ $'\n'"$release_info"$'\n' != *$'\n'"$asset"$'\n'* ]]; then
        missing+=("$asset")
      fi
    done
  else
    printf 'Release %s/%s is not yet available (attempt %s/%s).\n' "$REPO" "$tag" "$attempt" "$attempts" >&2
    missing=("${assets[@]}")
  fi
  if [[ ${#missing[@]} -eq 0 ]]; then
    break
  fi
  printf 'Missing assets (attempt %s/%s):\n' "$attempt" "$attempts" >&2
  printf '  %s\n' "${missing[@]}" >&2
  if (( attempt == attempts )); then
    printf 'Release assets unavailable for %s/%s after %s attempts.\nMissing assets:\n' "$REPO" "$tag" "$attempts" >&2
    printf '  %s\n' "${missing[@]}" >&2
    # shellcheck disable=SC2016 # Backticks quote suggested commands, not command substitution.
    printf 'Remediation: run `scripts/release.sh github-release` (or `gh release upload %s <files>`) and re-run the Update Homebrew Tap workflow via workflow_dispatch with tag=%s\n' "$tag" "$tag" >&2
    exit 1
  fi
  sleep "$delay"
done

# Asset downloads go through the release-assets CDN, which can time out transiently; retry with the same bounds.
for ((attempt = 1; attempt <= attempts; attempt++)); do
  if gh release download "$tag" --repo "$REPO" --dir "$tmp" --pattern "$tgz*" --clobber; then
    break
  fi
  printf 'Asset download failed (attempt %s/%s).\n' "$attempt" "$attempts" >&2
  if (( attempt == attempts )); then
    fail "Could not download release assets for $REPO/$tag after $attempts attempts."
  fi
  sleep "$delay"
done
for asset in "${assets[@]}"; do
  [[ -f "$tmp/$asset" ]] || fail "Downloaded assets do not include $asset."
done

# Checksum files are either a bare digest (older releases) or `digest  filename` as written by shasum.
verify_checksum() {
  local algorithm="$1" suffix="$2" length="$3" line pattern expected observed
  line=$(tr -d '\r' < "$tmp/$tgz.$suffix")
  pattern="^([[:xdigit:]]{$length})( [ *]([^[:space:]]+))?$"
  if [[ ! "$line" =~ $pattern ]]; then
    fail "$tgz.$suffix must contain exactly one $suffix digest, optionally followed by the filename $tgz."
  fi
  expected=$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')
  if [[ -n "${BASH_REMATCH[3]:-}" && "$(basename "${BASH_REMATCH[3]}")" != "$tgz" ]]; then
    fail "$tgz.$suffix references ${BASH_REMATCH[3]} instead of $tgz."
  fi
  observed=$(shasum -a "$algorithm" "$tmp/$tgz")
  observed="${observed%% *}"
  if [[ "$observed" != "$expected" ]]; then
    printf 'Error: %s mismatch for %s\n  expected: %s\n  observed: %s\n' "$suffix" "$tgz" "$expected" "$observed" >&2
    exit 1
  fi
  printf '%s: %s OK\n' "$tgz" "$suffix"
}

verify_checksum 256 sha256 64
verify_checksum 1 sha1 40
tarball_sha256=$(shasum -a 256 "$tmp/$tgz")
tarball_sha256="${tarball_sha256%% *}"
if [[ -n "$expected_sha256" ]]; then
  expected_sha256=$(printf '%s' "$expected_sha256" | tr '[:upper:]' '[:lower:]')
  if [[ "$tarball_sha256" != "$expected_sha256" ]]; then
    printf 'Error: RELEASE_ASSET_EXPECT_SHA256 mismatch for %s\n  expected: %s\n  observed: %s\n' "$tgz" "$expected_sha256" "$tarball_sha256" >&2
    exit 1
  fi
fi

if [[ "$is_draft" == false && "$public_check" == 1 ]]; then
  command -v curl >/dev/null 2>&1 || fail 'curl is required for the public URL check.'
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if http_code=$(curl -fsSIL --connect-timeout 15 --max-time 60 -o /dev/null -w '%{http_code}' "$url") && [[ "$http_code" == 200 ]]; then
      break
    fi
    printf 'Public URL not ready (attempt %s/%s, HTTP %s): %s\n' "$attempt" "$attempts" "${http_code:-unknown}" "$url" >&2
    if (( attempt == attempts )); then
      fail "Public release URL never returned HTTP 200 after $attempts attempts: $url"
    fi
    sleep "$delay"
  done
fi

for asset in "${assets[@]}"; do
  size=$(wc -c < "$tmp/$asset" | tr -d '[:space:]')
  printf '%s: %s bytes' "$asset" "$size"
  if [[ "$asset" == "$tgz" ]]; then
    printf ', sha256 %s' "$tarball_sha256"
  fi
  printf '\n'
done
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'tarball_sha256=%s\ntarball_url=%s\n' "$tarball_sha256" "$url" >> "$GITHUB_OUTPUT"
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '### Release assets verified: %s\n\n' "$tag"
    printf 'Tarball and both checksum files verified for [%s](%s).\n\n' "$REPO/$tag" "$url"
    # shellcheck disable=SC2016 # Backticks are literal Markdown code delimiters.
    printf 'SHA256: `%s`\n' "$tarball_sha256"
    if [[ "$is_draft" == false && "$public_check" == 1 ]]; then
      printf '\nPublic download URL returned HTTP 200.\n'
    else
      printf '\nPublic download URL check skipped (draft release or disabled).\n'
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi
