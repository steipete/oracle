# Windows work notes

Read this file whenever you're working from Windows and add new findings so the next agent can stay unblocked.

- Browser engine now allowed on Windows; expect more flakiness. If automation fails, rerun with `--engine api --wait` or point `--remote-chrome` to a running Chrome with remote debugging.
- Chrome DevTools via mcporter: `chrome-devtools` server needs `CHROME_DEVTOOLS_URL` from a live session; without it `mcporter call chrome-devtools.*` fails. Expect this to be unset on Windows unless you bring your own Chrome session/URL.
- The agent-scripts `runner` helper can fail under PowerShell/CMD because of CRLF and bash expectations. If it explodes, run commands directly (`pnpm ...`, `git add/commit`) instead.
- browser-tools binary: not built in `agent-scripts/bin` on Windows; `pnpm tsx scripts/browser-tools.ts` also fails there (no package manifest). Use a macOS-built binary or run from macOS if you need it.
- Prefer PowerShell + pnpm directly; watch for CRLF warnings when touching tracked files.
- WSL browser launch host detection: a systemd-resolved stub such as `nameserver 127.0.0.53` is guest loopback, not the Windows host. Keep resolver-derived non-loopback hosts for Windows Chrome compatibility, but route resolver-derived `127/8` values to the standard local Chrome launcher.

Future Windows gotchas belong here. Update this doc when you learn something new.

- A fresh Windows worktree with `core.autocrlf=true` can make `oxfmt --check` flag otherwise unchanged files. Use LF checkout contents for validation and inspect the staged diff to keep checkout-only line-ending changes out of the PR.

- ChatGPT sidebar/history labels can include phrases like "Login setup instruction"; login probes must match exact auth CTAs, not any visible text starting with login, or manual-login automation loops forever before typing.
