# Router/Worker skill assessment and injection plan

Assessment date: 2026-11-06. English translation: 2026-11-10.
Historical status: candidate selection, not installation, renderer/lock changes
or individual adoption approval. Later implementation status is recorded separately.

Companion: [implementation design](README.md). This assessment does not change
the serial first release, PM-only commits, independent verification or permissions.

## 1. Inspection scope and evidence limits

The assessment enumerated complete recursive GitHub trees (`truncated=false`) and
read every SKILL.md frontmatter/structure in these scopes:

- [Matt Pocock](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills):
  39 skills across engineering, productivity, misc and in-progress. Experimental
  directories are not stable-release commitments.
- [Pstack](https://github.com/cursor/plugins/tree/2776ddd2355d6d6c8747d3964600f28daf62f049/pstack):
  58 main skills and three Benny automation skills, 61 total. Other cursor/plugins
  packages were outside scope.
- Deeper reading covered candidate method bodies, all 24 principles and playbooks
  including eval, runtime-forensics, trace-forensics, visual-parity, hillclimb,
  pause-safely and session-pickup. Supporting directories were checked for scripts,
  runtime and model dependencies.

This was a complete catalog screen and semantic review of priority candidates,
**not a line-by-line security audit of every script/reference, execution of upstream
scripts or model-effectiveness testing**. Adoption requires reading the selected
dependency closure, checking licenses and testing the adapter. Unreviewed
conditional candidates cannot enter a deployment allowlist.

The local baseline was the skill pack merged at `main@8331e09`, not a claim to have
refetched AI.Team main during this assessment. Matt's upstream SHA matched the local
pin. Pstack's repository SHA advanced from local
`bb68f2365eceafa0cb2d253112f675acf5f144cc` to
`2776ddd2355d6d6c8747d3964600f28daf62f049`, but the five selected files, including
LICENSE, had identical SHA-256 bytes. `node scripts/role-skills.mjs verify` passed.
An upstream repository commit does not necessarily change selected methods.
These are dated assessment results, not a fresh upstream audit on the translation date.

## 2. Injection architecture: methods rather than professions

Select by `mode × duty × task-kind × project-capability`, not by assigning debug
only to frontend/backend. Design, research and performance below are task types,
not mandatory permanent positions.

| Recipient | Inject | Do not inject/grant |
|---|---|---|
| PM/Router | Small reviewed catalog; current clarification/specification/slicing/handoff methods | All skill bodies, another orchestrator, upstream model/budget defaults |
| Executor | One primary method plus necessary support, stack conventions, authority/stop/delivery contract | Entire PM planning process, nested delegation, tracker/commit/push/deploy rights |
| Independent check | Real project acceptance recipe and risk-appropriate review/impact/measurement | Author PASS as fact or unrestricted product/criteria/scope edits |
| Coach | Batch retrospective/rule-improvement methods and authorized lifecycle/usage/failure evidence | Automatic changes per error, self-approved charter/budget/model edits or upstream rule adoption |
| Auditor/Guardian/Security | Original checklists and limited supporting methods, retaining independence | Generic review as a security audit, or skill loading as proof of governance coverage |
| Initialization/maintenance worker | Generate/maintain project checks only in authorized configuration/test paths, for PM review | Silent installation, global configuration, automation or service publication during bootstrap |

All recipients still read required hard rules. Progressive disclosure applies to
methods, not hidden safety controls. Initially use zero or one primary method and
at most one support method. Review/expand required dependencies before dispatch
and charge them to context. References cannot evade limits. A new method needed
mid-task goes back to PM, not an arbitrary worker Skill call.

Expose only approved, executable project methods to PM, not 100 descriptions in
cold-start context. Qualify IDs by source to avoid Matt/Pstack `tdd` or `teach`
collisions.

## 3. Priority minimum set

Priority means worth adapting and evaluating, not default injection on every task.

| Capability | Source | Recipient/trigger | Output and adaptation |
|---|---|---|---|
| Specification draft | Matt `to-spec` | PM after scope discussion | Retain draft-only excerpt; no automatic issue publication |
| Vertical slices | Matt `to-tickets` | PM when an approved goal exceeds one verifiable block | Preserve dependencies/acceptance; not UI/API staffing splits; tracker operations retain PM authority |
| Evidence-based diagnosis | Matt `diagnosing-bugs` | Exec for unknown-cause bugs/regressions | Failing reproduction→hypothesis→fix→regression; retain guards; questions through PM; no automatic HITL script; budgets/stops override persistence prose |
| Test-driven implementation | Matt `tdd` | Exec for new behavior/test-first repairs | Primary TDD method; review tests.md/mocking.md dependencies; agree seams in ticket/stack instead of repeatedly asking owner; no automatic skill chaining |
| Interface design | Reviewed Pstack `architect` references | Design-scoped exec for cross-module interfaces | Caller-first usage, tradeoffs, types/boundaries; no arena. Existing Design-only excerpt is not implementation authorization |
| Requirements and conventions review | Matt `code-review` excerpt | Independent check | Two output dimensions in one check, not two delegated agents. Include staged/unstaged/untracked candidate, not only `base...HEAD`; style heuristics are not hard defects |
| Downstream impact | Pstack `blast-radius` | Check for shared contracts/persistence/lifecycle | Reproduce key safety assumptions; retain uncertainty; no arena/why/unslop; unnecessary for ordinary copy |
| Real project acceptance recipe | Pstack `create-verification-skill` method | Initialization/dedicated maintenance | Produce launch/doctor/drive/evidence/cleanup and feature map; reuse stack/tests; portable AI.Team paths, not hardcoded `.cursor/skills`; actually run before claiming usability |
| Batch retrospective | Matt `retro` excerpt | Coach at original queue trigger | Evidence from usage/failures/work logs and improvement proposals; do not copy instructions to ignore coding standards |
| Evidence/numeric checks | Pstack `principle-explain-the-number`, optionally `benchmark-checklist` | Auditor/performance check/experiment owner | Failure rates, actual work, sample size/noise; adapt OS commands; repetitions do not authorize expensive full LLM runs |

Possible adoption groups: (1) TDD plus dual-axis review; (2) generation/execution
of project verification recipes; (3) retrospective plus measurement checks. Keep
the existing five methods compatible and validate additions incrementally, not
the entire upstream library at once.

## 4. Useful conditional capabilities

### PM/Router planning and delivery

- Matt `grilling`/`grill-with-docs`: substantive product decisions only. Choose
  one entry, remove exploratory subagents, and bound questions by budget/impact;
  simple work does not need a full interview.
- Matt `domain-modeling`: PM coordinates vocabulary/relationships; a design worker
  drafts. Reuse glossary/ADR authority, not a second decision system or worker-made
  business decisions.
- Matt `triage`: classification, reproduction and agent-ready briefs mapped to
  the existing tracker lifecycle; no imposed label machine or automatic closure.
- Matt `wayfinder`: borrow decision-dependency graphs for large uncertainty, not
  100K/session, one-ticket/session or parallel research branch-push rules. It is
  planning support, not a replacement loop/graph engine.
- Pstack `sharpen`/`in-your-own-words`: clarify goals/evidence in ambiguous briefs;
  preserve goals/prohibitions and label extra work as proposals.
- Matt `handoff`, Pstack `ketchup`/`show-me-your-work`: status/decision evidence
  mapped to PM checkpoint/ledger, not a second authoritative TSV. Temporary
  summaries do not replace durable budget/retry state.
- Matt `pr`, Pstack `technical-writing`/`unslop`: PM delivery prose or document
  tasks. Choose one main writing approach, preserve project style, and do not
  infer permission to publish a PR.
- Matt `to-questionnaire`/`wizard`: external decisions or owner-only setup. Separate
  wizard generation from execution; review side effects, redact credentials and
  separately authorize external writes.

### Execution and design

- Matt `research`: primary-source investigation and cited artifacts, without
  background subdelegation; the worker performs authorized research itself.
- Pstack `how`/`why`: local execution-flow/history investigation, removing parallel
  investigators, model defaults, automatic MCP and scope expansion. Unknown stays
  unknown.
- Matt `codebase-design`: local module/seam design where needed; do not impose
  wholesale replacement of established service/API/domain vocabulary.
- Matt `prototype`: isolated, bounded UI/logic experiments for owner decisions;
  no automatic commit/issues/product adoption. Prototype test scope is not a
  production-delivery exemption.
- Pstack `typescript-best-practices`: TS projects only; integrate with stack/lint,
  review principles/patterns.md closure, and do not migrate JS projects implicitly.
- Pstack domain/boundary/type-system principles: selected state/interface/type
  work only. Internal trust language cannot remove authorization, recovery or
  concurrency rechecks.
- Pstack idempotency/shared-state principles: useful for reservations, duplicate
  delivery, recovery and migration; neither grants automatic retry or concurrency.
- Pstack lever/verifiable-unit principles: repeatable bulk changes and bounded
  checks; remove worker commit/rebase and automatic delegate-skill creation.
- Pstack `principle-attack-the-premise`: test shared assumptions after repeated
  failures without extending retry caps.

### Verification, audit and skill maintenance

- `maintain-verification-skill`: separate recipe/map maintenance; distinguish doc
  drift from product defects. Remove reader fan-out and automatic PRs. Never turn
  a bug into a new expected result.
- Formal verification creation/maintenance and `statechart`: later-phase high-risk
  state/concurrency/recovery work. Models must correspond to code, disclose bounds,
  and fail mutation tests. A passing TLA+ model does not prove LLM/system behavior.
  Tool installation, dependencies and resource limits need separate approval.
- `interrogate`: independent adversarial check without arena/model fan-out.
  Executable reproduction is strong evidence, but unavailable execution must not
  discard statically proven permission defects. Separate confirmed, unproven and
  environment-blocked findings.
- `correct`/`reflect`: Coach investigates repeated failures and proposes mechanical
  controls; PM dispatches approved changes. No automatic per-correction rule edits,
  commits or mass modification of pinned third-party snapshots.
- Matt `writing-for-agents`: Coach/method maintenance checks triggers, references,
  completion and context cost. Not permanent worker reading, and no stylistic
  removal of hard safety rules.

## 5. Extract playbooks, not all of poteto-mode

[Pstack playbooks](https://github.com/cursor/plugins/tree/2776ddd2355d6d6c8747d3964600f28daf62f049/pstack/skills/poteto-mode/playbooks)
contain reusable methods beyond entry skills:

| Playbook | Useful method | AI.Team boundary |
|---|---|---|
| `eval` | Preregistered criteria, model-name blinding, natural tasks, logs/artifacts over self-report | Isolated serial experiment driver, no multi-model fan-out. Hidden scoring cannot hide acceptance/permissions/stops; only this experiment's logs; implementation evidence over model judge |
| `runtime-forensics` / `trace-forensics` | Real profiles/traces, minimized evidence, source tracing, hypotheses vs confirmation | Bounded diagnosis, no subagents or unauthorized live mutation labelled read-only; instrumentation follows environment permission |
| `visual-parity` | Freeze baseline, compare same-state screenshots | Approved equivalence tasks only; no baseline edits to satisfy tests. Control device/font/animation noise and preregister tolerances; no universal zero-pixel or endless loop rule |
| `hillclimb` | Frozen measurement, one hypothesis/experiment, correctness with performance | Original PM budgets/stops/small commits; remove ongoing autonomy, fixed models, parallelism and publishing; no spending past a cap to break a plateau |
| `pause-safely` / `session-pickup` | Boundary checklist, state evidence, recovery points | Checklist only; no worker commit on pause or transcript authority above current disk; follow branch reconciliation/migration protocol |

These are potential extractions, not adoption of Pstack orchestration, autopilot,
shipping or watchers.

## 6. Exclusions and deduplication

1. Do not import another orchestrator: Matt `ask-matt`, `implement-spec`,
   `chief-of-staff`, `claude-handoff`; Pstack `poteto-mode`, `arena`, `swarm`.
   Study their design without making them worker entry protocols.
2. Installation/automation is not a runtime method: setup skills, Benny and
   `make-bot-ui` require dedicated adoption decisions, not global config, roster
   or webhook changes during work.
3. Choose one primary synonymous method. Matt TDD is the first candidate; Pstack
   TDD may later serve lightweight regression with an existing cheap reproduction,
   but its skip suggestions cannot waive configured acceptance. Do not stack teach,
   grilling aliases or entire writing methods.
4. Merge principles into existing rules where possible instead of permanent extra
   prompt text. M4/M5 already require real outcomes; M6 covers root causes/class
   scans. Record source and incremental benefit; add instructions for measured gaps.
5. Compatibility overrides legacy-deletion principles. This branch promises the
   old path, so caller migration/deletion, temporary breakage for outcomes and
   broad first-principles redesign cannot override it.
6. Reversible is not authorized. From `never-block-on-the-human`, retain only
   continuing unblocked work within authority. Safety, spending, direction and
   permission decisions still wait for owner.
7. Never edit vendor files directly. Preserve source, pins and licenses; put
   excerpts, dependency removal and permission narrowing in versioned adapters.
   Label upstream source and AI.Team adaptation revision, not an edited original.

## 7. Complete disposition index

**A:** prioritize adaptation. **B:** review for a concrete task. **C:** extract a
method or merge into existing rules, without a new runtime entry. **D:** exclude
from this branch. A/B do not mean safe unchanged. Every name on a grouped row
receives that row's disposition.

### Matt: 39 skills

Paths relative to `skills/`.

| Path/skill | Decision | Recipient/reason |
|---|---|---|
| engineering/ask-matt | D | Second router; AI.Team has its own capability catalog |
| engineering/code-review | A | Check, requirements/conventions axes, no fan-out |
| engineering/codebase-design | B | Design worker, local modules/seams |
| engineering/diagnosing-bugs | A | Exec/debug, reuse current adaptation |
| engineering/domain-modeling | B | PM/design draft under ADR authority |
| engineering/grill-with-docs | B | PM clarification combining grilling/domain modeling; no alias duplication |
| engineering/implement-spec | D | Own graph dispatch/integration/publication process |
| engineering/implement | C | Implementation ordering only; no automatic commit/skill chain |
| engineering/improve-codebase-architecture | B | Dedicated bounded architecture audit; no fan-out or automatic refactor |
| engineering/pr | B | PM delivery prose, no automatic PR |
| engineering/prototype | B | Isolated bounded experiment, not direct production adoption |
| engineering/research | B | Research worker, no subdelegation |
| engineering/retro | A | Coach, batch evidence-backed retrospective |
| engineering/setup-matt-pocock-skills | D | Overlaps bootstrap/tracker configuration |
| engineering/tdd | A | Primary executor testing method |
| engineering/to-spec | A | PM, retain draft-only |
| engineering/to-tickets | A | PM, retain draft-only |
| engineering/triage | B | PM intake mapped to current lifecycle |
| engineering/wayfinder | C | Decision-dependency graph, not scheduling/branch process |
| engineering/wizard | B | Owner setup assistance; review templates separately |
| in-progress/chief-of-staff | D | Experimental orchestrator |
| in-progress/claude-handoff | D | Background takeover conflicts with recovery |
| in-progress/loop-me | C | Workflow clarification, not another loop specification |
| in-progress/setup-ts-deep-modules | B | Explicit TS architecture task; new tools separately approved |
| in-progress/software-factory | C | Architecture vocabulary, not runtime protocol |
| in-progress/writing-beats, writing-fragments, writing-shape | D | Content-writing experiments outside minimum engineering set |
| misc/git-guardrails-claude-code | B | Host safety integration research; hooks alone do not prove PM-only writes |
| misc/migrate-to-shoehorn | B | Specific TS fixture migration, not permanent dependency |
| misc/scaffold-exercises | D | Teaching exercises only |
| misc/setup-pre-commit | B | Explicit tooling task; no mandatory Husky/JS or overwritten hooks |
| productivity/grill-me | C | Grilling alias, no duplicate injection |
| productivity/grilling | B | PM owner-decision clarification |
| productivity/handoff | B | PM checkpoint summary, not state ledger |
| productivity/teach | B | Explicit explanation/teaching, not executor default |
| productivity/to-questionnaire | B | PM questions for external decision makers, no automatic send |
| productivity/wait-what | C | Communication restatement, not a separate engineering budget |
| productivity/writing-for-agents | B | Coach/method maintenance, on demand |

### Pstack: 58 main skills plus three Benny skills

The next two tables use paths under `pstack/skills/`.

| Non-principle skill | Decision | Recipient/reason |
|---|---|---|
| architect | A | Retain reviewed design excerpts |
| arena | D | Multi-candidate/model orchestration, not worker work |
| automate-me | B | Owner-requested custom method, reviewed maintenance task |
| benchmark-checklist | A | Measurement check/Auditor; no unapproved paid repetitions |
| blast-radius | A | Independent impact verification |
| bro | C | Concise expression, no separate entry |
| correct | B | Coach proposal, separately authorized structural repair |
| create-formal-verification-skill | B | High-risk control-plane verification generation |
| create-verification-skill | A | Project setup/acceptance gap; actually run generated recipe |
| figure-it-out | C | Bounded experimentation/planning, not PM/engine replacement |
| how | B | Code understanding without model selection/fan-out |
| in-your-own-words | C | PM clarification with a short prompt |
| interrogate | B | Separate adversarial check, not automatic arena |
| ketchup-video | D | Video delivery outside minimum engineering set |
| ketchup | B | PM owner-facing status/decisions |
| maintain-formal-verification-skill | B | Dedicated maintenance; do not weaken invariants |
| maintain-verification-skill | B | Recipe/map maintenance without fan-out/automatic PR |
| make-bot-ui | D | Grok Bot/webhook/Tailscale-specific deployment expansion |
| no-comments | C | Project lint/conventions first; no Comment Sicko subagent |
| poteto-help | D | Pstack product help, not team capability |
| poteto-mode | D | No whole orchestrator; adapt selected playbooks separately |
| recall | B | Scoped PM recovery summary, no cross-chat scan/fan-out |
| reflect | B | Local Coach method without three subagents/automatic skill edits |
| setup-pstack | D | No roster/global always-applied-rule replacement |
| sharpen | B | PM clarification without scope growth |
| show-me-your-work | C | Evidence mapped to existing ledger, no second authority |
| statechart | B | Formal-model diagnosis; review tools/dependencies/bounds |
| swarm | D | Second concurrency controller |
| tdd | B | Lightweight regression alternative, not simultaneous with Matt |
| teach | B | Owner explanation; no nested how/why orchestration |
| technical-writing | B | Document worker/PM; project style wins |
| typescript-best-practices | B | TS only, reviewed closure |
| unslop | B | User-facing prose without weakening evidence/risk statements |
| why | B | History investigation; authorized external reads, no fan-out |

| Principle (prefix every name with `principle-`) | Decision | Recipient/limit |
|---|---|---|
| attack-the-premise | B | Exec checks failed assumptions, no retry extension |
| boundary-discipline | B | Compiler/interface design, retain dynamic safety checks |
| build-the-lever | B | Proportionate repeatable edits/evidence tools, not a framework |
| encode-lessons-in-structure | C | Merge with Coach/M6, retain necessary authority rules |
| exhaust-the-design-space | B | Owner-approved novel design trials, bounded candidates/cost |
| experience-first | C | Existing M5; worker does not decide product direction |
| explain-the-number | A | Measurement/eval evidence |
| fix-root-causes | C | Deduplicate with diagnosis/M6 |
| foundational-thinking | B | Design worker; do not inflate small tasks into infrastructure |
| guard-the-context-window | C | Existing context controls; no worker delegation |
| laziness-protocol | C | Simplification heuristic, no unrelated deletions |
| make-operations-idempotent | B | Generation, recovery, budget/report settlement |
| migrate-callers-then-delete-legacy-apis | D | Old API/mode must remain |
| minimize-reader-load | B | Maintainability; a wrapper alone is not a defect |
| model-the-domain | B | State machines/core data structures |
| never-block-on-the-human | C | Authorized unblocked work only; owner gates retained |
| outcome-oriented-execution | D | No breaking compatibility to achieve an outcome |
| prove-it-works | C | Existing M4/M5; incremental evidence, not duplicate full text |
| redesign-from-first-principles | B | Explicit design task, not default redesign |
| separate-before-serializing-shared-state | B | Future concurrency/recovery; PM single-writer log retained |
| sequence-verifiable-units | C | Map small-step acceptance to existing process; no auto rebase/commit |
| subtract-before-you-add | C | Deduplication, not old-mode/safety removal |
| test-behavior-not-implementation | B | Exec/check test quality, deduplicate with TDD |
| type-system-discipline | B | Typed code/protocols, not language-migration authority |

Under `pstack/automations/benny/skills/`, `setup-benny`, `triage-issue-reports` and
`reproduce-and-fix-issues` are all **D**. They depend on Benny Slack/automation/control
configuration and external labels/issues/PR effects, not direct general-worker
injection. Future event intake needs a separate integration design.

## 8. Adaptation and update requirements

1. Preserve the five existing routes and `brief(role, task)` output. New mode entry
   consumes reviewed method IDs, not worker added to every old role allowlist.
2. Record source commit/file hashes, adapter version, dependencies, triggers and
   exclusions, allowed duty, environment/tools, output evidence, size and tests.
   Catalog metadata grants no permission.
3. Render reviewed implicit dependencies ahead of time, or explicitly remove them
   and explain the replacement. No dangling arena/why instructions; no whole-pack
   injection when only a few references are needed.
4. Freeze source pin, adapter, catalog and final brief digest per dispatch.
   Upstream changes do not affect in-flight work. Version changes at takeover/retest
   require revalidation with candidate/policy, not silent substitution.
5. Keep upstream checks read-only, with PM diff review/tests/commit. New methods do
   not enter old deployments automatically; upgrade instances explicitly and allow
   old pins. Inspect actual rendered dependencies, not only SKILL.md.
6. Test duty/trigger positives/negatives, bad hashes, missing dependencies, context
   overflow, missing permission, uncertain output and legacy compatibility.
   Human review handles semantic conflicts; keyword scanning is not security proof.
7. Compare base brief against one added method with fixed model/candidate/budget/
   oracle. Judge behavior/artifacts, not a model's claim of compliance. Include
   failed runs and dependency calls in cost.
8. Execute generated acceptance recipes at least once. Model/formal verification
   needs a deliberately broken version it catches and a correct control. Passing
   tests cover only the samples and stated bounds.

## 9. Next delivery boundary

This document supports selection decisions. Confirm a minimum set, then implement
adapters/catalog entries and negative tests for the first group. Generate project
verification recipes as separate scoped/budgeted tasks, not acceptance for every
possible product. Formal verification, concurrent research and automation
integration are not first-release dependencies.

The original Nov 6 assessment only added this selection document: no plugin install,
upstream script execution, pin/renderer/design-policy change, model trial, commit
or push occurred in that assessment step. Later implementation/PR activity is
recorded in [implementation status](implementation-status.md).
