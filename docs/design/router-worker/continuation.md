# Retry continuation (rollout gate G-03, offline part)

Status: offline. Nothing here resumes a session, calls a model or writes a file.
Every record is `launchable: false`.

The [retry journal](retry-accounting.md) already counts attempts per ticket and
duty and demands that a retry continue the previous assignment in its original
session. The compiler, however, only produced first attempts, so a retry had no
frozen assignment and its attempt number and session were whatever a caller
wrote. This step compiles a retry from the journal.

```sh
node kit/scripts/continue-router-worker.mjs REQUEST.json [--instance <instance-root>]
```

`REQUEST.json` is `{"input", "journal", "duty", "divergence"}`:

| Field | Meaning |
|---|---|
| `input` | a compiler input for the revised plan, in the first-attempt shape, with new assignment IDs and `baseline.candidateRef` naming the candidate to work from |
| `journal` | the ticket's retry journal |
| `duty` | `exec` or `check` |
| `divergence` | `{reason, evidenceRef}`: what changed since the previous attempt and the evidence for it |

Exit 0 prints `{continuation, renderedBrief, prepareEvent}`; exit 2 is a
refusal; exit 1 is usage. The retry rules are read from the kit, and the
charter from the instance when `--instance` is given.

## Derived from the journal, never from the request

| Fact | Source |
|---|---|
| `attempt` | started calls of this ticket and duty, plus one |
| `continuationOf` | the last started assignment of the duty |
| `resumeSessionRef` | the session the journal bound to the duty |
| `candidateRef` | exec: the candidate of the previous exec assignment; check: the latest closed author candidate |
| `divergence.previousPlanDigest` | the plan digest of the previous assignment |

The attempt therefore does not change when the wrapper, model, method or
assignment name changes between attempts, and the fourth call of a duty is
refused whatever it is called.

`prepareEvent` is the journal `prepare` event without `eventId` and `admission`.
The host adds both, observing the admission gates at that moment. The compiler
checks the event against the journal's own rules in a discarded dry run, so cap,
divergence, check-before-repair and used-ID violations are reported here.

`renderedBrief` is the first-attempt brief of the revised plan with a
continuation header in front: attempt, previous assignment, original session
only, the candidate to work from and the stated change. The mandatory rules of
the first brief are kept unchanged. `planRef.digest` is the digest of that brief.

## No engine plan item

The count engine starts a fresh agent for every call and cannot address an
existing session ([engine contract](../../engine.md), fix-retest drain rule). A
continuation as an engine plan item would silently open a new session, which the
journal forbids. The record says `dispatch: main-session-resume-only`: a retry
is a PM main-session resume of the original session, outside the engine batch.

## Refusals

| Code | Reason |
|---|---|
| a compiler code | the revised input does not compile |
| `INVALID_CONTINUATION` | duty other than exec or check; divergence not exactly `{reason, evidenceRef}` (a claimed previous plan digest is refused); unreadable input |
| `TICKET_MISMATCH` | the journal belongs to another ticket |
| `RETRY_STOPPED` | the ticket carries a sticky stop (missing session, unknown execution, operator stop, any admission gate), or a passing check awaits settlement |
| `RETRY_PENDING` | earlier work is prepared, started or unknown |
| `NOT_A_CONTINUATION` | the duty never started on this ticket |
| `STALE_CANDIDATE` | the request names a candidate other than the one the journal holds |
| `CHECK_REQUIRED` | an author candidate has no independent failed check yet |
| `RETRY_LIMIT` | the duty already had its initial call and two retries |
| `RETRY_DIVERGENCE_REQUIRED` | the revised plan has the digest of the previous one |
| `IDEMPOTENCY_CONFLICT` | the assignment ID was used before |
| `RETRY_JOURNAL_MISMATCH` | the journal or the rule sources changed |
| `BRIEF_LIMIT_EXCEEDED` | the continuation brief exceeds the policy limit |

## Not covered

- `real-session-resume` and `session-liveness`: the session reference is a
  journal value. Whether that session still exists and can be resumed is only
  shown by a live run; a host that cannot find it records a `missing-session`
  stop.
- `candidate-observation`: the candidate is compared by reference. Observing the
  checkout is the job of [candidate binding](candidate-binding.md).
- `meaningful-divergence-review`: a different plan digest and a stated reason do
  not prove a real change; the PM reads the evidence.
- `host-admission-at-prepare-and-start` and `usage-and-lifecycle-settlement` (G-04).

G-03 stays open for the live half.
