# ADR 0005: Conservative recovery commands (R05b)

Date: 2026-10-07
Status: Proposed (implemented in R05b; PM sign-off and owner ratification pending)

## Context

- Plan card R05: ingest an already durable receipt, abandon with recorded operator confirmation. KO: a confirmation described as a verified process exit; recovery that deletes audit history. No resume, re-spawn or kill by saved PID.
- ADR 0001 decision 6 (Q6): a reconciled run closes through the existing `abandon` (usage unknown); explicit close deferred to R07.
- ADR 0002 §3(c): `closeOrphanedExecution` existed as a library call only. R05a review F1: a hot rollback journal makes every read-only open fail (errcode 776); F2: abandon must not be offered while a receipt source is unreadable.

## Decision

1. **ingest-receipt.** Settles one STARTED/UNKNOWN dispatch from a receipt already in `fixture.sqlite` (row result and request digests) or `evidence.sqlite` (validated record, intent RECORDED), read read-only. Refusals leave the store unchanged: source unreadable `RECEIPT_SOURCE_UNKNOWN`, no receipt `RECEIPT_MISSING`, digest or dispatch expectations differ `RECEIPT_MISMATCH`, run or bound product clone (lock-file target binding, dev/ino checked) moved off the dispatch candidate `STALE_RECEIPT`, cleanup-unknown transcript or scope change `EFFECT_UNKNOWN`. Build usage comes only from the receipt's structured output; absent usage is `null`, never 0. A host-local gate records 0: it has no provider and a zero reservation. A settled dispatch with an identical receipt returns `alreadySettled` and records nothing.
2. **Crash is recorded.** Holding the kernel lock proves no live owner. When the run is not yet RECOVERY_REQUIRED, ingest and abandon first record `interrupted` (as the R02 driver restart does), so an ingested run stays RECOVERY_REQUIRED until abandon.
3. **abandon.** `--note` (1–500 chars, no control characters) and `--confirm <runId>`. The reducer's `abandon` accepts `{operatorConfirmation, note}` and stores `state.abandonment = {by: 'operator', operatorConfirmation, note, at}`; no field or message calls it an exit. The pre-R05b `{confirmedProcessesExited: true}` shape still replays and stays accepted for library callers. Refused while any claimed dispatch's receipt presence is unknown (absent, unreadable or hot journal). Attempts and agent calls are kept, tokens and cost become unknown, the dispatch is ACKNOWLEDGED `cancelled` and cannot be claimed again.
4. **Exclusion.** ingest and abandon run entirely under `withExclusiveLock`: the R03a kernel lock with no marker row and no binding write (an existing store binding is still checked). A live owner gives `EXECUTION_OWNER_ACTIVE` (exit 4); the operator stops it first. An open marker stays open until `close-execution-marker`.
5. **close-execution-marker.** CLI over `closeOrphanedExecution` (exact owner id, non-empty note, lock/state identity check, run state untouched), plus an operator-audit row.
6. **Hot journal.** Write commands refuse a hot `loop.sqlite` with `HOT_JOURNAL` instead of rolling it back implicitly. `recover-journal --note [--all]` refuses while the lock is held, opens each hot file (`loop.sqlite`, with `--all` also the fixture and evidence journals) writable once, verifies every run chain and appends file sizes before/after to `operator_audit`. Read commands (`status`, `events`, `audit`, `show`, `inspect`) on 776 copy the store and journal into a private temp directory (stat identity re-checked after the copy), let SQLite roll back the copy, label the output `snapshot: uncommitted transaction pending rollback; store untouched` and delete the copy. `immutable=1` stays rejected.
7. **Audit.** ingest and abandon append to the run's hash-chained event log; recover-journal and marker close append to `operator_audit` (lazy table, update and delete refused by triggers, outside every run chain). Nothing deletes or rewrites a row.
8. **Exit codes.** Unchanged: 2 input/runtime (all receipt refusals, `HOT_JOURNAL`), 3 only `STALE_STATE` (a stale receipt is not retryable), 4 exclusion, 7 capability.

## Considered Alternatives

1. Ingest without `interrupted`: leaves a crashed run RUNNING and lets the next owner continue it silently.
2. Refuse abandon while a durable receipt exists: deadlocks when ingest is refused by the host checks; the result lists `durableReceiptsNotIngested` instead.
3. Operator audit as a sidecar file: no transactional append and no engine-level append-only guard.
4. Zero gate usage replaced by `null`: would stop every budgeted run after any recovered gate although gates have no provider.

## Consequences

- Every recovery is explicit, audited and refusable; replay (`audit`) covers ingest and abandon.
- Limitations: `operator_audit` is unversioned like `executions` (R07); taking the lock creates `execution-owner.sqlite` if missing; same-UID tampering with journals or the lock file stays out of scope (ADR 0002); a snapshot read needs temp space for one store copy; a dispatch whose receipt is durable but refused by host checks can only be abandoned.
- ADR 0002 lock-file replacement: `close-execution-marker` keeps refusing (`EXECUTION_OWNER_ACTIVE`), since the lock no longer proves the owner gone. Manual procedure: leave that state directory untouched as evidence and start any new run in a fresh state directory.

## Follow-ups

- [ ] PM sign-off; owner ratification.
- [ ] R07: version `operator_audit`, `executions` and the abandon payload; explicit close action.
