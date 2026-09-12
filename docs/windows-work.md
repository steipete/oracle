# Windows work notes

Read this file whenever you're working from Windows and add new findings so the next agent can stay unblocked.

- Browser engine now allowed on Windows; expect more flakiness. If automation fails, rerun with `--engine api --wait` or point `--remote-chrome` to a running Chrome with remote debugging.
- Chrome DevTools via mcporter: `chrome-devtools` server needs `CHROME_DEVTOOLS_URL` from a live session; without it `mcporter call chrome-devtools.*` fails. Expect this to be unset on Windows unless you bring your own Chrome session/URL.
- The agent-scripts `runner` helper can fail under PowerShell/CMD because of CRLF and bash expectations. If it explodes, run commands directly (`pnpm ...`, `git add/commit`) instead.
- browser-tools binary: not built in `agent-scripts/bin` on Windows; `pnpm tsx scripts/browser-tools.ts` also fails there (no package manifest). Use a macOS-built binary or run from macOS if you need it.
- Prefer PowerShell + pnpm directly; watch for CRLF warnings when touching tracked files.
- WSL browser launch host detection: a systemd-resolved stub such as `nameserver 127.0.0.53` is guest loopback, not the Windows host. Keep resolver-derived non-loopback hosts for Windows Chrome compatibility, but route resolver-derived `127/8` values to the standard local Chrome launcher.
- Detached session workers launched by either CLI or MCP must use the shared launcher with `windowsHide: true`; a bounded MCP `wait` releases only the waiter and leaves that hidden worker running.
- A waiter can read `meta.json` while the detached worker atomically replaces it. Windows may transiently reject that replacement with `EPERM`, `EBUSY`, or `EACCES`; retry only those lock-like errors with a short bounded backoff.
- Resolve the session directory with `realpathSync.native` before `fs.watch`; Windows short-path aliases can otherwise hit a native libuv path-prefix assertion instead of a catchable watcher error.

Future Windows gotchas belong here. Update this doc when you learn something new.

- Tab-lease tests run real PowerShell process-identity probes (up to five seconds each). Their Windows test budget must cover multiple probes and registry cleanup. Failed self-identity probes are retried on the next lookup; only a successful identity is cached for the controller lifetime.

- A fresh Windows worktree with `core.autocrlf=true` can make `oxfmt --check` flag otherwise unchanged files. Use LF checkout contents for validation and inspect the staged diff to keep checkout-only line-ending changes out of the PR.

- ChatGPT sidebar/history labels can include phrases like "Login setup instruction"; login probes must match exact auth CTAs, not any visible text starting with login, or manual-login automation loops forever before typing.
- For Windows PR refreshes, use `git -c core.autocrlf=false` for merge and review commands; preserve untracked `.codex-tmp/` handoff state and leave it out of commits.
- ChatGPT's composer plus button can sit close to Work suggestions. A coordinate click observed on Windows entered a new `/c/WEB:...` Work task even though the attachment tile later appeared. Activate only `#composer-plus-btn` / `button[data-testid="composer-plus-btn"]`, then fail closed if the conversation id changes or Work becomes selected before file assignment. Preserve that page identity through upload and check it again at final dispatch. After upload, close an expanded plus menu and keyboard-activate only the exact `button[data-testid="send-button"]`; a trusted coordinate click was observed dismissing UI without committing the staged attachment prompt.
- `scripts/browser-tools.ts` may attach its "active page" command to an `about:blank` target when several DevTools targets exist. For signed-in evidence, select the exact target id recorded by the Oracle session and verify its URL and composer state directly.

- Shared manual-login Chrome is detached from its native Windows controller and launched with `windowsHide`; temporary and copied profiles retain their existing process lifecycle. The final verified lease owner terminates the matching Chrome PID/profile.
- After upgrading this lease protocol, restart all Oracle browser controllers before sharing a profile. Older live controllers can forcibly remove a registry lock after their timeout; stored legacy records remain readable, but simultaneous mixed-version controllers are not a safe upgrade path.
- Run `node scripts/shared-chrome-lifecycle-proof.mjs` after building for the native two-controller check. It uses a freshly initialized, signed-out profile and locally supplied pages, verifies peer CDP access after the owner exits, then checks final registry/process/endpoint cleanup. It does not prove signed-in ChatGPT concurrency or backend model identity.

- After merging a dependency update that changes oxfmt, CRLF checkouts may fail format checks across otherwise unchanged files. Normalize tracked text working copies to LF and use `git -c core.autocrlf=false` for staging; verify the resulting diff contains only intended changes.
