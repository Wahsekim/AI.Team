# Team Roster Template

Stable role ledger. Display names are configurable; role IDs stay stable.

**Single source:** once instantiated as `agents/roster.md`, this table is the
ONLY home for per-role Model + Reasoning values (see
`agents/_shared/README.md`). Wrappers, templates, and briefs copy from here;
on conflict this table wins. Do not restate models elsewhere.

**Wrapper-column honesty:** the Wrapper file column lists only files that
EXIST. Fill it as you create the wrappers at bootstrap (or write
`inline mode — .claude/agents/INLINE_BASE_AGENT_MODE.md` on every row).
Never point at planned-but-uncreated files, and never record a "Verified"
claim citing a nonexistent log.

**Status column (staffing):** every row carries
`status: active | dormant | not-hired`, set at the bootstrap HIRING STEP
(`docs/staffing.md` — Minimum Viable Team + questionnaire) and changed only
via the hire/retire protocol (one-line ADR + owner ack). Wrappers exist ONLY
for `active` rows; `scripts/validate-team.sh` checks wrapper existence for
active rows and skips `dormant`/`not-hired` rows. A non-active row keeps its
Wrapper file cell as `— (not-hired)` / `— (dormant)` until hired.

## Choosing Models (first-start guidance)

Model names change; pick by TIER from whatever menu the runtime offers, then
recalibrate against the tier bands (`agents/pm.md` Rules):

| Tier | Roles | Why |
|---|---|---|
| Strongest available | architect, coach, auditor, security, chaos | reasoning-audit / decision work; cheap models under-deliver here (the source project had to raise its chaos role mid-project) |
| Mid tier | backend, data, qa, ux | implementation + evidence work; strong enough to follow verify-discipline |
| Fast/cheap tier | high-volume execution roles (often frontend) — only while quality holds | watch variance; promote the tier on repeated same-sign overshoots |

The PM inherits the main session's model. Raise a role's reasoning effort
before swapping its model.

## Base-Agent Library (what `base_agent_root` means)

`{{BASE_AGENT_ROOT | ask:first_start | optional}}` points at a LOCAL library
of reusable agent personas (one markdown persona per file — e.g. an
`agency-agents` checkout), if this machine has one. It is OPTIONAL:

- library present -> verify each `base_agent_path` exists ON THIS MACHINE
  before first dispatch;
- library absent (fresh machine) -> mark ALL roles `synthetic`: the role file
  + its `agents/templates.md` block carry the full persona. Synthetic is a
  first-class mode, not a degradation — never block bootstrap on a missing
  library.

## Naming Model

```yaml
pm:
  role_id: "pm"
  display_name: "{{PM_NAME | default:PM}}"
```

Use role IDs in internal rules. Use display names in owner-facing reports.

## Recommended Roster

Status defaults below encode the Minimum Viable Team (`docs/staffing.md`);
the bootstrap hiring questionnaire overrides them per project.

| Role id | Display placeholder | Role file | Wrapper file | Base agent source | Responsibility | Model | Reasoning | Tier | Status |
|---|---|---|---|---|---|---|---|---|---|
| `pm` | `{{PM_NAME}}` | `agents/pm.md` | main session | `product/product-manager.md` | backlog, dispatch, budget, owner communication | inherits main session | `{{PM_REASONING | default:medium}}` | persistent | active |
| `architect` | `{{ARCHITECT_NAME | default:Architect}}` | `agents/architect.md` | `.claude/agents/{{PROJECT_SLUG}}-architect.md` | `engineering/engineering-software-architect.md` | architecture, ADRs, stack profile, boundaries | `{{ARCHITECT_MODEL | ask:first_start}}` | `{{ARCHITECT_REASONING | default:high}}` | standing | dormant (active if polyglot/multi-toolchain) |
| `backend` | `{{BACKEND_NAME | default:Backend}}` | `agents/backend.md` | `.claude/agents/{{PROJECT_SLUG}}-backend.md` | `engineering/engineering-backend-architect.md` | server logic, APIs, auth, integrations | `{{BACKEND_MODEL | ask:first_start}}` | `{{BACKEND_REASONING | default:high}}` | standing | active (default MVT builder — swap for frontend if UI-dominant) |
| `frontend` | `{{FRONTEND_NAME | default:Frontend}}` | `agents/frontend.md` | `.claude/agents/{{PROJECT_SLUG}}-frontend.md` | `engineering/engineering-frontend-developer.md` | UI implementation and browser behavior | `{{FRONTEND_MODEL | ask:first_start}}` | `{{FRONTEND_REASONING | default:medium}}` | standing | not-hired (active if UI) |
| `ux` | `{{UX_NAME | default:UX}}` | `agents/ux.md` | `.claude/agents/{{PROJECT_SLUG}}-ux.md` | `design/design-ux-architect.md` | user flows, copy, accessibility, visual quality | `{{UX_MODEL | ask:first_start}}` | `{{UX_REASONING | default:medium}}` | standing | not-hired (active if UI) |
| `qa` | `{{QA_NAME | default:QA}}` | `agents/qa.md` | `.claude/agents/{{PROJECT_SLUG}}-qa.md` | `testing/testing-evidence-collector.md` | tests, evidence, screenshots, acceptance | `{{QA_MODEL | ask:first_start}}` | `{{QA_REASONING | default:medium}}` | standing | active |
| `data` | `{{DATA_NAME | default:Data}}` | `agents/data.md` | `.claude/agents/{{PROJECT_SLUG}}-data.md` | `engineering/engineering-database-optimizer.md` | schema, migrations, persistence | `{{DATA_MODEL | ask:first_start}}` | `{{DATA_REASONING | default:high}}` | standing | not-hired (active if DB/schema surface) |
| `coach` | `{{COACH_NAME | default:Coach}}` | `agents/coach.md` | `.claude/agents/{{PROJECT_SLUG}}-coach.md` | `specialized/recruitment-specialist.md` or synthetic | lessons index, prompt/template improvement | `{{COACH_MODEL | ask:first_start}}` | `{{COACH_REASONING | default:high}}` | event-triggered | dormant (active if duration >= 3 loops) |
| `auditor` | `{{AUDITOR_NAME | default:Auditor}}` | `agents/auditor.md` | `.claude/agents/{{PROJECT_SLUG}}-auditor.md` | `engineering/engineering-code-reviewer.md` | independent periodic process audit (Mode 2) | `{{AUDITOR_MODEL | ask:first_start}}` | `{{AUDITOR_REASONING | default:high}}` | event/on-request | dormant (active if duration >= 3 loops) |
| `security` | `{{SECURITY_NAME | default:Security}}` | `agents/security.md` | `.claude/agents/{{PROJECT_SLUG}}-security.md` | `engineering/engineering-security-engineer.md` | threat model and security review | `{{SECURITY_MODEL | ask:first_start}}` | `{{SECURITY_REASONING | default:high}}` | event-triggered (standing trigger: auth/session/cookie changes) | dormant (active if auth/payments/sensitive data) |
| `chaos` | `{{CHAOS_NAME | default:Chaos}}` | `agents/chaos.md` | `.claude/agents/{{PROJECT_SLUG}}-chaos.md` | synthetic | loop guardian, halt investigation, chaos gate | `{{CHAOS_MODEL | ask:first_start | note:reasoning-audit work, not a cheap tier}}` | `{{CHAOS_REASONING | default:high}}` | event-triggered | dormant (active if count-directed loops expected) |

## Deployment Invariant

Every active role MUST have:

1. one role file at `agents/<role_id>.md`;
2. a `Base Agent` section naming either a base-agent-library source path
   (verified on this machine) or `synthetic`;
3. a project overlay section;
4. one concrete project-scoped wrapper at `.claude/agents/<project>-<role>.md`
   when the runtime supports wrappers (created at bootstrap — the default
   dispatch path), otherwise instantiated inline mode;
5. wrapper frontmatter values for model (`model`), reasoning effort (`effort`)
   and turn cap (`maxTurns`) — model/reasoning COPIED from this roster (single
   source) — plus the ADVISORY token budget stated in the wrapper body and
   dispatch brief (no runtime frontmatter field hard-caps tokens per agent);
6. dispatch instructions telling the PM how to combine base agent + overlay;
7. a matching row in this roster.

All-purpose or general-purpose worker dispatch is a fallback only for runtimes
without role wrappers, and must still inline the role's base agent, model,
reasoning effort, and token budget. It is not an acceptable default.

If a workflow says "after N cycles spawn reviewer", then `auditor` must be in
the roster and have `agents/auditor.md`. If a workflow says "on loop break run
fault injection", then `chaos` must be in the roster and have `agents/chaos.md`.

## Add Member Protocol

1. Coach proposes a new role with evidence from at least two lifecycle entries.
2. PM evaluates fit, token economics, and overlap with existing roles.
3. Owner approves if the roster change affects cost, governance, or scope.
4. PM updates this roster, templates, lessons section, and writes an ADR.

No fire/replace theater. Improve role prompts and briefs before adding or
renaming people.
