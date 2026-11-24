// One batch ticket, derived from the batch records (spec §2.3 and default 5).
// Pure: every input is already parsed; `run` is built by collect.mjs.
import { available, derived, counting, notApplicable, unavailable, hasValue } from './model.mjs'

const WORKER = {
  succeeded: 'done', running: 'running',
  blocked: 'blocked', terminal_stop: 'blocked',
  error: 'failed', invalid_worker_result: 'failed', no_progress: 'failed', null_result: 'failed',
}
const VERIFIER = { passed: 'done', failed: 'failed', running: 'running' }

const lastResult = (ret, id) => (ret?.results ?? []).filter(r => r.ticket === id).at(-1) ?? null

const journalOf = (settlement, id) => settlement?.ticketRecords?.find(r => r.ticketId === id)?.journal?.events ?? []

// Calls are keyed by agentId so a replayed settlement row is counted once.
function settledCalls(settlement, id, duty) {
  const byAgent = new Map()
  for (const call of settlement?.calls ?? []) if (call.ticket === id && call.duty === duty) byAgent.set(call.agentId, call)
  return [...byAgent.values()]
}

function statusOf({ result, afterTicket, committed, phase }) {
  if (committed) return 'committed'
  if (result?.verificationStatus === 'passed' || afterTicket?.status === 'passed') return 'accepted'
  if (WORKER[result?.workerStatus] === 'blocked') return 'blocked'
  if (result?.verificationStatus === 'failed' || WORKER[result?.workerStatus] === 'failed') return 'failed'
  if (result) return result.verificationStatus === 'running' ? 'checking' : 'running'
  return phase === 'open' ? 'unrecorded' : 'queued'
}

function tokensOf(calls, settled, source) {
  if (!settled) return counting(source, 'settlement not written yet')
  if (!calls.length) return unavailable('no settled call for this step', source)
  return available(calls.reduce((sum, c) => sum + c.tokens, 0), source)
}

function splitOf(calls, split) {
  if (!split) return unavailable('token split needs --transcripts <session-dir>')
  if (split.error) return unavailable(`measure-spawn could not read the transcripts: ${split.error}`)
  if (!calls.length) return unavailable('no settled call to look up')
  const rows = calls.map(c => split.rows.get(c.agentId))
  if (rows.some(r => !r)) return unavailable('agent transcript not found in --transcripts')
  const sum = key => rows.reduce((acc, r) => acc + r[key], 0)
  const models = [...new Set(rows.map(r => r.model).filter(Boolean))]
  return derived({ input: sum('input'), output: sum('output'), cacheCreate: sum('cacheCreate'), cacheRead: sum('cacheRead'), model: models.join(' + ') || null },
    'measure-spawn.mjs --json, by agentId of settlement.calls')
}

// Step start/end is not recorded (journal events carry no time); the write-boundary
// log gives tool-call times per wrapper inside the batch window.
function activityOf(log, wrapper, window) {
  const times = log.filter(l => l.agentType === wrapper && l.at >= window.from && l.at <= window.to).map(l => l.at).sort()
  const first = times[0] ?? null, last = times.at(-1) ?? null
  const source = '.claude/rw-write-boundary.log.jsonl (approx. from tool activity)'
  return {
    at: first ? derived(first, source) : unavailable('no tool call by this wrapper in the batch window'),
    elapsedMs: first && last > first ? derived(Date.parse(last) - Date.parse(first), source)
      : unavailable(first ? 'one tool-call record only; step times are not recorded' : 'step times are not recorded'),
  }
}

function eventText(events, assignmentId) {
  const own = events.filter(e => e.assignmentId === assignmentId)
  const last = own.at(-1)
  if (!last) return 'No journal event'
  if (last.type === 'close') return `Closed: ${last.outcome}`
  if (last.type === 'start') return 'Started, not closed'
  return 'Prepared, not started'
}

function modelOf(teamMode, duty, splitField) {
  if (hasValue(splitField) && splitField.value.model) return derived(splitField.value.model, 'observed in transcripts')
  const s = teamMode?.staffing?.[duty]
  if (!s?.model) return unavailable('no staffing entry in profiles/team-mode.json')
  return available(`${s.model}${s.effort ? ` · ${s.effort}` : ''} (configured)`, `profiles/team-mode.json staffing.${duty}`)
}

function execState(result, events, id) {
  if (result) return WORKER[result.workerStatus] ?? 'failed'
  const own = events.filter(e => e.assignmentId?.startsWith(`${id}.exec.`))
  return own.some(e => e.type === 'start') ? 'running' : 'pending'
}

function checkState(result, exec) {
  if (!result) return 'pending'
  const state = VERIFIER[result.verificationStatus]
  // A verifier that stopped on "no candidate" ran no command: grey, not a red verdict.
  if (exec === 'blocked' && state === 'failed' && !(result.verifier?.commandsRun ?? []).length) return 'stopped'
  return state ?? 'pending'
}

function commitState(status, committed, planned, run) {
  if (committed) return 'done'
  if (run.abandoned) return 'archived'
  if (status === 'accepted' && (run.after?.holdAll || planned)) return 'waiting'
  return 'pending'
}

function focusOf(nodes) {
  const live = nodes.findIndex(n => ['running', 'failed', 'blocked'].includes(n.state))
  if (live >= 0) return live
  return Math.max(0, nodes.findLastIndex(n => n.state !== 'pending'))
}

function node(key, fields) {
  return { key, failures: [], files: notApplicable('no file list for this step'), split: notApplicable('kit step'), ...fields }
}

const SETTLE_SRC = 'settlement.json calls[] (input+cache_creation)'

function engineStep(c, duty, wrapper, wrapperKey, outputKey) {
  const calls = settledCalls(c.run.settlement, c.id, duty)
  const split = splitOf(calls, c.run.split)
  const activity = activityOf(c.run.log, wrapper, c.window)
  return {
    wrapper: wrapper ? available(wrapper, `batch.json args.plan[].${wrapperKey}`) : unavailable('no plan entry'),
    model: modelOf(c.run.teamMode, duty, split),
    event: { text: eventText(c.events, `${c.id}.${duty}.${c.result?.attempts ?? 1}`), at: activity.at, atKind: 'first-tool-call' },
    elapsedMs: activity.elapsedMs,
    tokens: tokensOf(calls, Boolean(c.run.settlement), SETTLE_SRC),
    outputTokens: c.result ? available(c.result[outputKey], `return.json results[].${outputKey} (engine output meter)`) : unavailable('no engine result yet'),
    split,
  }
}

function execNode(c) {
  const { result } = c
  return node('exec', {
    ...engineStep(c, 'exec', c.plan.agentType, 'agentType', 'workerTokens'),
    state: c.exec,
    attempt: c.attempt,
    activity: result?.worker?.outcome ? available(result.worker.outcome, 'return.json results[].worker.outcome') : unavailable('no worker result yet'),
    detail: result?.worker?.notes ? available(result.worker.notes, 'return.json results[].worker.notes') : unavailable('no worker notes'),
    files: result ? available(result.worker?.filesTouched ?? [], 'return.json results[].worker.filesTouched') : unavailable('no worker result yet'),
    artifacts: [c.run.artifacts.return, c.run.artifacts.batch].filter(Boolean),
  })
}

function checkNode(c) {
  const verifier = c.result?.verifier
  const commands = (verifier?.commandsRun ?? []).map(cmd => `${cmd.command} -> exit ${cmd.exitCode}`).join('\n')
  return node('check', {
    ...engineStep(c, 'check', c.plan.verifierAgentType, 'verifierAgentType', 'verifierTokens'),
    state: c.check,
    attempt: c.result && c.check !== 'pending' ? c.attempt : unavailable('not dispatched'),
    activity: verifier?.summary ? available(verifier.summary, 'return.json results[].verifier.summary') : unavailable('no verifier result yet'),
    detail: verifier ? available(commands || 'No verification command was run.', 'return.json results[].verifier.commandsRun') : unavailable('no verifier result yet'),
    failures: verifier?.failures ?? [],
    artifacts: [c.run.artifacts.return].filter(Boolean),
  })
}

function commitNode(c) {
  const { run, commit, afterTicket } = c
  return node('commit', {
    state: commitState(c.status, commit, c.planned, run),
    wrapper: notApplicable('kit step run by the PM (rw-batch.mjs commit)'),
    model: notApplicable('kit step, no model'),
    attempt: notApplicable('kit step'),
    activity: commit ? available(`Committed ${commit.sha.slice(0, 8)}`, 'commits.json')
      : run.abandoned ? available(run.abandoned.next, 'abandoned.json next')
      : run.after ? available((run.after.next ?? []).join(' ') || 'No next step recorded.', 'after.json next[]')
      : unavailable('batch not closed yet'),
    detail: afterTicket ? available(`Changed paths: ${afterTicket.changedPaths?.length ? afterTicket.changedPaths.join(', ') : 'none'}`, 'after.json tickets[].changedPaths') : unavailable('batch not closed yet'),
    event: {
      atKind: 'record',
      text: commit ? 'Committed' : run.abandoned ? 'Batch archived without commit' : run.after ? 'Batch closed' : 'No event',
      at: run.abandoned ? available(run.abandoned.archivedAt, 'abandoned.json archivedAt') : run.after ? available(run.after.closedAt, 'after.json closedAt') : unavailable('batch not closed yet'),
    },
    elapsedMs: notApplicable('kit step'),
    tokens: notApplicable('kit step, no model call'), outputTokens: notApplicable('kit step, no model call'),
    artifacts: [run.artifacts.after, run.artifacts.commits, run.artifacts.abandoned].filter(Boolean),
  })
}

function context(spec, run) {
  const { id } = spec
  const result = lastResult(run.ret, id)
  const afterTicket = run.after?.tickets?.find(t => t.id === id) ?? null
  const commit = (run.commits?.commits ?? []).find(c => c.ticket === id && /^[a-f0-9]{40}$/.test(c.sha ?? '')) ?? null
  const events = journalOf(run.settlement, id)
  const exec = execState(result, events, id)
  return {
    id, run, result, afterTicket, commit, events, exec,
    check: checkState(result, exec),
    planned: (run.after?.commits ?? []).some(c => c.ticket === id),
    status: statusOf({ result, afterTicket, committed: Boolean(commit), phase: run.phase }),
    plan: run.batch.args?.plan?.find(p => p.ticket === id) ?? {},
    window: { from: run.batch.openedAt, to: run.after?.closedAt ?? run.now },
    attempt: result ? available(result.attempts, 'return.json results[].attempts') : unavailable('no engine result yet'),
  }
}

function tokenFields(c) {
  const settled = c.run.settlement?.tickets?.find(t => t.ticket === c.id) ?? null
  return {
    tokens: settled ? available(settled.spentTokens, 'settlement.json tickets[].spentTokens')
      : c.run.settlement ? unavailable('ticket not in settlement') : counting('settlement.json', 'settlement not written yet'),
    authorizedTokens: settled ? available(settled.authorizedTokens, 'settlement.json tickets[].authorizedTokens') : unavailable('settlement not written yet'),
    outputTokens: c.result ? available(c.result.workerTokens + c.result.verifierTokens, 'return.json results[] workerTokens + verifierTokens (engine output meter)') : unavailable('no engine result yet'),
  }
}

export function deriveTicket(spec, run) {
  const c = context(spec, run)
  const nodes = [execNode(c), checkNode(c), commitNode(c)]
  const redispatched = (c.result?.priorAttempts ?? []).length > 0 || c.events.some(e => e.type === 'prepare' && e.continuationOf)
  const suggested = Boolean(c.result?.needsFixRetest) || (run.ret?.fixRetestQueue ?? []).some(q => q.ticket === c.id)
  const limit = run.batch.limits?.attemptsPerTicket
  return {
    id: c.id,
    title: spec.title,
    goal: spec.goal ? available(spec.goal, 'batch.json tickets[].goal') : unavailable('no goal in the batch record'),
    acceptance: spec.acceptance ?? [],
    status: c.status,
    pmPending: Boolean(run.ret?.haltRequiresAcknowledgement) && ['blocked', 'failed'].includes(c.status),
    archivedWithoutCommit: Boolean(run.abandoned) && !c.commit,
    attempt: c.attempt,
    attemptCeiling: limit ? available(limit, 'batch.json limits.attemptsPerTicket') : unavailable('no attempt limit recorded'),
    ...tokenFields(c),
    rework: redispatched ? 'redispatched' : suggested ? 'suggested' : 'none',
    nodes,
    focusNode: focusOf(nodes),
  }
}
