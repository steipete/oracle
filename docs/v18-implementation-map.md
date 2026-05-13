# v18 Implementation Map

This note maps the current Oracle codebase to the v18 browser/provider reliability
responsibilities. It is intentionally an implementation guide, not a new product
spec. The v18 planning bundle observed during this pass lives at
`PLAN/oracle-vnext-plan-bundle-v18.0.0/`, but that directory is an untracked
planning input and should be treated as read-only unless a later bead claims it.

## Current Code Paths

| Surface | Current files | Existing coverage to reuse | v18 gap |
| --- | --- | --- | --- |
| CLI command registration | `bin/oracle-cli.ts`, `src/cli/options.ts`, `src/cli/runOptions.ts`, `src/cli/browserConfig.ts`, `src/cli/sessionCommand.ts` | Root command, `serve`, `status`, `session`, `restart`, `bridge`, `project-sources`, model aliasing, dry-run, wait/detach defaults | Robot `--json` envelopes, `doctor`, `capabilities`, `browser leases`, provider-specific doctor/lease commands, `--provider`, `--prompt-file`, `--evidence`, `--remote-browser` |
| API provider execution | `src/oracle/run.ts`, `src/oracle/background.ts`, `src/oracle/multiModelRunner.ts`, `src/oracle/client.ts`, `src/oracle/modelResolver.ts`, `src/oracle/errors.ts`, `src/oracle/types.ts` | OpenAI/Azure/OpenRouter/Gemini/Claude/Grok dispatch, background polling, usage/cost summary, follow-up support, transport/user errors | Shared JSON envelope/error taxonomy and provider-result normalization for API-allowed reviewers |
| ChatGPT browser automation | `src/browser/index.ts`, `src/browser/sessionRunner.ts`, `src/browser/pageActions.ts`, `src/browser/actions/*`, `src/browser/providers/chatgptDomProvider.ts`, `src/browser/providerDomFlow.ts` | CDP launch/attach/remote Chrome, cookie sync, model selection, thinking-time selection, prompt submit, attachment upload, Deep Research, markdown capture, follow-ups, auto-reattach | Same-session mode/effort verification ledger before prompt submit, selector manifest versioning, fail-closed drift errors, protected-slot state machine |
| Gemini browser/web automation | `src/gemini-web/*`, `src/browser/providers/geminiDeepThinkDomProvider.ts` | Cookie-based Gemini HTTP client, image generate/edit flows, manual-login cookie extraction, Deep Think DOM path for no-attachment runs, shared browser session manager | Gemini 3.1 Deep Think protected route naming, high-if-exposed thinking verification, evidence, fail-closed fallback policy, non-empty capture eligibility |
| Remote browser service/client | `src/remote/server.ts`, `src/remote/client.ts`, `src/remote/health.ts`, `src/remote/remoteServiceConfig.ts`, bridge files under `src/cli/bridge/*` | `ORACLE_REMOTE_HOST`/`ORACLE_REMOTE_TOKEN`, `/runs` NDJSON, `/health`, attachment serialization, single-flight server guard, bridge config commands | `remote doctor/status/attach`, `--remote-browser preferred|required|off`, remote capability/lease planning, structured progress events, reconnect/error envelopes |
| Browser leases | `src/browser/tabLeaseRegistry.ts`, `src/browser/profileState.ts`, manual-login locking inside `src/browser/index.ts`, Gemini profile reuse in `src/gemini-web/browserSessionManager.ts` | Shared-profile tab leases, stale lease pruning, launch/profile locks, max concurrent ChatGPT tabs | Provider-scoped leases for `chatgpt` and `gemini`, TTL/status/recover commands, shared browser profile hash, browser_lease.v1 output |
| Evidence/artifacts | `src/browser/artifacts.ts`, `src/browser/chatgptImages.ts`, `src/sessionManager.ts`, `src/sessionStore.ts` | Transcript, Deep Research report, image artifacts, session metadata/runtime hints under `~/.oracle/sessions` | Redacted browser_evidence.v1 storage, prompt/output/session hashes, selector/transition hashes, unsafe-artifact quarantine, artifact index linkage |
| Session storage | `src/sessionManager.ts`, `src/sessionStore.ts`, `tests/sessionStore.test.ts` | Local file store, per-model logs, browser runtime metadata, zombie/dead-browser checks, restart metadata | Contracted robot metadata for evidence/provider results and consistent status names for JSON consumers |
| Heartbeat/logging/progress | `src/heartbeat.ts`, `src/oracle/oscProgress.ts`, browser thinking monitor, MCP logging notifications | API heartbeat, browser thinking/status logs, OSC progress, session logs | run_progress.v1 JSON events for robot surfaces and remote browser NDJSON |
| MCP surfaces | `src/mcp/server.ts`, `src/mcp/tools/*`, `src/mcp/types.ts`, `src/mcp/utils.ts`, `src/mcp/consultPresets.ts` | `consult`, `sessions`, `project_sources`, session resources, strict input schemas, dry-run resolved details | Expose capabilities/doctor/leases/evidence/provider-result summaries once CLI surfaces exist |
| Docs and manual tests | `README.md`, `docs/manual-tests.md`, `docs/testing.md`, `docs/mcp.md`, `docs/spec.md`, `docs/agents.md` | Browser, Gemini, remote Chrome, attach-running, Deep Research, multi-turn, live API smoke guidance | v18-specific manual smokes for protected routes, evidence, leases, remote browser doctor, and provider-result linkage |

## What Should Be Hardened In Place

- Keep `src/browser/index.ts` as the ChatGPT orchestration path. It already has
  launch/attach, cookie sync, model selection, thinking-time selection, prompt
  submission, capture, reattach, archive, and cleanup. Add verification hooks
  around the existing model/thinking selection steps rather than building a new
  browser stack.
- Reuse `src/browser/providerDomFlow.ts` for provider state machines. The
  ChatGPT and Gemini adapters are the right place for provider-specific
  selectors.
- Extend `src/browser/tabLeaseRegistry.ts` instead of creating a scheduler.
  v18 needs synchronous provider locks and lease status, not a daemon.
- Store redacted evidence under the existing session artifact tree through
  `src/browser/artifacts.ts` and `src/sessionStore.ts`.
- Keep remote browser execution as a drop-in browser executor through
  `src/remote/client.ts`. Add structured events and doctor/capability commands
  around it.
- Keep MCP consult behavior thin. MCP should call the same CLI/service helpers
  and return the same robot envelopes rather than growing separate logic.

## New Modules Worth Adding

| Responsibility | Suggested home | Why it is new |
| --- | --- | --- |
| Contract validators and fixtures | `src/contracts/` plus `tests/contracts/` | v18 schemas are shared by CLI, MCP, evidence, leases, and provider results |
| JSON envelope and error taxonomy | `src/oracle/jsonEnvelope.ts`, `src/oracle/recoveryErrors.ts` | Robot commands need a uniform `ok`, `blocked_reason`, `next_command`, `fix_command`, `retry_safe` shape |
| Browser evidence writer | `src/browser/evidence.ts` | Evidence is distinct from transcripts/images and must redact by default |
| Selector manifests | `src/browser/selectors/chatgpt.ts`, `src/browser/selectors/gemini.ts` | Selectors need versioned manifests and hashed observations |
| Provider result normalization | `src/providerResults/` | APR should consume provider_result.v1 without knowing browser internals |
| CLI robot subcommands | Small handlers under `src/cli/doctor.ts`, `src/cli/capabilities.ts`, `src/cli/browserLeases.ts` | Keep `bin/oracle-cli.ts` registration thin as new commands land |

## Implementation Order

1. Materialize v18 contracts as TypeScript validators and test fixtures.
2. Add the shared JSON envelope/error helpers and migrate only new robot
   commands first.
3. Build provider-scoped browser leases on top of current tab/profile locks.
4. Add redacted evidence storage and artifact/session references.
5. Add ChatGPT selector manifests and same-session Pro/highest-visible effort
   verification before prompt submission.
6. Add Gemini selector manifests and Deep Think/high-if-exposed verification
   before prompt submission.
7. Normalize provider_result.v1 for ChatGPT and Gemini browser routes, with
   evidence linkage and non-empty output eligibility.
8. Promote remote browser health into doctor/status/attach/capabilities surfaces
   and add structured progress events.
9. Wire MCP to the new robot surfaces.
10. Update README/manual tests/changelog after user-visible behavior exists.

## Parallel Ownership and Agent Mail Reservations

| Track | Primary ownership | Suggested reservation globs |
| --- | --- | --- |
| Contracts and envelopes | Contract schemas, validators, JSON envelope helpers, recovery errors | `src/contracts/**`, `src/oracle/jsonEnvelope.ts`, `src/oracle/recoveryErrors.ts`, `tests/contracts/**` |
| Remote browser | Remote health, remote CLI commands, remote structured events, bridge docs | `src/remote/**`, `src/cli/bridge/**`, `tests/remote/**`, `docs/bridge.md`, `docs/debug/remote-chrome.md` |
| Browser leases | Provider locks, lease status/recover/acquire/release, shared profile policy | `src/browser/tabLeaseRegistry.ts`, `src/browser/profileState.ts`, `src/cli/browserLeases.ts`, `tests/browser/*lease*` |
| Evidence | Redacted evidence writer, artifact index references, privacy tests | `src/browser/evidence.ts`, `src/browser/artifacts.ts`, `src/session*.ts`, `tests/browser/*evidence*`, `tests/sessionStore.test.ts` |
| ChatGPT selectors/state | ChatGPT selector manifest, Pro/highest-visible verification, state machine tests | `src/browser/actions/modelSelection.ts`, `src/browser/actions/thinkingTime.ts`, `src/browser/providers/chatgptDomProvider.ts`, `src/browser/selectors/chatgpt.ts`, `tests/browser/modelSelection*`, `tests/browser/thinkingTime.test.ts` |
| Gemini selectors/state | Gemini Deep Think selector manifest, high-if-exposed verification, DOM/HTTP fallback policy | `src/gemini-web/**`, `src/browser/providers/geminiDeepThinkDomProvider.ts`, `src/browser/selectors/gemini.ts`, `tests/gemini-web/**`, `tests/browser/geminiDeepThinkDomProvider.test.ts` |
| Provider results | provider_result.v1 builders, eligibility checks, hash consistency | `src/providerResults/**`, `tests/providerResults/**`, `src/browser/evidence.ts` |
| MCP robot surfaces | MCP wrappers for capabilities, doctor, leases, evidence/session resources | `src/mcp/**`, `tests/mcp/**`, `docs/mcp.md`, `docs/testing/mcp-smoke.md` |
| CLI wiring and docs | Thin command registration, README/manual tests/changelog | `bin/oracle-cli.ts`, `src/cli/**`, `tests/cli/**`, `README.md`, `docs/manual-tests.md`, `CHANGELOG.md` |

Reserve by bead ID before editing overlapping files. If two tracks both need
`bin/oracle-cli.ts` or `src/sessionStore.ts`, one track should own the command or
metadata shape and the other should integrate through exported helpers.

## Existing Partial Coverage

- Browser attach/launch/reuse, remote Chrome, manual-login profiles, tab cleanup,
  and reattach are already implemented and covered by browser tests.
- ChatGPT model labels and thinking-time controls already exist, but they are
  not yet evidence-producing contracts.
- Gemini Deep Think DOM automation already exists for the no-attachment path.
  Attachment/image cases intentionally fall back to the HTTP/header path today.
- Remote browser already has authenticated `/runs` and `/health`; it does not
  yet expose the richer v18 doctor/status/capability surfaces.
- Session storage already persists model logs, browser runtime hints, artifacts,
  and restart metadata. It is the right place to attach evidence references.
- MCP already exposes strict schemas and dry-run resolution for consults. It
  should reuse new robot command helpers instead of duplicating behavior.

## Cautions

- Do not replace the browser stack. The main risk is selector drift and missing
  evidence, not absence of a browser implementation.
- Do not silently substitute API routes for protected ChatGPT, Gemini, or Claude
  subscription/browser routes. Return a blocked/degraded envelope instead.
- Do not store raw cookies, account email, DOM dumps, screenshots, auth headers,
  raw private prompt text, or raw private output text in default evidence.
- Keep prompt files semantically unchanged. Oracle may add transport metadata and
  hashes, but APR owns provider-specific prompt compilation.
