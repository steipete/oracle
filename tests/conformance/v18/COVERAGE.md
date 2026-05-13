# v18 Conformance Coverage

Source spec: `PLAN/oracle-vnext-plan-bundle-v18.0.0/spec.md` §11 (CLI
Ergonomics), §12 (Error Codes), and
`contracts/json-envelope.schema.json`.

## json_envelope.v1

| Clause source           | Requirement                                            | Tested |
|-------------------------|--------------------------------------------------------|--------|
| schema §required         | All 11 required fields present                         | yes    |
| schema §type             | `ok: boolean`                                          | yes    |
| schema §type             | `schema_version: string` (literal `json_envelope.v1`)  | yes    |
| schema §type             | `data` is object / array / string / null               | yes    |
| schema §type             | `meta: object`                                         | yes    |
| schema §type             | `errors[]` items are objects                           | yes    |
| schema §type             | `warnings[]` items are strings                         | yes    |
| schema §type             | `commands: object`                                     | yes    |
| schema §type             | `blocked_reason: string \| null`                       | yes    |
| schema §type             | `next_command: string \| null`                         | yes    |
| schema §type             | `fix_command: string \| null`                          | yes    |
| schema §type             | `retry_safe: boolean \| null`                          | yes    |
| schema §additionalProps  | Extension keys round-trip without dropping             | yes    |
| spec §11 recovery        | Failure envelopes carry `blocked_reason`               | yes    |
| spec §11 recovery        | Failure envelopes carry `next_command` / `fix_command` | yes    |
| spec §11 recovery        | Failure envelopes declare `retry_safe`                 | yes    |
| spec §12 error taxonomy  | All 12 canonical error codes are known                 | yes    |
| spec §12 error taxonomy  | `error_code` validation rejects unknown codes          | yes    |
| canonical fixture        | `fixtures/json-envelope.ok.json` parses                | yes    |

## Not covered (by this harness, intentional)

- `provider_capability.v1`, `browser_lease.v1`, etc. — owned by pane 6 in
  `src/oracle/v18/contracts.ts`. This harness only covers
  `json_envelope.v1` + the error taxonomy from oracle-0h7.
- Live CLI surface compliance (does `oracle doctor --json` actually emit
  a valid envelope?) — that belongs to the downstream beads
  (`oracle-rg2`, `oracle-a2u`, `oracle-qok`, ...) once the helpers ship.
