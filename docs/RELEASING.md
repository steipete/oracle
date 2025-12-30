# Release Checklist (npm + Homebrew)

> For a guarded, phased flow, run `./scripts/release.sh <phase>` (gates | artifacts | publish | smoke | tag | all); it stops on the first error so you can resume after fixing issues.

1. **Version & metadata**
   - [ ] Update `package.json` version (e.g., `1.0.0`).
   - [ ] Update any mirrored version strings (CLI banner/help, docs metadata) to match.
   - [ ] Confirm package metadata (name, description, repository, keywords, license, `files`/`.npmignore`).
   - [ ] If dependencies changed, run `pnpm install` so `pnpm-lock.yaml` is current.
   - [ ] Source `~/.profile` so codesign/notary env vars are available before building the notifier.
2. **Artifacts**
   - [ ] Run `pnpm run build` (ensure `dist/` is current).
   - [ ] Verify `bin` mapping in `package.json` points to `dist/bin/oracle-cli.js`.
 - [ ] Produce npm tarball and checksums:
    - `npm pack --pack-destination /tmp` (after build)
    - Move the tarball into repo root (e.g., `oracle-<version>.tgz`) and generate `*.sha1` / `*.sha256`.
    - Keep these files handy for the GitHub release; do **not** commit them.
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
   - [ ] Update formula in `~/Projects/homebrew-tap/Formula/oracle.rb` (or create it if missing).
   - [ ] Bump version, URL, and SHA256 to match the GitHub release asset you want Homebrew to install.
   - [ ] Commit + push the tap update only after assets are live.
   - [ ] Verify install:
      - `brew uninstall oracle || true`
      - `brew tap steipete/tap || true`
      - `brew install steipete/tap/oracle`
      - `oracle --version`
      - `brew uninstall oracle`
7. **Post-publish**
  - [ ] Verify GitHub release exists for `vX.Y.Z` and has the intended assets (tarball + checksums if produced). Add missing assets before announcing.
  - [ ] Confirm the GitHub release body exactly matches the `CHANGELOG.md` section for `X.Y.Z` (full bullet list). If not, update with `gh release edit vX.Y.Z --notes-file <file>`.
  - [ ] Confirm npm shows the new version: `npm view @steipete/oracle version` and `npx -y @steipete/oracle@X.Y.Z --version`.
  - [ ] Promote desired dist-tag (e.g., `npm dist-tag add @steipete/oracle@X.Y.Z latest`).
  - [ ] `git tag vX.Y.Z && git push origin vX.Y.Z` (always tag each release).
  - [ ] `git tag vX.Y.Z && git push --tags`
   - [ ] Create GitHub release for tag `vX.Y.Z`:
      - Title = `X.Y.Z` (just the version, no “Oracle”, no date).
   - Body = product-facing bullet list for that version (copy from changelog bullets only; omit the heading and the word “changelog”). Always paste the full Added/Changed/Fixed bullets (no trimming) to keep npm/GitHub notes in sync.
      - Upload assets: `oracle-<version>.tgz`, `oracle-<version>.tgz.sha1`, `oracle-<version>.tgz.sha256`.
      - Confirm the auto `Source code (zip|tar.gz)` assets are present.
   - [ ] From a clean temp directory (no package.json/node_modules), run `npx @steipete/oracle@X.Y.Z "Smoke from empty dir" --dry-run` to confirm the package installs/executes via npx.
   - [ ] After uploading assets, verify they are reachable (e.g., `curl -I <GitHub-asset-URL>` or download and re-check SHA).
   - [ ] After verification, remove the untracked tarball/checksum assets from the repo root (`trash oracle-<version>.tgz*`).
   - [ ] Announce / share release notes.
