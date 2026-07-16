# AI.Team - Portable Multi-Agent Team Template

> "Portable" means the TEAM is portable across projects (drop the kit next to
> any product repo and bootstrap) — not portable across agent runtimes. The
> kit targets **Claude Code only** (>= 2.1.154); other runtimes are out of
> scope unless a future ADR says otherwise.

A reusable **team operating system for [Claude Code](https://claude.com/claude-code)**:
one persistent PM session orchestrating a roster of specialist AI agents
(architect, backend, frontend, UX, QA, data, security, coach, auditor, chaos)
to run a software project end to end — product scope, tickets, implementation,
verification, audits, and self-improvement — with a human owner in the loop
for decisions only.

It is the distilled, project-neutral version of a multi-agent team system that
ran a real product for ~3 months. The governance that made it survive is
included: a constitution (charter) with hard budget/halt rules, append-only
audit ledgers, a mechanical loop engine for unattended runs, a curated
failure-class catalog, and validation scripts.

It works against either:

1. **Empty project mode** - no codebase exists yet; the PM bootstraps product scope,
   stack choice, docs, tickets, and first implementation slices.
2. **Existing project mode** - a codebase already exists; the PM first inventories
   repo structure, current docs, conventions, tests, risks, and open work before
   dispatching agents.

## Requirements

- **Claude Code >= 2.1.154** (tested against 2.1.x, July 2026) with the
  Workflow tool (Dynamic Workflows require 2.1.154+), project-scoped subagent
  registry (`.claude/agents/`), hooks, and background agent dispatch. Check
  yours with `claude --version`. Every missing primitive has a documented
  fallback — see the degradation table in `docs/harness-assumptions.md`.
  Note: per-role token budgets in this kit are ADVISORY brief-level targets;
  the runtime enforces `model`, `effort`, and `maxTurns` from wrapper
  frontmatter, but no frontmatter field hard-caps tokens per agent.
- **git** (local use is enough; no remote required).
- Optional: an issue tracker (Jira / Linear / GitHub Projects). Without one,
  the Kanban methodology falls back to a file-based board — see
  `methodologies/kanban.md`.

## How to Deploy

1. **Clone this repo next to (or as the future home of) your product code.**
   The intended layout is a workspace folder holding the team and the product
   side by side:

   ```text
   MyWorkspace/
     AI.Team/        <- this repo (team: charter, agents, ledgers, docs)
     MyProduct/      <- your product code (created at bootstrap if absent)
   ```

2. **Open Claude Code in `AI.Team/` — with the product repo added — and say
   `start team`.** The product repo is a sibling directory, so the session
   needs explicit access to it:

   ```bash
   cd MyWorkspace/AI.Team
   claude --add-dir /absolute/path/to/MyWorkspace/MyProduct
   ```

   Team files (`agents/...`, `profiles/...`) are read relative to this cwd —
   the team root. The PM wakes, reads `CLAUDE.md`, and runs the bootstrap
   interview:
   - instantiates `charter.md` and `profiles/project.md` / `profiles/stack.md`
     from their `.template.md` seeds (templates stay untouched as reference);
   - asks only the first-start placeholders (project name, repo path, token
     caps, tracker...) — see `docs/lazy-placeholders.md`;
   - runs the staffing questionnaire (`docs/staffing.md`) — default is a
     Minimum Viable Team of PM + 1 builder + 1 verifier, other roles stay
     dormant until a trigger promotes them;
   - then follows `docs/bootstrap-empty-project.md` or
     `docs/bootstrap-existing-project.md` depending on your answer.

3. **Wire the recommended hooks** (optional but advised for unattended runs):
   merge the `settings.json` snippet from `docs/harness-assumptions.md` into
   your deployment's `.claude/settings.json`, and install the watchdog per
   `scripts/watchdog/INSTALL.template.md`.

4. **Verify the deployment** at any time:

   ```bash
   scripts/check-claude-compat.sh .            # runtime version + wrapper frontmatter
   scripts/validate-team.sh --mode deployment . # deployed instance: full artifact matrix
   scripts/validate-team.sh .                   # fresh kit / auto-detect
   node --test tests/*.test.mjs  # engine + validator + watchdog fault-injection suite
   ```

   Pure bash (validator) + node (tests); exit 0 = no FAIL **in the checked
   mode** — kit mode does not attest a deployment, so deployed instances must
   use `--mode deployment`. The validator is also the wake-step-0 integrity
   gate the PM runs every cycle.

5. **Drive it.** `start <project>` / `stop <project>` for daily cycles. Your
   duties as the human owner (decision SLA, weekly ledger scan, real-device
   review, SAFE-MODE when absent) are defined in `docs/owner-contract.md`.

## The Operating Model

The important extraction from the source project is not the ASP.NET stack. The reusable system
is the operating model:

- one persistent PM loop;
- named specialist roles with stable responsibilities;
- one role file per active agent, including base-agent source resolution;
- standing meta-rules (M1-M6) and shared verification/browser disciplines in
  `agents/_shared/`;
- stack rules behind a lazy `profiles/stack.md`;
- project facts behind `profiles/project.md`;
- append-only lifecycle, PM decisions, memory, messages, lessons index, and
  ADRs — all under the slim-active + archive rotation regime;
- coach-curated lessons index and independent periodic audit;
- a mechanical count-directed loop engine with a guardian audit node
  (`.claude/workflows/run-n-rounds.js`, contract in `docs/engine.md`);
- Claude cold-start indexes and project-scoped agent wrappers.

## Start Here

| Goal | Read |
|---|---|
| Install this team into a new blank repo | `docs/bootstrap-empty-project.md` |
| Attach this team to an existing repo | `docs/bootstrap-existing-project.md` |
| Understand what every file is for | `docs/process-index.md` |
| See all portable workflows preserved from the source team workspace | `docs/workflow-catalog.md` |
| Read the standing meta-rules every agent follows | `agents/_shared/meta-rules.md` |
| Run owner count directives mechanically | `docs/engine.md` |
| Configure project name, PM name, tracker, language | `profiles/project.template.md` |
| Configure or lazily discover the stack | `profiles/stack.template.md` |
| See document completeness expectations | `docs/doc-completeness.md` |
| Understand Claude integration and index preservation | `docs/claude-integration.md` |
| Understand self-improvement loops | `agents/self-improvement.md` |
| Read the canonical failure-class catalog (mechanical controls per class) | `docs/failure-classes.md` |
| Run the mechanical integrity check (wake step 0 / bootstrap gate) | `scripts/validate-team.sh <root>` |
| Decide which roles to hire (MVT, questionnaire, triggers) | `docs/staffing.md` |
| See what the runtime must provide + deployment hooks | `docs/harness-assumptions.md` |
| Know the human owner's duties and SAFE-MODE | `docs/owner-contract.md` |
| Port an instance lesson back into this template | `docs/backport-ritual.md` |

## Directory Shape

```text
AI.Team/
  CLAUDE.md                    # cold-start primer for future Claude Code sessions
  charter.template.md          # constitution SEED -> instantiated as charter.md at bootstrap
  profiles/                    # project and stack profiles, lazily locked
  agents/                      # PM, roster, templates, lifecycle, lessons index
    <role_id>.md               # one file per active role, with base agent source
    _shared/                   # meta-rules M1-M6 + verify/browser discipline templates
  docs/workflow-catalog.md     # portable workflows preserved from the source team workspace
  docs/engine.md               # count-directed loop engine contract
  methodologies/               # Kanban default + lazy methodology packs
  decisions/                   # ADR index + template
  docs/                        # bootstrap, process map + rotation regime, completeness
  memory/                      # PM state and atomic counters
  messages/                    # inter-agent daily dialogue
  scripts/validate-team.sh     # mechanical integrity checker (kit + deployments)
  scripts/watchdog/            # copied hang-detection hooks from the source team workspace
  .claude/agents/              # project-scoped Claude agent wrapper templates
  .claude/workflows/           # run-n-rounds loop engine
```

## Key Principle

Keep universal rules universal, keep stack facts in the stack profile, and keep
project facts in the project profile.

Example:

- Universal: "framework entry points stay thin; business logic belongs in the
  application/domain layer."
- Stack adapter: "For ASP.NET Razor Pages, PageModel handlers stay thin; services
  hold non-trivial logic."
- Project profile: "For this project, deployment is macOS LAN, single user, FR/ZH/EN."

## First Command Pattern

Use a project-specific phrase once the placeholders are resolved:

```text
start {{PROJECT_NAME}}
stop {{PROJECT_NAME}}
resume {{PROJECT_NAME}}
```

Before `{{PROJECT_NAME}}` is known, use:

```text
start team
```

The PM should then initialize `profiles/project.md` and `profiles/stack.md`.

## License

MIT — see [LICENSE](LICENSE). You may use, modify, and redistribute this kit,
including commercially, with attribution. Instantiated deployments (your
`charter.md`, profiles, ledgers) are your own content and are not required to
be shared.
