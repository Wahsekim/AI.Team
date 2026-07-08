export const meta = {
  name: 'run-n-rounds',
  description: 'Mechanical autonomous-loop engine for owner count directives ("run N rounds"). Hard for-loop count bound (kills the PM premature-halt / author-identity-trap failure class for the count dimension) + Q5 token-burnout gate + per-iter worker dispatch with schema + verifier gate before Done + a guardian (chaos-role) verify node auditing for runaway. By DESIGN it does NOT do: tracker/MCP sync (banned in-loop), audit-file writes (serial-PM-only), same-session fix-retest (no SendMessage), or observe Q3 hardware / Q4 owner-input halts (no IO in a workflow body). Those stay with the main-session PM, who pre-scopes the plan while attended and reconciles after the run. Contract doc: docs/engine.md.',
  phases: [
    { title: 'Plan check', detail: 'validate the pre-scoped iteration plan passed via args' },
    { title: 'Loop', detail: 'serial per-iter worker dispatch + verifier gate, bounded by count N and the Q5 budget gate' },
    { title: 'Guardian', detail: 'chaos-role guardian audits the run for runaway / missed-halt / budget-gate correctness / dropped fix-retest' },
  ],
}

// Model/agentType values: worker/verifier/guardian agentType MUST be the project-scoped wrapper
// names and models per agents/roster.md (the single source) — pass them via args/plan. The
// 'general-purpose' fallbacks below are ONLY valid in a deployment running documented inline mode
// (.claude/agents/INLINE_BASE_AGENT_MODE.md) with the persona inlined into the brief.
//
// Test/verify commands: the default verifier brief points at profiles/stack.md verification
// commands — the engine carries NO stack-specific command text.
//
// NO CLOCK IN-LOOP: Date.now() / new Date() are UNAVAILABLE in workflow script bodies. Anything
// date- or sequence-dependent MUST arrive via args: `args.date` ('YYYY-MM-DD' for the
// messages/<date>.md block) and `args.nextLifecycleNumber` (the starting '## [NNN]' entry number
// for agents/lifecycle.md — the workflow cannot read lifecycle.md to count entries). Both are
// REQUIRED; the script throws a clear error at Plan check if either is missing.
//
// ---- args contract (pre-scoped by the main-session PM while ATTENDED, because tracker/MCP is banned in-loop) ----
// args = {
//   rounds: number,                       // owner count directive N -> hard for-loop bound (N is a CEILING, not a quota)
//   date: string,                         // REQUIRED — 'YYYY-MM-DD' for the messages/<date>.md log block (no clock in-loop)
//   nextLifecycleNumber: number,          // REQUIRED — starting agents/lifecycle.md entry number for '## [NNN]' blocks
//   budgetCeilingTokens?: number,         // pre-declared worker ceiling; Q5 halt at 80% (launch-spend-relative via spent0 baseline).
//                                         // First loop (no observed-per-round history): sum of per-iter tier estimates
//                                         // (worker + verifier) x 1.3 — docs/engine.md. If omitted, the engine falls back to
//                                         // the harness session budget.total and LOGS A WARNING — declare explicitly.
//   plan: [{
//     ticket: string,
//     agentType: string,                  // wrapper name per agents/roster.md (single source)
//     model?: string,                     // per agents/roster.md (single source)
//     brief: string,                      // the full worker brief (built from agents/templates.md by the PM before the run)
//     isCodeShipping?: boolean,           // worker writes product source -> verifier gate fires
//     verifierBrief?: string,             // verifier brief WITH stack env/prefix lines re-pasted verbatim (see _shared/verify-discipline.md)
//     verifierAgentType?: string, verifierModel?: string    // per agents/roster.md
//   }],
//   guardianAgentType?: string, guardianModel?: string      // per agents/roster.md
// }

// Boundary defense: args may arrive as a parsed object OR as a JSON string depending on the caller.
const A = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const rounds = A.rounds || 0
const plan = Array.isArray(A.plan) ? A.plan : []
const ceiling = A.budgetCeilingTokens || budget.total || null
// spent0 baseline (source-project DOA bug fix): budget.spent() is TURN-CUMULATIVE — it includes
// PRE-EXISTING session spend, so gating on the raw value can kill the loop at iteration 0 before
// any worker runs. Capture the baseline at script start and measure only LOOP-attributable spend
// (budget.spent() - spent0) against the ceiling.
const spent0 = budget.spent()
const spentInLoop = () => budget.spent() - spent0

phase('Plan check')
if (!A.date || typeof A.date !== 'string') {
  throw new Error('run-n-rounds: args.date (string, YYYY-MM-DD) is REQUIRED — Date.now()/new Date() are unavailable in workflow scripts, so the caller must pass the date for the messages/<date>.md log block.')
}
if (typeof A.nextLifecycleNumber !== 'number' || !isFinite(A.nextLifecycleNumber)) {
  throw new Error('run-n-rounds: args.nextLifecycleNumber (number) is REQUIRED — the starting "## [NNN]" entry number for agents/lifecycle.md; the workflow cannot read lifecycle.md to count existing entries.')
}
if (!rounds || plan.length === 0) {
  return {
    error: 'run-n-rounds needs args.rounds (count N) AND a non-empty args.plan. The workflow CANNOT read the tracker/MCP in-loop — the main-session PM must pre-scope the N-iter plan while attended, then invoke with {scriptPath, args}.',
    rounds, planLength: plan.length,
    dispatchedCount: 0,   // DOA surface: keeps the documented `dispatchedCount === 0` check true on malformed invocations too
  }
}
const iters = Math.min(rounds, plan.length)
if (!A.budgetCeilingTokens && ceiling) {
  log(`WARNING: budgetCeilingTokens not declared — Q5 gate falling back to harness budget.total (${ceiling}). Declare an explicit ceiling per docs/engine.md (first loop: sum of per-iter tier estimates x 1.3).`)
}
log(`run-n-rounds: N=${rounds}, plan=${plan.length} iters -> running ${iters}; ceiling=${ceiling ?? 'none'}; spent0 baseline=${spent0}`)

const WORKER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'progress', 'filesTouched', 'decisionsCount', 'selfReportTokens', 'blocked'],
  properties: {
    outcome: { type: 'string', description: 'one-phrase close outcome (-> lifecycle Outcome field)' },
    progress: { type: 'boolean', description: '>=1 of {written artifact, ticket transition, recorded decision} produced (harness mandatory-progress rule)' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    decisionsCount: { type: 'integer' },
    selfReportTokens: { type: 'integer', description: 'worker token self-estimate (meta-rule M4: distrust — the engine records harness spend deltas per spawn; guardian cross-checks)' },
    blocked: { type: 'boolean', description: 'this TICKET is blocked (recoverable) — does NOT stop the loop' },
    terminalStop: { type: 'boolean', description: 'this WHOLE LOOP must stop now (terminal signal the engine can break on deterministically). Distinct from blocked. Only catches stops a worker can surface; pure out-of-band owner-input Q4 still needs the main-session batch discipline.' },
    notes: { type: 'string' },
  },
}
const VERIFIER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pass', 'staticPass', 'e2ePass', 'summary', 'commandsRun'],
  properties: {
    pass: { type: 'boolean', description: 'overall PASS -> ticket may go Done; FALSE -> same-session fix-retest needed (main session). ENFORCED: effective pass also requires staticPass=true AND e2ePass=true — a pass=true with either false is rejected as inconsistent (fail-closed).' },
    staticPass: { type: 'boolean', description: 'static/test-suite gate per profiles/stack.md; if n/a for this ticket return true with a note. ENFORCED (see pass).' },
    e2ePass: { type: 'boolean', description: 'end-to-end gate per profiles/stack.md verification commands; if n/a return true with a note. ENFORCED (see pass).' },
    commandsRun: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['command', 'exitCode'],
        properties: {
          command: { type: 'string', description: 'the exact (env-prefixed, if the stack requires it) command actually executed' },
          exitCode: { type: 'integer', description: 'the REAL process exit code observed' },
        },
      },
      description: 'executable-oracle grounding: every test command ACTUALLY run, with its real exit code. The engine REJECTS a pass=true verdict whose commandsRun is empty or contains any nonzero exitCode (fail-closed -> fixRetestQueue). Residual risk: content is still verifier-reported — see docs/engine.md.',
    },
    failures: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}
const GUARDIAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['runawayDetected', 'missedHaltRisk', 'budgetGateCorrect', 'droppedFixRetest', 'verdict', 'findings', 'newPatternCandidates'],
  properties: {
    runawayDetected: { type: 'boolean', description: 'loop ran PAST a should-halt condition (repeated identical failures, ship-broken-N-times, no-progress pile-up)' },
    missedHaltRisk: { type: 'boolean', description: 'a legitimate Q3/Q4 halt may have been needed but the mechanical loop is blind to it — main session must have watched' },
    budgetGateCorrect: { type: 'boolean', description: 'Q5 token-burnout gate behaved correctly vs the spent trace + ceiling (a vacuous ceiling is a finding)' },
    droppedFixRetest: { type: 'boolean', description: 'any verifier-FAIL items at risk of being silently dropped instead of handed to main-session fix-retest' },
    verdict: { type: 'string', enum: ['clean', 'main-session-action-required', 'halt-and-investigate'] },
    findings: { type: 'array', items: { type: 'string' } },
    newPatternCandidates: { type: 'array', items: { type: 'string' }, description: 'workflow-specific failure patterns for the chaos-role pattern catalog' },
  },
}

phase('Loop')
const results = []
const spentTrace = []            // per-iter cumulative LOOP-attributable spend (baseline spent0 already subtracted)
const lifecycleEntries = []      // preformatted numbered entry lines for agents/lifecycle.md (main session pastes verbatim)
const msgBullets = []            // one bullet per round for the messages/<date>.md block
const NNN = n => String(n).padStart(3, '0')
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140)
const emitLogs = (r, verdict) => {
  const entryNo = NNN(A.nextLifecycleNumber + lifecycleEntries.length)
  const w = r.worker || {}
  const summary = oneLine(w.outcome || w.notes || '(no outcome reported)')
  // Per-spawn attribution: worker and verifier spend are SEPARATE harness deltas (never fused,
  // never aggregate/N) so lifecycle entries + coaching KPIs keep the per-spawn variance signal.
  const tok = `~${r.workerTokens} tok worker` + (r.verifier ? ` / ~${r.verifierTokens} tok verifier` : '')
  lifecycleEntries.push(`## [${entryNo}] ${r.agentType || 'worker'} ${r.ticket} — ${verdict}, ${tok}, ${summary}`)
  msgBullets.push(`- [${entryNo}] iter${r.iter} ${r.ticket} (${r.agentType || 'worker'}): ${verdict} — ${summary}`)
}
let haltReason = null
for (let i = 0; i < iters; i++) {
  const p = plan[i]
  // Q5 token-burnout — the ONLY halt the script body can observe.
  // Q3 (hardware) and Q4 (owner mid-loop input) are invisible here BY DESIGN (no IO/clock in a
  // workflow body) -> the main session owns them.
  // Gate on LOOP-attributable spend (budget.spent() - spent0), NOT raw budget.spent() — DOA fix.
  // Granularity: checked BEFORE each dispatch only — one oversized iteration can overshoot the
  // ceiling before the next check; the guardian audits budgetGateCorrect post-hoc (docs/engine.md).
  if (ceiling && spentInLoop() >= 0.8 * ceiling) {
    haltReason = `token-burnout Q5: loop-spent ${spentInLoop()} (session baseline ${spent0} excluded) >= 80% of ${ceiling}`
    log(`HALT — ${haltReason}`)
    break
  }
  let worker = null
  const preWorker = spentInLoop()
  try {
    worker = await agent(p.brief, {
      agentType: p.agentType, model: p.model,
      label: `iter${i + 1}:${p.ticket}:${p.agentType || 'worker'}`, phase: 'Loop', schema: WORKER_SCHEMA,
    })
  } catch (e) {
    haltReason = `agent() threw at iter ${i + 1} (likely harness budget exhausted): ${String(e).slice(0, 200)}`
    log(`HALT — ${haltReason}`)
    break
  }
  const workerTokens = spentInLoop() - preWorker
  // Deterministic terminal-stop: if a worker structurally signals the WHOLE loop must stop
  // (not just a blocked ticket), break here instead of relying on a human-readable note the loop
  // never parses. This only catches stops a worker can SURFACE; pure out-of-band owner input (Q4)
  // still needs the main-session batch discipline.
  if (worker && worker.terminalStop) {
    spentTrace.push(spentInLoop())
    const r = { iter: i + 1, ticket: p.ticket, agentType: p.agentType, worker, verifier: null, verifierPass: null, verifierGroundingFailure: null, needsFixRetest: false, progress: worker.progress, workerTokens, verifierTokens: 0 }
    results.push(r)
    emitLogs(r, 'TERMINAL-STOP')
    haltReason = `terminal-stop at iter ${i + 1}: ${(worker.notes || worker.outcome || '').slice(0, 120)}`
    log(`HALT — ${haltReason}`)
    break
  }
  let verifier = null
  const preVerifier = spentInLoop()
  if (p.isCodeShipping && worker) {
    try {
      verifier = await agent(
        p.verifierBrief || `Verify ticket ${p.ticket} against its acceptance criteria. Run the code-shipping verification commands from profiles/stack.md (static suite + e2e gate where configured; gates whose surfaces do not exist on this ticket are N/A — say so with a note), following _shared/verify-discipline.md (clean state, env prefix verbatim if the stack defines one, real exit codes). You MUST actually EXECUTE the verification commands — do not infer results from reading code. Report EVERY command you ran with its REAL exit code in the commandsRun field; set staticPass and e2ePass honestly (true-with-note when n/a); the engine rejects any pass verdict with an empty commandsRun, a nonzero exitCode, or staticPass/e2ePass=false.`,
        { agentType: p.verifierAgentType || 'general-purpose', model: p.verifierModel, label: `iter${i + 1}:verifier:${p.ticket}`, phase: 'Loop', schema: VERIFIER_SCHEMA },
      )
    } catch (e) {
      verifier = null
      log(`iter ${i + 1} ${p.ticket}: verifier gate agent() FAILED (${String(e).slice(0, 160)}) — fail-closed, routing to fixRetestQueue`)
    }
  }
  const verifierTokens = spentInLoop() - preVerifier
  // Executable-oracle grounding (fail-closed): a pass=true verdict must be backed by commands that
  // really ran, ALL with exit code 0, AND consistent sub-gates (staticPass/e2ePass true — true-with-note
  // when n/a). Missing/empty commandsRun, any nonzero exitCode, or a false sub-gate -> FAIL -> fixRetestQueue.
  let verifierGroundingFailure = null
  if (verifier && verifier.pass === true) {
    const cmds = Array.isArray(verifier.commandsRun) ? verifier.commandsRun : []
    if (cmds.length === 0) {
      verifierGroundingFailure = 'pass=true with missing/empty commandsRun — ungrounded verdict rejected'
    } else {
      const bad = cmds.filter(c => !c || typeof c.exitCode !== 'number' || c.exitCode !== 0)
      if (bad.length > 0) {
        verifierGroundingFailure = `pass=true but nonzero/invalid exitCode: ${bad.map(c => `${oneLine((c && c.command) || '?').slice(0, 80)} -> ${c ? c.exitCode : '?'}`).join('; ')}`
      }
    }
    if (!verifierGroundingFailure && (verifier.staticPass === false || verifier.e2ePass === false)) {
      verifierGroundingFailure = `pass=true but ${verifier.staticPass === false ? 'staticPass=false' : ''}${verifier.staticPass === false && verifier.e2ePass === false ? ' + ' : ''}${verifier.e2ePass === false ? 'e2ePass=false' : ''} — inconsistent verdict rejected`
    }
    if (verifierGroundingFailure) log(`iter ${i + 1} ${p.ticket}: verifier GROUNDING FAIL — ${verifierGroundingFailure}`)
  }
  const verifierEffectivePass = verifier ? (verifier.pass === true && !verifierGroundingFailure) : null
  spentTrace.push(spentInLoop())
  const r = {
    iter: i + 1, ticket: p.ticket, agentType: p.agentType,
    worker, verifier,
    workerTokens, verifierTokens,   // SEPARATE per-spawn harness deltas (per-spawn attribution rule)
    verifierPass: verifierEffectivePass,
    verifierGroundingFailure,
    // Same-session fix-retest CANNOT run in-workflow (no SendMessage) -> hand to main session.
    // FAIL-CLOSED: a code-shipping iter whose verifier gate returned no verdict (threw /
    // unresolvable agentType) must NOT pass silently — queue it for main-session verify.
    // Grounding failures (ungrounded/inconsistent pass) are ALSO fail-closed via verifierEffectivePass === false.
    needsFixRetest: !!(verifier && verifierEffectivePass === false) || !!(p.isCodeShipping && worker && !verifier),
    progress: worker ? worker.progress : false,
  }
  results.push(r)
  const verdict = !p.isCodeShipping ? 'no verifier gate (non-code-shipping)'
    : !verifier ? 'verifier gate MISSING -> fail-closed fix-retest'
    : verifierGroundingFailure ? 'verifier FAIL (ungrounded/inconsistent pass rejected) -> fix-retest'
    : verifierEffectivePass ? 'verifier PASS'
    : 'verifier FAIL -> fix-retest'
  emitLogs(r, verdict)
}
if (!haltReason && iters < rounds) haltReason = `board-exhausted: plan had ${plan.length} iters < N=${rounds}; grooming needs the tracker -> main session re-invokes for the rest`
if (!haltReason) haltReason = 'count-complete'

phase('Guardian')
const runSummary = results.map(r => {
  const w = r.worker || {}
  return `iter${r.iter} ${r.ticket} [${r.agentType}] progress=${r.progress} blocked=${w.blocked} verifierPass=${r.verifierPass} needsFixRetest=${r.needsFixRetest} workerTokens=${r.workerTokens} verifierTokens=${r.verifierTokens} notes="${(w.notes || '').slice(0, 200)}"`
}).join('\n')
const guardianBrief = `You are the chaos-role Guardian (see agents/chaos.md), auditing a WORKFLOW-DRIVEN "run N rounds" loop (the mechanical engine).

POLARITY FLIP: a mechanical for-loop structurally CANNOT premature-halt on judgement, so the PM premature-halt failure class is dead for the count dimension. Your job is the OPPOSITE failure mode — RUNAWAY / failure-to-halt — plus verifying the mechanical gates and the workflow<->main-session boundary.

Loop config: N=${rounds}, iters actually run=${results.length}, declared haltReason="${haltReason}", token ceiling=${ceiling ?? 'none'}, loop-spend trace (baseline-relative: budget.spent() minus pre-existing session spend ${spent0})=${JSON.stringify(spentTrace)}.

Per-iter outcomes:
${runSummary || '(none)'}

Audit for:
1. RUNAWAY — did the loop keep dispatching past a point where it SHOULD have stopped? (same ticket failing the verifier every iter = ship-broken-N-times; no-progress iters piling up; identical failure repeated.)
2. MISSED-HALT RISK — the script body is BLIND to Q3 (hardware) and Q4 (owner mid-loop input). Flag whether the main session must be confirmed to have watched for these around this run.
3. BUDGET GATE — did the Q5 token-burnout gate behave correctly given the spent trace and ceiling? A vacuous ceiling (spend far below it at count-complete) is a finding.
4. DROPPED FIX-RETEST — any verifier-FAIL (needsFixRetest=true) at risk of being silently dropped instead of handed to main-session same-session fix-retest?
5. NEW PATTERNS — propose workflow-specific failure patterns for the chaos-role pattern catalog.

Reasoning audit only — no product work, no MCP, no git. Return the structured verdict object only.`

const guardianTokensPre = spentInLoop()
const guardian = await agent(guardianBrief, {
  agentType: A.guardianAgentType || 'general-purpose',
  model: A.guardianModel,          // per agents/roster.md (single source) — pass explicitly
  label: 'chaos:guardian', phase: 'Guardian', schema: GUARDIAN_SCHEMA,
})
const guardianTokens = spentInLoop() - guardianTokensPre

// Separate "dispatched N/N" from "passed N/N" so a count-complete haltReason can never mask a
// terminal verifier-fail; expose the fix-retest drain queue as a first-class field.
const fixRetestQueue = results.filter(r => r.needsFixRetest)
// Guardian verdict gets its OWN numbered lifecycle entry (emitted here so the PM never hand-derives it).
const guardianEntryNo = NNN(A.nextLifecycleNumber + lifecycleEntries.length)
lifecycleEntries.push(`## [${guardianEntryNo}] guardian (chaos) — verdict: ${guardian && guardian.verdict}, runaway=${guardian && guardian.runawayDetected}, missedHalt=${guardian && guardian.missedHaltRisk}, budgetGate=${guardian && guardian.budgetGateCorrect}, droppedFixRetest=${guardian && guardian.droppedFixRetest}, ~${guardianTokens} tok`)
// Paste-ready block: BATCH header + entries + guardian line, per agents/lifecycle.md engine-mode format.
const lifecycleBlock = [
  `### BATCH ${A.date} — run-n-rounds N=${rounds}, dispatched ${results.length}, halt: ${haltReason}`,
  ...lifecycleEntries,
]
const messagesLogBlock = [
  `## ${A.date} — run-n-rounds batch (N=${rounds}, dispatched ${results.length}, halt: ${haltReason})`,
  '',
  ...(msgBullets.length > 0 ? msgBullets : ['- (no iterations ran)']),
  `- Halt reason: ${haltReason}; fixRetestQueue=${fixRetestQueue.length}; guardian verdict=${guardian && guardian.verdict}`,
].join('\n')
return {
  rounds,
  dispatchedCount: results.length,                                        // structural: how many iters ran (0 => DOA — check budget/ceiling semantics, docs/engine.md)
  passedCount: results.filter(r => r.verifierPass !== false).length,      // clean (verifierPass true) + no-gate (null)
  verifierGatedCount: results.filter(r => r.verifierPass !== null).length,
  verifierPassedCount: results.filter(r => r.verifierPass === true).length,
  allPassed: fixRetestQueue.length === 0,                                 // DISTINCT from count-complete — read THIS for batch quality
  itersRun: results.length, haltReason,
  needsGrooming: iters < rounds, remainingRounds: rounds - results.length,
  results,                                                                // each result carries workerTokens + verifierTokens (separate harness deltas)
  fixRetestQueue,                                                         // MANDATORY drain — main session must fix-retest each before close
  guardian,
  guardianTokens,
  mainSessionTodo: {
    pasteInstruction: `Paste mainSessionTodo.lifecycleEntries VERBATIM (in order — it begins with the "### BATCH" header, then numbered entries starting at [${NNN(A.nextLifecycleNumber)}] per args.nextLifecycleNumber, and ends with the guardian verdict entry) into agents/lifecycle.md, and paste mainSessionTodo.messagesLogBlock VERBATIM into messages/${A.date}.md. Do NOT reword — these are the preformatted audit blocks (workflow cannot write audit files itself; audit writes are serial-PM-only). Manual re-derivation of these entries is BANNED (docs/engine.md reconciliation rule).`,
    lifecycleEntries: lifecycleBlock,
    messagesLogBlock,
    checklist: [
      'Paste the preformatted lifecycleEntries (### BATCH header + entries + guardian entry) + messagesLogBlock per pasteInstruction; still reconstruct one pm-decisions.md dispatch+close line per iter from results[] using workerTokens/verifierTokens (workflow cannot write audit files — serial-PM-only).',
      'Do ALL tracker transitions now, attended (workflow is banned from tracker/MCP in-loop).',
      'Handle every fixRetestQueue item per the engine fix-retest drain rule (docs/engine.md): same-session continuation if the harness exposes the workflow-spawned session; otherwise a fresh scoped fix spawn inlining the verifier failure report, logged `Session: resumed-fresh`.',
      'Confirm you watched Q3 (hardware) + Q4 (owner input) during the run — the workflow could not.',
      'If guardian.verdict != "clean", act on guardian.findings before the next invocation.',
      'If needsGrooming, groom remaining tickets (tracker) then re-invoke run-n-rounds with remainingRounds + a fresh plan (and an updated nextLifecycleNumber).',
      'DRAIN fixRetestQueue: `haltReason: count-complete` means all N DISPATCHED, NOT all passed. Read `allPassed` + `fixRetestQueue` — every queued item MUST be fix-retested (or PM-direct-verified) BEFORE the batch is declared closed (count-complete must never mask not-done).',
    ],
  },
}
