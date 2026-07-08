# Portable Workflow Catalog

This catalog preserves the project-neutral workflows extracted from
the source team workspace. It is the workflow inventory used during bootstrap, audit, and
agent deployment validation.

## Portability Rule

A portable workflow defines:

- trigger;
- owner;
- required role files;
- stack-neutral steps;
- evidence to write;
- escalation rule.

Stack-specific commands, framework conventions, local deployment facts, and
project vocabulary live in `profiles/stack.md` and `profiles/project.md`.

## Workflow Status

| State | Meaning |
|---|---|
| `enabled` | workflow is active for this project |
| `deferred` | workflow is known but not needed yet |
| `profile-bound` | workflow needs a stack or project profile value |
| `disabled` | owner explicitly opted out |

The PM records project-specific status in `profiles/project.md` or an ADR. Do
not delete a portable workflow just because a project does not use it yet.

## Catalog

### WF-00 Bootstrap And Deployment Validation

- Trigger: first `start team`, first attach to an existing repo, or copied team
  folder.
- Owner: PM.
- Required roles: PM, Architect, QA; Coach/Auditor/Chaos when enabled.
- Steps: create project and stack profiles; create `agents/roster.md`; ensure
  one file per active role; verify every role file has a `Base Agent` section;
  verify every non-synthetic base path exists; verify `.claude/agents` wrappers
  or inline base-agent mode.
- Evidence: bootstrap note in `memory/pm.md`, lifecycle entry if work was
  dispatched, ADR if operating model changed.

### WF-01 Cold Start, Stop, Resume

- Trigger: owner says `start {{PROJECT_NAME}}`, `stop {{PROJECT_NAME}}`,
  `resume {{PROJECT_NAME}}`, or unresolved `start team`.
- Owner: PM.
- Steps: load `CLAUDE.md`, profiles, charter, PM prompt, workflow catalog,
  lifecycle, PM decisions, memory, lessons, roster, and ADR index; run one
  bounded cycle; report; sleep.
- Evidence: lifecycle close entry, PM decision close line, memory delta.

### WF-02 Kanban Pull And Backlog Grooming

- Trigger: PM cycle with no explicit owner task.
- Owner: PM.
- Required roles: PM; Architect/UX/QA as needed.
- Steps: pull highest ready item; if Ready is empty, groom Backlog; if Backlog is
  empty, create small risk-ordered tickets from docs and current project state.
- Evidence: tracker update or local ticket ledger, PM decision dispatch line.

### WF-03 Dispatch Brief Construction

- Trigger: PM assigns work to a role.
- Owner: PM.
- Steps: choose role by responsibility; estimate tokens; split if above hard cap;
  build brief from `agents/templates.md`; include objective, scope, constraints,
  files allowed, verification expectations, output contract, and stop condition.
- Evidence: lifecycle open entry before dispatch.

### WF-04 Base-Agent Assembly

- Trigger: role file creation, bootstrap validation, or deployment drift.
- Owner: PM; Coach may refine overlays.
- Steps: resolve base-agent source; write `base_agent_root`,
  `base_agent_path`, or `synthetic`; keep project overlay in `agents/<role>.md`;
  generate concrete `.claude/agents/<project>-<role>.md` wrappers when using
  Claude subagents; set model, reasoning effort, and token budget in wrapper
  frontmatter or dispatch brief; do not let active roles inherit the main
  session's all-purpose worker defaults.
- Evidence: role file and wrapper file.

### WF-05 Lifecycle, PM Ledger, Memory, Messages

- Trigger: every PM cycle and every dispatch.
- Owner: PM.
- Steps: lifecycle stores full dispatch and close artifact; `pm-decisions.md`
  stores terse dispatch/close lines; `memory/pm.md` stores counters and
  next-wake state; `messages/` stores durable inter-agent notes when needed.
- Evidence: append-only entries. Supersede with dated entries instead of
  rewriting history.

### WF-06 Token Estimate, Cap, And Variance Calibration

- Trigger: every dispatch and close.
- Owner: PM; Coach watches drift.
- Steps: estimate before dispatch; split work above hard cap; close with actual
  tokens and variance; update tier guidance when repeated variance appears.
- Evidence: lifecycle variance, memory counter, Coach lesson if pattern repeats.

### WF-07 Empty-Loop And Progress Guard

- Trigger: PM cycle start or repeated no-op cycle.
- Owner: PM.
- Steps: compare recent lifecycle entries; reject cycles that only read, restate,
  or reassign without progress; choose a divergent next action or escalate.
- Evidence: lifecycle note with the concrete next action.

### WF-08 Retry Divergence And Tool Swap

- Trigger: failed retry, tool hang, repeated MCP error, or same agent failure.
- Owner: PM.
- Steps: do not repeat the same failing action; change agent, scope, tool, or
  verification method; use timeout-capable alternatives for fragile tools.
- Evidence: lifecycle close explains what changed before retry.

### WF-09 Code-Shipping Verification Gate

- Trigger: code, config, schema, migration, UI, build, or runtime behavior
  changed.
- Owner: QA verifies; PM enforces.
- Steps: worker proposes test evidence; PM dispatches QA or runs configured gate;
  code-shipping work is not Done until verification passes or owner accepts a
  documented exception.
- Evidence: QA result, command output summary, screenshots when UI is involved.

### WF-10 Same-Session Fix And Retest

- Trigger: verification fails but fix is narrow and still within the cycle cap.
- Owner: PM.
- Steps: send the same worker a focused fix brief with failed evidence; retest
  with the same gate; stop if the retry would repeat the same failure mode.
- Evidence: lifecycle retry entry with failure and retest result.

### WF-11 Three-Round Escalation

- Trigger: third verification round-trip on the same ticket.
- Owner: PM.
- Steps: stop chaining workers; report to owner with bugs fixed, bugs remaining,
  failed or untested checks, and recommended call: ship with follow-up, continue,
  split, or drop.
- Evidence: `Needs Decision` tracker state or owner report.

### WF-12 Direct Verification Exceptions

- Trigger: QA procedural failure loops or contradictory observable claims.
- Owner: PM.
- Steps: use direct verification only for read-only/static checks, or for an
  emergency when QA failed procedurally twice and token burn is already material;
  do not use this to bypass real runtime proof.
- Evidence: PM note naming why direct verification was allowed.

### WF-13 External Library And API Verification

- Trigger: adding or relying on a library, framework API, external API, or
  version-sensitive convention.
- Owner: worker proposes; PM/Architect/QA verify.
- Steps: check installed dependencies first; verify existence and API shape
  against official docs, source, registry, or local package metadata; ask owner
  before web search when network knowledge is required.
- Evidence: source link or local package path in worker output.

### WF-14 Worker MCP Boundary

- Trigger: task involves issue tracker, external service, or network-bound MCP.
- Owner: PM.
- Steps: PM owns tracker sync and external service coordination; workers use
  local repo tools unless explicitly permitted; autonomous loops avoid
  network-bound MCPs where hangs cannot be bounded.
- Evidence: brief states allowed tools.

### WF-15 Watchdog, Heartbeat, And Hang Visibility

- Trigger: unattended run, long cycle, or known fragile command/tool.
- Owner: PM.
- Steps: start heartbeat or watchdog when configured; require periodic progress;
  treat silence, fake heartbeat, and long blocking calls as recoverable incidents.
- Evidence: watchdog logs or lifecycle incident note.

### WF-16 Parallel Dispatch With Shared-State Isolation

- Trigger: independent work items can safely run together.
- Owner: PM.
- Steps: dispatch up to the project cap; require disjoint write scopes; define
  join condition; avoid parallel writes to lifecycle, lessons, PM decisions,
  decisions, charter, roster, memory, or shared agent docs.
- Evidence: lifecycle entries name write scope and join condition.

### WF-17 Cleanup Batch Rhythm

- Trigger: configured number of feature cycles since last cleanup batch.
- Owner: PM; Coach/QA support.
- Steps: schedule a maintenance batch for docs drift, brittle tests, dead files,
  prompt drift, or small refactors; keep product work paused or explicitly
  separated.
- Evidence: memory counter and cleanup lifecycle entry.

### WF-18 Hardening Wave

- Trigger: major release prep, repeated reliability issues, or configured cycle
  interval.
- Owner: PM; Security, QA, Auditor, Chaos may participate.
- Steps: run focused hardening tickets for verification gaps, error handling,
  security, data safety, performance, and process reliability.
- Evidence: hardening report and ADRs for policy changes.

### WF-19 Coach / Agent Improver Loop

- Trigger: queued coaching triggers drained BATCHED (variance threshold, 10+
  entries, harness violation, repeated failure, owner request) — never one
  spawn per trigger, never calendared.
- Owner: Coach.
- Steps: analyze evidence; append one index line per lesson to
  `agents/lessons.md` AND land the rule in the owning overlay or `_shared/`
  file; consolidate recurring lesson families into meta-rules or band rows
  (Coach owns index curation); edit overlays/templates only within authority;
  never add/remove members unilaterally.
- Evidence: index line, rule landed in owning file, lifecycle citation.

### WF-20 Auditor / Process Reviewer Loop (Mode 2 — periodic only)

- Trigger: hardening counter threshold, owner request, major process ADR
  cluster, or unresolved drift. Per-PR code review mode is RETIRED (the QA
  verification gate covers per-change review); revive only by owner directive.
- Owner: Auditor.
- Steps: review per the `agents/auditor.md` checklist — PM hygiene, handoffs,
  lifecycle quality, ADR coherence, tier-model integrity, backlog dynamics,
  overlay drift, meta:product token ratio (flag > 0.5), primer-vs-charter
  drift.
- Evidence: one-page GREEN/AMBER/RED audit note; hardening counter reset on
  recon completion.

### WF-21 Member Addition And No-Churn Rule

- Trigger: proposed new role, repeated unmet responsibility, or owner request.
- Owner: PM + Coach + Auditor; owner ratifies.
- Steps: require evidence; prefer improving overlays before adding people; update
  roster, role file, templates, lessons, and ADR; preserve stable names unless
  owner changes them.
- Evidence: ADR and roster entry.

### WF-22 One-Shot Security Review

- Trigger: pre-release, auth/session/data change, permission change, or owner
  request.
- Owner: Security.
- Steps: inspect threat surface, sensitive data paths, auth/session handling,
  dependency risk, secrets, and deployment assumptions.
- Evidence: security review result and blocking/non-blocking findings.

### WF-23 Chaos / Guardian Loop

- Trigger: every engine batch (guardian verify-node); any non-listed halt of a
  count-directed loop (halt-investigation auto-fire); new/changed loop
  machinery (chaos gate); token-burn or recovery-rule work; owner request.
- Owner: Chaos role (`agents/chaos.md`).
- Steps: guardian audits engine batches for runaway / missed-halt /
  budget-gate correctness / dropped fix-retests; halt-investigation traces
  every rationalization before a non-listed halt; chaos gate injects failures
  into loop machinery to prove fail-closed behavior. Note: deterministic stall
  SIMULATION is a proven dead end on this harness class — test reachable
  patterns only.
- Evidence: guardian verdict logged in lifecycle; pattern/harness-constraint
  note; recovery result.

### WF-24 ADR And Profile Decision Locking

- Trigger: policy change, architecture decision, methodology lock, stack lock,
  or reopened placeholder.
- Owner: PM/Architect drafts; owner ratifies when material.
- Steps: write short ADR; update profiles; point workers to locked values; do
  not re-litigate locked choices during normal tickets without new evidence.
- Evidence: ADR file and profile update.

### WF-25 Documentation Completeness

- Trigger: bootstrap, product behavior change, public/user-facing change, or
  audit.
- Owner: PM; worker updates docs in scope.
- Steps: maintain README, usage docs, technical docs, functional docs, ADRs,
  process index, and source map as applicable; docs are part of Done when a
  behavior change needs them.
- Evidence: `docs/doc-completeness.md` status and changed docs.

### WF-26 Rendered/UI Verification

- Trigger: frontend, UI, report, generated doc, screenshot-sensitive output, or
  design-system work.
- Owner: Frontend/UX implements; QA verifies.
- Steps: run browser/rendered checks when available; inspect mobile and desktop
  layouts; verify text does not overlap; verify screenshots or generated assets
  render as intended.
- Evidence: screenshot path or rendered verification summary.

### WF-27 Handoff Protocol

- Trigger: worker completes work that another role must continue or verify.
- Owner: worker writes; PM enforces.
- Steps: include files changed, what was verified, what remains unverified,
  assumptions, risks, and next recommended owner; for multi-file UI changes use
  a file-by-file outcome table.
- Evidence: worker final output and lifecycle close.

### WF-28 Owner Escalation / Needs Decision

- Trigger: ambiguous product direction, charter conflict, security/data-loss
  risk, irreversible choice, token cap conflict, agent disagreement, or
  three-round escalation.
- Owner: PM.
- Steps: stop autonomous action; present options and recommendation; mark tracker
  `Needs Decision` when available.
- Evidence: owner report or tracker state.

### WF-29 Model, Reasoning, And Role Budget Profiles

- Trigger: role creation, repeated token variance, or model policy change.
- Owner: PM + Coach; owner may lock.
- Steps: keep role budget and reasoning defaults in project profile or ADR; use
  placeholders until owner resolves them; update when variance proves the tier is
  wrong; role dispatch must use these values rather than silently inheriting the
  main session's model or thinking hardness.
- Evidence: profile value, ADR, or memory counter.

### WF-30 Lazy Stack, Convention, And Methodology Resolution

- Trigger: unresolved stack convention, code convention, library API, test
  method, delivery methodology, or PM method first use.
- Owner: PM/Architect.
- Steps: inspect local repo first; ask owner before web search; prefer official
  docs and primary sources; lock the result in profiles or methodology docs; use
  generic defaults only when work is not blocked.
- Evidence: profile/methodology update and source note.

### WF-31 Count-Directed Loop Engine

- Trigger: owner count directive ("run N rounds") with a pre-scopable plan.
- Owner: PM invokes; Chaos guardian audits; QA gates code-shipping iters.
- Required roles: PM, QA, Chaos.
- Steps: PM pre-scopes the plan attended; invokes
  `.claude/workflows/run-n-rounds.js` with `{rounds, plan, date,
  nextLifecycleNumber, budgetCeilingTokens}`; engine owns count bound + Q5
  budget gate + fail-closed verifier gate + guardian node; PM reconciles per
  `docs/engine.md` (paste-verbatim log blocks, per-iter pm-decisions lines,
  fix-retest drain, tracker sync, Q3/Q4 attestation).
- Evidence: `### BATCH` lifecycle block, messages log block, guardian verdict
  entry, pm-decisions per-iter lines.

## Non-Portable Items

These stay in stack or project profiles:

- framework-specific file names and commands;
- deployment host, port, LAN, and OS assumptions;
- product language, domain vocabulary, and ticket prefixes;
- package manager and test runner commands;
- UI design system details;
- tracker provider and field names.

## Bootstrap Acceptance Checklist

Before product work starts, the PM can answer:

- Which workflows above are enabled, deferred, profile-bound, or disabled?
- Which enabled workflows require `coach`, `auditor`, `security`, or `chaos`?
- Does every workflow-triggered role have `agents/<role_id>.md`?
- Does every non-synthetic role resolve to a real base agent?
- Where are workflow-specific settings stored: profile, methodology file, ADR,
  or tracker?
