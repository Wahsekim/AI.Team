// Tests for the read-only dashboard (scripts/dashboard.mjs, src/dashboard/).
// Fixture: a synthetic Router/Worker batch shaped like a real one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collect } from '../src/dashboard/collect.mjs'
import { render } from '../src/dashboard/render.mjs'

const FIXTURES = fileURLToPath(new URL('./fixtures/dashboard/', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../scripts/dashboard.mjs', import.meta.url))
const RUN = 'rw-3c9e1a42-L101-n2k8q4vz'
const NOW = new Date('2026-11-24T18:00:00Z')
const OPTS = { now: NOW, timezone: 'UTC' }

function instance(name = 'rw-instance') {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-'))
  cpSync(join(FIXTURES, name), dir, { recursive: true })
  return dir
}

const batchFile = (inst, file) => join(inst, 'batches', RUN, file)
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'))
const editJSON = (path, edit) => writeFileSync(path, JSON.stringify(edit(readJSON(path)), null, 2))
const page = (inst, opts = {}) => render(collect(inst, { ...OPTS, ...opts }))
const ticket = snap => snap.batch.value.tickets[0]

test('collects the fixture batch values with their sources', () => {
  const snap = collect(join(FIXTURES, 'rw-instance'), OPTS)
  const batch = snap.batch.value, t = ticket(snap)
  assert.equal(snap.project.name.value, 'Sample Project')
  assert.equal(batch.runId, RUN)
  assert.equal(batch.phase, 'archived')
  assert.deepEqual([batch.roundCurrent.value, batch.roundCeiling.value, batch.ticketTotal.value, batch.acceptedCount.value], [1, 1, 1, 0])
  assert.equal(batch.tokens.value, 148758)
  assert.equal(batch.unattributed.guardian.value, 17589)
  assert.equal(batch.unattributed.mainSession.value, 137732)
  assert.equal(batch.activeTicketId, 'T-1')
  assert.equal(batch.activeKind, 'last-executed')
  assert.equal(t.status, 'blocked')
  assert.equal(t.tokens.value, 131169)
  assert.equal(t.pmPending, true)
  assert.equal(t.archivedWithoutCommit, true)
  assert.deepEqual(t.nodes.map(n => n.state), ['blocked', 'stopped', 'archived'])
  assert.deepEqual(t.nodes.slice(0, 2).map(n => n.tokens.value), [69472, 61697])
  assert.equal(t.rework, 'suggested')
})

test('output tokens and input+cache-creation tokens stay separate meters, never summed', () => {
  const snap = collect(join(FIXTURES, 'rw-instance'), OPTS)
  const batch = snap.batch.value, t = ticket(snap)
  assert.equal(batch.outputTokens.value, 15801)
  assert.match(batch.outputTokens.source, /output meter/)
  assert.equal(t.outputTokens.value, 8383 + 3593)
  assert.match(t.tokens.source, /spentTokens/)
  const html = render(snap)
  for (const mixed of [131169 + 11976, 148758 + 15801, 69472 + 8383]) assert.ok(!html.includes(new Intl.NumberFormat('en-US').format(mixed)), `no summed figure ${mixed}`)
  assert.match(html, /input \+ cache write/)
  assert.match(html, /engine meter/)
})

test('no prototype sample value appears in the page', () => {
  const inst = instance()
  editJSON(join(inst, 'profiles/team-mode.json'), mode => ({ ...mode, staffing: {} }))
  const html = page(inst)
  for (const sample of ['US-19', 'US-20', 'US-21', 'US-22', 'US-23', 'OBS-04', '96.4k', '84.2k', '362.4k', '128.6k', '41%', '63%', '17:40', 'v0.4', '18 / 30', '60%', '2分18秒', '空列表恢复', 'Europe/Paris', 'Opus', 'opus', '示例', 'sample data']) {
    assert.ok(!html.includes(sample), `prototype sample "${sample}" must not appear`)
  }
  assert.equal(ticket(collect(inst, OPTS)).nodes[0].model.state, 'unavailable')
})

test('fields without a source render the unavailable state, never a zero or a bar', () => {
  const snap = collect(join(FIXTURES, 'rw-instance'), OPTS)
  const html = render(snap)
  assert.equal(snap.quota.state, 'unavailable')
  assert.match(html, /data-quota-state="unavailable"/)
  assert.match(html, /no quota source configured/)
  assert.ok(!html.includes('class="micro-fill"'), 'no quota bar without quota data')
  assert.ok(!/width:\s*0%/.test(html), 'no 0% bar')
  assert.equal(snap.milestone.state, 'unavailable')
  assert.match(html, /milestone not declared/)
  assert.equal(ticket(snap).nodes[0].elapsedMs.state, 'unavailable')
  assert.equal(ticket(snap).nodes[0].split.state, 'unavailable')
  assert.ok((html.match(/data-state="unavailable"/g) ?? []).length >= 5)
})

test('quota unknown, stale and not-started each use their own copy (M4)', () => {
  const inst = instance(), quota = join(inst, 'quota.json')
  const write = sampledAt => writeFileSync(quota, JSON.stringify({ account_id: 'acct', sampled_at: sampledAt, windows: { five_hour: { used_percentage: 37, resets_at: '2026-11-24T20:00:00Z' } } }))
  write('2026-11-24T17:58:00Z')
  const fresh = page(inst, { quota })
  assert.match(fresh, /data-quota-state="available"/)
  assert.match(fresh, /width:37%/)
  write('2026-11-24T12:00:00Z')
  const old = page(inst, { quota })
  assert.match(old, /data-quota-state="stale"/)
  assert.match(old, /Stale/)
  editJSON(batchFile(inst, 'batch.json'), b => ({ ...b, tickets: [...b.tickets, { ...b.tickets[0], id: 'US-99', title: 'Queued ticket' }] }))
  const queued = collect(inst, OPTS).batch.value.tickets.find(t => t.id === 'US-99')
  assert.equal(queued.status, 'queued')
  assert.equal(queued.attempt.state, 'unavailable')
  assert.match(render(collect(inst, OPTS)), /Not dispatched/)
})

test('a replayed batch folder, settlement row or log line is not counted twice (M5)', () => {
  const inst = instance()
  const before = collect(inst, OPTS)
  editJSON(batchFile(inst, 'settlement.json'), s => ({ ...s, calls: [...s.calls, ...s.calls] }))
  cpSync(join(inst, 'batches', RUN), join(inst, 'batches', `${RUN}-replay`), { recursive: true })
  const log = join(inst, '.claude/rw-write-boundary.log.jsonl')
  writeFileSync(log, readFileSync(log, 'utf8').repeat(3))
  const after = collect(inst, OPTS)
  assert.equal(after.instanceTokens.value, before.instanceTokens.value)
  assert.equal(after.instanceTokens.value, 148758)
  assert.deepEqual(ticket(after).nodes.map(n => n.tokens.value), ticket(before).nodes.map(n => n.tokens.value))
  assert.equal(after.batch.value.unattributed.guardian.value, 17589)
  assert.deepEqual(ticket(after).nodes[0].elapsedMs, ticket(before).nodes[0].elapsedMs)
})

test('round, ticket total and accepted count come from their own records, not from Round (A1, M5)', () => {
  const inst = instance()
  editJSON(batchFile(inst, 'batch.json'), b => ({ ...b, args: { ...b.args, rounds: 5 } }))
  const batch = collect(inst, OPTS).batch.value
  assert.equal(batch.roundCeiling.value, 5)
  assert.equal(batch.roundCurrent.value, 1)
  assert.equal(batch.ticketTotal.value, 1)
  assert.equal(batch.acceptedCount.value, 0)
})

test('rework distinguishes return suggested from re-dispatched (A4)', () => {
  const inst = instance()
  assert.match(page(inst), /data-rework="suggested"/)
  editJSON(batchFile(inst, 'return.json'), r => ({ ...r, results: r.results.map(x => ({ ...x, workerStatus: 'succeeded', priorAttempts: [{ attempt: 1 }], attempts: 2 })) }))
  const t = ticket(collect(inst, OPTS))
  assert.equal(t.rework, 'redispatched')
  assert.equal(t.nodes[0].state, 'done')
  assert.equal(t.nodes[1].state, 'failed')
  assert.match(render(collect(inst, OPTS)), /data-rework="redispatched"/)
})

test('instance text is HTML-escaped', () => {
  const inst = instance()
  const evil = '<script>alert("x")</script><img src=x onerror=alert(1)>'
  editJSON(batchFile(inst, 'return.json'), r => ({ ...r, results: r.results.map(x => ({ ...x, worker: { ...x.worker, notes: evil, outcome: evil } })) }))
  editJSON(batchFile(inst, 'batch.json'), b => ({ ...b, tickets: b.tickets.map(t => ({ ...t, title: evil })) }))
  const html = page(inst)
  assert.ok(!html.includes(evil))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
  assert.equal((html.match(/<script>/g) ?? []).length, 1, 'only the page script')
})

test('an open batch with no engine result yet shows counting and unrecorded, not zeros', () => {
  const inst = instance()
  cpSync(batchFile(inst, 'batch.json'), join(inst, 'rw-batch.json'))
  const snap = collect(inst, OPTS), batch = snap.batch.value
  assert.equal(batch.phase, 'open')
  assert.equal(batch.roundCurrent.state, 'unavailable')
  assert.equal(batch.tokens.state, 'counting')
  assert.equal(batch.acceptedCount.state, 'unavailable')
  assert.equal(ticket(snap).status, 'unrecorded')
  assert.equal(ticket(snap).tokens.state, 'counting')
  render(snap)
})

test('a specialist-mode instance gets the reduced view without crashing', () => {
  const snap = collect(join(FIXTURES, 'specialist-instance'), OPTS)
  assert.equal(snap.project.name.value, 'Sample Specialist Team')
  assert.equal(snap.project.mode.value, 'specialist')
  assert.equal(snap.batch.state, 'unavailable')
  assert.equal(snap.instanceTokens.state, 'unavailable')
  const html = render(snap)
  assert.match(html, /Batch view unavailable/)
  assert.match(html, /specialist mode/)
  assert.ok(!html.includes('class="sidebar"'))
})

test('the CLI writes one offline page and leaves the instance untouched', () => {
  const inst = instance()
  const listing = dir => readdirSync(dir, { recursive: true }).sort().map(f => `${f}:${statSync(join(dir, f)).mtimeMs}`)
  const before = listing(inst)
  const html = execFileSync(process.execPath, [SCRIPT, '--instance', inst, '--now', NOW.toISOString()], { encoding: 'utf8' })
  assert.deepEqual(listing(inst), before)
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/)
  assert.ok(!/<link\b|\bsrc=|@import|url\(/.test(html), 'no external resource')
  assert.deepEqual([...new Set(html.match(/https?:\/\/[^"'\s)]+/g))], ['http://www.w3.org/2000/svg'])
  rmSync(inst, { recursive: true, force: true })
})

test('the CLI refuses a missing instance with exit 2', () => {
  const missing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /--instance is required/)
  const wrong = spawnSync(process.execPath, [SCRIPT, '--instance', join(tmpdir(), 'no-such-instance-dashboard')], { encoding: 'utf8' })
  assert.equal(wrong.status, 2)
})
