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
overrides; nothing marked proposed is enforced until ratified.

| Field | Value |
|---|---|
| Provider / runtime | Claude Code CLI **2.1.318** (the installed version on the pilot machine); PM session model `claude-fable-5-1`; worker models per `agents/roster.md` once instantiated. Any other runtime version is a new R06 revision. |
| Supported OS | macOS only (Darwin 27 on the pilot machine). Linux CI runs tests only, never a pilot. |
| Trust assumptions | Local, owner-attended session. The worker runs as the owner's own UID with the owner's own file permissions. **This is not an OS sandbox**: isolation comes from the disposable checkout, the state-directory rules and the runtime's permission prompts, nothing else. |
| Disposable checkout | One isolated clone per run (ADR 0003 target isolation). No credentials, no production data, no `.env` with real values in it. Deleted or archived at run close; never reused as a working tree. |
| Allowed paths | The run's checkout and its state directory, which lives OUTSIDE any git repository (ADR 0002/0003). Reads of the team kit are allowed; writes to the kit happen only through the PM reconciliation scripts. |
| Allowed tools | File read/write inside the checkout; the stack's test and verification commands (`profiles/stack.md`); `git` on the working branch only (commit per card, push working branch, never `main`, never `--force`, no deploy, no publish). No external-service MCP calls inside loops (CLAUDE.md hard rule). |
| Allowed network | The model API only. Package-registry fetches only through the stack's declared install command on a lockfile. Nothing else. |
| Call ceiling | **proposed:** wrapper `maxTurns` is the mechanical bound per worker (`docs/harness-assumptions.md`); a run is at most the engine count N the owner directed. |
| Time ceiling | **proposed:** the watchdog's hang timeout per worker (`scripts/watchdog/`) and the engine per-invocation gate; no run continues past an owner-absent SAFE-MODE trigger (`docs/owner-contract.md`). |
| Token ceiling | The charter Canonical Budget/Halt Table (single source): per-spawn cap, loop worker-token ceiling, engine per-invocation gate. Measured on the harness scale (`agents/lifecycle.md` Harness Rule 9). Not restated here. |
| Spend cap (USD) | `billing_mode: subscription` for this instance → **n/a** (bounded by the plan's own limits, no per-token invoice). For `billing_mode: api`, `{{COST_CAP_USD}}` is `ask:first_start` and REQUIRED: unset = paid stages blocked (card KO). Priced spend is read from `scripts/measure-spawn.mjs --pricing scripts/lib/model-pricing.json` (four-class view), never from the lifecycle `Tokens:` effort scale. |
| Transcript policy | Runtime transcripts stay where Claude Code writes them (local, under `~/.claude/projects/`). Run evidence stays in `docs/rollout-evidence/` (local, gitignored, owner decision Q1/Q4). Nothing from either is published; redaction before any sharing (engine `redact`). Retention beyond this machine: **blocking unknown** (owner open item 4 from the G0 exit record). |
| Named owner | Yang XIAO (repository owner). Only the owner halts, ratifies, or authorizes a paid stage. |
| Automatic landing | **Off.** Worker changes land only through the per-card commit + PR + owner merge path. No auto-merge, no auto-deploy. |

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

- The kit asks `BILLING_MODE` at first start and `COST_CAP_USD` only when the
  answer is `api` (`profiles/project.md`, `docs/lazy-placeholders.md`).
- The charter budget table gains a Spend-cap row that points here; no other
  file restates the cap.
- R07 can start: it depends on R06 only for the contract being written, not
  ratified. Paid stages (R16+) stay blocked until Status becomes Accepted.
- Watch: the proposed call/time ceilings are inherited from existing
  mechanisms; if the owner wants numeric per-run caps, this ADR gets a dated
  revision, not an edit.

## Follow-ups

- [ ] Owner ratifies (Status → Accepted) or overrides proposed rows.
- [ ] Owner decides evidence retention beyond this machine (blocking unknown).
- [ ] Fill `scripts/lib/model-pricing.json` before any `billing_mode: api` pilot.
- [ ] R07: version the execution and storage contracts.
