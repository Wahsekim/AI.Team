# Process Index

Single-page map for cold-start sessions and owner audit. This is an index, not
a duplicate of the authoritative files.

## By Task

| If you want to... | Read | Edit authority |
|---|---|---|
| Start the team | `CLAUDE.md`, `agents/pm.md` | PM |
| Understand templates vs instantiated files | `CLAUDE.md` -> Templates vs Deployed Instance | PM |
| Read the constitution | `charter.md` (seed: `charter.template.md`) | human owner |
| Configure project facts (incl. tracker adapter, workflow status) | `profiles/project.md` | PM + owner |
| Configure stack facts (incl. brief adapter blocks, gates) | `profiles/stack.md` | Architect + PM |
| Bootstrap blank project | `docs/bootstrap-empty-project.md` | PM |
| Attach existing project | `docs/bootstrap-existing-project.md` | PM |
| Map logical Kanban states onto the tracker | `methodologies/kanban.md` -> Tracker Adapters | PM |
| See preserved portable workflows | `docs/workflow-catalog.md` | PM + Auditor |
| See team roles + models (single source) | `agents/roster.md` | owner + PM |
| See one role's base agent and overlay | `agents/<role_id>.md` | PM + Coach |
| Read the standing meta-rules (M1-M6) | `agents/_shared/meta-rules.md` | Coach |
| Check the single-source (anti-drift) map | `agents/_shared/README.md` | PM |
| Follow stack verification discipline | `agents/_shared/verify-discipline.md` (seed: `.template.md`) | Architect + PM |
| Follow browser-verification rules | `agents/_shared/browser-access.md` (seed: `.template.md`) | PM + owner |
| Build a worker brief (incl. Mandatory Brief Lines) | `agents/templates.md` | PM, maintained by Coach |
| See tier bands (single source) | `agents/pm.md` -> Rules | PM + Coach |
| See budget/halt axes (single source) | `charter.md` -> Canonical Budget/Halt Table | owner-ratified |
| Run a count-directed loop mechanically | `docs/engine.md`, `.claude/workflows/run-n-rounds.js` | PM |
| See dispatch history | `agents/lifecycle.md` | PM |
| See PM decisions | `pm-decisions.md` | PM |
| See PM state | `memory/pm.md` | PM |
| See lessons and coaching | `agents/lessons.md` (index) + `agents/archive/` | Coach |
| Understand self-improvement loops | `agents/self-improvement.md` | Coach + Auditor |
| Read the failure-class catalog (single source) | `docs/failure-classes.md` | Coach + Auditor |
| Run the mechanical integrity check | `scripts/validate-team.sh <root>` (PM wake step 0) | PM |
| Hire or retire a role (MVT, questionnaire, triggers) | `docs/staffing.md` | Coach proposes, owner ratifies |
| Check runtime assumptions / deployment hooks | `docs/harness-assumptions.md` | PM |
| Know the owner's duties + SAFE-MODE | `docs/owner-contract.md` | human owner |
| Port an instance lesson to the template | `docs/backport-ritual.md` | human owner |
| Check doc completeness | `docs/doc-completeness.md` | PM |
| Record an ADR | `decisions/0000-template.md` | owner-ratified |
| Wire Claude project agents | `.claude/agents/README.md` | PM/owner |

## Rotation Regime (THE standing rule for append-only surfaces)

Every append-only surface runs **slim-active + archive**:

- Applies to: `agents/lifecycle.md`, `agents/lessons.md` (index + archive),
  `pm-decisions.md`, `memory/pm.md`, `messages/` (engine-emitted blocks
  included).
- The ACTIVE file stays small enough to read every cycle (indicative caps:
  lifecycle ~400 entry-lines, pm-decisions ~200 lines, memory ~300 lines,
  lessons index ~150 lines).
- Rotation moves history byte-identical to an immutable, date-ranged archive
  file (`agents/archive/`, `memory/`, `messages/archive/`, or repo root for
  pm-decisions), keeping a short verbatim tail or one-line summary in the
  active file for continuity.
- Archives are immutable evidence — never rewritten, opened only when an index
  line or investigation needs them, NEVER read in full during normal cycles.
- Counters derived from a rotated log (hardening counter) are RECONCILED at
  rotation time; the structured counter block in `memory/pm.md` is canonical.
- Lifecycle-specific: monotonic `[NNN]`, one header per entry ever, no
  duplicate numbers, no second "close" headers (`agents/lifecycle.md` counter
  rules).
- Engine-emitted blocks are pasted verbatim, then rotate like everything else.

Supersede with dated entries instead of rewriting history, everywhere.

## Drift Detection

Watch for:

1. profile drift: local repo changed but `profiles/stack.md` still says old commands;
2. docs drift: product behavior changed but user/technical docs did not;
3. lessons drift: `agents/lessons.md` index says one behavior, overlays/templates say another;
4. charter drift: new owner instruction changes non-negotiables without ADR;
5. token drift: repeated variance but the `agents/pm.md` band table not updated;
6. dispatch drift: workflow mentions reviewer/chaos role but no matching role file;
7. workflow drift: enabled workflow lacks evidence surface or profile status;
8. single-source drift: a model, band, or budget value restated outside its home
   (`agents/_shared/README.md`);
9. counter drift: structured counter vs close-line increments diverging;
10. primer drift: `CLAUDE.md`/`README` no longer match charter + ADR state
    (Auditor checklist item);
11. dangling-reference drift: citing an ADR number, wrapper file, log, or
    example profile that does not exist on disk — verification claims must
    point at real artifacts;
12. instantiation drift: an operational file referencing a `.template.md` as
    if it were the deployed instance (or vice versa);
13. staffing drift: a non-active roster row with a live wrapper, or a hired
    role without role file/wrapper (`docs/staffing.md`).

**Mechanical coverage:** `scripts/validate-team.sh` re-derives items 8
(partially: caps/bands/models), 9 (lifecycle side), 11 (wrapper existence),
12 (template-as-instance) and 13 (active-row wrappers) — run it at PM wake
step 0 instead of eyeballing. The remaining items stay human/Auditor checks.

## Update Triggers

Update this file only when a new process surface appears or a surface moves.
Do not centralize rule text here.
