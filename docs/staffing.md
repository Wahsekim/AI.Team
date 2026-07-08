# Staffing (hiring / retirement phase)

The roster template lists the FULL recommended role set; a real deployment
should not instantiate all of it on day 1. Idle roles cost bootstrap tokens,
wrapper maintenance, and validation surface — and an 11-role team on a 2-week
CLI tool is theater. Staffing is a bootstrap STEP (before wrapper
instantiation) plus a standing expand/retire loop owned by the Coach
(RECRUITER mission — `agents/coach.md`) with owner ratification.

Roster mechanics: every role row carries `status: active | dormant |
not-hired` (`agents/roster.template.md`). Wrappers exist ONLY for `active`
rows; `scripts/validate-team.sh` enforces exactly that (non-active rows are
skipped by the wrapper check).

## Minimum Viable Team (default)

PM + 1 builder + 1 verifier. Concretely: `pm` (main session), one shipping
role matched to the dominant surface (usually `backend` or `frontend`), and
`qa`. Everything else starts `not-hired` unless the questionnaire below says
otherwise. `coach` starts `dormant` (event-triggered; its first trigger is its
hire signal — instantiate the role file at bootstrap, defer the wrapper until
first fire counts as hire-NOW if you expect coaching within the first loop).

## Staffing questionnaire (run at bootstrap, with the owner)

Answers map to hire-NOW vs leave `not-hired`. Record the filled questionnaire
in the bootstrap ADR.

| Question | If YES → hire now | If NO |
|---|---|---|
| Does the product have a UI? | `frontend` + `ux`; instantiate `_shared/browser-access.md` | both `not-hired`; skip browser-access |
| Is there a database/schema/migration surface? | `data` | `not-hired` (builder role absorbs trivial persistence) |
| Auth, payments, or sensitive user data? | `security` (standing trigger: any auth/session/cookie/payment-touching change) | `dormant` (hire on first such ticket) |
| Multiple toolchains / polyglot repo? | `architect` active from day 1 | `architect` dormant; PM+builder handle stack lock, first ADRs written with owner |
| Expected duration >= 3 loops (or >= ~30 dispatches)? | `coach` + `auditor` active (variance data will accumulate) | both `dormant` |
| Count-directed loops expected? | `chaos` active (guardian node is unconditional in engine mode) | `chaos` dormant |
| Owner mostly absent (low decision availability)? | prefer FEWER active roles + conservative halts (`docs/owner-contract.md` SAFE-MODE) | normal staffing |

## Expansion triggers (mechanical — evidence, not vibes)

The Coach proposes a hire when a trigger fires; the owner ratifies. Triggers:

1. **Defect-class recurrence in an area** — the same defect class FAILs
   verification TWICE in one area (FC-10 signal): hire the specialist for that
   area (e.g. two schema-migration failures → hire `data`).
2. **Oversize breaches** — `{{OVERSIZE_BREACH_K | default:3}}` consecutive
   dispatches in one area breach their tier band or need splitting at the hard
   cap: the generalist role is overloaded there; hire the specialist.
3. **New surface type appears** — the product grows a surface no active role
   owns (first UI screen, first payment flow, first data pipeline): hire the
   matching role BEFORE the second ticket on that surface.
4. **Standing-trigger fire on a dormant role** — e.g. first auth-touching
   change while `security` is dormant: activate it for that ticket and keep it
   active.

## Retirement triggers

1. **Idle** — a role with no dispatch for `{{IDLE_CYCLES_N | default:15}}`
   lifecycle entries → mark `dormant` (wrapper may stay on disk; roster status
   governs).
2. **Long-dormant** — dormant for `{{DORMANT_CYCLES_M | default:30}}` further
   entries → mark `not-hired`; delete or archive the wrapper.
3. Event-triggered roles (`coach`, `auditor`, `chaos`, `security`) are exempt
   from idle-retirement while their triggering workflows are enabled — they
   are meant to be quiet.

## Hire/retire protocol

Every staffing change, both directions:

1. Coach (or PM at bootstrap) states the trigger + evidence (lifecycle
   entries / questionnaire line).
2. Owner acks (hire/retire is an owner-ratified change — `docs/owner-contract.md`).
3. **One-line ADR** in `decisions/` (e.g. `NNNN-hire-data-role.md`: trigger,
   evidence, status change) + index in `decisions/README.md`.
4. PM updates `agents/roster.md` status column; creates the wrapper (hire) or
   archives it (retire → not-hired); creates `agents/<role_id>.md` if absent.
5. Run `scripts/validate-team.sh` — it must exit 0 after the change.

## Anti-patterns

- Instantiating all wrappers "to be safe" — validation surface without
  evidence of need.
- Hiring on one failure (single occurrence ≠ class; see FC-10 — second
  occurrence is the line).
- Retiring the verifier. `qa` is never retired while any code-shipping work
  exists; the verification gate is unconditional.
- Fire/replace theater — improving a role's brief/overlay beats replacing the
  role (`agents/self-improvement.md` Anti-Pattern).
