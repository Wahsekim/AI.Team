# Owner Contract

The process assumes a human owner in the loop. This page states what the
owner MUST actually do for the machinery to hold — and what the team does
when the owner is absent. The AI side of the contract is the charter; this is
the human side. Cross-linked from `charter.template.md` and `CLAUDE.md`.

## Owner duties

1. **Decision SLA.** Answer Needs-Decision items within
   `{{OWNER_DECISION_SLA | default:48h}}` (or explicitly delegate the class of
   decision). Escalations exist because the PM is FORBIDDEN to decide certain
   things (charter conflicts, unsplittable oversize tickets, ambiguous product
   direction); an unanswered escalation stalls exactly the work that most
   needed judgement.
2. **Periodic real-device / visual spot review.** The process's designated
   blind spot (failure class FC-6, `docs/failure-classes.md`): no gate in this
   kit can see what only a human sees — visual quality, feel, "would I
   actually use this". Drive the product yourself on a real device at least
   once per `{{OWNER_REVIEW_INTERVAL | default:loop close or weekly}}`. This
   is a named control, not a nicety; skipping it removes the only backstop
   behind M5.
3. **Ratifications.** ADRs, hire/retire proposals (`docs/staffing.md`),
   charter changes, and anything touching cost/governance/scope wait for your
   ack. Ack fast or delegate explicitly — silence is not consent
   (SAFE-MODE below governs silence).
4. **Pushback duty.** When the PM halts, defers, or escalates: interrogate the
   reason. A halt citing the charter halt list is legitimate; anything else is
   the premature-halt class (FC-7) wearing a costume. Do not reflexively
   accept "diminishing returns" — and equally, do not reflexively override a
   listed halt.
5. **Weekly ledger scan.** Skim `pm-decisions.md` (last ~20 lines),
   `agents/lifecycle.md` recent entries, and the `agents/lessons.md` index
   once a week (~5 minutes). You are looking for: repeated FAILs on one area,
   variance drift, deferral density, and anything the PM normalized that you
   would not have. Run `scripts/validate-team.sh` yourself if in doubt — it
   is owner-runnable by design.
6. **Template back-port duty.** When a deployed instance learns a model-level
   lesson, YOU decide whether it goes back into the portable kit — the team
   cannot edit its own template source. Ritual and criteria:
   `docs/backport-ritual.md`.

## SAFE-MODE (owner absent)

The team enters SAFE-MODE when an owner ack is overdue past the decision SLA
or the owner has announced absence. In SAFE-MODE:

- **No hires or retirements** — staffing freezes at current roster status.
- **No destructive or irreversible ops** — no deletions of user data, no
  schema-destructive migrations, no force-anything; git policy stays at its
  most conservative reading.
- **Conservative halt bias** — count-directed loops still honor their count
  (the count was an owner directive), but new loops are not started; ambiguous
  situations resolve to "stop and queue", never "guess and proceed".
- **Decisions queue, work continues around them** — Needs-Decision items
  accumulate in a dated queue (tracker or `pm-decisions.md`); the PM keeps
  pulling tickets that do NOT depend on a queued decision.
- **Exit:** owner returns, drains the queue oldest-first, team resumes normal
  mode. The PM reports what was deferred and why, in one list.

## Failure mode this page prevents

An owner who only reads the <=100-word cycle reports gets exactly the view the
process can produce — which excludes FC-6 (owner-perspective drift) by
construction. The duties above are the minimum human injection that keeps
"green ledgers" and "usable product" from diverging.
