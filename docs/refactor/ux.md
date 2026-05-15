# Oracle UX Refactor Plan

Context: Oracle bundles prompts + files, then sends the bundle to API/browser models for second-model review. Recent multi-model advisory use exposed confusing provider routing, timeout, auth, partial-success, output, and session behaviors.

## Diagnosis

- CLI/docs drift: installed `0.11.1` rejected `--no-azure` while local help/docs mention it. Likely stale published artifact, `pnpm dlx` cache, or docs not verified against packed CLI.
- Azure routing too implicit: exported `AZURE_OPENAI_ENDPOINT` can steer GPT/OpenAI-family API runs through Azure unless users manually unset env vars or force provider routing.
- Timeout layering unclear: `--timeout` controls Oracle's overall deadline; `--http-timeout` controls SDK transport. A long overall timeout can still fail early at transport.
- Multi-model aggregation saves successful outputs, but any failed model makes the command exit 1. Partial success is real but under-communicated.
- Auth failures are lazy: missing keys fail early; invalid/expired keys fail only after requests start.
- Output summary ordering is weak: saved outputs can be buried under noisy failures.
- Session lifecycle vocabulary is inconsistent across API foreground, API background, browser, and Pro runs.
- Provider/key routing is opaque: users need safe, redacted route/readiness visibility.

## Priorities

### 1. Provider Doctor + Preflight

Add:

```sh
oracle doctor --providers
oracle doctor --providers --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro
oracle --preflight --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro -p "..."
```

Expected output:

```text
Provider readiness

OpenAI: ok
  key: OPENAI_API_KEY=sk-...a91
  base: api.openai.com
  route gpt-5.4: OpenAI Responses API

Azure OpenAI: configured, inactive
  endpoint: my-resource.openai.azure.com
  key: AZURE_OPENAI_API_KEY=az-...32c
  route gpt-5.4: ignored because --provider openai

Anthropic: auth failed
  key: ANTHROPIC_API_KEY=sk-...9bc
  error: invalid x-api-key

Gemini: auth failed
  key: GEMINI_API_KEY=AIza...77e
  error: API key expired
```

Implementation:

- Add top-level `oracle doctor`; keep `oracle bridge doctor` bridge-specific.
- Extract provider route/auth logic into `src/oracle/providerDoctor.ts`.
- Support `local` preflight for env/config/routing and `auth` preflight for cheap provider network checks.
- Redact all keys. Never print raw env values.

### 2. Explicit Provider Route Plan

Add:

```sh
oracle --route --models gpt-5.4,gemini-3-pro
oracle --provider openai --route --model gpt-5.4
oracle --no-azure --route --model gpt-5.4
```

Expected output:

```text
Route plan

gpt-5.4
  provider: OpenAI
  base: api.openai.com
  key: OPENAI_API_KEY=sk-...a91
  azure: ignored, AZURE_OPENAI_ENDPOINT is set

gemini-3-pro
  provider: Google Gemini
  base: generativelanguage.googleapis.com
  key: GEMINI_API_KEY=AIza...77e
```

Implementation:

- Make provider routing return a structured `ProviderRoutePlan`.
- Reuse it in run header, doctor, dry-run JSON, and session metadata.
- Add route-plan tests for Azure env present plus `--provider openai`.

### 3. Unified Timeout Semantics

Target behavior:

```sh
oracle --timeout 10m ...
oracle --timeout 10m --http-timeout 30s ...
oracle --timeout auto ...
```

Expected output:

```text
Timeouts
  overall: 10m
  transport: 10m
  session stale cutoff: 10m
```

With explicit shorter transport:

```text
Timeouts
  overall: 10m
  transport: 30s
  note: transport can fail before overall timeout
```

Implementation:

- If user sets `--timeout` and omits `--http-timeout`, derive HTTP timeout from overall timeout.
- Keep `--http-timeout` as explicit override.
- Print timeout plan in verbose and long-running runs.
- Store resolved timeouts in session metadata.

Migration:

- Keep both flags.
- Warn when `--http-timeout < --timeout`.
- Update docs so `--timeout` is the normal user-facing deadline.

### 4. Partial Success Mode

Add:

```sh
oracle --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro --allow-partial ...
oracle --models ... --partial fail
oracle --models ... --partial ok
```

Expected output:

```text
Multi-model result: partial success, 1/3 succeeded

Saved outputs:
- gpt-5.4 -> /tmp/name.gpt-5.4.md

Failures:
- claude-4.6-sonnet: auth failed, invalid x-api-key
- gemini-3-pro: auth failed, API key expired

Session:
- oracle session 20260515-naming-panel
```

Implementation:

- Add `allowPartial?: boolean` or `partialMode: "fail" | "ok"` to run options.
- In multi-model runner, if fulfilled > 0 and partial ok, exit 0.
- Add a `partial` or `completed_with_errors` session status.
- Keep default exit-1 behavior initially for backcompat, but always print structured partial summary before throwing.

### 5. Output Manifest + Summary Ordering

For multi-model `--write-output`, always print saved outputs first, then logs, then failures:

```text
Saved outputs:
- gpt-5.4 -> /tmp/name.gpt-5.4.md

Run logs:
- gpt-5.4 -> ~/.oracle/sessions/.../logs/gpt-5.4.log
- claude-4.6-sonnet -> ~/.oracle/sessions/.../logs/claude-4.6-sonnet.log

Failures:
- gemini-3-pro -> auth failed
```

Implementation:

- Add optional output manifest next to the requested path, e.g. `/tmp/name.oracle.json`.
- Include model, status, output path, log path, error category, elapsed, usage.
- Make manifest useful for agents consuming partial output.

### 6. Auth Error Classification

Expected output:

```text
Failures:
- claude-4.6-sonnet: auth failed
  key: ANTHROPIC_API_KEY=sk-...9bc
  provider said: invalid x-api-key
  fix: refresh ANTHROPIC_API_KEY or run `oracle doctor --providers anthropic`

- gemini-3-pro: auth expired
  key: GEMINI_API_KEY=AIza...77e
  fix: rotate key, then rerun failed model:
       oracle session <id> --rerun-failed
```

Implementation:

- Normalize provider SDK errors into Oracle user errors.
- Classify auth, expired key, quota, rate limit, model unavailable, and transport separately.
- Store category in per-model metadata.

### 7. Clear Foreground/Detached Lifecycle

Run start should print a compact lifecycle block:

```text
Session: 20260515-name-panel
Mode: api foreground
Models: 3 parallel
Detach: no
Reattach: oracle session 20260515-name-panel
```

For background/Pro:

```text
Session: 20260515-pro-review
Mode: api background
Detach: yes, polling
Reattach: oracle session 20260515-pro-review --live
```

Implementation:

- Add lifecycle fields to session metadata: `engine`, `execution`, `attached`, `reattachCommand`.
- Use the same fields in `status`, `session`, notifications, and run headers.
- Avoid special-case wording for Pro unless the behavior truly differs.

### 8. Help/Docs Single Source + Packed CLI Test

Add CI/doc check:

```sh
oracle docs check
```

Expected failure:

```text
Docs/help drift:
- skills/oracle/SKILL.md mentions --no-azure
- packed CLI help does not expose --no-azure
```

Implementation:

- Generate docs snippets from Commander metadata or a shared flag registry.
- CI smoke:
  - `pnpm pack`
  - install packed tarball in a temp dir
  - run `oracle --help --verbose`
  - assert documented flags exist.
- Add skill-doc lint for stale flags.

## Azure Backcompat

- Keep auto Azure initially.
- Make Azure route reason loud:

```text
Provider: Azure OpenAI
Reason: AZURE_OPENAI_ENDPOINT is set
Opt out: --provider openai or --no-azure
```

- Add explicit opt-out options:

```sh
oracle --provider openai
oracle --no-azure
ORACLE_AZURE=0 oracle ...
```

- Longer term: when both first-party OpenAI and Azure env are present, require `--provider azure` to use Azure, or gate stricter routing behind a major version.

## Tests

- Packed CLI exposes every documented flag, especially `--no-azure`.
- `--timeout 10m` passes `httpTimeoutMs=600000` when `--http-timeout` is omitted.
- `--timeout 10m --http-timeout 30s` preserves 30s and warns.
- Azure env plus `--provider openai` routes to OpenAI and omits Azure metadata.
- Azure env plus auto prints route reason and opt-out hint.
- `doctor --providers` redacts keys and classifies missing, valid, invalid, and expired.
- Multi-model partial: one success, two auth failures, `--allow-partial` exits 0 and prints saved outputs first.
- Multi-model default: same case exits 1 but still prints structured partial summary.
- `--write-output` multi-model writes per-model files and optional manifest.
- `oracle status` displays partial sessions and per-model failures cleanly.
