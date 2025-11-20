# Remote Chrome Service Debug Log

## Context
- Date: 2025-11-20 (US timezone)
- Goal: Run Oracle browser mode from local laptop against VM-hosted Chrome via new `oracle serve` remote service.
- VM IP: 192.168.64.2
- Service port/token used during attempts: 49810 / `cd93955b64d5afcb946a4a4a89651313`

## Attempts

### 1) Local run via remote host
Command:
```
oracle --engine browser \
  --remote-host 192.168.64.2:49810 \
  --remote-token cd93955b64d5afcb946a4a4a89651313 \
  --prompt "Remote service sanity check" \
  --wait
```
Outcome:
- Initially routed to local Chrome (before wiring fix).
- After wiring fix, logs showed “Routing browser automation to remote host …” but requests failed with:
  - `ECONNREFUSED 192.168.64.2:49810` when no service listening.
  - `busy` when a previous service process was still bound.
  - Later run reached remote path but failed model switch: `Unable to find model option matching "GPT-5.1 Pro"` (remote Chrome not logged into ChatGPT / model picker mismatch).
- After disabling cookie shipping and requiring host login, remote runs now fail earlier: service logs “Loading ChatGPT cookies from host Chrome profile…” then reports `Unhandled promise rejection ... Unknown error` when `loadChromeCookies` runs on the VM. Remote client sees `socket hang up` because the server doesn’t deliver a result.

### 2) Remote service on VM
Actions taken on VM (tmux `vmssh`):
- Installed bun (`~/.bun/bin/bun`), added to PATH in `~/.zshrc`.
- `./runner` requires bun; starting service with:
  ```
  cd ~/Projects/oracle
  export PATH="$HOME/.bun/bin:$PATH"
  ./runner pnpm run oracle -- serve --port 49810 --token cd93955b64d5afcb946a4a4a89651313
  ```
- When started correctly, logs show:
  ```
  Remote Oracle listening at 0.0.0.0:49810
  Access token: cd93955b64d5afcb946a4a4a89651313
  ```
- One run failed with EADDRINUSE when a stale node listener stayed on 49810; resolved by killing `node ...49810`.

### Observed blockers
- Environment PATH: bun not on PATH for non-interactive shells caused `./runner` to fail; need to `export PATH="$HOME/.bun/bin:$PATH"` before starting service.
- Port collisions: prior listeners on 49810 caused ECONNREFUSED/busy.
- Remote model switch failed: remote Chrome likely not signed into ChatGPT; model picker couldn’t find “GPT-5.1 Pro”.
- Keychain/cookie read now failing on VM: `loadChromeCookies` throws “Unknown error” when invoked from the server process (Node 25, SSH shell). When `oracle serve` runs from GUI Terminal it starts fine; under nohup/SSH it logs the rejection and remote runs hang.

## Next steps
- On VM: start service in a clean shell with bun on PATH:
  ```
  cd ~/Projects/oracle
  export PATH="$HOME/.bun/bin:$PATH"
  ./runner pnpm run oracle -- serve --port 49810 --token cd93955b64d5afcb946a4a4a89651313
  ```
  Leave it running; verify with `lsof -nP -iTCP:49810 -sTCP:LISTEN`.
- Sign into ChatGPT in the VM’s Chrome profile used by the service so model switching succeeds. (Currently we rely on host cookies only; client cookie shipping is disabled.)
- If cookie loading keeps failing under SSH/nohup, start `oracle serve` from a GUI macOS session or switch to Node 20 to avoid Keychain issues.
- Retry local command above; ensure service logs show incoming /runs and that the login probe passes (no login button).
- Optional: switch to a fresh port/token (`oracle serve` with no args) to avoid lingering listeners.
- Code change (2025-11-20): `loadChromeCookies` now probes the macOS Keychain with a timeout and fails fast instead of hanging when Keychain access is denied. Remote runs should now emit a clear error instead of a socket hang up if the service can’t read Chrome cookies; re-test the SSH/nohup scenario.

## Notes
- Remote mode forces `--wait`, disables detach, and logs when routing to remote executor.
- Client uses NDJSON streaming; remote server serializes attachments per run and cleans temp dirs.
