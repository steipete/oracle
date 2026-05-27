# Sync APISC batch conflict report

## SKIPPED: 20166468 refactor(api): share provider route resolution

### Reason
This refactor moves logic from `src/oracle/run.ts` into a new helper
`src/oracle/providerRoutePlan.ts`. The helper was originally introduced by
upstream commits **b36a3dce** (`feat(cli): add provider route diagnostics`)
and **9dc102dd** (`perf(cli): add startup traces and lazy loading`), neither
of which is an ancestor of our `main`. `git merge-base --is-ancestor
b36a3dce HEAD` returns 1.

### Symptoms during cherry-pick
- `src/oracle/providerRoutePlan.ts`: `modify/delete` (deleted in HEAD).
  Upstream's full version of the helper was left in the tree.
- `src/oracle/run.ts`: 12 conflict regions spanning lines 30..516. Our
  run.ts has structurally different surroundings (evidence infrastructure,
  json_envelope.v1 wrappers, no existing route-plan call site) so the
  refactor cannot land in isolation.

### Decision
Skipped with `git cherry-pick --skip`. Re-apply after the predecessor
commits (b36a3dce, 9dc102dd) have landed via another pane, or re-author
this refactor on top of our run.ts once provider route diagnostics are in
place.

### Files touched at the time of skip
- `src/oracle/providerRoutePlan.ts` (left by upstream; removed by `--skip`)
- `src/oracle/run.ts` (unmerged; reverted to HEAD by `--skip`)

## SKIPPED: 504f70a3 fix(api): report explicit proxy key source

### Reason
Depends on the same provider-route refactor (`runtimeKeySource`,
`formatProviderRouteLogLine`, `ResolvedProviderRoute`,
`route.providerLabel`) introduced by 20166468 / b36a3dce, which are not in
our HEAD. Our HEAD's `src/oracle/run.ts` resolves API keys inline (via a
single `provider, source` object literal around lines 144-185) rather than
through the upstream helper layer, so the patched lines have no
corresponding code to amend.

### Symptoms during cherry-pick
- `src/oracle/run.ts`: hunk targets the `runtimeKeySource` helper, which
  does not exist in our tree. Merge produced a single broad conflict where
  upstream's `runtimeKeySource`/`formatProviderRouteLogLine` collided with
  our `shouldEmitRunProgress`.
- `tests/cli/runOracle/runOracle.request-payload.test.ts`: upstream's new
  test asserts the log line `"Provider: OpenAI-compatible | base:
  litellm.test/v1 | key: apiKey option"`, but our HEAD never emits a
  `Provider: ... | key: ...` line because the underlying log helper does
  not exist. Conflict region also pulled in unrelated proxy-routing tests
  from a predecessor we do not carry.

### Decision
Skipped with `git cherry-pick --skip`. Re-land after the provider route
plan refactor is integrated, or open a new patch that ports the
"apiKey option" override into our inline resolver in `src/oracle/run.ts`.

## SKIPPED: decff455 fix(api): report explicit forced-openai key source

### Reason
Same dependency chain as 504f70a3 — depends on `runtimeKeySource` and the
provider route plan refactor.

### Symptoms during cherry-pick
- `src/oracle/run.ts`: hunk targets the same upstream `runtimeKeySource`
  helper we do not carry.
- `tests/cli/runOracle/runOracle.request-payload.test.ts`: new test
  asserts `"Provider: OpenAI | base: api.openai.com | key: apiKey
  option"`, a log line our HEAD never emits.

### Decision
Skipped with `git cherry-pick --skip`. Land alongside 504f70a3 once the
provider route refactor is integrated.

## SKIPPED: 3ae0df0d feat(config): layer project config defaults (#218)

### Reason
This is a coordinated multi-file refactor whose pieces partially depend on
the provider route plan we skipped in 20166468 *and* on a new
`loadUserConfig` shape that does not coexist with our HEAD's
`applyEnvConfigOverrides`-based loader.

### Symptoms during cherry-pick (10 conflicted files)
- `src/config.ts`: 1 conflict region. Upstream replaces our
  `loadUserConfig` / `applyEnvConfigOverrides` pair with a project-aware
  loader that calls new helpers (`resolveUserConfigPath`,
  `discoverProjectConfigPaths`, `mergeUserConfig`,
  `sanitizeProjectConfig`) and adds a `paths: string[]` field to
  `LoadConfigResult`. None of these helpers exist in HEAD; the env
  overrides path also disappears.
- `src/cli/engine.ts`: 2 conflict regions. Upstream's `resolveEngine`
  expects a new `apiProviderRequested` parameter. Our HEAD never had it,
  and bin/oracle-cli.ts in upstream's snapshot passes it explicitly.
- `bin/oracle-cli.ts`: 1 conflict spanning ~110 lines. Upstream's
  snapshot imports `buildProviderRoutePlan` from
  `../src/oracle/providerRoutePlan.js` (line 1668), the very module we
  could not introduce when 20166468 was skipped.
- `src/cli/bridge/doctor.ts`: 1 conflict.
- `src/cli/runOptions.ts`: 4 conflict regions.
- `tests/cli/integrationCli.test.ts`: 2 conflicts.
- `tests/config.test.ts`, `tests/engine.test.ts`,
  `tests/runOptions.test.ts`: 1 conflict each. Tests assert against the
  upstream loader/engine signatures we cannot land in isolation.

### Decision
Skipped with `git cherry-pick --skip`. The orchestrator should re-apply
this PR once 20166468 (provider route plan) is merged and the
`loadUserConfig` rewrite is coordinated as a single follow-up landing —
attempting a partial merge here would leave the CLI calling a
`resolveEngine` it does not declare and importing
`providerRoutePlan.js` that does not exist on disk.


