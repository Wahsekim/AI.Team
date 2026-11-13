# Usage settlement (rollout gate G-04, offline part)

Status: offline. Nothing here calls a model, reads a transcript or writes a
file. Every record is `launchable: false`.

The [retry journal](retry-accounting.md) refuses a call unless the `budget`
admission gate is `clear`, but that gate was a value the host declared, and
measured usage was never attached to a ticket. This step adds a per-ticket
ledger of measured usage and derives the gate from it.

`src/router-worker/settlement.mjs`:

- `createSettlementLedger({ticketId, authorizedTokens})`
- `advanceSettlementLedger({ledger, expectedDigest, event})` returns `{ledger, state, applied}`
- `inspectSettlementLedger({ledger})`
- `usageEventFromMeterRow({row, callRef, eventId})`
- `settleAgainstJournal({ledger, retryJournal, rules, nextEstimateTokens?})`

```sh
node kit/scripts/settle-router-worker.mjs REQUEST.json [--instance <instance-root>]
```

`REQUEST.json` is `{"ledger", "retryJournal", "nextEstimateTokens"?}`. Exit 0
means the budget gate is `clear`; exit 2 means `blocked`, `unknown` or invalid;
exit 1 is usage. The command only reads.

## Unit and meter

The unit is `input+cache_creation`, the same unit as the lifecycle `Tokens:`
line and the compiler's `budgetUnit`. The meter is the existing
`scripts/measure-spawn.mjs --json`: one row of `.subagents[]` becomes one usage
event through `usageEventFromMeterRow`, taking `harnessEq` (never the four-class
`total`), `uniqueMessages` and `finished`. No second meter is introduced.
For an agent the count engine started, `finished` comes from the workflow run's
`journal.jsonl`: a recorded `result` for that agent means finished, `started`
alone means not finished, and no readable journal leaves it unknown. On the
E-01 smoke run (2026-11-13) this settles the execution and check calls
(59,717 and 29,511) and the gate is `clear`; before, both stayed `partial`.

## Events

| Event | Fields | Effect |
|---|---|---|
| `usage` | `callRef`, `agentId`, `harnessTokens`, `uniqueMessages`, `finished`, `sourceRef` | one meter read of one call |
| `unknown-usage` | `callRef`, `reasonRef` | the call ran and cannot be measured |

`callRef` is the call reference the retry journal recorded at `start`.

- **One call, one meter row.** A call is bound to the first `agentId` that pays
  it; a second row for the same call, or one row for two calls, is
  `IDEMPOTENCY_CONFLICT`.
- **Cumulative reads.** A transcript only grows, so a later read of the same
  call replaces the earlier one and only the difference is added. A read with
  fewer tokens or fewer messages is `USAGE_REGRESSION`.
- **Duplicate delivery.** The same event ID with the same content is a no-op
  (`applied: false`); with different content it is `IDEMPOTENCY_CONFLICT`. The
  same measurement under another event ID adds nothing.
- **Unknown stays unknown.** An `unknown-usage` call counts no tokens and is
  never read as zero. Only a later measurement resolves it; a measured call
  cannot be turned back into unknown.
- **Restart.** The ledger is canonical JSON with a self-digest; state is always
  rebuilt by replaying its events. A writer holding an older digest is
  `STALE_SETTLEMENT_LEDGER`; a ledger whose content or authorization was edited
  is `SETTLEMENT_LEDGER_MISMATCH`.

## Settlement against the retry journal

`settleAgainstJournal` lists every started call of the ticket with its
assignment, duty, attempt, tokens and status, and reports:

| Field | Meaning |
|---|---|
| `spentTokens` | all measured tokens of the ticket, including usage no journal call explains |
| `remainingTokens`, `overrunTokens` | against `authorizedTokens`; an overrun is kept in full |
| `budgetGate` | `blocked`, `unknown` or `clear` |
| `reasons` | why the gate is not clear |
| `ticketStopped` | the retry journal carries a stop; usage that arrives after a stop is still settled |

| Reason | Gate | When |
|---|---|---|
| `authorization-exhausted` | blocked | spent is at or above the authorization |
| `insufficient-remaining` | blocked | `nextEstimateTokens` exceeds what remains |
| `unknown-usage` | unknown | a call is recorded as unmeasurable |
| `partial-usage` | unknown | a call has only reads of an unfinished agent |
| `unsettled-call` | unknown | the journal started a call the ledger has no entry for |
| `unattributed-usage` | unknown | the ledger holds usage for a call the journal never started |

The `budget` gate is one of nine admission gates. A `clear` here does not clear
a stop or any other gate.

## Run settlement

The Guardian call belongs to the run and to no ticket, so no ticket ledger holds
it. `src/router-worker/run-settlement.mjs` `settleRun({record, tickets, guardian})`
takes the frozen run record, the ticket settlements of that run and the
Guardian's `measure-spawn` row (or `null`):

```sh
node kit/scripts/settle-run-router-worker.mjs REQUEST.json   # {"record", "tickets", "guardian"}
```

Exit 0 means the run gate is `clear`; 2 means `blocked`, `unknown` or invalid; 1
is usage. It reports `ticketTokens`, `guardianTokens`, `totalTokens`, the summed
ticket authorization and the Guardian estimate, all in `input+cache_creation`.

| Reason | Gate | When |
|---|---|---|
| `ticket-gate-blocked:<ticket>` | blocked | that ticket's budget gate is blocked |
| `guardian-over-estimate` | blocked | the finished Guardian call measured above `record.guardian.estimated` |
| `ticket-unsettled:<ticket>` | unknown | a ticket of the run has no settlement |
| `ticket-gate-unknown:<ticket>` | unknown | that ticket's budget gate is unknown |
| `guardian-usage-missing` | unknown | no Guardian row was supplied |
| `guardian-usage-partial` | unknown | the Guardian row is not marked finished |

A record or ticket settlement that does not match its own digest, a ticket that
is not in the run, or a ticket given twice is refused
(`INVALID_RUN_SETTLEMENT`). A blocked run gate is found after the run; it says
the next run needs a new estimate or authorization, it stops nothing.

In the E-01 smoke run the Guardian measured 17,488 and the two ticket calls
89,228, a run total of 106,716. The main session (54,594) and governance calls
are in neither figure.

## Not covered

- `meter-read-authenticity` and `call-to-transcript-binding`: the ledger trusts
  that the row passed in belongs to the call named. Binding a runtime agent ID
  to a journal call needs the live host.
- `durable-ledger`: the library is pure; storage and locking are the host's.
  Name a stored ledger `<ticket>.rw-settlement.json`; that pattern is
  gitignored. Custody follows the [storage policy](storage-policy.md).
- `guardian-and-governance-usage`: the Guardian call is settled per run (above),
  not in this ledger. Governance calls and the main session are settled nowhere.
- `lifecycle-token-lines`: lifecycle entries are still written by
  `scripts/reconcile-run.mjs` from the engine return.
- `cross-ticket-run-budget`: the run ceiling is the engine's Q5 gate
  ([frozen run arguments](run-args.md)); this ledger is per ticket.

G-04 stays open for the live half.
