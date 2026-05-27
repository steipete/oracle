# Upstream v0.13.x sync manifest

## Classification (curator: pane 6)

| SHA      | Subject                                         | Decision | Reason                                                                                                                                                                                                        |
| -------- | ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fa2d7691 | docs: update changelog for browser evidence     | APPLY    | Browser evidence release note matches the browser batch; added under `Upstream sync v0.13.x`.                                                                                                                 |
| 0914cf65 | docs: document provider preflight workflows     | APPLY    | Documents provider preflight, route diagnostics, partial multi-model recovery, and output manifest workflows that are part of the API/session/CLI sync.                                                       |
| 890cd4bb | docs: document latest cli features              | APPLY    | Corrected SHA verified on `upstream/main`; documents CLI guardrails, perf traces, partial panels, and manual smoke coverage for pulled CLI features.                                                          |
| 363827f7 | chore(release): 0.12.0                          | SKIP     | Release commit changes upstream package version/install pin and closes an upstream changelog release; we do not adopt upstream version bumps.                                                                 |
| cba9e6dd | chore: complete oracle triage updates           | SKIP     | Mixed rollup touching `package.json` and `pnpm-lock.yaml` dependency state plus skill/changelog text. Dependency state is owned by the deps pane, and the pure GPT-5.5 skill update is covered by `a34df92b`. |
| a34df92b | docs(skill): update Oracle skill to GPT-5.5 Pro | APPLY    | Updates the bundled Oracle skill from GPT-5.4 Pro to GPT-5.5 Pro for the local tool we use; no upstream-only domain change.                                                                                   |
| dcb10bc1 | docs(changelog): record dependency update       | APPLY    | Changelog-only dependency note for the dependency batch; added under `Upstream sync v0.13.x`.                                                                                                                 |
| 9302c209 | docs(changelog): record audit hardening         | APPLY    | Changelog-only audit hardening notes for session/API/CLI fixes included in the sync.                                                                                                                          |
| fa65bbd6 | chore(release): prepare 0.12.1                  | SKIP     | Release commit changes upstream package version/install pin and dates an upstream release; skipped per release rule.                                                                                          |
| 12995576 | chore(release): open 0.12.2                     | SKIP     | Upstream release bookkeeping only; skipped per release rule.                                                                                                                                                  |
| aef77fe5 | docs: point oracle homepage to askoracle.sh     | SKIP     | Points package/docs/social metadata at upstream-only `askoracle.sh`; not appropriate for the fork sync.                                                                                                       |
| abb7c9a7 | chore(release): 0.13.0                          | SKIP     | Release commit changes upstream package version and changelog release heading; skipped per release rule.                                                                                                      |
| e0cfed0c | chore(release): start 0.13.1 changelog          | SKIP     | Upstream release bookkeeping only; skipped per release rule.                                                                                                                                                  |

## Cherry-pick outcome

Applied 6 commits in chronological order:

| Upstream SHA | Local commit | Notes                                                                                               |
| ------------ | ------------ | --------------------------------------------------------------------------------------------------- |
| fa2d7691     | 89da98be     | Resolved `CHANGELOG.md` into `### Upstream sync v0.13.x`.                                           |
| 0914cf65     | 337670fd     | Resolved `CHANGELOG.md`, `README.md`, and `docs/multimodel.md`; preserved existing fork entries.    |
| 890cd4bb     | f54073b4     | Resolved `docs/configuration.md`; kept the added performance trace section.                         |
| a34df92b     | 2af013e7     | Clean skill update to GPT-5.5 Pro.                                                                  |
| dcb10bc1     | 24428df8     | Resolved `CHANGELOG.md`; kept only the dependency note from this changelog commit.                  |
| 9302c209     | a65ee359     | Resolved `CHANGELOG.md`; kept the session/API/CLI audit hardening notes from this changelog commit. |

Skipped 7 commits:

- `363827f7`, `fa65bbd6`, `12995576`, `abb7c9a7`, `e0cfed0c`: upstream release/version bookkeeping.
- `cba9e6dd`: mixed dependency lockfile/package update outside this pane's ownership.
- `aef77fe5`: upstream-only `askoracle.sh` homepage/social metadata.

Final state: manifest written, APPLY commits cherry-picked, no upstream package version bump adopted.

## Deferred upstream commits (require follow-up PR)

The following upstream commits were not applied in this sync because they
collectively rewrite `src/oracle/run.ts` from our fork's inline
`{provider, source}` resolver into a helper-based `runtimeKeySource` /
`buildProviderRoutePlan` layer. Landing them piecemeal would leave the CLI
calling functions that do not exist; landing the refactor wholesale
requires re-authoring on top of our v18 evidence / `json_envelope.v1`
plumbing.

| SHA      | Subject                                            | Reason for defer                                                                                                                            |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 20166468 | refactor(api): share provider route resolution     | Introduces `providerRoutePlan.ts` + helper layer; our `run.ts` has structurally different surroundings.                                     |
| 504f70a3 | fix(api): report explicit proxy key source         | Targets the `runtimeKeySource` helper introduced by 20166468.                                                                               |
| decff455 | fix(api): report explicit forced-openai key source | Same dependency chain as 504f70a3.                                                                                                          |
| 3ae0df0d | feat(config): layer project config defaults (#218) | 10-file coordinated rewrite of `loadUserConfig`, `resolveEngine`, and `bin/oracle-cli.ts` that imports the deferred `providerRoutePlan.js`. |

Suggested follow-up: port the upstream provider-route refactor onto our
inline resolver as a single coordinated commit, then re-land 504f70a3,
decff455, and 3ae0df0d on top. The full conflict analysis from the apisc
pane is preserved in the git history at branch `sync/apisc-v0.13` →
`CONFLICT_REPORT.md`.

## Tests batch — also-deferred upstream commits

The tests pane (sync/tests-v0.13) cherry-picked 3 of 6 commits. The
other 3 depend on infrastructure introduced by the deferred apisc commits:

| SHA      | Subject                                              | Reason for defer                                                 |
| -------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| f8727d0f | test(cli): stabilize windows signal and loader tests | Depends on `feat(config): layer project config defaults` shapes. |
| fde1bae6 | style: format audit patches                          | Reformats files modified by the deferred apisc refactor.         |
| 1bd574ad | test: fix Windows project config smokes              | Tests the deferred `loadUserConfig` rewrite.                     |

These should land alongside the apisc refactor in the follow-up PR.
