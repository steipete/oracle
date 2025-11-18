# Release Checklist (npm)

1. **Version & metadata**
   - [ ] Update `package.json` version (e.g., `1.0.0`).
   - [ ] Confirm package metadata (name, description, repository, keywords, license, `files`/`.npmignore`).
2. **Artifacts**
   - [ ] Run `pnpm run build` (ensure `dist/` is current).
   - [ ] Verify `bin` mapping in `package.json` points to `dist/bin/oracle-cli.js`.
 - [ ] Produce npm tarball and checksums:
    - `npm pack --pack-destination /tmp` (after build)
    - Move the tarball into repo root (e.g., `oracle-<version>.tgz`) and generate `*.sha1` / `*.sha256`.
    - Keep these files handy for the GitHub release; do **not** commit them.
  - [ ] Rebuild macOS notifier helper with signing + notarization:
    - `cd vendor/oracle-notifier && ./build-notifier.sh` (requires `CODESIGN_ID` and `APP_STORE_CONNECT_*`).
    - Verify tickets: `xcrun stapler validate vendor/oracle-notifier/OracleNotifier.app` and `spctl -a -t exec -vv vendor/oracle-notifier/OracleNotifier.app`.
3. **Changelog & docs**
  - [ ] Update `CHANGELOG.md` (or release notes) with highlights.
  - [ ] Ensure README reflects current CLI options (globs, `--status`, heartbeat behavior).
4. **Validation**
   - [ ] `pnpm vitest`
   - [ ] `pnpm run lint`
   - [ ] Optional live smoke (with real `OPENAI_API_KEY`): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/openai-live.test.ts`
   - [ ] MCP sanity check: with `config/mcporter.json` pointed at the local stdio server (`oracle-local`), run `mcporter list oracle-local --schema --config config/mcporter.json` after building (`pnpm build`) to ensure tools/resources are discoverable.
5. **Publish**
   - [ ] `npm login` (or confirm session) & check 2FA.
   - [ ] `npm publish --tag beta --access public` (adjust tag if needed).
   - [ ] Verify positional prompt still works: `npx -y @steipete/oracle "Test prompt" --dry-run`.
6. **Post-publish**
   - [ ] Promote desired dist-tag (e.g., `npm dist-tag add @steipete/oracle@X.Y.Z latest`).
   - [ ] `git tag vX.Y.Z && git push origin vX.Y.Z` (always tag each release).
   - [ ] `git tag vX.Y.Z && git push --tags`
   - [ ] Create GitHub release for tag `vX.Y.Z`:
     - Title `Oracle X.Y.Z`, body = changelog bullets.
     - Upload assets: `oracle-<version>.tgz`, `oracle-<version>.tgz.sha1`, `oracle-<version>.tgz.sha256`.
     - Confirm the auto `Source code (zip|tar.gz)` assets are present.
   - [ ] Announce / share release notes.
