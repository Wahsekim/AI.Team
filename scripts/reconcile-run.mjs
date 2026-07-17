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
// applied. "Already applied" means BLOCK IDENTITY, not marker presence (R6-08):
// an existing block for this runId that differs from the payload (truncated,
// different date, diverging content) fails closed before any write.
// Writes are tmp-file + rename (atomic on POSIX filesystems).
//
// NOT automated here (PM-authored, serial-PM-only): pm-decisions.md lines and
// tracker transitions — the tool prints reminders for both.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs'
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
    if (!owner || !Number.isInteger(owner.pid)) {
      // R6-09: missing/corrupt metadata may just be a concurrent acquirer
      // inside its mkdir->writeFile init window — grace-wait and re-read
      // before judging, instead of reclaiming a lock that is being born.
      await new Promise(r => setTimeout(r, 300))
      try { owner = JSON.parse(await readFile(LOCK_META, 'utf8')) } catch { /* still ownerless */ }
      if (!owner || !Number.isInteger(owner.pid)) {
        // Still ownerless after the grace re-read: reclaim ONLY a demonstrably
        // old lock — a FRESH ownerless lock is treated as held (R6-09).
        let lockMtimeMs = null
        try { lockMtimeMs = statSync(LOCK_DIR).mtimeMs } catch { /* dir vanished — retry below */ }
        if (lockMtimeMs !== null && Date.now() - lockMtimeMs < 10_000) {
          die(`another reconcile appears to be in progress (${LOCK_DIR} is ownerless but fresh) — wait for it, or remove the lock manually if it persists`)
        }
      }
    }
    const ownerAlive = owner && Number.isInteger(owner.pid) && (() => {
      try { process.kill(owner.pid, 0); return true } catch { return false }
    })()
    if (ownerAlive) die(`another reconcile is in progress (pid ${owner.pid} since ${owner.startedAt}) — wait for it`)
    if (retried) die(`cannot acquire ${LOCK_DIR} even after clearing a stale lock — resolve manually`)
    // Stale lock (owner dead, or ownerless past the grace + age gate): recover
    // and retry once.
    try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* fall through to retry */ }
    return acquireLock(true)
  }
}
await acquireLock()
// Ownership-verified release (R6-09): re-read the recorded pid at exit and
// delete the lock ONLY if it is our own — a process exiting after losing a
// race must never clean up someone else's live lock.
process.on('exit', () => {
  try {
    const owner = JSON.parse(readFileSync(LOCK_META, 'utf8'))
    if (owner.pid === process.pid) rmSync(LOCK_DIR, { recursive: true, force: true })
  } catch { /* not ours / unreadable / already gone — leave it */ }
})

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
// Single-line invariant (R6-08): every lifecycleEntries element is ONE ledger
// line — an element embedding '\n## [999] ...' would forge entries past every
// line-anchored check below. messagesLogBlock is multi-line by design, but
// its lines must not carry CRs (they would poison later line-anchored parsing).
todo.lifecycleEntries.forEach((l, i) => {
  if (typeof l !== 'string' || /[\r\n]/.test(l)) die(`lifecycleEntries[${i}] must be a single newline-free string — embedded line breaks forge ledger entries`)
})
if (/\r/.test(todo.messagesLogBlock)) die('messagesLogBlock contains CR characters — refusing to write them into the ledger')
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
// Canonical-header invariant (R6-08): the idempotency check anchors on this
// EXACT prefix (built from the validated date + runId), so a payload header in
// any other form could never be recognized as applied and would duplicate.
const msgCanonicalPrefix = `## ${date} — run-n-rounds batch ${runId} (`
if (!msgHeader.startsWith(msgCanonicalPrefix)) die(`messagesLogBlock header is not the canonical '${msgCanonicalPrefix}...)' form emitted by the engine — refusing a block the idempotency check could never re-recognize`)

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
// "Already applied" means BLOCK IDENTITY (R6-08): each finder returns the
// existing on-disk block for this runId so it can be compared line-by-line
// with the payload BEFORE anything is written — a bare header, a truncated
// block, or a diverging one must fail closed, never SKIP.
// Lifecycle block: the '### BATCH <date> <runId> — ...' header plus all
// IMMEDIATELY following '## [' entry lines.
function findLifecycleBlock(text, id) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^### BATCH (\d{4}-\d{2}-\d{2}) (\S+) /.exec(lines[i])
    if (!m || m[2] !== id) continue
    const block = [lines[i]]
    for (let j = i + 1; j < lines.length && lines[j].startsWith('## ['); j++) block.push(lines[j])
    return { block, headerDate: m[1] }
  }
  return null
}
// Messages block: anchored to the CANONICAL header prefix built from the
// validated date + runId (R6-08, supersedes the R5-07 regex): a prose H2 that
// merely mentions 'run-n-rounds batch <runId> (' must never count as the
// applied block. The block runs from the header line to the line before the
// next '## ' heading, or EOF.
function findMessagesBlock(text, prefix) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith(prefix))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('## ')) end++
  return lines.slice(start, end)
}
const stripTrailingBlank = lines => {
  const out = [...lines]
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}
const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i])

// ---- read BOTH targets and settle block identity BEFORE any write (R6-08):
// a mismatch in either target must abort with the counter untouched.
if (!existsSync(lifecyclePath)) die(`missing ${lifecyclePath} — not a deployed AI.Team root? (pass TEAM_ROOT)`)
let lifecycle = await readFile(lifecyclePath, 'utf8')
const existingLc = findLifecycleBlock(lifecycle, runId)
if (existingLc) {
  if (existingLc.headerDate !== date) {
    die(`agents/lifecycle.md already carries a BATCH block for runId ${runId} dated ${existingLc.headerDate}, but this result is dated ${date} — same runId reused for a different date (runId collision). Nothing was written.`)
  }
  if (existingLc.block.length < todo.lifecycleEntries.length) {
    die(`agents/lifecycle.md BATCH block for runId ${runId} is TRUNCATED — ${existingLc.block.length - 1} entries on disk vs ${todo.lifecycleEntries.length - 1} in the payload (an earlier write was cut short); repair the ledger manually, then re-run. Nothing was written.`)
  }
  if (!sameLines(existingLc.block, todo.lifecycleEntries)) {
    die(`agents/lifecycle.md BATCH block for runId ${runId} DIVERGES from this result's block — refusing to treat it as applied; reconcile the ledger manually. Nothing was written.`)
  }
}
const existingMsg = existsSync(messagesPath)
  ? findMessagesBlock(await readFile(messagesPath, 'utf8'), msgCanonicalPrefix)
  : null
if (existingMsg && !sameLines(stripTrailingBlank(existingMsg), stripTrailingBlank(todo.messagesLogBlock.split('\n')))) {
  die(`messages/${date}.md block for runId ${runId} DIVERGES from this result's block (truncated or altered earlier write) — refusing to treat it as applied; repair it manually. Nothing was written.`)
}

// ---- target 1: agents/lifecycle.md (block + counter, one atomic write) ----
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
if (existingLc) {
  actions.push(`SKIP - lifecycle: runId ${runId} already applied (block identical)`)
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
// (identity of an existing block was already settled above — R6-08)
if (existingMsg) {
  actions.push(`SKIP - messages/${date}.md: runId ${runId} already applied (block identical)`)
} else {
  await mkdir(dirname(messagesPath), { recursive: true })
  const messages = existsSync(messagesPath) ? await readFile(messagesPath, 'utf8') : ''
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
