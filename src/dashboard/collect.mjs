// Read-only collector: instance root -> dashboard snapshot (shape in model.mjs).
// It never writes; every missing source becomes an explicit Field state.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { RECORDS, BATCH_FILE, ARCHIVE } from '../router-worker/batch.mjs'
import { LOG_FILE } from '../router-worker/write-boundary.mjs'
import { available, derived, counting, stale, notApplicable, unavailable } from './model.mjs'
import { deriveTicket } from './ticket.mjs'

const MODE_FILE = 'profiles/team-mode.json'
const PROJECT_FILE = 'profiles/project.md'
const QUOTA_STALE_MS = 10 * 60 * 1000
const MEASURE_SPAWN = fileURLToPath(new URL('../../scripts/measure-spawn.mjs', import.meta.url))
const QUOTA_WINDOWS = [['five_hour', '5h'], ['seven_day', '7d']]
const ARTIFACTS = ['batch.json', 'return.json', 'after.json', 'settlement.json', 'commits.json', 'abandoned.json']

function readJSON(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

// Only first and last tool-call times are read, so a replayed line changes nothing.
function readLog(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

// The open batch lives at the root under rw-batch*.json; archived ones under batches/<runId>/.
// "Latest" is by closedAt (fallback openedAt), never by file mtime.
function batchLocations(inst) {
  const archive = join(inst, ARCHIVE)
  const archived = existsSync(archive)
    ? readdirSync(archive, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => ({
      kind: 'archived', dir: join(ARCHIVE, d.name), file: name => join(ARCHIVE, d.name, name),
    }))
    : []
  const open = existsSync(join(inst, BATCH_FILE))
    ? [{ kind: 'open', dir: '.', file: name => (name === 'abandoned.json' ? null : RECORDS[name]) }]
    : []
  return { open, archived }
}

function readBatch(inst, loc) {
  const rec = {}
  for (const name of ARTIFACTS) {
    const rel = loc.file(name)
    rec[name] = rel ? { rel, data: readJSON(join(inst, rel)) } : { rel: null, data: null }
  }
  return rec
}

function latestArchived(inst, archived) {
  const stamp = rec => rec['after.json'].data?.closedAt ?? rec['batch.json'].data?.openedAt ?? ''
  return archived.map(loc => readBatch(inst, loc)).filter(rec => rec['batch.json'].data)
    .sort((a, b) => stamp(a).localeCompare(stamp(b))).at(-1) ?? null
}

function artifactsOf(inst, rec) {
  const after = rec['after.json'].data
  const version = { 'return.json': after?.returnDigest ?? null }
  return Object.fromEntries(ARTIFACTS.map(name => {
    const { rel, data } = rec[name]
    const key = name.replace('.json', '')
    return [key, rel && {
      name, path: rel, available: Boolean(data),
      href: data ? pathToFileURL(join(inst, rel)).href : null,
      version: data ? (data.digest ?? version[name] ?? null) : null,
    }]
  }))
}

function haltTicket(ret) {
  const iter = Number(/at iter (\d+)/.exec(ret.haltReason ?? '')?.[1])
  return ret.results?.find(r => r.iter === iter)?.ticket ?? ret.results?.at(-1)?.ticket ?? null
}

function readSplit(transcripts) {
  if (!transcripts) return null
  try {
    const out = JSON.parse(execFileSync(process.execPath, [MEASURE_SPAWN, transcripts, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    return { rows: new Map(out.subagents.map(r => [r.agentId, r])) }
  } catch (error) {
    return { error: (error.stderr || error.message || String(error)).trim().split('\n')[0] }
  }
}

function collectBatch(inst, rec, ctx) {
  const batch = rec['batch.json'].data, ret = rec['return.json'].data, after = rec['after.json'].data
  const settlement = rec['settlement.json'].data, abandoned = rec['abandoned.json'].data
  const phase = abandoned ? 'archived' : after ? 'closed' : ret ? 'returned' : 'open'
  const artifacts = artifactsOf(inst, rec)
  const run = {
    batch, ret, after, settlement, abandoned, commits: rec['commits.json'].data, phase,
    teamMode: ctx.teamMode, log: ctx.log, split: ctx.split, now: ctx.now.toISOString(), artifacts,
  }
  const tickets = (batch.tickets ?? []).map(spec => deriveTicket(spec, run))
  const guardCalls = new Map((settlement?.calls ?? []).filter(c => c.ticket === null).map(c => [c.agentId, c]))
  const settledOr = (value, source) => (settlement ? available(value, source) : counting('settlement.json', 'settlement not written yet'))
  const end = after?.closedAt ?? null

  const activeTicketId = ret ? haltTicket(ret) : null
  return {
    runId: batch.runId,
    phase,
    branch: batch.branch ? available(batch.branch, 'batch.json branch') : unavailable('no branch recorded'),
    openedAt: available(batch.openedAt, 'batch.json openedAt'),
    closedAt: end ? available(end, 'after.json closedAt') : unavailable('batch not closed yet'),
    archivedAt: abandoned ? available(abandoned.archivedAt, 'abandoned.json archivedAt') : notApplicable('not archived without commit'),
    roundCurrent: ret ? available(ret.itersRun, 'return.json itersRun')
      : unavailable('engine dispatch keeps round progress in the Claude Code session, not in the instance'),
    roundCeiling: Number.isInteger(batch.args?.rounds) ? available(batch.args.rounds, 'batch.json args.rounds') : unavailable('no round count in batch.json args'),
    ticketTotal: available(tickets.length, 'batch.json tickets[]'),
    acceptedCount: after ? available(after.tickets.filter(t => t.status === 'passed').length, 'after.json tickets[].status == passed')
      : ret ? derived(ret.results.filter(r => r.verificationStatus === 'passed').length, 'return.json results[].verificationStatus')
      : unavailable('no engine result yet'),
    tokens: settledOr(settlement?.run?.totalTokens, 'settlement.json run.totalTokens (input+cache_creation)'),
    outputTokens: ret?.budgetStatus ? available(ret.budgetStatus.loopSpent, 'return.json budgetStatus.loopSpent (engine output meter)') : unavailable('no engine result yet'),
    unattributed: {
      guardian: settledOr([...guardCalls.values()].reduce((sum, c) => sum + c.tokens, 0), 'settlement.json calls[] with ticket null'),
      mainSession: settledOr(settlement?.mainSessionTokens, 'settlement.json mainSessionTokens'),
      reviews: settledOr(settlement?.reviewCost, 'settlement.json reviewCost'),
    },
    runElapsedMs: end ? derived(Date.parse(end) - Date.parse(batch.openedAt), 'after.json closedAt - batch.json openedAt')
      : derived(ctx.now - Date.parse(batch.openedAt), 'now - batch.json openedAt (still open)'),
    waitingMs: !ret?.haltRequiresAcknowledgement ? notApplicable('no halt waits for the PM')
      : abandoned ? unavailable('batch archived; no record says when the halt was acknowledged')
      : end ? derived(ctx.now - Date.parse(end), 'now - after.json closedAt')
      : unavailable('batch not closed yet'),
    halt: ret ? available({ reason: ret.haltReason, requiresAck: Boolean(ret.haltRequiresAcknowledgement) }, 'return.json haltReason') : unavailable('no engine result yet'),
    blockers: after ? available(after.account?.blockers ?? [], 'after.json account.blockers') : unavailable('batch not closed yet'),
    next: abandoned ? [abandoned.next] : after?.next ?? [],
    guardian: ret?.guardian ? available({ verdict: ret.guardian.verdict, findings: (after?.findings ?? []).map(f => f.code) }, 'return.json guardian.verdict, after.json findings[].code')
      : unavailable('no guardian result yet'),
    activeTicketId,
    activeKind: activeTicketId ? (phase === 'open' ? 'running' : 'last-executed') : null,
    tickets,
    artifacts: Object.values(artifacts).filter(a => a?.available),
  }
}

// Settled totals over every batch of the instance, one per runId, so a copied
// or replayed batch folder is not counted twice.
function instanceTokens(inst, locs) {
  const byRun = new Map()
  for (const loc of [...locs.archived, ...locs.open]) {
    const s = readJSON(join(inst, loc.file('settlement.json')))
    if (s?.runId && Number.isFinite(s.run?.totalTokens)) byRun.set(s.runId, s.run.totalTokens)
  }
  if (!byRun.size) return unavailable('no settled batch in this instance')
  return derived([...byRun.values()].reduce((a, b) => a + b, 0), `settlement.json run.totalTokens over ${byRun.size} batch(es), one per runId (input+cache_creation)`)
}

function projectName(inst, teamMode) {
  const spec = teamMode?.spec?.project
  if (spec?.name) return { name: available(spec.name, `${MODE_FILE} spec.project.name`), slug: available(spec.slug ?? null, `${MODE_FILE} spec.project.slug`) }
  const text = existsSync(join(inst, PROJECT_FILE)) ? readFileSync(join(inst, PROJECT_FILE), 'utf8') : ''
  const field = key => [...text.matchAll(/^\s+(\w+):\s*"?([^"\n]+?)"?\s*$/gm)].find(m => m[1] === key)?.[2] ?? null
  const name = field('name'), slug = field('slug')
  return {
    name: name ? available(name, `${PROJECT_FILE} project.name`) : unavailable(`no project name in ${PROJECT_FILE}`),
    slug: slug ? available(slug, `${PROJECT_FILE} project.slug`) : unavailable(`no project slug in ${PROJECT_FILE}`),
  }
}

export function readQuota(path, now) {
  if (!path) return unavailable('no quota source configured (--quota <file>)')
  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { return unavailable(`quota file unreadable: ${error.message}`) }
  const sampledAt = Date.parse(raw?.sampled_at)
  if (!Number.isFinite(sampledAt)) return unavailable('quota file has no valid sampled_at')
  const windows = QUOTA_WINDOWS.flatMap(([key, label]) => {
    const w = raw.windows?.[key]
    if (!w || !Number.isFinite(w.used_percentage) || w.used_percentage < 0 || w.used_percentage > 100) return []
    const resets = typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : Number.isFinite(Date.parse(w.resets_at)) ? w.resets_at : null
    return [{ key: label, usedPercentage: w.used_percentage, resetsAt: resets }]
  })
  if (!windows.length) return unavailable('quota file has no valid window')
  const value = { accountId: raw.account_id ?? null, sampledAt: new Date(sampledAt).toISOString(), windows }
  return now - sampledAt > QUOTA_STALE_MS
    ? stale(value, path, `sampled more than ${QUOTA_STALE_MS / 60000} min before collection`)
    : available(value, path)
}

export function collect(inst, opts = {}) {
  const now = opts.now ?? new Date()
  const teamMode = readJSON(join(inst, MODE_FILE))
  const mode = teamMode?.mode ?? 'specialist'
  const locs = batchLocations(inst)
  const ctx = { teamMode, now, log: readLog(join(inst, LOG_FILE)), split: readSplit(opts.transcripts) }
  const rec = mode !== 'router-worker' ? null : locs.open.length ? readBatch(inst, locs.open[0]) : latestArchived(inst, locs.archived)

  const batch = mode !== 'router-worker'
    ? unavailable('specialist mode: engine results are not kept in the instance (a lifecycle-only view is a later slice)')
    : rec ? derived(collectBatch(inst, rec, ctx), rec['batch.json'].rel) : unavailable('no batch recorded in this instance')

  return {
    schemaVersion: 1,
    collectedAt: now.toISOString(),
    timezone: opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    project: {
      ...projectName(inst, teamMode),
      mode: teamMode ? available(`${mode}${teamMode.status ? ` · ${teamMode.status}` : ''}`, `${MODE_FILE} mode, status`) : derived('specialist', `no ${MODE_FILE}`),
    },
    quota: readQuota(opts.quota, now),
    milestone: unavailable('milestone not declared: the instance has no declared scope (tracker is PM-only)'),
    instanceTokens: mode === 'router-worker' ? instanceTokens(inst, locs) : unavailable('specialist mode keeps no settled batch'),
    batch,
    sources: [
      { name: 'team mode', path: MODE_FILE, found: Boolean(teamMode) },
      { name: 'batch records', path: rec ? rec['batch.json'].rel : `${ARCHIVE}/`, found: Boolean(rec) },
      { name: 'settlement', path: rec?.['settlement.json'].rel ?? 'settlement.json', found: Boolean(rec?.['settlement.json'].data) },
      { name: 'tool-activity log', path: LOG_FILE, found: ctx.log.length > 0 },
      { name: 'quota', path: opts.quota ? 'quota file (--quota)' : 'not configured', found: Boolean(opts.quota) },
      { name: 'transcripts', path: opts.transcripts ? 'session dir (--transcripts)' : 'not given', found: Boolean(ctx.split?.rows) },
      { name: 'milestone', path: 'not declared', found: false },
    ],
  }
}
