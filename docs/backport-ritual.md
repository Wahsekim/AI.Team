# Back-Port Ritual (instance lesson → portable template)

Deployed instances learn; the portable kit only improves if the right lessons
flow back. Owner-executed (or owner-ratified — the deployed team cannot edit
its own template source; see `docs/owner-contract.md` duty 6).

## Criteria — port it only if ALL three hold

1. **Model-level?** Does the failure come from how LLM agents behave
   (confabulation, optimistic self-report, narrative drift, instance-patching)
   rather than from this project's domain? Test: would a different team on a
   different product hit it? If it is project-specific, it belongs in the
   instance's overlays/profiles, not the kit.
2. **Stack-agnostic?** Can it be stated without naming the stack? If the rule
   only makes sense with the stack named, port the ABSTRACT driver and leave
   the stack text in `profiles/stack.md` / the stack-profile library
   (`profiles/stack-profiles/`).
3. **Mechanism or prose?** Prefer lessons that yield a MECHANICAL control
   (validator check, engine gate, schema field, template contract, staffing
   trigger). Pure prose wisdom back-ports only when it sharpens an existing
   meta-rule — the kit does not accumulate advisory text
   (`docs/failure-classes.md` design rule).

## The 5-step ritual

1. **Abstract it** — strip project specifics into drivers; the concrete
   incident becomes one line: `Observed as (<project>): ...`.
2. **Place it** — one home only, per the single-source map
   (`agents/_shared/README.md`): meta-rule family → `_shared/meta-rules.md`;
   sizing/band logic → `agents/pm.md` Rules; brief contract →
   `agents/templates.md`; staffing trigger → `docs/staffing.md`; runtime
   assumption → `docs/harness-assumptions.md`; mechanical check →
   `scripts/validate-team.sh`.
3. **Stamp provenance** — add the date and source project to the entry (the
   kit's convention: "observed as (source project)" one-liners; see
   `docs/source-map.md` for the provenance style).
4. **Update `docs/failure-classes.md`** — if this is a NEW failure class, add
   the full entry + summary-map row; if an existing class, strengthen that
   class's mechanical-control or residual-risk text.
5. **Run `scripts/validate-team.sh`** on the kit root — must exit 0 (SKIPs
   expected on a fresh kit). A back-port that introduces drift (restated caps,
   bands, models) is rejected by the validator, by design.

## Cadence

After each loop close, or monthly — whichever comes first. Batch small
candidates; do not interrupt a running loop to back-port. The instance-side
trigger is the Coach's consolidation pass (`agents/coach.md`): when a lesson
family folds into a meta-rule at the instance level, that is the natural
back-port candidate.
