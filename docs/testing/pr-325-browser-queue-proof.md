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
focused browser acceptance suite: 38 passed
provider/performance regression suite after scope split: 23 passed
full test suite: 1581 passed, 43 skipped
pnpm run check: passed
pnpm run build: passed
git diff --check: passed
```
