# PR 325 browser queue live proof

Date: 2026-07-17 (UTC)

Environment:

- Oracle CLI and MCP: `0.16.0`, built from the PR branch
- Platform: macOS, Node.js 24
- Browser engine only; no API fallback
- Shared signed-in manual-login profile
- ChatGPT Pro selection verified by Oracle for every submitted run
- Public neutral prompts and one 134-byte public neutral text fixture

Conversation URLs, profile paths, account identity, and generated conversation
content other than the neutral markers are omitted. Local Chrome PID and DevTools
port are retained because stable reuse is part of the behavior under test.

## Four-client FIFO handoff

Four independent CLI processes were started in the order B, A, C, D with:

```text
--engine browser
--model gpt-5-pro
--browser-thinking-time extended
--browser-model-strategy select
--browser-attachments never
--browser-archive never
--browser-max-concurrent-tabs 1
--browser-queue-timeout 10m
--wait
```

The processes started at `20:50:13Z`, `20:50:16Z`, `20:50:17Z`, and
`20:50:18Z`. The observed slot acquisition order was B, A, C, D:

```text
B  Acquired ChatGPT browser slot dd20860d
B  Released ChatGPT browser slot dd20860d
B  PR325_FIFO_B_OK

A  Waiting for ChatGPT browser slot (1 max, 0s elapsed)
A  Waiting for ChatGPT browser slot (1 max, 30s elapsed)
A  Acquired ChatGPT browser slot f583a582
A  Released ChatGPT browser slot f583a582
A  PR325_FIFO_A_OK

C  Waiting for ChatGPT browser slot (1 max, 0s elapsed)
C  Waiting for ChatGPT browser slot (1 max, 30s elapsed)
C  Waiting for ChatGPT browser slot (1 max, 60s elapsed)
C  Acquired ChatGPT browser slot 916e3dcb
C  Released ChatGPT browser slot 916e3dcb
C  PR325_FIFO_C_OK

D  Waiting for ChatGPT browser slot (1 max, 0s elapsed)
D  Waiting for ChatGPT browser slot (1 max, 30s elapsed)
D  Waiting for ChatGPT browser slot (1 max, 60s elapsed)
D  Waiting for ChatGPT browser slot (1 max, 90s elapsed)
D  Acquired ChatGPT browser slot 60f3c1ac
D  Released ChatGPT browser slot 60f3c1ac
D  PR325_FIFO_D_OK
```

All four processes exited `0`. Their persisted metadata recorded:

| Session              | Session status | Model status | Prompt submitted | Chrome PID | DevTools port | Transcript |
| -------------------- | -------------- | ------------ | ---------------- | ---------: | ------------: | ---------: |
| `pr325-fifo-proof-b` | `completed`    | `completed`  | `true`           |      81373 |         51341 |      479 B |
| `pr325-fifo-proof-a` | `completed`    | `completed`  | `true`           |      81373 |         51341 |      479 B |
| `pr325-fifo-proof-c` | `completed`    | `completed`  | `true`           |      81373 |         51341 |      479 B |
| `pr325-fifo-proof-d` | `completed`    | `completed`  | `true`           |      81373 |         51341 |      479 B |

The final registry was empty:

```json
{
  "version": 2,
  "leaseCount": 0,
  "waiterCount": 0
}
```

## Independent queue timeout

One holder used a 10-minute queue budget. A second process started three seconds
later with a 5-second queue budget:

```text
holder  Acquired ChatGPT browser slot 670d2352
waiter  Waiting for ChatGPT browser slot (1 max, 0s elapsed)
waiter  ERROR: Timed out waiting for ChatGPT browser slot after 5s (1 max).
holder  PR325_TIMEOUT_HOLDER_OK
holder  Released ChatGPT browser slot 670d2352
```

The waiter exited `1` with session/model status `error/error` and never launched
or attached to Chrome. The holder continued independently, exited `0`, persisted
`completed/completed`, and saved its transcript. The registry again ended with
zero leases and zero waiters.

## MCP parity

The canonical local MCP smoke ran after the CLI stress:

```text
[browser] Acquired ChatGPT browser slot 47659cee (1 max).
[browser] Thinking time: Pro (already selected)
{"status":"OK"}
[browser] Released ChatGPT browser slot 47659cee.
```

MCP returned session status `completed`; persisted session/model status was
`completed/completed`, `promptSubmitted=true`, the transcript was 180 bytes, and
the final registry remained empty.

## Upgrade and regression checks

The focused registry test starts from a literal version-1 registry containing an
active lease. It acquires a second slot, verifies the original lease is retained,
and verifies the file is rewritten as version 2 with an empty waiter list.

Validation on the same branch:

```text
focused browser acceptance suite: 39 passed
provider/performance regression suite after scope split: 23 passed
full test suite: 1582 passed, 43 skipped
pnpm run check: passed
pnpm run build: passed
git diff --check: passed
```

## Post-merge exact-tree refresh

Date: 2026-08-02 (UTC)

The PR head `9d15d2e67ea168fd6b1c7ad270645785c3b1b222` was merged without
rebasing with `upstream/main` at
`0ce8f2be62ace9c86fb9f00af1b12f1bfc0edea3`. The semantic conflict
resolution preserves registry v2 FIFO waiters and the current-main
`recoverableDisconnect` state machine.

Two fresh independent CLI clients used Oracle `0.16.1`, browser-only Pro,
`maxConcurrentTabs=1`, and the same neutral 96-byte text fixture. Client A
acquired first; client B logged a queue wait before acquiring after A released:

```text
A  Acquired ChatGPT browser slot 767f6b08
A  Released ChatGPT browser slot 767f6b08
A  PR325_QUEUE_A_OK

B  Waiting for ChatGPT browser slot (1 max, 0s elapsed)
B  Acquired ChatGPT browser slot d0b4c5d7
B  Released ChatGPT browser slot d0b4c5d7
B  PR325_QUEUE_B_OK
```

Both sessions exited `0`, persisted `completed/completed`, recorded
`promptSubmitted=true`, and independently verified the Pro picker. They reused
Chrome PID `29902` and DevTools port `56259`; each saved a 377-byte transcript
and a 17-byte answer-only output.

The canonical MCP live smoke then acquired and released the same one-slot queue,
verified Pro, returned `{"status":"OK"}`, persisted `completed/completed`, and
saved a 180-byte transcript. The registry after CLI and MCP proof was:

```json
{
  "version": 2,
  "leaseCount": 0,
  "waiterCount": 0
}
```

The no-login real-Chrome CDP proof also passed both lifecycle outcomes:

```text
live Chrome and target after client disconnect: recoverable=true
closed Chrome endpoint: recoverable=false
PROOF_OK both disconnect outcomes demonstrated against real Chrome CDP
```

Validation on the merged tree:

```text
focused browser/session/MCP suite: 236 passed
full test suite: 1624 passed, 43 skipped
pnpm run check: passed
pnpm run build: passed
pnpm run docs:check: passed
node scripts/cdp-disconnect-proof.mjs: passed
git diff --check: passed
```

One initial full-suite run hit the unrelated 15-second timeout in
`tests/cli/perfTrace.test.ts`. Its isolated rerun passed 13/13, and the immediate
full-suite rerun passed 1624/1624 executed tests.
