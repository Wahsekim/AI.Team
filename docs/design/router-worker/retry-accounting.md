# Offline retry and session accounting

Status: implementation of ADR 0008's accepted counting semantics; no live
dispatcher, session-resume API or settlement adapter. A separate
[SQLite persistence adapter](retry-persistence.md) now stores this journal.
All summaries remain `launchable: false`, `deliveryAuthorized: false`.

## Interface and authority

`src/router-worker/retries.mjs` exports:

- `loadRetryRules({teamRoot})`: read the existing charter, PM rules and accepted
  ADR 0008; bind their byte digests and refuse unsupported cap/stop wording.
  Current semantics are two retries after the initial call, two consecutive
  empty/repeated closes, and the original third fix→verify escalation threshold.
  The loader is intentionally conservative: upstream rule changes require review.
- `createRetryJournal({ticketId, rules})`: create one fixed-ticket journal.
- `advanceRetryJournal({journal, rules, expectedDigest, event})`: validate and
  replay the bounded journal, check caller version, then append one valid event.
  Returns `{journal, state, applied}`. Identical event-ID replay returns
  `applied: false`; conflicting content for that ID is rejected.
- `inspectRetryJournal({journal, rules})`: replay events into derived counters,
  sessions, assignments and stop reasons. Stored counter values are not accepted.

All functions except the local rule loader are pure. Inputs and prior journal
versions are not mutated. Invalid transitions throw a structured error with a
`code`; there is no partial output or side effect. Journals use canonical JSON,
a self-excluding content digest, a 1 MiB parsing bound and at most 256 events.
Capacity exhaustion requires a future reviewed archival procedure, not reset.

These events must ultimately come from a trusted host, never directly from worker
reports. Source hashes, session/call references and a matching journal digest
are consistency checks, **not authentication**. The pure library has no storage
or lock. Its optional persistence adapter provides transactional version checks,
but no product lock or trusted event producer. A caller able to replace/re-hash
the entire journal can erase its history; the future host must prevent that.
Do not claim this library alone enforces a deployed team's retry limit.

## Events and state transitions

Every event has a unique `eventId`. Closed schemas reject unknown fields.

| Event | Required event-specific fields | Effect |
|---|---|---|
| `prepare` | `assignmentId`, `duty`, `planRef`, `candidateRef`, `continuationOf`, `resumeSessionRef`, `divergence`, `admission` | Reserve one serial logical assignment; no call count yet |
| `start` | `assignmentId`, `sessionRef`, `callRef`, `admission` | Bind one host call and consume one attempt |
| `close` | `assignmentId`, `outcome`, `progress`, `outcomeKey`, `candidateRef`, `receiptRef` | Record host-observed closure; never authorize delivery |
| `cancel` | `assignmentId`, `neverStartedRef` | Cancel only a preparation proved never started; no attempt consumed |
| `unknown` | `assignmentId`, `reasonRef` | Conservatively consume an uncertain prepared call if necessary, block redispatch |
| `stop` | `reason`, `evidenceRef` | Add a sticky stop; no automatic resume |

```text
prepared ──start──> started ──close──> closed
    │                 │
    ├─cancel──> cancelled
    │                 │
    └─unknown──> unknown <──unknown─┘
                    │
                    └─late close only if the session was already bound

stop: blocks new prepare/start; existing started calls may still close.
unknown/stop never clears itself when a late result arrives.
```

Refs have the existing `{id, digest}` shape. Host session references must represent
stable session identity, not a changing transcript digest. `callRef` identifies
one physical call and cannot be attributed to another assignment. Guard and
governance dispatches are not ticket retries in this first library; those roles
remain governed by their existing workflows, not silently counted as exec/check.

## Counting and continuity

The journal fixes `ticketId`. Counters derive from started/uncertain assignments
for each duty, never model, method, wrapper or assignment names. Attempts 1–3 are
allowed; a fourth is refused. A cancelled preparation can be replaced under a new
assignment ID with the same next attempt number. Previously used assignment IDs
cannot be recycled. Transport/event replay does not create another call or close.

A retry must reference the previous started assignment of that duty and its
original session. Exec and check session IDs **and** identity digests must differ.
A missing/lost session cannot be silently replaced. Retry `divergence` must name
the previous plan digest, include an evidence ref and explanation, and use a new
`planRef.digest`. This proves a declared plan revision, not meaningful semantic
improvement; the host/PM must inspect the actual evidence and avoid cosmetic edits.

Exec cannot close with `pass`; it produces a `candidate` or reports `fail`/`blocked`.
A `blocked` author close may carry a candidate reference: the author returned
work and reports that the ticket cannot be completed inside its boundary (E-02
smoke run: the requested test was written, passing it needed a change outside
the mandate). That work may be checked once, which matches the count engine,
where the verifier still runs after a blocked worker. When that check closes,
with any outcome, the ticket gets the sticky stop `scope-decision`: the same
brief cannot converge, so there is no automatic repair and a passing check does
not make it accepted work. Before the check, a further author call is refused
(`CHECK_REQUIRED`). A `blocked` close without a candidate is unchanged.
Check must identify the latest author's candidate in preparation and closure.
A completed author candidate cannot be followed by an automatic repair until
that candidate has an independent failed check. A blocked verifier requires
resolution/retest, not author churn. A passing check claim blocks further chaining
pending the still-unimplemented acceptance/settlement transition; it is not Done.

## Earlier stops remain authoritative

Both prepare and start require an `admission` record:

```json
{
  "sourceRef": {"id": "host-admission", "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  "gates": {
    "owner": "clear", "budget": "clear", "security": "clear",
    "global-progress": "clear", "round-trip": "clear", "governance": "clear",
    "lifecycle": "clear", "count-guardian": "clear", "runtime-isolation": "clear"
  }
}
```

The digest above is a schema illustration, not approval evidence. Every gate is
required and must be `clear`; `blocked` or `unknown` appends a sticky stop without
preparing/starting work. No budget value is invented or copied into this library.
The host must re-observe the gates immediately before a real call; an event does
not itself measure tokens, invoke Guardian, check authorization or acquire locks.

Local closes additionally detect two consecutive no-progress closes or the same
normalized `outcomeKey`. The host derives that stable key from the observed result,
not an assignment ID or a worker's changing prose. This ticket-local check does
not replace the PM's **global** last-two-closes rule: `global-progress` remains a
mandatory separate gate, including pre-existing history from other tickets.

The local fix→verify counter advances when a failed check is followed by an author
candidate and a check of that candidate. Without owner exceptions, the stricter
three-attempt-per-duty cap allows at most two such repair cycles, so the original
third-round ceiling normally cannot be reached here. An earlier/externally
accumulated round-trip stop still blocks admission. No owner override or history
migration is implemented; do not create a fresh journal to evade prior counts.

A stop here prevents further ticket calls. It does **not** authorize terminating
a count-directed engine batch: the original count/Q/Chaos investigation process
must still run. Late receipts may close known calls after a stop but cannot
resurrect work or be relabelled accepted. A pre-start unknown with no session
binding needs operator investigation; no speculative recovery or re-dispatch exists.

## Verification and next integration

`node --test tests/router-worker-retries.test.mjs` covers normal fix/retest, caps,
separate original sessions, duplicate events/calls, cancelled preparation, unknown
execution, sticky stops, every admission gate at prepare/start, candidate binding,
local empty loops, journal drift, capacity and source-rule changes. A deterministic
bounded command exploration checks monotonic counters/stops and serial pending work.

Next integration must bind the persisted journal to one stable ticket and trusted
host, prevent rollback/reset, and supply real session-resume evidence,
candidate observations, host transcripts, global gates, measured usage and exactly-
once lifecycle/ledger closure. The compiler still rejects retry proposals; this
accounting library does not bypass that restriction or enable the old engine to
resume sessions. No model calls, product writes or legacy engine changes occur.
