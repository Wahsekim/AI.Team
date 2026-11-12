# ADR 0009: Separate the kit root from the project instance root

Date: 2026-11-12
Status: Accepted (owner ratification 2026-11-12, see Owner decisions)

## Context

A deployment today is a clone of this repository that bootstrap and every PM
cycle then modify in place. The kit and one project's team state share a root
and a Git history, so a kit update collides with project state.

Observed on the UHF demo instance on 2026-11-12 (kit checkout at `fb8e106`,
81 commits behind `main`): `git pull` was refused. Twenty tracked kit files
carried uncommitted project content, and seven of them were also changed
upstream. The content falls into three kinds:

| Kind | Tracked files modified by the instance | Cause |
|---|---|---|
| Project ledgers | `agents/lifecycle.md`, `pm-decisions.md`, `memory/pm.md` | Runs append to files the kit tracks. The kit also commits its own entries there (`agents/lifecycle.md`: 704 lines, 17 commits on `main`; `pm-decisions.md`: 12 commits), so both sides append to one file. |
| Role adaptations | `agents/{architect,auditor,backend,chaos,coach,data,frontend,qa,security,ux}.md` | Project overlays are edited into the kit's role files. |
| Localized kit files | `CLAUDE.md`, `.gitignore`, `decisions/README.md`, `docs/context-budget.md`, `docs/doc-completeness.md`, `docs/process-index.md`, `scripts/measure-context.sh` | `bootstrap-team.sh` rewrites the `CLAUDE.md` start phrase in place; the project adds ignore rules, ADR rows and doc rows. |

Files that bootstrap creates under new names (`charter.md`,
`profiles/project.md`, `agents/roster.md`) do not collide, because the kit never
ships them. The defect is limited to tracked files that are written after clone.

Router/Worker (ADR 0008) inherits the defect. Its draft tool overlays
`agents/roster.md`, `agents/worker-*.md` and `.claude/agents/` wrappers onto "a
fresh base-kit copy", and `src/router-worker/{coverage,retries}.mjs` read
`charter.template.md` from a single `teamRoot`. Rollout gate G-01 already records
that deployed authority must come from the instantiated `charter.md`.

## Decision

1. **Two roots.** The *kit root* is a clean checkout of this repository at a
   recorded commit. The *instance root* is a separate directory that belongs to
   one target project and holds everything bootstrap or a run writes.
2. **The kit root is read-only for deployments.** Bootstrap, PM cycles, engine
   runs, reconciliation and the Router/Worker tools write nothing under it. A
   kit update is a fast-forward of the kit checkout plus a recorded pin change.
3. **Instance root layout.** The PM session starts in the instance root, because
   Claude Code loads `CLAUDE.md`, `.claude/agents/`, `.claude/workflows/` and
   `.claude/settings.json` from the session directory.

   ```text
   MyWorkspace/
     MyProduct/                 # product code
     MyProduct.team/            # instance root (its own Git repository)
       kit/                     # kit root: submodule or pinned checkout, never edited
       kit.lock                 # kit commit + instance schema version
       CLAUDE.md                # generated from a kit seed, localized here
       charter.md  profiles/  agents/roster.md  agents/_shared/*.md
       agents/overlays/<role>.md  # optional project overlay only
       agents/lifecycle.md  agents/lessons.md  pm-decisions.md  memory/  messages/
       decisions/               # project ADRs
       .claude/agents/          # wrappers
       .claude/workflows/       # engine copy, digest-checked against kit/
   ```

4. **One path rule, no shadowing.** A team-relative path named in any kit
   document or script resolves in the instance root when it exists there,
   otherwise under `kit/`. A path present in both roots is a validator FAIL,
   except the generated files bootstrap owns (`CLAUDE.md`, `.gitignore`, the
   engine copy). Existing kit documents therefore keep their paths. A wrapper
   reads `kit/agents/<role>.md`, then the overlay `agents/overlays/<role>.md`
   when it exists. Overlays hold project adaptations only and never copy kit
   text.
5. **The kit ships no live state.** Ledgers, PM memory and `CLAUDE.md` are
   shipped as seeds. The kit's own development team becomes an ordinary instance
   with its own instance root, so kit commits stop appending to shipped ledgers.
6. **Mechanical enforcement.** `validate-team.sh --mode deployment` fails when
   `git -C kit status --porcelain` is non-empty or `kit` HEAD differs from
   `kit.lock`. The test suite gains a case that runs bootstrap and a simulated
   cycle and asserts the kit tree is unchanged, and a case that advances the kit
   with an instance present and asserts no conflict.
7. **Instance schema version.** `kit.lock` records the instance layout version.
   A kit change that alters an instance file format ships a migration step and
   bumps the version; the validator refuses a mismatch.
8. **Topology is an instance setting.** Specialist and Router/Worker resolve
   project authority (`charter.md`, roster, profiles) from the instance root and
   universal sources from the kit root. The Router/Worker `teamRoot` parameter
   splits into the two roots, and its drafts target an instance root.
9. **Legacy single-root deployments** keep working for one release with a
   validator WARN, then fail. The only known deployment is the UHF demo.

## Script audit (first pass by grep, not a line-by-line review)

| Surface | Today | Change |
|---|---|---|
| `scripts/bootstrap-team.sh` | One `ROOT`; seeds read from and written to it; edits tracked `CLAUDE.md` | Read seeds from the kit, write to the instance; generate `CLAUDE.md`, `kit.lock`, engine copy |
| `scripts/validate-team.sh` | One `ROOT`, about 60 instance-path references mixed with kit sources | Resolve both roots; add the kit-clean and pin checks |
| `scripts/check-claude-compat.sh` | `ROOT/.claude/agents` | Instance root only; no kit dependency expected |
| `scripts/reconcile-run.mjs` | `TEAM_ROOT` argument; writes `agents/lifecycle.md`, `messages/`, counters | Instance root only; refuse a root that is a kit checkout |
| `scripts/preflight-run.mjs` | `--team-root`; expects the engine under it | Instance root; compare the engine copy digest with `kit/` |
| `.claude/workflows/run-n-rounds.js` | About 25 team-relative paths in briefs | Kit sources become `kit/...`; instance paths unchanged |
| `scripts/measure-context.sh`, `scripts/lessons-stats.sh` | One `ROOT` | Read from both roots |
| `agents/_seeds/role-wrapper.template.md` | Reads `agents/<role>.md` at the team root | Reads `kit/agents/<role>.md` plus optional overlay |
| `src/router-worker/` (`draft`, `coverage`, `retries`, `preflight`, `methods`) | `teamRoot` defaults to the kit; rules read `charter.template.md` | Split roots; rules read the instance `charter.md` |
| `scripts/role-skills.mjs` | Resolves packs from its own location | None |
| `scripts/measure-spawn.mjs`, `scripts/now-utc.sh` | No root dependency | None |
| `scripts/watchdog/` | State under `$HOME/.claude` | None found; installation doc to re-check |
| Docs | README "How to Deploy", both bootstrap docs, `docs/claude-integration.md`, `docs/harness-assumptions.md`, `docs/process-index.md`, this repository's `CLAUDE.md` | Rewrite for two roots; add `docs/upgrade.md` |

## Considered Alternatives

1. Keep one root and merge kit updates on a local instance branch. Works today
   without code changes, but every update needs hand resolution of ledgers and
   role files, and the cost grows with each project.
2. Keep one root and stop tracking only the ledgers (ship them as seeds). Removes
   the largest conflicts but leaves role overlays, `CLAUDE.md` localization and
   project ADR rows inside tracked kit files.
3. Put instance state inside the product repository (`MyProduct/.ai-team/`).
   Matches "settings in the target project" literally, but ledger writes would
   dirty the product candidate that preflight checks, and ADR 0003 requires
   Loop/Graph state to live outside any Git repository that is the product.
4. Install the kit as a package (npm or a Claude Code plugin). Gives a clean
   version pin but adds a distribution channel and a release process the project
   does not have yet. `kit/` as a pinned checkout can be replaced by this later.

## Consequences

- A kit update no longer touches project state, and one kit checkout can serve
  instances with different topologies.
- Project team state gets its own history, separate from kit development.
- Every path in wrappers, briefs and docs that points at a kit source changes.
  This is the main cost and the main regression risk.
- The cold-start read set changes, so the context-budget ratchet
  (`docs/context-budget.md`) must be re-measured.
- Instance format changes now need explicit migrations instead of a merge.
- Rollout gate G-01 of the Router/Worker self-review is partly absorbed by
  decision 8; its other parts are unchanged.

## Migration of the UHF demo instance

1. Commit the current working tree on a local-only branch in the old checkout
   as a snapshot. Nothing is pushed.
2. Create the instance root beside the product, add `kit/` at current `main`,
   and run the new bootstrap with the existing project values.
3. Copy instance files across: `charter.md`, `profiles/`, `agents/roster.md`,
   instantiated `_shared` files, ledgers, `memory/`, `messages/`, project ADRs,
   `.claude/agents/`, `.claude/commands/`, `reference.yaml`,
   `scripts/notify-owner.sh`.
4. For each modified role file, extract the difference against `fb8e106` into
   the instance overlay.
5. Keep the copied ledgers as they are, including kit entries present at the
   fork point, and append one dated entry recording the migration.
6. Run `validate-team.sh --mode deployment` in the instance root, then one
   attended cycle. Keep the old checkout until that cycle closes.

## Owner decisions

Recorded 2026-11-12. The four open points were put to the owner with a
recommendation each; the owner's reply was "all follow your recommendations."

- Instance root location: a separate directory beside the product, with its own
  Git repository (decision 3).
- `kit/` mechanism: Git submodule.
- Legacy single-root support: one release with a validator WARN, then FAIL
  (decision 9).
- Home of the kit's own development ledgers: an instance directory inside this
  repository that uses the same layout. The question as put to the owner listed
  this option first without marking it as the recommendation, so it is recorded
  here as the author's choice pending the owner's confirmation.

The path rule in decision 4 and the `agents/overlays/` location were refined
after the proposal, during acceptance, to avoid rewriting every kit path.

## Follow-ups

- [x] Owner ratification (2026-11-12).
- [ ] Owner confirmation of the home of the kit's own ledgers.
- [ ] Root resolver shared by the bash and Node scripts, with legacy detection.
- [ ] Bootstrap, validator checks and the two new test cases (decisions 2 and 6).
- [ ] Wrapper seed and role overlay split (decision 4).
- [ ] Move kit ledgers out and ship seeds (decision 5).
- [ ] Router/Worker root split (decision 8).
- [ ] Docs rewrite and `docs/upgrade.md`.
- [ ] Migrate the UHF demo instance.
