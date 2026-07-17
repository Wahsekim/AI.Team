#!/usr/bin/env node
// reconcile-run.mjs — atomic, idempotent application of a run-n-rounds result
// to the audit ledgers (remediation N-09: manual multi-file pasting was
// non-atomic, idempotency looked only at lifecycle, and the counter drifted).
//
// Usage: node scripts/reconcile-run.mjs <engine-result.json> [TEAM_ROOT]
//
// What it does, per target, independently (so a crash between targets is
// repaired by simply re-running):
//   agents/lifecycle.md   append the BATCH block IF its runId is not present;
//                         then set 'Next NNN to assign' to nextLifecycleNumberAfter
//   messages/<date>.md    append the messages block IF its runId is not present
//
// Idempotency is checked in EVERY target file — a partial earlier write (e.g.
// lifecycle applied, then crash) is detected and only the missing targets are
// applied. Writes are tmp-file + rename (atomic on POSIX filesystems).
//
// NOT automated here (PM-authored, serial-PM-only): pm-decisions.md lines and
// tracker transitions — the tool prints reminders for both.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const die = msg => { console.error(`FAIL - ${msg}`); process.exit(1) }

const [, , resultPath, rootArg] = process.argv
if (!resultPath) die('usage: node scripts/reconcile-run.mjs <engine-result.json> [TEAM_ROOT]')
const ROOT = resolve(rootArg || '.')

// Concurrency lock (R-06/F-06): two concurrent reconciles would each read->
// append->rename and the last writer would silently drop the other's block.
// mkdir is atomic; the lock carries owner metadata so a crash (SIGKILL, power
// loss) does not require manual cleanup: a lock whose PID is dead is stale
// and is taken over.
const LOCK_DIR = join(ROOT, '.reconcile-lock')
const LOCK_META = join(LOCK_DIR, 'owner.json')
async function acquireLock(retried = false) {
  try {
    await mkdir(LOCK_DIR)
    await writeFile(LOCK_META, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    return
  } catch {
    let owner = null
    try { owner = JSON.parse(await readFile(LOCK_META, 'utf8')) } catch { /* no/corrupt metadata */ }
    const ownerAlive = owner && Number.isInteger(owner.pid) && (() => {
      try { process.kill(owner.pid, 0); return true } catch { return false }
    })()
    if (ownerAlive) die(`another reconcile is in progress (pid ${owner.pid} since ${owner.startedAt}) — wait for it`)
    if (retried) die(`cannot acquire ${LOCK_DIR} even after clearing a stale lock — resolve manually`)
    // Stale lock (owner dead or metadata missing): recover and retry once.
    try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* fall through to retry */ }
    return acquireLock(true)
  }
}
await acquireLock()
process.on('exit', () => { try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* best effort */ } })

let result
try {
  result = JSON.parse(await readFile(resultPath, 'utf8'))
} catch (e) {
  die(`cannot read/parse result JSON at ${resultPath}: ${e.message}`)
}

const runId = result.runId
const todo = result.mainSessionTodo
if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(runId)) die('result.runId missing or invalid')
if (!todo || !Array.isArray(todo.lifecycleEntries) || todo.lifecycleEntries.length === 0) die('result.mainSessionTodo.lifecycleEntries missing/empty')
if (typeof todo.messagesLogBlock !== 'string' || todo.messagesLogBlock.length === 0) die('result.mainSessionTodo.messagesLogBlock missing/empty')
if (!Number.isSafeInteger(todo.nextLifecycleNumberAfter) || todo.nextLifecycleNumberAfter < 1) die('result.mainSessionTodo.nextLifecycleNumberAfter missing/invalid')

// ---- payload invariants (F-06): the block must be internally consistent
// BEFORE anything is written — a malformed result must never corrupt ledgers.
const batchHeader = todo.lifecycleEntries[0]
const headerMatch = /^### BATCH (\d{4}-\d{2}-\d{2}) (\S+) /.exec(batchHeader)
if (!headerMatch) die(`lifecycleEntries[0] is not a '### BATCH <date> <runId> ...' header: ${batchHeader.slice(0, 80)}`)
if (headerMatch[2] !== runId) die(`BATCH header carries runId '${headerMatch[2]}' but result.runId is '${runId}' — refusing to apply a mismatched block`)
const date = headerMatch[1]
// Real CALENDAR date, not just the shape (R5-07): '2026-99-99' must never
// name a messages/<date>.md file.
const isRealDate = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const y = +m[1], mo = +m[2], d = +m[3]
  if (mo < 1 || mo > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
}
if (!isRealDate(date)) die(`BATCH header date '${date}' is not a real calendar date — refusing to create ledger targets from it`)

// Entry numbers must be parsed from the ACTUAL '## [NNN]' lines — consecutive,
// ending exactly at nextLifecycleNumberAfter - 1 (never inferred from array length).
const entryNos = todo.lifecycleEntries.slice(1).map((l, i) => {
  const m = /^## \[(\d+)\] /.exec(l)
  if (!m) die(`lifecycleEntries[${i + 1}] is not a '## [NNN] ...' entry: ${l.slice(0, 80)}`)
  return parseInt(m[1], 10)
})
if (entryNos.length === 0) die('BATCH block has no entries')
entryNos.forEach((n, i) => {
  if (i > 0 && n !== entryNos[i - 1] + 1) die(`BATCH entry numbers are not consecutive: [${String(entryNos[i - 1]).padStart(3, '0')}] -> [${String(n).padStart(3, '0')}]`)
})
if (entryNos[entryNos.length - 1] !== todo.nextLifecycleNumberAfter - 1) {
  die(`last BATCH entry is [${String(entryNos[entryNos.length - 1]).padStart(3, '0')}] but nextLifecycleNumberAfter is ${todo.nextLifecycleNumberAfter} — inconsistent payload`)
}

// The messages block must belong to the SAME run: date + exact runId token.
const msgHeader = todo.messagesLogBlock.split('\n')[0] || ''
const msgMatch = /^## (\d{4}-\d{2}-\d{2}) .*run-n-rounds batch (\S+) \(/.exec(msgHeader)
if (!msgMatch) die(`messagesLogBlock does not start with '## <date> — run-n-rounds batch <runId> (...': ${msgHeader.slice(0, 80)}`)
if (msgMatch[1] !== date || msgMatch[2] !== runId) die(`messagesLogBlock is for ${msgMatch[1]}/${msgMatch[2]} but the lifecycle block is for ${date}/${runId} — inconsistent payload`)

const NNN = n => String(n).padStart(3, '0')
const lifecyclePath = join(ROOT, 'agents', 'lifecycle.md')
const messagesPath = join(ROOT, 'messages', `${date}.md`)

// Atomic write: same-directory tmp + rename.
async function atomicWrite(path, content) {
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.reconcile-tmp`)
  await writeFile(tmp, content)
  await rename(tmp, path)
}

const actions = []

// Exact-token runId matching (R-06): includes() would let run-1 match run-10.
// The BATCH header format is '### BATCH <date> <runId> — ...'; messages headers
// carry 'run-n-rounds batch <runId> ('.
const lcHasRunId = (text, id) => text.split('\n').some(l => {
  const m = /^### BATCH \d{4}-\d{2}-\d{2} (\S+) /.exec(l)
  return m && m[1] === id
})
// Anchored to the CANONICAL header line (R5-07): a prose mention of the runId
// ('we expect run-n-rounds batch X (3 rounds) to land later') must never count
// as an applied block — that false-skip would drop the canonical block forever.
const msgHasRunId = (text, id) => text.split('\n').some(l => {
  const m = /^## \d{4}-\d{2}-\d{2} .*run-n-rounds batch (\S+) \(/.exec(l)
  return m && m[1] === id
})

// ---- target 1: agents/lifecycle.md (block + counter, one atomic write) ----
if (!existsSync(lifecyclePath)) die(`missing ${lifecyclePath} — not a deployed AI.Team root? (pass TEAM_ROOT)`)
let lifecycle = await readFile(lifecyclePath, 'utf8')
const lcHasRun = lcHasRunId(lifecycle, runId)
const firstEntryNo = entryNos[0]   // parsed from the actual '## [NNN]' lines (F-06)
const counterRe = /(Next NNN to assign[^\d]*)(\d+)/
const counterMatch = counterRe.exec(lifecycle)
// Counter PRECONDITION (R-06/F-06, hoisted for R5-07): a MISSING counter is
// fail-closed on EVERY path — including a batch that was already applied
// earlier. The validator FAILs deployments without a counter; writing any
// target here (even just messages) and exiting 0 would contradict it.
if (!counterMatch) {
  die(`agents/lifecycle.md has no 'Next NNN to assign' counter line — required before reconciling (scripts/validate-team.sh flags this); add it, then re-run. Nothing was written.`)
}
let lifecycleChanged = false
if (lcHasRun) {
  actions.push(`SKIP - lifecycle: runId ${runId} already applied`)
} else {
  // Numbering PRECONDITION: appending an unapplied batch whose numbering does
  // not line up with the live counter would create duplicate or gapped [NNN]
  // entries — fail closed instead of writing a corrupt ledger.
  const current = parseInt(counterMatch[2], 10)
  if (current !== firstEntryNo) {
    die(`lifecycle counter is ${NNN(current)} but this batch's entries start at ${NNN(firstEntryNo)} — numbering conflict (another batch ran since this result was produced?). Re-invoke the engine with nextLifecycleNumber=${current}, or resolve the ledger manually. Nothing was written.`)
  }
  lifecycle = lifecycle.replace(/\n*$/, '\n\n') + todo.lifecycleEntries.join('\n') + '\n'
  lifecycleChanged = true
  actions.push(`APPLY - lifecycle: BATCH block (${entryNos.length} entries) appended`)
}
// Counter update (drift fix): the paste block never carried it; the tool owns it.
// (A missing counter already died above — R5-07.)
{
  const current = parseInt(counterRe.exec(lifecycle)[2], 10)
  const target = todo.nextLifecycleNumberAfter
  if (current === target) {
    actions.push(`OK   - lifecycle counter already ${NNN(target)}`)
  } else if (current > target) {
    // Reachable only when the batch was ALREADY applied earlier and later
    // batches advanced the counter — informational, never a rewind.
    actions.push(`WARN - lifecycle counter ${NNN(current)} is AHEAD of this run's ${NNN(target)} — a later batch already advanced it; left untouched`)
  } else {
    lifecycle = lifecycle.replace(counterRe, `$1${NNN(target)}`)
    lifecycleChanged = true
    actions.push(`APPLY - lifecycle counter ${NNN(current)} -> ${NNN(target)}`)
  }
}
if (lifecycleChanged) await atomicWrite(lifecyclePath, lifecycle)

// ---- target 2: messages/<date>.md ----
await mkdir(dirname(messagesPath), { recursive: true })
let messages = existsSync(messagesPath) ? await readFile(messagesPath, 'utf8') : ''
if (msgHasRunId(messages, runId)) {
  actions.push(`SKIP - messages/${date}.md: runId ${runId} already applied`)
} else {
  const next = (messages ? messages.replace(/\n*$/, '\n\n') : '') + todo.messagesLogBlock + '\n'
  await atomicWrite(messagesPath, next)
  actions.push(`APPLY - messages/${date}.md: batch block appended`)
}

for (const a of actions) console.log(a)
const applied = actions.filter(a => a.startsWith('APPLY')).length
const skipped = actions.filter(a => a.startsWith('SKIP')).length
console.log(applied === 0
  ? `RESULT: ALREADY-RECONCILED — runId ${runId} present in all targets, nothing written.`
  : skipped > 0
    ? `RESULT: PARTIAL-REPAIRED — ${applied} missing target(s) applied for runId ${runId} (earlier partial write detected).`
    : `RESULT: RECONCILED — runId ${runId} applied to all targets.`)
console.log('REMINDER: pm-decisions.md lines (one dispatch+close per iter from results[]) and tracker transitions stay PM-authored — do them now, attended.')
