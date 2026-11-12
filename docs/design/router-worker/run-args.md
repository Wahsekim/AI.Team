# Frozen run arguments and call accounting (rollout gate G-05, offline part)

Status: offline. Nothing here starts the engine, calls a model or writes a file.
Every record is `launchable: false`.

The count engine (`.claude/workflows/run-n-rounds.js`, [contract](../../engine.md))
already owns the count bound, the Q5 budget gate, the failure policy and the
Guardian audit. Until now a Router/Worker preview produced one plan item, and
the rest of the engine arguments were whatever a caller typed. This step builds
the complete arguments from frozen inputs, so those controls cannot be left out
or loosened by omission.

```sh
node kit/scripts/freeze-run-router-worker.mjs RUN.json --team-root <team-root>
```

`RUN.json` is `{"run": {...}, "inputs": [...]}`. `inputs` are compiler inputs
([preflight contract](preflight-contract.md)), one per ticket, in run order.
`run` carries only the owner directive and the ledger position:

| Field | Meaning |
|---|---|
| `rounds` | the owner count N; must equal the number of inputs |
| `date`, `nextLifecycleNumber`, `runId` | ledger date, first lifecycle number, reconciliation key |
| `budgetCeilingTokens` | the Q5 ceiling for this invocation |
| `launchManifestDigest` (optional) | digest from `preflight-run.mjs`, echoed by the engine |

Exit 0 prints `{args, record}`; exit 2 is a refusal; exit 1 is usage.

## What is derived, not accepted from the caller

| Argument | Source |
|---|---|
| `plan` | the compiled plan item of each input |
| `guardianAgentType` | `policy.profiles.guard.wrapper` of the inputs |
| `allowedAgentTypes` | wrappers of the `active` rows of `agents/roster.md` in the team root |
| `executionMode` | always `wrappers` |
| `failurePolicy` | always `halt-on-failure` (`continue` needs per-ticket isolation, which does not exist) |

## Refusals

| Code | Reason |
|---|---|
| a compiler code | an input does not compile; the compiler finding is returned unchanged |
| `INVALID_RUN` | unknown or missing `run` field, wrong type, missing roster or engine |
| `COUNT_MISMATCH` | N differs from the number of frozen tickets |
| `DUPLICATE_TICKET` | one ticket twice in a run |
| `POLICY_MISMATCH` | inputs carry different policies (one run has one policy and one Guardian) |
| `DUTY_NOT_STAFFED` | the roster has no `active` `worker-exec`, `worker-check` or `worker-guard` row staffed by the policy wrapper; a dormant Guardian is a missing Guardian |
| `BUDGET_BELOW_ESTIMATE` | the summed execution and check estimates reach 80% of the ceiling, the line at which the engine stops dispatching; such a run could not finish even on estimate |
| `BUDGET_EXCEEDED` | ceiling above the summed ticket authorizations |
| `ENGINE_REJECTED` | the real engine validator (dry run, aborting agent, zero dispatch) rejects the arguments |

The record binds the arguments (`argsDigest`), the engine copy, the roster, the
policy and each input and preview digest, and states the budget figures.

Budget figures in the record: `ceiling`, `stopLine` (80% of the ceiling,
rounded down), `estimated` and `authorized`. The accepted range is
`estimated < 0.8 x ceiling` and `ceiling <= authorized`, so the ticket
authorizations must leave at least 25% above the execution and check estimates.
The Guardian call has no estimate and is not in `estimated`: it runs after the
last ticket, so it cannot stop a ticket, but its spend can still take the final
total over the stop line and block the next invocation. The rework estimate is
not counted either; a retry is a new run (G-03).

## Call accounting

`accountRun({ args, record, result })` (library) matches an engine return to the
frozen arguments: same arguments as frozen, same run identity, every result in
plan order with the planned wrapper, a Guardian record, and lifecycle entries and
the next lifecycle number equal to one entry per dispatched ticket plus one
Guardian entry. Anything else is `unaccounted`. An accounted return reports the
calls per duty and `blockers` (`guardian-unavailable`, `guardian-not-clean`,
`budget-gate`, `fix-retest-pending`, `recovery-pending`, `run-incomplete`,
`halt-requires-acknowledgement`). `accounted` is about bookkeeping, not quality.

Writing the ledgers stays with `scripts/reconcile-run.mjs`, unchanged.

## Injected faults (tests, real engine, mock agents)

- Budget crosses 80% of the ceiling after the first execution: no check call,
  no second ticket, the Guardian still audits, the run is blocked.
- Guardian unavailable: all work passed and the run is still not continuable.
- A worker reports a terminal stop: the next ticket is never dispatched.
- A return altered in any of eight ways, or arguments edited after the freeze:
  `unaccounted`.
- The same return delivered twice to `reconcile-run.mjs`: lifecycle entries and
  the counter are written once.

## Not covered

- `in-run-owner-stop-observation`: the engine has no IO, so an owner stop that
  arrives mid-run is seen only by a worker (terminal stop) or by the PM after
  the run. This is the existing engine contract, unchanged.
- `guardian-runtime-prompt`: the Guardian brief is built inside the engine and
  is not part of the frozen read closure.
- `runtime-isolation-and-lease-at-launch`: the isolation gate and the ownership
  lease are separate records; nothing binds them to a launch yet, because there
  is no launch step.
- `retry-continuation` (G-03) and `real-usage-settlement` (G-04).
- Governance triggers (Coach, Auditor, Security cadence) are PM duties outside
  the engine; staffing them is covered in
  [coverage and drafts](coverage-and-drafts.md), executing them is not automated.

G-05 stays open for the live half: these stops are shown against the real
engine with mock agents, not against a real runtime.
