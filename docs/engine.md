# Count-Directed Loop Engine (`run-n-rounds`)

Contract doc for `.claude/workflows/run-n-rounds.js` — the mechanical executor
for owner count directives ("run N rounds"). Ported from the source project,
where the maintainer used it across multi-batch loops (maintainer experience,
not independently published evidence); its deterministic behavior is verified
by the shipped fault-injection suite (`node --test tests/*.test.mjs`).

## Why an engine

A PM asked to run N rounds is structurally tempted to judgement-halt early
("diminishing returns", a worker's HALT verdict, "codebase looks solid") — the
author-identity trap: the PM authored the dispatches, so she feels she owns the
count. She does not; the count is the owner's boundary. Encoding the count as a
literal `for (i < N)` makes it a runtime fact the PM cannot re-frame. The
inverse risk appears instead — runaway / failure-to-halt — which the engine's
guardian node audits.

## When to use the engine vs single dispatches

| Situation | Use |
|---|---|
| One ticket, one worker | plain dispatch per `agents/pm.md` cycle |
| Owner count directive, PM hand-runs each cycle | hand-run loop under the charter halt rules (Q-gate at every cycle close) |
| Owner count directive, N >= ~3, plan can be pre-scoped attended | the engine |
| Work requiring tracker/MCP mid-loop, or same-session continuations mid-loop | NOT the engine — those are main-session carve-outs |

Precondition: the plan's `agentType` values are the project wrapper names from
`agents/roster.md`. If the deployment runs documented inline mode instead
(`.claude/agents/INLINE_BASE_AGENT_MODE.md`), `general-purpose` + inlined
persona is the sanctioned fallback — never an undocumented default.

## What the engine owns

- hard `for (i < N)` count bound — N is a **ceiling, not a quota**; board
  exhaustion is a legitimate stop, make-work to reach N is a violation;
- Q5 token-burnout gate: halt at 80% of the pre-declared per-invocation
  ceiling, measured **launch-spend-relative** (a `spent0` baseline captured at
  script start — `budget.spent()` is turn-cumulative, so gating on the raw
  value can kill the loop at iteration 0 before any worker runs).
  **Granularity:** the gate is checked before each dispatch only; one oversized
  iteration can overshoot the ceiling before the next check — the guardian
  audits `budgetGateCorrect` post-hoc;
- per-iter worker dispatch with a validated schema return, including a
  `terminalStop` field that deterministically breaks the whole loop;
- verifier gate (QA role) as an unconditional code path for code-shipping
  iters, **fail-closed** three ways: a missing/thrown verifier verdict on a
  code-shipping iter routes to `fixRetestQueue`; a `pass=true` verdict is
  REJECTED unless `commandsRun` lists actually-executed commands, all with exit
  code 0 (executable-oracle grounding — no pass by code-reading); and a
  `pass=true` with `staticPass=false` or `e2ePass=false` is rejected as an
  inconsistent verdict (sub-gates are enforced; verifiers return
  true-with-note when a sub-gate is n/a for the ticket);
- **per-spawn token attribution**: the engine records SEPARATE harness spend
  deltas for each worker (`results[i].workerTokens`), each verifier
  (`results[i].verifierTokens`), and the guardian (`guardianTokens`) — never a
  fused per-iter number, never aggregate/N;
- a guardian verify node (chaos role) auditing runaway / missed-halt risk /
  budget-gate correctness / dropped fix-retests;
- mechanical log emission: a paste-ready lifecycle block (`### BATCH` header +
  numbered entries + a numbered guardian-verdict entry) and a `messages/` log
  block, returned in `mainSessionTodo`.

## Honesty note on grounding

`commandsRun` grounding raises the bar substantially but the content is still
verifier-REPORTED: a hallucinating verifier defeats it. The guardian
cross-checks patterns and token deltas, not command transcripts. Treat the gate
as strong evidence, not proof; M4 distrust still applies.

## Main-session carve-outs (the engine MUST NOT do these)

1. **Tracker/MCP sync** — banned in-loop (hang risk is unbounded inside a
   workflow body); the PM pre-scopes the plan attended and batch-syncs after.
2. **Audit-file writes** — lifecycle / pm-decisions / lessons / memory are
   serial-PM-only; the engine only EMITS preformatted blocks.
3. **Fix-retest drain** — `agent()` is a cold spawn; see "Fix-retest drain
   rule" below.
4. **Q3 (hardware) + Q4 (owner input) halt observation** — a workflow body has
   no IO or clock; the main session watches around the run, and the guardian
   flags `missedHaltRisk` unless that watch is attested.

## Fix-retest drain rule

Whether the main session can CONTINUE a session that a workflow spawned is a
harness capability that must be verified per deployment (chaos-gate it once).
The rule, in preference order:

1. If the harness exposes the workflow-spawned worker session — continue it
   with the verifier failure report verbatim (normal same-session fix-retest).
2. Otherwise (assume this until verified): a FRESH scoped fix spawn that
   inlines the verifier failure report + the worker's files-touched summary is
   the sanctioned path. Log `Session: resumed-fresh` in the lifecycle entry.
   This does NOT violate the PM's "never spawn fresh" anti-pattern — that rule
   applies only when continuation is actually available.

## Args contract

```js
{ rounds, plan, date, nextLifecycleNumber, executionMode, budgetCeilingTokens,
  failurePolicy?, runId? }
```

**Strict validation (fail-closed):** every field is validated BEFORE any
dispatch; any violation (including a malformed JSON args string) returns
`{errorCode: 'invalid-args', validationErrors: [...], dispatchedCount: 0}`
with zero agents run. `rounds` and `nextLifecycleNumber` must be positive
safe integers (`rounds` <= 300, plan <= 300 items); `date` must be a real
`YYYY-MM-DD` calendar date; briefs are size-capped (200k chars);
ticket/agentType are length-capped and reject control characters (they land
in lifecycle headers).

- `executionMode` (REQUIRED): `'wrappers'` — every agentType (worker,
  verifier, guardian) must be an explicit roster wrapper name;
  `'general-purpose'` anywhere is a validation error. `'inline'` — the
  documented INLINE_BASE_AGENT_MODE fallback; generic types allowed with the
  persona inlined in the brief. There is NO silent fallback between modes.
- `budgetCeilingTokens` (REQUIRED): a run without a declared Q5 ceiling is an
  invalid invocation — the old silent `budget.total` fallback is gone.
- `failurePolicy` (default `'halt-on-failure'`): the loop STOPS after any
  iteration that needs recovery (unknown side effects, failed/missing
  verification, blocked/no-progress worker) — later workers never build on an
  unattested workspace. `'continue'` is legal ONLY for plans the caller
  asserts are per-ticket isolated and dependency-free.

- `date` (YYYY-MM-DD) and `nextLifecycleNumber` are REQUIRED — the workflow
  body has no clock and cannot read `agents/lifecycle.md` to count entries.
- `runId` (optional, `[A-Za-z0-9._-]{1,64}`) — reconciliation idempotency
  key; derived as `run-<date>-<NNN>` when omitted. It appears in the
  `### BATCH` header so a re-run can be detected before pasting twice.
- `plan[]` items: `{ticket, agentType, model, brief, isCodeShipping,
  verifierBrief, verifierAgentType, verifierModel}`. Models/agentTypes come
  from `agents/roster.md` (single source); briefs are built from
  `agents/templates.md` before the run; verifier briefs re-paste the stack's
  env/command discipline verbatim (`_shared/verify-discipline.md`).
  `isCodeShipping` is a REQUIRED EXPLICIT boolean on every item —
  verification opt-out by omission is rejected at validation.
- `budgetCeilingTokens` — the Q5 ceiling. **Computable on every loop:**
  - **First loop (no history):** `sum of per-iter tier estimates
    (worker + verifier, from agents/pm.md Rules bands) x 1.3`.
  - **Subsequent loops:** `observed-per-round x N x 1.3` (observed-per-round =
    mean per-iter spend from the previous batch's `spentTrace` deltas).
  - If omitted, the engine falls back to the harness session `budget.total`
    and logs a WARNING — that gates against a number nobody declared and
    produces guardian vacuous-ceiling findings; always declare explicitly.
  - This is a PER-INVOCATION gate — the PM tracks the cumulative cross-batch
    loop ceiling herself (charter budget/halt table). Conflating the two axes
    caused a false-halt in the source project.

## Return contract — how to read it

- **One truth derivation, no contradictions** (single source in the script):
  - `allPassed` — batch quality. STRICT conjunction: every worker
    `succeeded`/`terminal_stop` (a `blocked` or `no_progress` worker is NOT
    success), no unknown side effects, every required verification `passed`,
    both queues empty, guardian ran AND returned a consistent `clean`.
  - `nextInvocationBlocked` — true unless the guardian is clean AND both
    queues are empty. `allPassed=true` implies `nextInvocationBlocked=false`
    BY CONSTRUCTION — the two can never contradict.
  - `safeToContinue` — the one field automation may read alone: `allPassed`
    AND the run finished everything it was asked (`!runIncomplete`).
  **Never read `haltReason` for quality**: `count-complete` means all N
  DISPATCHED, not all passed.
- Per-iteration records carry three explicit state fields (no nullable
  booleans with dual meanings):
  - `workerStatus`: `succeeded | blocked | no_progress | null_result | error
    | terminal_stop` — `blocked`/`no_progress` route to `recoveryQueue`
    (dispatched ≠ effectively done); `null_result`/`error` mean the worker
    vanished/threw and its `sideEffects` are `unknown` (it may have
    half-changed files);
  - `verificationStatus`: `not_applicable | passed | failed | missing |
    blocked_by_worker_error` — a code-shipping iter counts ONLY on `passed`;
    `missing` (gate threw/null/budget-blocked) and `blocked_by_worker_error`
    are fail-closed into the queues;
  - `sideEffects`: `none_reported | known | unknown`.
  A code-shipping iteration that terminal-stops STILL gets its verifier gate
  before the loop breaks — `terminalStop` only stops FURTHER iterations.
- **Guardian consistency is enforced**: a `clean` verdict alongside any
  failure flag (`runawayDetected`, `missedHaltRisk`, `budgetGateCorrect:
  false`, `droppedFixRetest`) is demoted fail-closed to
  `main-session-action-required` with `guardianConsistencyFailure` set.
- `runIncomplete` (halted before finishing the planned iters) is distinct
  from `planShortfall`/`needsGrooming` (the plan was shorter than N) —
  early halts can never masquerade as a fully-run board.
- `budgetStatus` reports `{ceiling, loopSpent, overshootTokens}` — the Q5
  gate checks before worker AND verifier dispatches, but one oversized spawn
  can still overshoot; overshoot is visible, never silent. All engine
  outputs (haltReason, ledger lines, guardian data) pass through a
  sanitizer that strips newlines/header tokens and redacts common secret
  shapes.
- Counts are explicit: `workerSucceededCount`, `verificationRequiredCount`,
  `verificationPassedCount`, `recoveryRequiredCount` (there is no ambiguous
  `passedCount`).
- `dispatchedCount === 0` is the **DOA check**: the run died before any worker
  ran — invalid args (`errorCode: 'invalid-args'` + `validationErrors`),
  budget/ceiling semantics error, or malformed plan. Fix the invocation; do
  not count it as a loop.
- `results[i].workerTokens` / `results[i].verifierTokens` are the per-spawn
  harness figures for lifecycle attribution and coaching KPIs;
  `selfReportTokens` is the distrusted M4 self-report (dual-record >30%
  divergence).
- **Guardian is fail-closed**: if the guardian throws, is skipped, or returns
  null, the engine STILL returns the full recovery package (results, queues,
  paste-ready blocks) with `guardian.status: 'unavailable'`,
  `guardianError`, and `nextInvocationBlocked: true` — the run is UNAUDITED
  and can never be `allPassed`. `guardian.status: 'ok'` +
  `guardian.verdict != 'clean'` also blocks the next invocation until the PM
  acts on `guardian.findings`.
- `needsGrooming` / `remainingRounds`: the plan was shorter than N — groom
  attended, then re-invoke with a fresh plan and an updated
  `nextLifecycleNumber`.

## Reconciliation rule (atomic, idempotent per target)

After EVERY invocation, before anything else — before tracker sync, before the
cycle report, before pulling new work — the PM applies the run with the
shipped tool:

```bash
# save the engine return object to a file, then:
node scripts/reconcile-run.mjs <result.json> .
```

The tool checks the runId in EVERY target independently (a crash between
targets is repaired by re-running — a partial earlier write is detected and
only the missing targets are applied, never masked), appends the lifecycle
BATCH block and the messages block via atomic tmp+rename writes, and advances
the lifecycle `Next NNN to assign` counter to
`mainSessionTodo.nextLifecycleNumberAfter` (counter drift fix).

Manual fallback (tool unavailable): check that NO target already contains the
runId, paste `mainSessionTodo.lifecycleEntries` verbatim into
`agents/lifecycle.md` and `mainSessionTodo.messagesLogBlock` verbatim into
`messages/<date>.md`, then update the counter yourself. The emitted lifecycle
block already includes the `### BATCH` header (with the runId), the numbered
per-iter entries (with separate worker/verifier token figures), and the
numbered guardian entry — nothing in it is hand-derived.

**Manual re-derivation of these entries is BANNED** — re-derivation
reintroduces the transcription-drift failure class the emission exists to
prevent. The PM still: writes one `pm-decisions.md` dispatch+close line per
iter from `results[]` (using `workerTokens`/`verifierTokens`); dual-records
self-report vs harness divergence >30% (M4).

Then drain the checklist: tracker sync, fix-retest queue (per the drain rule
above), Q3/Q4 attestation, guardian findings.

## Keeping the engine honest

Before trusting a new or changed engine script in production, run the chaos
gate (see `agents/chaos.md`): the kit SHIPS the injected-failure suite —
`node --test tests/*.test.mjs` exercises the real script through a mock runtime
(`tests/workflow-harness.mjs`) covering invalid args, worker error/null,
terminal-stop verification, null/ungrounded/inconsistent verifier verdicts,
guardian failure, budget gating, and log-injection neutralization. Run it
after ANY engine edit; all tests must pass. Also verify once per deployment
whether workflow-spawned sessions are continuable (fix-retest drain rule).
