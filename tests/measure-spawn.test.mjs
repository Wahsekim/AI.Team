// Tests for scripts/measure-spawn.mjs (teamai port P01): per-subagent token
// totals read from Claude Code transcripts, deduplicated by message.id,
// joined to the main session's Agent-tool results, failing loudly on drift.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/measure-spawn.mjs', import.meta.url))

const usage = (input, create, read, output, extra = {}) => ({
  input_tokens: input,
  cache_creation_input_tokens: create,
  cache_read_input_tokens: read,
  output_tokens: output,
  ...extra,
})

const assistant = (id, u, agentId, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  isSidechain: Boolean(agentId),
  agentId,
  requestId: `req_${id}`,
  message: { id: `msg_${id}`, model, role: 'assistant', content: [], usage: u },
})

const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

// Builds <tmp>/<sessionId>.jsonl + <tmp>/<sessionId>/subagents/... in the
// real on-disk layout (verified 2026-10-14: per-agent files, not sidechain
// entries in the main file).
function makeSession({ mainRows, agents, workflowAgents = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'measure-spawn-'))
  const sessionId = 'sess-test'
  const sessionDir = join(dir, sessionId)
  const sub = join(sessionDir, 'subagents')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(mainRows))
  for (const a of agents) {
    writeFileSync(join(sub, `agent-${a.id}.jsonl`), jsonl(a.rows))
    if (a.meta) writeFileSync(join(sub, `agent-${a.id}.meta.json`), JSON.stringify(a.meta))
  }
  for (const a of workflowAgents) {
    const wf = join(sub, 'workflows', a.runId)
    mkdirSync(wf, { recursive: true })
    writeFileSync(join(wf, `agent-${a.id}.jsonl`), jsonl(a.rows))
    if (a.journal) writeFileSync(join(wf, 'journal.jsonl'), a.journal)
  }
  return { dir, sessionDir, mainFile: join(dir, `${sessionId}.jsonl`) }
}

const launched = (agentId, description, resolvedModel = 'claude-opus-5-5') => ({
  type: 'user',
  toolUseResult: { isAsync: true, status: 'async_launched', agentId, description, resolvedModel },
})

const baseSession = () => makeSession({
  mainRows: [
    assistant('m1', usage(10, 100, 1000, 5)),
    assistant('m1', usage(10, 100, 1000, 5)), // streamed duplicate of m1
    launched('a1', 'explore repo'),
    launched('a2', 'write tests', 'claude-sonnet-5-5'),
    assistant('m2', usage(20, 0, 2000, 7)),
  ],
  agents: [
    {
      id: 'a1',
      meta: { agentType: 'Explore', description: 'explore repo', toolUseId: 'toolu_1', finished: true },
      rows: [
        assistant('a1x', usage(2, 20000, 0, 8, { server_tool_use: {}, iterations: 1 }), 'a1'),
        assistant('a1x', usage(2, 20000, 0, 8), 'a1'), // duplicate id, identical usage
        assistant('a1x', usage(2, 20000, 0, 120), 'a1'), // later chunk: output grows
        assistant('a1x', usage(2, 20000, 0, 100), 'a1'), // later chunk smaller: max wins, not last
        assistant('a1y', usage(3, 0, 30000, 400), 'a1'),
        { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'x' } },
        { type: 'attachment', isSidechain: true, agentId: 'a1' },
      ],
    },
    {
      id: 'a2',
      rows: [assistant('a2x', usage(1, 500, 0, 50), 'a2', 'claude-sonnet-5-5')],
    },
  ],
  workflowAgents: [
    { runId: 'wf_abc123', id: 'w1', rows: [assistant('w1x', usage(4, 40, 400, 44), 'w1')] },
  ],
})

test('sums the four token classes per subagent, max per field across a duplicated message.id', async () => {
  const s = baseSession()
  const { stdout } = await exec('node', [SCRIPT, s.sessionDir, '--json'])
  const out = JSON.parse(stdout)
  const a1 = out.subagents.find(a => a.agentId === 'a1')
  assert.deepEqual(
    { input: a1.input, cacheCreate: a1.cacheCreate, cacheRead: a1.cacheRead, output: a1.output },
    { input: 5, cacheCreate: 20000, cacheRead: 30000, output: 520 },
  )
  assert.equal(a1.harnessEq, 20005) // input + cache_creation: the lifecycle Tokens: column
  assert.equal(a1.total, 50525)
  assert.equal(a1.entries, 5)
  assert.equal(a1.uniqueMessages, 2)
  assert.equal(a1.duplicates, 3)
})

test('joins subagent files to meta.json and the main file Agent-tool results', async () => {
  const s = baseSession()
  const { stdout } = await exec('node', [SCRIPT, s.sessionDir, '--json'])
  const out = JSON.parse(stdout)
  const a1 = out.subagents.find(a => a.agentId === 'a1')
  assert.equal(a1.agentType, 'Explore')
  assert.equal(a1.description, 'explore repo')
  assert.equal(a1.toolUseId, 'toolu_1')
  assert.equal(a1.model, 'claude-opus-5-5')
  const a2 = out.subagents.find(a => a.agentId === 'a2')
  assert.equal(a2.agentType, null) // no meta.json
  assert.equal(a2.description, 'write tests') // from the main file join
  assert.equal(a2.model, 'claude-sonnet-5-5')
})

test('walks subagents/workflows/wf_*/ engine agents and reports the run id', async () => {
  const s = baseSession()
  const { stdout } = await exec('node', [SCRIPT, s.sessionDir, '--json'])
  const out = JSON.parse(stdout)
  const w1 = out.subagents.find(a => a.agentId === 'w1')
  assert.equal(w1.workflowRunId, 'wf_abc123')
  assert.equal(w1.total, 488)
})

test('main-session totals deduplicate too and the transcript path form is accepted', async () => {
  const s = baseSession()
  const { stdout } = await exec('node', [SCRIPT, s.mainFile, '--json'])
  const out = JSON.parse(stdout)
  assert.equal(out.session.uniqueMessages, 2)
  assert.equal(out.session.total, 10 + 100 + 1000 + 5 + 20 + 2000 + 7)
  assert.equal(out.subagents.length, 3)
})

test('surfaces meta finished and warns on stderr for partial subagents', async () => {
  const s = baseSession()
  const { stdout, stderr } = await exec('node', [SCRIPT, s.sessionDir, '--json'])
  const out = JSON.parse(stdout)
  assert.equal(out.subagents.find(a => a.agentId === 'a1').finished, true)
  assert.equal(out.subagents.find(a => a.agentId === 'a2').finished, null)
  assert.doesNotMatch(stderr, /WARN - partial: agent a1 /)
  assert.doesNotMatch(stderr, /WARN - partial: agent a2 /) // no flag: not a per-row claim
  assert.match(stderr, /WARN - partial\?: 2 subagent\(s\) have no 'finished' flag/)
  const running = makeSession({ mainRows: [], agents: [{ id: 'r', meta: { finished: false }, rows: [assistant('rx', usage(1, 1, 1, 1), 'r')] }] })
  const r1 = await exec('node', [SCRIPT, running.sessionDir])
  assert.match(r1.stderr, /WARN - partial: agent r finished=false entries=1/)
  const empty = makeSession({ mainRows: [], agents: [{ id: 'e', meta: { finished: true }, rows: [] }] })
  const r2 = await exec('node', [SCRIPT, empty.sessionDir])
  assert.match(r2.stderr, /WARN - partial: agent e finished=true entries=0/)
  assert.match(r2.stdout, /\be\b.*\byes\b/)
})

test('--agent filters to one subagent', async () => {
  const s = baseSession()
  const { stdout } = await exec('node', [SCRIPT, s.sessionDir, '--agent', 'a2', '--json'])
  const out = JSON.parse(stdout)
  assert.deepEqual(out.subagents.map(a => a.agentId), ['a2'])
})

test('text output has one row per subagent and the four classes', async () => {
  const s = baseSession()
  const { stdout } = await exec('node', [SCRIPT, s.sessionDir])
  assert.match(stdout, /agentId\s+type\s+model/)
  assert.match(stdout, /harness_eq\s+total/)
  assert.match(stdout, /subagents: 3 file\(s\), harness_eq=20550 \(-> lifecycle Tokens:\)/)
  assert.match(stdout, /\ba1\b.*\bExplore\b.*\b50525\b/)
  assert.match(stdout, /\bw1\b.*wf_abc123/)
  assert.match(stdout, /session \(main file\).*3142/)
})

test('fails loudly when an assistant entry lacks one of the four token fields', async () => {
  const s = makeSession({
    mainRows: [],
    agents: [{
      id: 'bad',
      rows: [{ type: 'assistant', agentId: 'bad', message: { id: 'msg_b', usage: { input_tokens: 1, output_tokens: 2 } } }],
    }],
  })
  try {
    await exec('node', [SCRIPT, s.sessionDir])
    assert.fail('expected exit 2 on schema drift')
  } catch (e) {
    assert.equal(e.code, 2)
    assert.match(String(e.stderr), /FAIL - schema: .*agent-bad\.jsonl:1 missing cache_creation_input_tokens/)
  }
})

test('fails loudly when an assistant entry has no message.id and no requestId', async () => {
  const s = makeSession({
    mainRows: [],
    agents: [{
      id: 'noid',
      rows: [{ type: 'assistant', agentId: 'noid', message: { usage: usage(1, 1, 1, 1) } }],
    }],
  })
  try {
    await exec('node', [SCRIPT, s.sessionDir])
    assert.fail('expected exit 2 on missing dedup key')
  } catch (e) {
    assert.equal(e.code, 2)
    assert.match(String(e.stderr), /FAIL - schema: .*agent-noid\.jsonl:1 no message\.id or requestId/)
  }
})

test('prices rows when the model is in the pricing table and leaves others unpriced', async () => {
  const s = baseSession()
  const pricing = join(s.dir, 'pricing.json')
  writeFileSync(pricing, JSON.stringify({
    tableVersion: 'test-2026-11-05',
    usdPerMTok: { 'claude-opus-5-5': { input: 10, cacheCreate: 12.5, cacheRead: 1, output: 50 } },
  }))
  const { stdout } = await exec('node', [SCRIPT, s.sessionDir, '--pricing', pricing, '--json'])
  const out = JSON.parse(stdout)
  assert.equal(out.pricingTableVersion, 'test-2026-11-05')
  const a1 = out.subagents.find(a => a.agentId === 'a1')
  // 5*10 + 20000*12.5 + 30000*1 + 520*50 = 50 + 250000 + 30000 + 26000 micro-USD
  assert.equal(a1.microUsd, 306050)
  const a2 = out.subagents.find(a => a.agentId === 'a2')
  assert.equal(a2.microUsd, null)
})

test('rejects a pricing file without tableVersion', async () => {
  const s = baseSession()
  const pricing = join(s.dir, 'pricing.json')
  writeFileSync(pricing, JSON.stringify({ usdPerMTok: {} }))
  try {
    await exec('node', [SCRIPT, s.sessionDir, '--pricing', pricing])
    assert.fail('expected exit 1')
  } catch (e) {
    assert.equal(e.code, 1)
    assert.match(String(e.stderr), /FAIL - pricing: .*tableVersion/)
  }
})

test('rejects a session with no subagents directory and no transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-spawn-empty-'))
  try {
    await exec('node', [SCRIPT, dir])
    assert.fail('expected exit 1')
  } catch (e) {
    assert.equal(e.code, 1)
    assert.match(String(e.stderr), /FAIL - args: .*no transcript or subagents/)
  }
})

test('unknown flag and missing path fail fast', async () => {
  for (const args of [[], ['--bogus']]) {
    try {
      await exec('node', [SCRIPT, ...args])
      assert.fail('expected exit 1')
    } catch (e) {
      assert.equal(e.code, 1)
      assert.match(String(e.stderr), /FAIL - args/)
    }
  }
})

test('workflow agents take finished from the run journal: result recorded = true, started only = false, no journal = unknown', async () => {
  const row = id => [assistant(`${id}-m`, usage(1, 2, 3, 4), id)]
  const journal = jsonl([{ type: 'launched' }, { type: 'started', agentId: 'done1' }, { type: 'result', agentId: 'done1', result: {} },
    { type: 'started', agentId: 'open1' }]) + '{"type":"result","agentId":"torn1"'
  const s = makeSession({ mainRows: [], agents: [], workflowAgents: [
    { id: 'done1', runId: 'wf_j', rows: row('done1'), journal }, { id: 'open1', runId: 'wf_j', rows: row('open1') },
    { id: 'torn1', runId: 'wf_j', rows: row('torn1') }, { id: 'nojournal', runId: 'wf_none', rows: row('nojournal') }] })
  const { stdout, stderr } = await exec('node', [SCRIPT, s.sessionDir, '--json'])
  const finished = Object.fromEntries(JSON.parse(stdout).subagents.map(a => [a.agentId, a.finished]))
  assert.deepEqual(finished, { done1: true, open1: false, torn1: null, nojournal: null }, 'a torn journal line proves nothing')
  assert.match(stderr, /WARN - partial: agent open1 finished=false/)
  assert.match(stderr, /WARN - partial\?: 2 subagent\(s\)/)
})
