# ADR 0006: Pilot operating contract (R06)

Date: 2026-11-05
Status: Proposed (PM draft from owner answers 2026-11-05; owner ratification pending — paid stages stay blocked until ratified)

## Context

- Plan card R06 (`docs/loop-graph-rollout-plan.md` §4): one short decision
  record fixing what a live Loop/Graph worker may do before any paid stage.
  KO: implicit permission bypass, undefined spend cap, or calling a same-UID
  checkout an OS sandbox.
- G0 exited 2026-10-07 and merged to `main` 2026-11-05 (PR #1). G1 (R07–R15)
  stays offline; a paid smoke (R16) needs explicit cost authorization after G1.
- Owner answer 2026-11-05: this instance runs on a Claude subscription, not a
  metered API key, so a per-run USD cap does not apply here; any deployment
  that runs on an API key MUST be asked for a cost cap at first start.

## Decision

Every field below has a concrete value or an explicit blocking unknown
(card test). Values marked **proposed** are PM defaults the owner ratifies or
overrides; nothing marked proposed is enforced until ratified. The
**Enforcement** column follows the charter's own classes: `mechanical` =
refused by code or runtime; `policy` = PM/owner discipline, checked at close.

| Field | Value | Enforcement |
|---|---|---|
| Provider / runtime | Claude Code CLI **2.1.318** (the installed version on the pilot machine); PM session model `claude-fable-5-1`; worker models per `agents/roster.md` once instantiated. Any other runtime version is a new R06 revision. | policy: `scripts/check-claude-compat.sh` gates only `>= 2.1.154`; the exact pin is checked by hand — `claude --version` is recorded in each run's evidence |
| Supported OS | macOS only (Darwin 27 on the pilot machine). The CI matrix (ubuntu, macOS) runs tests only, never a pilot. | policy |
| Trust assumptions | Local, owner-attended session. The worker runs as the owner's own UID with the owner's own file permissions. **This is not an OS sandbox**: isolation comes from the disposable checkout, the state-directory rules and the runtime's permission prompts, nothing else. | policy |
| Permission mode | Wrappers keep `permissionMode: default` (runtime prompts). The PM session and every worker run WITHOUT permission bypass; an unattended count-directed loop may run only on an owner-written allowlist in `settings.json`, never on a bypass flag. | policy today (no `.claude/settings.json` exists yet); becomes mechanical once the owner writes the allowlist/deny rules |
| Disposable checkout | One isolated clone per run (ADR 0003 target isolation). No credentials, no production data, no `.env` with real values in it. Deleted or archived at run close; never reused as a working tree. | mechanical for isolation (ADR 0003 binding refusals); policy for the no-credentials rule and the close-time deletion (no code deletes a clone) |
| Allowed paths | The run's checkout and its state directory, which lives OUTSIDE any git repository (ADR 0002/0003). Reads of the team kit are allowed; writes to the kit happen only through the PM reconciliation scripts. | mechanical for the state-dir rule (ADR 0002/0003 refusals); policy for kit writes |
| Allowed tools | File read/write inside the checkout; the stack's test and verification commands (`profiles/stack.md`); `git` on the working branch only (commit per card, push working branch, never `main`, never `--force`, no deploy, no publish). No external-service MCP calls inside loops (CLAUDE.md hard rule). | policy (builders hold Bash via the wrapper seed); the engine body has no IO by construction |
| Allowed network | The model API only. Package-registry fetches only through the stack's declared install command on a lockfile. Nothing else. | policy (no egress control exists on a same-UID checkout) |
| Call ceiling | **proposed:** wrapper `maxTurns` is the bound per worker (`docs/harness-assumptions.md`); a run is at most the engine count N the owner directed. | mechanical (frontmatter `maxTurns`; engine for-loop count) |
| Time ceiling | **blocking unknown — no wall-clock ceiling exists today.** The watchdog (`scripts/watchdog/`) only notifies on a stale heartbeat (600 s) and expires itself after 12 h; it stops nothing. The engine has no clock in-loop. The only time proxies are owner attendance, `maxTurns` and count N. A paid stage needs either a real bound (owner sets a per-run wall-clock cap enforced by a kill step) or an explicit owner waiver. | none (unknown) |
| Token ceiling | The charter Canonical Budget/Halt Table (single source): per-spawn cap, loop worker-token ceiling, engine per-invocation gate. Measured on the harness scale (`agents/lifecycle.md` Harness Rule 9). Not restated here. | mechanical for the engine Q5 gate; policy for the per-spawn and batch caps (charter enforcement note) |
| Spend cap (USD) | `billing_mode: subscription` for this instance → **n/a** (bounded by the plan's own limits, no per-token invoice; a plan-window ceiling is a separate owner decision, pending). For `billing_mode: api`, the cap lives ONLY in the charter Canonical Budget/Halt Table (Spend cap row) and is REQUIRED: unset, or unpriced because the pricing table is empty, = paid stages blocked (card KO). Priced spend is read from `scripts/measure-spawn.mjs --pricing scripts/lib/model-pricing.json` (four-class view), never from the lifecycle `Tokens:` effort scale. | policy (PM checks at scoping and close); no runtime halts on USD |
| Transcript policy | Runtime transcripts stay where Claude Code writes them (local, under `~/.claude/projects/`); no redactor runs over them. Run evidence stays in `docs/rollout-evidence/` (local, gitignored, owner decision Q1/Q4). Nothing from either is published; sharing any excerpt requires a manual redaction pass (the engine's `redact` covers engine telemetry only). Retention beyond this machine: **blocking unknown** (owner open item 4 from the G0 exit record). | policy; gitignore is the only mechanical part |
| Named owner | Yang XIAO (repository owner). Only the owner halts, ratifies, or authorizes a paid stage. | policy |
| Automatic landing | **Off.** Worker changes land only through the per-card commit + PR + owner merge path. No auto-merge, no auto-deploy. | policy (branch protection on `main` would make it mechanical — owner's call) |

## Allowed / denied actions (card test checklist)

| Action | Verdict | Why |
|---|---|---|
| Edit files inside the run's isolated clone | allowed | disposable checkout |
| Run the stack's test command inside the clone | allowed | allowed tools |
| Commit on the working branch, push that branch | allowed | git policy |
| Push to `main`, force-push, tag a release | denied | git policy |
| Deploy, publish a package, post to an external service | denied | no deploy/publish; no MCP in loops |
| Read a `.env` with real values, or copy production data into the clone | denied | no credentials or production data |
| Write to a state directory inside any git repository | denied | ADR 0002/0003 |
| Fetch an arbitrary URL, call a non-model API | denied | network = model API only |
| Install a dependency not in the lockfile | denied | registry fetch via lockfile only |
| Continue a loop after a halt condition in the charter table | denied | token burnout halt |
| Start a paid stage with `billing_mode: api` and no `COST_CAP_USD` | denied | undefined spend cap = KO |
| Describe the checkout as sandboxed in any report | denied | same-UID checkout is not a sandbox |
| Run the PM session or a wrapper with a permission-bypass flag | denied | permission mode row; KO "implicit permission bypass" |

## Considered Alternatives

1. One USD cap for every deployment, including subscription users — rejected:
   a subscription has no per-token invoice to cap; the number would be fiction
   and would train the PM to trust a fake meter.
2. Enforce the spend cap mechanically in the engine now — deferred: the
   pricing table is unfilled and the engine meter is the harness scale, not
   priced spend; a mechanical cap belongs to the paid-stage cards (R16+).
3. Treat the same-UID checkout as sufficient isolation — rejected by the card's
   KO; stated plainly instead.

## Consequences

- The kit asks `BILLING_MODE` at first start (`profiles/project.md`) and
  `COST_CAP_USD` only when the answer is `api`; the cap's single home is the
  charter Spend-cap row, and `profiles/project.md` only points at it.
- Two blocking unknowns remain and both block any paid stage: no wall-clock
  ceiling, and evidence retention beyond this machine.
- R07 can start: it depends on R06 only for the contract being written, not
  ratified. Paid stages (R16+) stay blocked until Status becomes Accepted.
- Watch: the proposed call/time ceilings are inherited from existing
  mechanisms; if the owner wants numeric per-run caps, this ADR gets a dated
  revision, not an edit.

## Follow-ups

- [ ] Owner ratifies (Status → Accepted) or overrides proposed rows.
- [ ] Owner sets a wall-clock ceiling per run (and the kill step that enforces it) or waives it explicitly.
- [ ] Owner decides the subscription plan-window ceiling (5-hour / weekly utilization halt) — separate decision, pending.
- [ ] Owner writes the `settings.json` allowlist/deny rules before any unattended loop.
- [ ] Owner decides evidence retention beyond this machine (blocking unknown).
- [ ] Fill `scripts/lib/model-pricing.json` before any `billing_mode: api` pilot.
- [ ] R07: version the execution and storage contracts.
