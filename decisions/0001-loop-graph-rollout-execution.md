# ADR 0001: Loop/Graph rollout execution decisions

Date: 2026-10-06
Status: Accepted (owner-ratified in the PM session of 2026-10-06)

## Context

`docs/loop-graph-rollout-plan.md` and `docs/loop-graph-rollout-handoff.md`
were handed to a subagent team on 2026-10-06. R01 was executed and reviewed;
the R01–R05 assessment (`docs/rollout-evidence/assessment-R01-R05.md`, local)
raised seven owner questions. The owner answered them one by one in session.
Two charter-level rules also needed an owner exception: agents could neither
commit nor push.

## Decision

1. Commits: agents commit per card (one commit per slice, conventional
   message). Acceptance evidence under `docs/rollout-evidence/` is never
   committed (gitignored, local only). The dispatch ledgers
   `agents/lifecycle.md` and `pm-decisions.md` are committed per card.
2. CI: the PM opened draft PR #1 (`codex/loop-graph-mvp` -> `main`) at the
   owner's request. Agents may push `codex/loop-graph-mvp` only, never `main`,
   never `--force`. Every push re-runs the CI matrix on the PR.
3. R02 may start on locally verified R01 while CI is pending (R01 later went
   OK: run 37471272538 green on `fb8e106`).
4. Evidence layout accepted: `docs/rollout-evidence/<card>/acceptance.md`
   (handoff §7 template) + `logs/` with sha256 digests + `review.md`.
5. R03b policy: the Loop/Graph host operates only on an isolated clone it
   created itself; shared-target operation is refused; running legacy
   `run-n-rounds` on that clone is unsupported and documented, not enforced.
6. R05: a fully reconciled run closes via the existing `abandon` (usage
   becomes unknown). An explicit close action is deferred to R07.
7. Splits approved: R04a (stop command written to the store) / R04b (driver
   observes the stop record within a bounded interval); R05a (read-only
   inspection) / R05b (receipt ingest + recorded abandon). Per-card token
   allowances are provisional (order of 150k–500k harness tokens per card,
   see assessment §1) and are re-baselined from R01/R02 actuals at the first
   checkpoint, no later than 2026-10-08.

## Considered Alternatives

1. Owner commits batched: rejected, reviews would stay digest-based and CI
   would lag by batches.
2. Enforce R03b against legacy now: rejected, needs a separately scoped
   legacy change before any pilot; deferred to R19.
3. Explicit close event in R05: rejected for now, requires an event-schema
   change better done under R07 versioning.
4. Keep R04/R05 whole: rejected, raises the chance of hitting the two-attempt
   limit per card.

## Consequences

- Evidence is reproducible only from committed code plus the digests recorded
  in the ledgers; a reviewer without the local evidence folder must rerun.
- The two rollout plan docs stay local (gitignored, owner decision), like
  the evidence folder; the ADR and card records cite them by path only.
- Agents may push the working branch; a push cancels an in-progress CI run on
  the same ref (workflow concurrency group), so push only between runs.
- R03b leaves legacy coexistence as a documented limitation until R19.
- Abandon-based close loses known usage for reconciled runs until R07.

## Follow-ups

- [ ] Re-baseline per-card allowances at the 2026-10-08 checkpoint.
- [ ] Carry the R03b policy and limitation into the R06 operating contract.
- [ ] R07: explicit close action for reconciled runs.
- [ ] Owner sign-off line on `docs/rollout-evidence/R01/acceptance.md`.
- [x] Rollout plan docs are kept local (decided 2026-10-06).
