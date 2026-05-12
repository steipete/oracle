---
name: oracle
description: Use the @steipete/oracle CLI to bundle a prompt plus the right files and get a second-model review (API or browser) for debugging, refactors, design checks, or cross-validation.
---

# Oracle (CLI) — best use

Oracle bundles your prompt + selected files into one “one-shot” request so another model can answer with real repo context (API or browser automation). Treat outputs as advisory: verify against the codebase + tests.

## Main use case (browser, GPT‑5.5 Pro)

Default workflow here: `--engine browser` with GPT‑5.5 Pro in ChatGPT. This is the “human in the loop” path: it can take ~10 minutes to ~1 hour; expect a stored session you can reattach to.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Model: GPT‑5.5 Pro (try `--model gpt-5.5-pro`, or the visible ChatGPT picker label such as `--model "5.5 Pro"` / `--model "Pro"`).
- Attachments: prefer focused files or ZIP bundles; avoid secrets.
- If cookie reuse fails, use manual-login defaults:
  - `--browser-manual-login --browser-keep-browser --browser-input-timeout 120000`
- Wait longer for Pro browser runs: 15–20 minutes of “no thinking status detected” can still be normal. Prefer waiting or reattaching over rerunning while the browser/session is alive.

## Golden path (fast + reliable)

1. Pick a tight file set (fewest files that still contain the truth).
2. Preview what you’re about to send (`--dry-run` + `--files-report` when needed).
3. Run in browser mode for the usual GPT‑5.5 Pro ChatGPT workflow; use API only when you explicitly want it.
4. If the run detaches/timeouts: check status and reattach to the stored session (don’t re-run blindly).

## Commands (preferred)

- Show help (once/session):
  - `npx -y @steipete/oracle --help`

- Preview (no tokens):
  - `npx -y @steipete/oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `npx -y @steipete/oracle --dry-run full -p "<task>" --file "src/**"`

- Token/cost sanity:
  - `npx -y @steipete/oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run (main path; long-running is normal):
  - `npx -y @steipete/oracle --engine browser --model gpt-5.5-pro -p "<task>" --file "src/**"`

- Browser run with manual login:
  - `npx -y @steipete/oracle --engine browser --model "Pro" --browser-manual-login --browser-keep-browser --browser-input-timeout 120000 -p "<task>" --file review-bundles/00_core_diff_history.zip`

- Longer Pro review run:
  - `npx -y @steipete/oracle --engine browser --model "Pro" --browser-timeout 30m --browser-input-timeout 120000 -p "<task>" --file review-bundles/00_core_diff_history.zip`

- Manual paste fallback (assemble bundle, copy to clipboard):
  - `npx -y @steipete/oracle --render --copy -p "<task>" --file "src/**"`
  - Note: `--copy` is a hidden alias for `--copy-markdown`.

## Attaching files (`--file`)

`--file` accepts files, directories, and globs. You can pass it multiple times; entries can be comma-separated.

Do not use `--file .` by default for nontrivial repos. It can pull in images, lockfiles, databases, caches, local env files, generated assets, and build output. Prefer `git ls-files` plus filters, or attach curated ZIP bundles.

- Include:
  - `--file "src/**"` (directory glob)
  - `--file src/index.ts` (literal file)
  - `--file docs --file README.md` (literal directory + file)

- Exclude (prefix with `!`):
  - `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`

- Browser-upload caveat:
  - Avoid negative `--file` globs for complex browser uploads; some paths can be treated literally by downstream upload handling.
  - Generate an explicit file list first and pass only positive file paths, or put the curated files into ZIP bundles.

- Always exclude unless specifically needed:
  - `.env*`, key files, DBs, images/media, lockfiles, virtualenvs, `node_modules`, build output, generated assets, caches.

- Defaults (important behavior from the implementation):
  - Default-ignored dirs: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp` (skipped unless you explicitly pass them as literal dirs/files).
  - Honors `.gitignore` when expanding globs.
  - Does not follow symlinks (glob expansion uses `followSymbolicLinks: false`).
  - Dotfiles are filtered unless you explicitly opt in with a pattern that includes a dot-segment (e.g. `--file ".github/**"`).
  - Default cap: files > 1 MB are rejected unless you raise `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` in `~/.oracle/config.json`.

## Attachment limits

Oracle has a configurable per-file read guard, not a fixed hard attachment limit:

- Default per-file cap: 1 MiB (`DEFAULT_MAX_FILE_SIZE_BYTES`).
- CLI raise for one run: `--max-file-size-bytes 5000000`.
- One-off raise: `ORACLE_MAX_FILE_SIZE_BYTES=5000000 npx -y @steipete/oracle ...`.
- Persistent raise: set `maxFileSizeBytes` in `~/.oracle/config.json`.
- Browser mode switches from inline paste to uploads around 60k characters; ChatGPT itself may still reject very large or numerous uploads.

Raising the file-size cap does not solve token budget issues. A 424 KB ZIP can expand to hundreds of thousands of tokens if it contains large before/after copies. Always run `--dry-run summary --files-report` before broad reviews.

## Broad repo reviews: ZIP bundles

For repo reviews, browser mode is more reliable with one or more ZIPs than many loose `--file` attachments.

- Put `REVIEW_INSTRUCTIONS.md` inside every ZIP so the attachment is self-describing if files are separated.
- Name chunks clearly: `00_core_diff_history.zip`, `01_backend_context.zip`, `02_frontend_context.zip`.
- Keep each ZIP under Oracle’s 1 MB default file cap unless config is known to allow more.
- Prefer source and review artifacts over generated files. Use `git ls-files` + filters instead of directory dumps.
- For broad reviews, prefer patch + selected after files over all before/after copies. Include before copies only where context matters.

Use a two-layer bundle strategy:

- Mandatory diff bundle: review instructions, `git status --short`, name-status, staged/working patch, test status, previous Oracle findings if this is a re-review.
- Project context bundle: `AGENTS.md`/`CLAUDE.md`, README, relevant configs, changed files after-state, adjacent modules/import callers, route/API/type files, and migration context.
- Whole-project mode: use `git ls-files` with exclusions for `.env*`, DBs, binaries, images/media, generated output, caches, `node_modules`, build dirs, and virtualenvs. Keep the diff as a separate named artifact so the reviewer can distinguish “what changed” from “background”.

Dry-run gate for broad context:

- Under ~200k tokens: whole tracked project + separate diff is usually reasonable.
- 200k–500k: only use if the chosen model supports the context and slowness is acceptable.
- Above ~500k: split into `00_diff.zip`, `01_backend_project.zip`, `02_frontend_project.zip`, each self-describing.

Diff-only is fast but misses architecture regressions. Whole-project-only makes it hard to spot what changed. Send both when practical.

## Final staged pre-commit review

Use this before commit. It reviews the staged index, includes status metadata, skips common generated paths, and captures staged after-state with `git show :path` so unstaged edits do not leak into the review.

```bash
bash <<'BASH'
set -euo pipefail

bundle_root="review-bundles"
stage="$bundle_root/precommit-review"
limit_bytes=950000

rm -rf "$stage"
mkdir -p "$stage/metadata" "$stage/diff" "$stage/changed-before" "$stage/changed-after"
rm -f "$bundle_root"/[0-9][0-9]_precommit_review.zip

cat > "$stage/REVIEW_INSTRUCTIONS.md" <<'EOF'
# Final staged pre-commit review

Review exactly the staged changes for correctness, regressions, missing tests/docs, and risky assumptions.
Produce final report only. Do not reply with progress updates.
Prioritize findings by severity with file/line references. Include tests/docs gaps and logic-change assessment.
EOF

git status --short > "$stage/metadata/git-status-short.txt"
printf 'Paste test command/results here before running Oracle.\n' > "$stage/metadata/test-status.txt"
git diff --cached --binary > "$stage/diff/staged.patch"
git diff --cached --name-status > "$stage/diff/name-status.txt"
git log -2 --stat > "$stage/metadata/git-log-2-stat.txt"

git diff --cached --name-only -z |
while IFS= read -r -d '' file; do
  case "$file" in
    node_modules/*|dist/*|build/*|coverage/*|.next/*|.turbo/*|tmp/*|*.lock|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.sqlite|*.db)
      continue
      ;;
  esac
  mkdir -p "$stage/changed-before/$(dirname "$file")"
  mkdir -p "$stage/changed-after/$(dirname "$file")"
  git show "HEAD:$file" > "$stage/changed-before/$file" 2>/dev/null || true
  git show ":$file" > "$stage/changed-after/$file" 2>/dev/null || true
done

find "$stage" -type f -size +850k ! -name REVIEW_INSTRUCTIONS.md -print \
  > "$stage/metadata/SKIPPED_LARGE_ARTIFACTS.txt"
if [ -s "$stage/metadata/SKIPPED_LARGE_ARTIFACTS.txt" ]; then
  while IFS= read -r file; do rm -f "$file"; done < "$stage/metadata/SKIPPED_LARGE_ARTIFACTS.txt"
fi

chunk=0
zip_path=""
start_chunk() {
  zip_path="$(printf '%s/%02d_precommit_review.zip' "$bundle_root" "$chunk")"
  rm -f "$zip_path"
  (cd "$stage" && zip -qj "../$(basename "$zip_path")" REVIEW_INSTRUCTIONS.md)
}

start_chunk
while IFS= read -r -d '' file; do
  rel="${file#$bundle_root/}"
  (cd "$bundle_root" && zip -q "$(basename "$zip_path")" "$rel")
  if [ "$(wc -c < "$zip_path")" -gt "$limit_bytes" ]; then
    (cd "$bundle_root" && zip -qd "$(basename "$zip_path")" "$rel" >/dev/null || true)
    chunk=$((chunk + 1))
    start_chunk
    (cd "$bundle_root" && zip -q "$(basename "$zip_path")" "$rel")
  fi
done < <(find "$stage" -type f ! -name REVIEW_INSTRUCTIONS.md -print0 | sort -z)

du -h "$bundle_root"/[0-9][0-9]_precommit_review.zip
BASH
```

Run:

```bash
oracle_files=()
for zip in review-bundles/[0-9][0-9]_precommit_review.zip; do
  oracle_files+=(--file "$zip")
done

npx -y @steipete/oracle \
  --dry-run summary --files-report \
  -p "Final staged pre-commit review. Produce final report only." \
  "${oracle_files[@]}"

npx -y @steipete/oracle \
  --engine browser \
  --model "Pro" \
  --browser-timeout 30m \
  --slug "precommit-review" \
  -p "Final staged pre-commit review. Produce final report only. Do not reply with progress updates." \
  "${oracle_files[@]}"
```

## Diff review bundle

Use this recipe for “review the current git diff”. It captures the binary diff, name-status, recent history, untracked-file diffs, recent patches, and before/after copies for changed files.

```bash
bash <<'BASH'
set -euo pipefail

bundle_root="review-bundles"
stage="$bundle_root/review-diff"
limit_bytes=950000

rm -rf "$stage"
mkdir -p "$stage"
rm -f "$bundle_root"/[0-9][0-9]_*.zip

cat > "$stage/REVIEW_INSTRUCTIONS.md" <<'EOF'
# Review instructions

Review the current git diff for correctness, regressions, missing tests, and risky assumptions.
Produce final report only. Do not reply with progress updates.
Prioritize findings with file/line references, then open questions, then a brief summary.
EOF

git diff --binary > "$stage/git-diff-binary.patch"
git diff --name-status > "$stage/git-diff-name-status.txt"
git log -2 --stat > "$stage/git-log-2-stat.txt"
git format-patch -2 --stdout > "$stage/git-format-patch-2.patch"

mkdir -p "$stage/untracked-diffs"
git ls-files --others --exclude-standard -z |
while IFS= read -r -d '' file; do
  safe_name="$(printf '%s' "$file" | sed 's#[/ ]#_#g')"
  git diff --no-index --binary /dev/null "$file" \
    > "$stage/untracked-diffs/${safe_name}.patch" || true
done

mkdir -p "$stage/before" "$stage/after"
git diff --name-only -z |
while IFS= read -r -d '' file; do
  mkdir -p "$stage/before/$(dirname "$file")"
  mkdir -p "$stage/after/$(dirname "$file")"
  git show "HEAD:$file" > "$stage/before/$file" 2>/dev/null || true
  test -f "$file" && cp "$file" "$stage/after/$file" || true
done

# Keep chunks below Oracle's default file cap. Oversized single artifacts are logged instead of packed.
find "$stage" -type f -size +850k ! -name REVIEW_INSTRUCTIONS.md -print \
  > "$stage/SKIPPED_LARGE_ARTIFACTS.txt"
if [ -s "$stage/SKIPPED_LARGE_ARTIFACTS.txt" ]; then
  while IFS= read -r file; do rm -f "$file"; done < "$stage/SKIPPED_LARGE_ARTIFACTS.txt"
fi

chunk=0
zip_path=""
start_chunk() {
  zip_path="$(printf '%s/%02d_core_diff_history.zip' "$bundle_root" "$chunk")"
  rm -f "$zip_path"
  (cd "$stage" && zip -qj "../$(basename "$zip_path")" REVIEW_INSTRUCTIONS.md)
}

start_chunk
while IFS= read -r -d '' file; do
  rel="${file#$bundle_root/}"
  (cd "$bundle_root" && zip -q "$(basename "$zip_path")" "$rel")
  if [ "$(wc -c < "$zip_path")" -gt "$limit_bytes" ]; then
    (cd "$bundle_root" && zip -qd "$(basename "$zip_path")" "$rel" >/dev/null || true)
    chunk=$((chunk + 1))
    start_chunk
    (cd "$bundle_root" && zip -q "$(basename "$zip_path")" "$rel")
  fi
done < <(find "$stage" -type f ! -name REVIEW_INSTRUCTIONS.md -print0 | sort -z)

du -h "$bundle_root"/[0-9][0-9]_*.zip
BASH
```

Run Oracle with only the ZIP chunks unless you know more context is required:

```bash
oracle_files=()
for zip in review-bundles/[0-9][0-9]_*.zip; do
  oracle_files+=(--file "$zip")
done

npx -y @steipete/oracle \
  --engine browser \
  --model "Pro" \
  --slug "diff-review" \
  -p "Review the attached current-diff bundle. Produce final report only. Do not reply with progress updates." \
  "${oracle_files[@]}"
```

If the first browser response is only a progress note or otherwise incomplete, use `--browser-follow-up` to ask for the full report instead of starting over.

## Focused re-review after fixes

After Oracle reports findings, do not resend a repo-sized bundle by default. Create a small re-review bundle with:

- Previous Oracle findings pasted into `REVIEW_INSTRUCTIONS.md`.
- Only files touched to address those findings.
- Current staged patch and `git status --short`.
- Test command/results in `metadata/test-status.txt`.

Prompt: “Check whether the listed findings are fixed. Report only remaining issues, regressions introduced by the fixes, and missing tests/docs.”

## Source-control hygiene

Before Oracle review:

- Ensure required new files are tracked/staged if doing final review.
- Ensure generated assets and review bundles are not staged.
- Include `metadata/git-status-short.txt` so Oracle can catch missing files.
- Create review artifacts under `review-bundles/`; remove them after the run unless the user asks to keep them.
- Use `git add` with explicit paths. Do not stage `review-bundles/**`, generated dirs, local DBs, caches, or env files.

## Budget + observability

- Target: keep total input under ~196k tokens.
- Use `--files-report` (and/or `--dry-run json`) to spot the token hogs before spending.
- If you need hidden/advanced knobs: `npx -y @steipete/oracle --help --verbose`.

## Engines (API vs browser)

- Auto-pick: uses `api` when `OPENAI_API_KEY` is set, otherwise `browser`.
- Browser engine supports GPT + Gemini only; use `--engine api` for Claude/Grok/Codex or multi-model runs.
- **API runs require explicit user consent** before starting because they incur usage costs.
- Browser attachments:
  - `--browser-attachments auto|never|always` (auto pastes inline up to ~60k chars then uploads).
- Browser model picker drift:
  - If model selection fails, retry with the visible ChatGPT picker label, e.g. `--model "Pro"`.
  - If needed, manually select the model in the kept browser and rerun with `--browser-model-strategy current`.
- Remote browser host (signed-in machine runs automation):
  - Host: `oracle serve --host 0.0.0.0 --port 9473 --token <secret>`
  - Client: `oracle --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`

## Sessions + slugs (don’t lose work)

- Stored under `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).
- Browser runs save durable files under `~/.oracle/sessions/<id>/artifacts/`, including `transcript.md`, Deep Research reports, and downloaded ChatGPT-generated images when available.
- Runs may detach or take a long time (browser + GPT‑5.5 Pro often does). If the CLI times out: don’t re-run; reattach.
  - List: `oracle status --hours 72`
  - Attach: `oracle session <id> --render`
- Always check `oracle status --hours 72` before retrying.
- If a session is still running, attach/render first. If it was cancelled or stale, let reattach mark it completed/failed before starting a replacement.
- Do not reuse errored slugs unless intentionally inspecting that failed session.
- Use a new slug after changing attachment strategy.
- Use `--slug "<3-5 words>"` to keep session IDs readable.
- Duplicate prompt guard exists; use `--force` only when you truly want a fresh run.

## Prompt template (high signal)

Oracle starts with **zero** project knowledge. Assume the model cannot infer your stack, build tooling, conventions, or “obvious” paths. Include:

- Project briefing (stack + build/test commands + platform constraints).
- “Where things live” (key directories, entrypoints, config files, dependency boundaries).
- Exact question + what you tried + the error text (verbatim).
- Constraints (“don’t change X”, “must keep public API”, “perf budget”, etc).
- Desired output (“return patch plan + tests”, “list risky assumptions”, “give 3 options with tradeoffs”).

Useful review prompts:

- Initial architecture review: “Review architecture and design fit. Focus on invariants, module boundaries, data flow, failure modes, and missing tests. Return severity-ranked findings with file/line refs.”
- Check fixes: “Given the previous findings in the bundle, verify which are fixed. Report only remaining issues, regressions introduced by the fixes, and missing tests/docs.”
- Final staged pre-commit review: “Review exactly the staged changes. Prioritize correctness, regressions, tests/docs gaps, and whether logic changes match the stated intent. Produce final report only.”

### “Exhaustive prompt” pattern (for later restoration)

When you know this will be a long investigation, write a prompt that can stand alone later:

- Top: 6–30 sentence project briefing + current goal.
- Middle: concrete repro steps + exact errors + what you already tried.
- Bottom: attach _all_ context files needed so a fresh model can fully understand (entrypoints, configs, key modules, docs).

If you need to reproduce the same context later, re-run with the same prompt + `--file …` set (Oracle runs are one-shot; the model doesn’t remember prior runs).

## Safety

- Don’t attach secrets by default (`.env`, key files, auth tokens). Redact aggressively; share only what’s required.
- Prefer “just enough context”: fewer files + better prompt beats whole-repo dumps.
