# Proof 1: a standing team end to end, with no model

[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), proof of
readiness 1, with the addition of
[ADR 0011](../../../decisions/0011-router-worker-batch-review.md): a flagged
ticket that passes, one that is rejected and one whose review cannot be
obtained.

The test is `tests/router-worker-proof-1.test.mjs`. CI runs it with the rest
of `tests/*.test.mjs`. It drives one team through these steps in order:

1. A two-root instance is bootstrapped with `kit/scripts/bootstrap-team.sh` on
   a blank product repository, which holds only the README and docs that
   `docs/bootstrap-empty-project.md` step 6 has the PM create. The team is
   switched into Router/Worker mode, confirmed as typed at a terminal, and
   `validate-team.sh --mode deployment` passes.
2. Batch 1 runs five tickets: `before`, the real engine on stand-in agents,
   `after`, `scripts/reconcile-run.mjs` on the kept return, the reviews,
   `resolve`, `commit` and `settle`. The kit's triggers flag three tickets. A
   CI file passes Security's review and is committed. A path holding "auth"
   fails a Security rule and is held as a patch. A lint and test configuration
   file needs the Architect, whose review gets no answer twice, so it is held.
   The last ticket follows a held one, so the verification commands run again;
   they pass, and it is committed.
3. The test checks that the working branch holds one commit per committed
   ticket with only its paths, that both patches apply on the start commit,
   that `pm-decisions.md` has the lines of before, after, both reviews,
   resolve, commit and settle, that the settlement states the reviewer's cost
   apart from the tickets', and that the batch is archived.
4. The team switches to specialist mode and back. The roster, the worker roles,
   the wrappers and the mode profile come back byte for byte. `gatePath` is
   still false and the limits are still the ones the ledger binds. Every other
   file of the instance, the lifecycle, the archives and `reviews/` included,
   is unchanged. `pm-decisions.md` is unchanged apart from the two switch
   lines.
5. Batch 2 runs one ticket and commits it. A command the owner did not confirm
   is refused, the batch freezes the bound limits, and the next `before` is
   refused until batch 2 is settled.

## What it does not prove

- No model runs. The workers, the checker, the Guardian and the reviewers are
  stand-ins: the engine's mock agents, and reviewer transcripts written in the
  shape Claude Code writes them. The meter rows come from transcripts the test
  writes. Proof 2 is the run on a real team.
- The bootstrap stops short of the owner's interview. The fixture hires one
  specialist delivery role, fills the remaining placeholders mechanically and
  gives the switch a fixed request instead of one drafted by
  `team-mode.mjs request` from the interview's answers. That team does not pass
  `validate-team.sh` before the switch, as `docs/staffing.md` asks; it passes
  after it.
- The steps are called as library functions, as the other Router/Worker tests
  call them, not through `rw-batch.mjs` and `team-mode.mjs` at a terminal.
  The terminal confirmation is the `node --test` exception of the switch.
