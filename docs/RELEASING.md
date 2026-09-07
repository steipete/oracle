# Release Checklist (npm + Homebrew)

> For a guarded, phased flow, run `./scripts/release.sh <phase>` (gates | artifacts | publish | smoke | tag | github-release | all); it stops on the first error so you can resume after fixing issues.

1. **Version & metadata**
   - [ ] Update `package.json` version (e.g., `1.0.0`).
   - [ ] Update any mirrored version strings (CLI banner/help, docs metadata) to match.
   - [ ] Confirm package metadata (name, description, repository, keywords, license, `files`/`.npmignore`).
   - [ ] If dependencies changed, run `pnpm install` so `pnpm-lock.yaml` is current.
   - [ ] Source `~/.profile` so codesign/notary env vars are available before building the notifier.
2. **Artifacts**
   - [ ] Run `./scripts/release.sh artifacts` (builds `dist/`, packs npm, and generates checksums).
   - [ ] Verify `bin` mapping in `package.json` points to `dist/bin/oracle-cli.js`.

- [ ] Keep the generated `.release-artifacts/oracle-<version>.tgz{,.sha1,.sha256}` for the GitHub release.
  - `.release-artifacts/` is gitignored; do **not** commit these files.
  - Set `ARTIFACT_DIR` to override the artifact directory; use the same directory for `github-release`.
- [ ] Rebuild macOS notifier helper with signing + notarization:
  - `cd vendor/oracle-notifier && ./build-notifier.sh` (requires `CODESIGN_ID` and `APP_STORE_CONNECT_*`).
  - Signing inputs (same as Trimmy): `CODESIGN_ID="Developer ID Application: Peter Steinberger (Y5PE65HELJ)"` plus notary env vars `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, and `APP_STORE_CONNECT_ISSUER_ID`.
  - Sparkle ed25519 private key lives at `/Users/steipete/Library/CloudStorage/Dropbox/Backup/Sparkle`; export `SPARKLE_PRIVATE_KEY_FILE` to that path whenever the build script needs to sign an appcast/enclosure.
  - Verify tickets: `xcrun stapler validate vendor/oracle-notifier/OracleNotifier.app` and `spctl -a -t exec -vv vendor/oracle-notifier/OracleNotifier.app`.

3. **Changelog & docs**

- [ ] Update `CHANGELOG.md` (or release notes) with highlights.
- [ ] Keep changelog entries product-facing only; avoid adding release-status/meta lines (e.g., “Published to npm …”)—that belongs in the GitHub release body.
- [ ] Verify changelog structure: versions strictly descending, no duplicates or skipped numbers, single heading per version.
- [ ] Ensure README reflects current CLI options (globs, `--status`, heartbeat behavior).
- [ ] **Release notes must exactly match the version’s changelog section** (full Added/Changed/Fixed/Tests bullets, no omissions). After creating the GitHub release, compare the body to `CHANGELOG.md` and fix any mismatch.

4. **Validation**
   - [ ] `pnpm run check` (zero warnings allowed; fail on any lint/type warnings).
   - [ ] `pnpm vitest`
   - [ ] `pnpm run lint`
   - [ ] Optional live smoke (with real `OPENAI_API_KEY`): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/openai-live.test.ts`
   - [ ] MCP sanity check: with `config/mcporter.json` pointed at the local stdio server (`oracle-local`), run `mcporter list oracle-local --schema --config config/mcporter.json` after building (`pnpm build`) to ensure tools/resources are discoverable.
5. **Publish (npm)**
   - [ ] Ensure git status is clean; commit and push any pending changes.
   - [ ] Avoid repeated browser auth: create a granular access token with **write** + **Bypass 2FA** at npmjs.com/settings/~/tokens, then export it (e.g., `export NPM_TOKEN=...` in `~/.profile`) and set `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` in `~/.npmrc`.
   - [ ] Use the `NPM_TOKEN` from `~/.profile` (our “NPM out token”). If `npm publish` opens browser auth, the token wasn’t loaded—rerun with `source ~/.profile`.
   - [ ] Confirm auth: `npm whoami`.
   - [ ] Decide tag before publish:
     - If npm `latest` is ahead (e.g., `npm view @steipete/oracle version` shows a higher major), publish with `--tag legacy`.
     - If this should become latest, publish with `--tag latest` (or publish then `npm dist-tag add @steipete/oracle@X.Y.Z latest`).
   - [ ] `npm publish --access public --tag <legacy|latest>` (2FA OTP required even with token).
   - [ ] If promoting later: `npm dist-tag add @steipete/oracle@X.Y.Z latest --otp <code>` (OTP required).
   - [ ] `npm view @steipete/oracle version` (and optionally `npm view @steipete/oracle time`) to confirm the registry shows the new version.
   - [ ] Verify positional prompt still works: `npx -y @steipete/oracle "Test prompt" --dry-run`.
6. **Homebrew (tap)**
   - [ ] The `Update Homebrew Tap` workflow preflights the tarball and both checksum assets after the GitHub release is published: it verifies their hashes and the public tarball URL before dispatching `steipete/homebrew-tap`.
   - [ ] Missing assets or failed verification stop the job before dispatch. Run `./scripts/release.sh github-release`, then re-run `.github/workflows/update-homebrew-tap.yml` via `workflow_dispatch` with the release tag (`tag=vX.Y.Z`). For an older release, do not rebuild: download the published npm tarball (`npm view @steipete/oracle@X.Y.Z dist.tarball`), verify it against `dist.integrity`, place it in `ARTIFACT_DIR` as `oracle-X.Y.Z.tgz` with `.sha1`/`.sha256` files, and run the phase with `VERSION=X.Y.Z`.
   - [ ] Confirm the tap workflow updated `Formula/oracle.rb` to the GitHub release asset and committed the SHA256.
   - [ ] Verify install:
     - `brew uninstall oracle || true`
     - `brew tap steipete/tap || true`
     - `brew install steipete/tap/oracle`
     - `oracle --version`
     - `brew uninstall oracle`
7. **Post-publish**

- [ ] Run `./scripts/release.sh tag` so `vX.Y.Z` exists on origin (always tag each release).
- [ ] Run `./scripts/release.sh github-release`: create a draft with title `X.Y.Z` and the full version's changelog section (without its heading), upload the tarball and both checksums, verify the downloads, publish, and re-verify the public tarball URL. Publishing triggers the Homebrew tap workflow, which also waits for that URL to become available.
  - Existing releases keep their notes; identical assets are skipped, and conflicting assets fail without overwriting.
- [ ] Confirm the GitHub release body exactly matches the `CHANGELOG.md` section for `X.Y.Z` (full bullet list). If not, update with `gh release edit vX.Y.Z --notes-file <file>`.
- [ ] Confirm npm shows the new version: `npm view @steipete/oracle version` and `npx -y @steipete/oracle@X.Y.Z --version`.
- [ ] Promote desired dist-tag (e.g., `npm dist-tag add @steipete/oracle@X.Y.Z latest`).
- [ ] From a clean temp directory (no package.json/node_modules), run `npx @steipete/oracle@X.Y.Z "Smoke from empty dir" --dry-run` to confirm the package installs/executes via npx.
- [ ] After verification, remove the generated tarball/checksum assets (`trash .release-artifacts`, or the overridden `ARTIFACT_DIR`).
- [ ] Announce / share release notes.
