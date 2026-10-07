# ADR 0004: Durable stop record in the control store (R04a)

Date: 2026-10-07
Status: Proposed (R04a implementation; PM sign-off and owner ratification pending)

## Context

- R04 (plan §4), split by ADR 0001 decision 7: R04a = durable graceful/hard stop written to the store plus a read interface; R04b = the active driver observes it and cancels. OK: durable stop precedes cancellation; no later dispatch. KO: a reported stop while dispatch continues; hard stop depending on an LLM reading a message.
- Baseline f19e221: CLI `stop` was graceful-only and a versioned `store.apply('stop', {mode, reason})`, so it could fail `STALE_STATE` against a busy driver, a repeat re-ran the transition, and `reason` was free text.
- ADR 0002: stop and inspection stay unfenced and never open the lock file.
- R-1 (assessment): a stop committed between the driver's read and its apply makes that apply `STALE_STATE`; the step's catch then applies `interrupted`, degrading a clean stop to RECOVERY_REQUIRED.

## Decision

1. **Record.** `state.stopRequest = {kind, seq, requestedBy, requestedAt}`. `kind` is `graceful|hard`; `requestedBy` is an ID-pattern label; `requestedAt` is the host time of the transition (display only); `seq` starts at 1 and grows by one per recorded transition. It lives in the run state and the hash-chained event log, so `verify` replays it; no new table.
2. **Write path.** `store.requestStop(runId, {kind, requestedBy}, now)`: one `BEGIN IMMEDIATE`, no expected version, no fence, no `executions` access, no lock file. `store.apply('stop', …)` is refused (`INVALID_SPEC`).
3. **Idempotency and escalation.** Only none → any and graceful → hard record a transition. A repeat of the same kind, or graceful after hard, returns the existing record with `recorded: false` and leaves the version unchanged. The reducer refuses a non-escalating stop event. A terminal run gives `RUN_TERMINAL`.
4. **Transition.** The first stop keeps the baseline effect (reason `user_stop`, PENDING intents cancelled, a pending projection → RECOVERY_REQUIRED) and never clears an existing RECOVERY_REQUIRED. An escalation changes only the record; the first stop already barred dispatch. Kind changes nothing else at R04a.
5. **No later dispatch (store rule).** While a stop record exists, `apply` refuses with `STOP_REQUESTED`, before the reducer and regardless of fence, a `claim` of any effect other than the run's projection, and after reduction any `tick` whose result emits a dispatch. Settle, interrupted, abandon and projection closeout stay allowed, so a stopped run still reaches STOPPED and existing closeout tests hold. CLI maps it to exit 2; exit 4 stays execution exclusion.
6. **R-1 rule.** A recorded stop raises the state version in the same transaction as its event. Any command prepared against an earlier version fails `STALE_STATE` and changes nothing; re-prepared, a claim or dispatching tick fails `STOP_REQUESTED` and a settle is accepted. A non-recording repeat leaves the version alone and never invalidates a driver's prepared command. So a stop is never lost and no dispatch slips past it. R04b must treat `STALE_STATE` as "re-read, check `readStopRequest`, re-prepare" instead of `interrupted`; until then the driver fails closed into RECOVERY_REQUIRED.
7. **Legacy replay.** `verify` replays a pre-R04a `{mode, reason}` stop event through `replayLegacyStop`, the baseline transition verbatim, so stored digests match; a legacy record's kind is its `mode`, its seq counts as 1, and a later hard stop records seq 2. The live path still refuses that shape. `'stop'` is removed from execution-owner's `UNFENCED` set (dead after decision 2).
8. **Read interface.** `store.readStopRequest(runId)` returns the record or null with one `SELECT json_extract(...)`: no table creation, chmod or version change. R04b polls it between steps and during an effect. It does not widen X5 (opening the store still mutates; R05a).

## Considered Alternatives

1. Stop as unversioned metadata (column or side table): a driver's stale apply would succeed after the stop, and replay would not show it (mutation M2 is red).
2. Keep versioned `apply('stop')`: a CLI stop loses to a busy driver (`STALE_STATE`), and repeats are new transitions.
3. Refuse every `tick`/`claim` after a hard stop: blocks closeout, so a hard-stopped run never reaches STOPPED, and breaks the existing SIGINT and driver closeout tests.
4. Version-exempt settle after a stop: smaller R04b change, but weakens the optimistic-concurrency contract for all commands.

## Consequences

- External stop is accepted while a driver runs; no lock contention (S4).
- Stores written before R04a replay as legacy records (decision 7; attempt 2, review F1).
- Limitations (pre-existing, follow-up cards): F4, a first stop overwrites an earlier failure reason (a run quiescing on `final_gate_failed` projects STOPPED, not FAILED); F5, after a stop, settling the last UNKNOWN dispatch while a limit trips leaves RECOVERY_REQUIRED through the receipt, not `abandon`, and replaces `user_stop` with the limit reason (R05 recovery rules).
- Library callers: `driver.stop({kind, requestedBy})`; `stopRequest.mode/detail` became `kind/seq/requestedBy/requestedAt`.
- Open for R04b: polling, abort, observer failure, escalation during a running effect, and the driver's R-1 handling. Open for the PM/owner: whether a first stop during a pending projection should keep forcing RECOVERY_REQUIRED (assessment decision ii; unchanged here).

## Follow-ups

- [ ] PM sign-off; owner ratification.
- [ ] R04b: observation loop and R-1 driver handling against this rule.
- [ ] R04b, PM decision 2026-10-07: graceful stop during a pending/started closing projection records the stop only, keeps FINALIZING and the projection, and ends at the projection's outcome. Hard stop: RECOVERY_REQUIRED (today's rule). A graceful→hard escalation while a projection is kept applies the hard rule. In all cases mark the dropped/kept projection's outbox row explicitly.
- [ ] Follow-up cards: F4 (keep an existing failure reason on stop), F5 (R05 recovery rules).
- [ ] R07: version the stop payload change.
