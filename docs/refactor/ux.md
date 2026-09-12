# Provider and session UX maintenance notes

The original UX proposal described routing, readiness, timeouts, partial results,
and session lifecycle work that has since shipped. Use the current guides and
implementations below when changing those behaviors.

| Concern               | Current contract                                                                                                                                        | Implementation                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Provider readiness    | `oracle doctor --providers` and `--preflight` inspect routing and credentials; see [multi-model runs](../multimodel.md).                                | `src/cli/providerDoctor.ts`                            |
| Provider selection    | `--route`, `--provider`, and `--no-azure` make routing explicit; see [provider endpoints](../openai-endpoints.md).                                      | `src/oracle/providerRoutePlan.ts`                      |
| Timeouts              | An explicit `--timeout` supplies the default HTTP timeout; `--http-timeout` overrides it. See [configuration](../configuration.md#api-timeouts).        | `src/cli/runOptions.ts`                                |
| Partial results       | Multi-model runs fail by default; `--allow-partial` or `--partial ok` accepts at least one successful result. See [multi-model runs](../multimodel.md). | `src/cli/sessionRunner.ts`                             |
| Saved output          | Per-model files and an optional output manifest retain successful results and failure details. See [multi-model runs](../multimodel.md).                | `src/cli/sessionRunner.ts`                             |
| Provider failures     | Authentication, quota, rate-limit, model, and transport failures have shared classifications.                                                           | `src/oracle/providerFailures.ts`                       |
| Session lifecycle     | Foreground/background state and reattach guidance are shared across entrypoints; see [sessions](../sessions.md).                                        | `src/cli/sessionLifecycle.ts`                          |
| Docs/help consistency | `pnpm docs:check` checks documented flags; `pnpm test:packed-cli` checks the installed package.                                                         | `src/cli/docsCheck.ts`, `scripts/packed-cli-smoke.mjs` |

## Proposals that are not current contracts

- `oracle session <id> --rerun-failed` was a proposed convenience command; it is
  not implemented. Use the documented [session commands](../sessions.md).
- Automatic Azure routing remains supported. Requiring an explicit Azure opt-in
  when both OpenAI and Azure are configured would be a compatibility decision,
  not a cleanup. Keep the existing `--provider openai` and `--no-azure` escape
  hatches.

Do not copy the old proposal's illustrative output into tests or documentation.
The CLI help, current guides, and regression tests define supported behavior.
