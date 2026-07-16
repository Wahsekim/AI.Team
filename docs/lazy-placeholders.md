# Lazy Placeholders

Lazy placeholders let the team start with incomplete knowledge without forcing a
long setup interview. The PM resolves only the values that block the next action.

## Placeholder States

| State | Meaning |
|---|---|
| `unresolved` | no reliable value yet |
| `auto_detect` | infer from local files before asking |
| `ask:first_start` | ask once during first PM start |
| `ask:first_use` | ask only when the feature/methodology is invoked |
| `ask_before_web_search` | owner must approve external lookup |
| `locked` | accepted value; do not re-litigate in normal tickets |

## Core Placeholders

| Placeholder | Location | Resolution |
|---|---|---|
| `{{PROJECT_NAME}}` | `profiles/project.md` | ask first start |
| `{{PROJECT_SLUG}}` | `profiles/project.md` | derive: lowercase-kebab of the name (confirm with owner); used in wrapper filenames |
| `{{PM_NAME}}` | `profiles/project.md` | ask first start; default `PM` |
| `{{PRODUCT_REPO_PATH}}` | `profiles/project.md` | ask first start; bootstrap creates it if absent |
| `{{TOKEN_SOFT_CAP}}` / `{{TOKEN_HARD_CAP}}` | charter -> Canonical Budget/Halt Table (single source) | ask first start; defaults `200000` / `250000`; recalibrate |
| `{{STACK_PROFILE}}` | `profiles/stack.md` | auto-detect, then confirm |
| `{{CODE_CONVENTIONS}}` | `profiles/stack.md` | local-first; ask before web search |
| `{{STACK_BACKEND_RULES}}` etc. | `profiles/stack.md` -> Brief Adapter Blocks | filled once at stack lock; PM copies verbatim into briefs |
| `{{WORKFLOW_METHOD}}` | `methodologies/` | default Kanban |
| `{{TDD_PROFILE}}` | `methodologies/tdd.md` | ask first use |
| `{{ISSUE_TRACKER}}` + `{{TRACKER_ADAPTER}}` / `{{TICKET_ID_FORM}}` | `profiles/project.md` | ask first start; adapter per `methodologies/kanban.md` -> Tracker Adapters |
| `{{PRODUCT_LOCALES}}` | `profiles/project.md` | ask first start |
| `{{BASE_AGENT_ROOT}}` | `agents/roster.md` | ask first start; optional — absent library => all roles synthetic |
| `{{<ROLE>_MODEL}}` / `{{<ROLE>_REASONING}}` | `agents/roster.md` (single source) | ask first start, using the model-tier menu in `agents/roster.template.md` -> Choosing Models |
| `{{ENV_PREFIX}}` and verify-discipline values | `agents/_shared/verify-discipline.md` | auto-detect from stack at bootstrap (record `none` explicitly) |
| `{{BROWSER_TOOL}}` / `{{SMOKE_CREDENTIAL_REF}}` | `agents/_shared/browser-access.md` | ask first use (UI projects); REF = env var / keychain name only — literal secrets never enter tracked files (SECURITY.md) |
| `{{<ROLE> status}}` (`active | dormant | not-hired`) | `agents/roster.md` Status column | hiring step at bootstrap (`docs/staffing.md` questionnaire) |
| `{{OVERSIZE_BREACH_K}}` / `{{IDLE_CYCLES_N}}` / `{{DORMANT_CYCLES_M}}` | `docs/staffing.md` | defaults 3 / 15 / 30; recalibrate |
| `{{OWNER_DECISION_SLA}}` / `{{OWNER_REVIEW_INTERVAL}}` | `docs/owner-contract.md` | ask first start; defaults 48h / loop close-or-weekly |

## First Start Behavior

The PM asks only high-impact questions:

1. Project name (+ confirm derived slug)?
2. Is this a blank project or existing project? Where does/should the product
   repo live?
3. PM display name?
4. Token soft/hard cap, or accept defaults?
5. Issue tracker — and which tracker adapter (columns / labels / file-ledger)?
6. Worker models — accept the tier menu in `agents/roster.template.md` ->
   Choosing Models, or override per role?
7. Is there a base-agent library on this machine (`BASE_AGENT_ROOT`), or run
   all roles synthetic?
8. May I search official stack conventions online if local files are insufficient?

Everything else is discovered or deferred.

## First Methodology Use

When a user first invokes a methodology that is not initialized:

```text
User: use TDD for this feature
PM: TDD profile is not initialized. Use the built-in generic TDD loop, or search
    current stack testing conventions first?
```

If the owner approves web search, the PM must prefer official framework docs,
testing-library docs, and primary sources.

## Locking Rule

Once a placeholder is resolved and written into a profile:

- workers treat it as input;
- workers may flag mismatch evidence;
- only PM/Architect/Owner can reopen it;
- reopening a locked project or stack decision should create an ADR.

