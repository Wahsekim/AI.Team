#!/usr/bin/env node
// measure-spawn.mjs — per-subagent token totals read from Claude Code
// transcripts (teamai port P01, docs/teamai-port-plan-2026-10-14.md).
// Gives M4 a harness meter that is neither worker self-report nor the engine
// budget delta.
//
// Usage: node scripts/measure-spawn.mjs <session-dir|transcript.jsonl>
//                                        [--agent <id>] [--pricing <file>] [--json]
//
// Layout read (verified 2026-10-14 on this machine):
//   <sessionId>.jsonl                               main session; Agent-tool
//                                                   results carry toolUseResult.agentId
//   <sessionId>/subagents/agent-<id>.jsonl          one file per subagent
//   <sessionId>/subagents/agent-<id>.meta.json      agentType, description, toolUseId
//   <sessionId>/subagents/workflows/wf_*/agent-*.jsonl   engine-run agents
//
// Which column goes into lifecycle `Tokens:`: harness_eq = input +
// cache_creation. Calibrated 2026-11-05 against 140 Agent-tool completion
// notices (<subagent_tokens>): single-run agents match at median ratio 1.008;
// cache reads and output are NOT in the harness figure, so `total` (all four
// classes) is a cost view only and must never be written into `Tokens:`.
//
// Rules: assistant entries are summed over the four token classes and
// deduplicated by message.id (fallback requestId), keeping the max of each
// field per id — streamed entries repeat the id and early chunks can
// under-report output_tokens. Every assistant entry MUST carry the
// four fields; unknown extra usage keys are tolerated. Schema drift exits 2.
// Pricing is optional: a table with a tableVersion; unknown models stay
// unpriced (null), never $0. A subagent whose meta.json says finished:false
// or that has no assistant entries gets a WARN on stderr (partial total);
// a missing flag (older runtime, or still running) gets one summary WARN.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const TOKEN_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
const CLASSES = ['input', 'cacheCreate', 'cacheRead', 'output']

const die = (msg, code = 1) => { console.error(`FAIL - ${msg}`); process.exit(code) }

function parseArgs(argv) {
  const opts = { path: null, agent: null, pricing: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--agent') opts.agent = argv[++i] ?? die('args: --agent needs an id')
    else if (a === '--pricing') opts.pricing = argv[++i] ?? die('args: --pricing needs a file')
    else if (a.startsWith('-')) die(`args: unknown flag '${a}'`)
    else if (opts.path) die('args: only one path accepted')
    else opts.path = a
  }
  if (!opts.path) die('args: usage: measure-spawn.mjs <session-dir|transcript.jsonl> [--agent <id>] [--pricing <file>] [--json]')
  return opts
}

function locate(path) {
  const abs = resolve(path)
  if (!existsSync(abs)) die(`args: '${path}' does not exist`)
  const isFile = statSync(abs).isFile()
  const sessionDir = isFile ? abs.replace(/\.jsonl$/, '') : abs
  const mainFile = isFile ? abs : `${abs}.jsonl`
  const subDir = join(sessionDir, 'subagents')
  const hasMain = existsSync(mainFile) && statSync(mainFile).isFile()
  const hasSub = existsSync(subDir) && statSync(subDir).isDirectory()
  if (!hasMain && !hasSub) die(`args: '${path}' has no transcript or subagents directory`)
  return { mainFile: hasMain ? mainFile : null, subDir: hasSub ? subDir : null }
}

function readEntries(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const entries = []
  lines.forEach((line, i) => {
    if (!line.trim()) return
    let e
    try { e = JSON.parse(line) } catch { die(`schema: ${file}:${i + 1} is not JSON`, 2) }
    entries.push({ e, line: i + 1 })
  })
  return entries
}

function sumAssistant(file, entries) {
  // Per message id keep the MAX of each field: streamed entries repeat the id
  // and the first chunk sometimes under-reports output_tokens (corpus check
  // 2026-11-05: 141 of 13,883 duplicate groups differ, only on output).
  const byKey = new Map()
  const models = new Set()
  let entryCount = 0
  let duplicates = 0
  for (const { e, line } of entries) {
    if (e.type !== 'assistant') continue
    entryCount++
    const usage = e.message?.usage
    if (!usage || typeof usage !== 'object') die(`schema: ${file}:${line} assistant entry has no message.usage`, 2)
    for (const f of TOKEN_FIELDS) {
      if (!Number.isInteger(usage[f])) die(`schema: ${file}:${line} missing ${f}`, 2)
    }
    const key = e.message?.id ?? e.requestId
    if (!key) die(`schema: ${file}:${line} no message.id or requestId`, 2)
    if (e.message?.model) models.add(e.message.model)
    const prev = byKey.get(key)
    if (prev) duplicates++
    byKey.set(key, TOKEN_FIELDS.map((f, i) => Math.max(prev?.[i] ?? 0, usage[f])))
  }
  const t = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }
  for (const v of byKey.values()) CLASSES.forEach((c, i) => { t[c] += v[i] })
  return {
    ...t,
    entries: entryCount,
    duplicates,
    uniqueMessages: byKey.size,
    harnessEq: t.input + t.cacheCreate,
    total: t.input + t.cacheCreate + t.cacheRead + t.output,
    models: [...models],
  }
}

// Agent-tool results in the main file: the join key to subagent files.
function launchIndex(mainEntries) {
  const byAgent = new Map()
  for (const { e } of mainEntries) {
    const r = e.toolUseResult
    if (r && typeof r === 'object' && typeof r.agentId === 'string' && !byAgent.has(r.agentId)) {
      byAgent.set(r.agentId, { description: r.description ?? null, resolvedModel: r.resolvedModel ?? null, status: r.status ?? null })
    }
  }
  return byAgent
}

function* walkAgentFiles(dir, workflowRunId = null) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'workflows') for (const wf of readdirSync(p).sort()) {
        const wfDir = join(p, wf)
        if (statSync(wfDir).isDirectory()) yield* walkAgentFiles(wfDir, wf)
      }
      continue
    }
    const m = /^agent-(.+)\.jsonl$/.exec(name)
    if (m) yield { file: p, agentId: m[1], workflowRunId }
  }
}

function readMeta(file) {
  const metaFile = join(dirname(file), basename(file).replace(/\.jsonl$/, '.meta.json'))
  if (!existsSync(metaFile)) return {}
  try { return JSON.parse(readFileSync(metaFile, 'utf8')) } catch { die(`schema: ${metaFile} is not JSON`, 2) }
}

function loadPricing(file) {
  if (!file) return null
  let table
  try { table = JSON.parse(readFileSync(file, 'utf8')) } catch { die(`pricing: ${file} unreadable or not JSON`) }
  if (typeof table.tableVersion !== 'string' || !table.tableVersion) die(`pricing: ${file} has no tableVersion`)
  if (!table.usdPerMTok || typeof table.usdPerMTok !== 'object') die(`pricing: ${file} has no usdPerMTok table`)
  return table
}

// Integer micro-dollars; null when the model is unknown or ambiguous.
function price(row, pricing) {
  if (!pricing || row.models.length !== 1) return null
  const p = pricing.usdPerMTok[row.models[0]]
  if (!p) return null
  const usd = CLASSES.reduce((acc, c) => acc + (row[c] * (p[c] ?? NaN)) / 1e6, 0)
  return Number.isFinite(usd) ? Math.round(usd * 1e6) : null
}

function measure(opts) {
  const { mainFile, subDir } = locate(opts.path)
  const pricing = loadPricing(opts.pricing)
  const mainEntries = mainFile ? readEntries(mainFile) : []
  const launches = mainFile ? launchIndex(mainEntries) : new Map()
  const session = mainFile ? sumAssistant(mainFile, mainEntries) : null

  const subagents = []
  if (subDir) for (const { file, agentId, workflowRunId } of walkAgentFiles(subDir)) {
    if (opts.agent && agentId !== opts.agent) continue
    const meta = readMeta(file)
    const launch = launches.get(agentId) ?? {}
    const sums = sumAssistant(file, readEntries(file))
    const row = {
      agentId,
      workflowRunId,
      agentType: meta.agentType ?? null,
      description: meta.description ?? launch.description ?? null,
      toolUseId: meta.toolUseId ?? null,
      finished: meta.finished === true ? true : (meta.finished === false ? false : null),
      model: sums.models.length === 1 ? sums.models[0] : (launch.resolvedModel ?? (sums.models.join('+') || null)),
      launchStatus: launch.status ?? null,
      file,
      ...sums,
    }
    row.microUsd = price(row, pricing)
    if (row.finished === false || row.entries === 0) {
      console.error(`WARN - partial: agent ${agentId} finished=${row.finished} entries=${row.entries} — measure after the agent finishes before citing Tokens:`)
    }
    subagents.push(row)
  }
  if (opts.agent && subagents.length === 0) die(`args: no subagent file for agent '${opts.agent}'`)
  const unknownDone = subagents.filter(r => r.finished === null).length
  if (unknownDone) console.error(`WARN - partial?: ${unknownDone} subagent(s) have no 'finished' flag in meta.json (older runtime or still running) — confirm the agent finished before citing Tokens:`)

  return {
    mainFile,
    subagentsDir: subDir,
    pricingTableVersion: pricing?.tableVersion ?? null,
    session: session && { ...session, microUsd: price(session, pricing) },
    subagents,
  }
}

const COLS = [
  ['agentId', r => r.agentId, 18],
  ['type', r => r.agentType ?? '-', 16],
  ['model', r => r.model ?? '-', 18],
  ['msgs', r => r.uniqueMessages, 5],
  ['dup', r => r.duplicates, 4],
  ['input', r => r.input, 8],
  ['cache_create', r => r.cacheCreate, 12],
  ['cache_read', r => r.cacheRead, 10],
  ['output', r => r.output, 8],
  ['harness_eq', r => r.harnessEq, 10],
  ['total', r => r.total, 9],
  ['usd', r => (r.microUsd == null ? '-' : (r.microUsd / 1e6).toFixed(4)), 9],
  ['done', r => (r.finished === true ? 'yes' : (r.finished === false ? 'no' : '?')), 4],
  ['run / description', r => [r.workflowRunId, r.description].filter(Boolean).join(' ').slice(0, 48), 0],
]

function printText(out) {
  const line = cells => cells.map(([v, w]) => (w ? String(v).padEnd(w) : String(v))).join(' ').trimEnd()
  console.log(line(COLS.map(([h, , w]) => [h, w])))
  for (const r of out.subagents) console.log(line(COLS.map(([, f, w]) => [f(r), w])))
  if (out.session) {
    const s = out.session
    console.log(`session (main file): msgs=${s.uniqueMessages} dup=${s.duplicates} input=${s.input} cache_create=${s.cacheCreate} cache_read=${s.cacheRead} output=${s.output} harness_eq=${s.harnessEq} total=${s.total}${s.microUsd == null ? '' : ` usd=${(s.microUsd / 1e6).toFixed(4)}`}`)
  }
  const sub = out.subagents.reduce((a, r) => a + r.total, 0)
  const subEq = out.subagents.reduce((a, r) => a + r.harnessEq, 0)
  console.log(`subagents: ${out.subagents.length} file(s), harness_eq=${subEq} (-> lifecycle Tokens:), total=${sub}${out.pricingTableVersion ? ` (pricing ${out.pricingTableVersion})` : ' (unpriced: no --pricing table)'}`)
}

const opts = parseArgs(process.argv.slice(2))
const out = measure(opts)
if (opts.json) console.log(JSON.stringify(out, null, 2))
else printText(out)
