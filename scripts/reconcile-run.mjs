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
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const die = msg => { console.error(`FAIL - ${msg}`); process.exit(1) }

const [, , resultPath, rootArg] = process.argv
if (!resultPath) die('usage: node scripts/reconcile-run.mjs <engine-result.json> [TEAM_ROOT]')
const ROOT = resolve(rootArg || '.')

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

const batchHeader = todo.lifecycleEntries[0]
const dateMatch = /^### BATCH (\d{4}-\d{2}-\d{2}) /.exec(batchHeader)
if (!dateMatch) die(`lifecycleEntries[0] is not a '### BATCH <date> ...' header: ${batchHeader.slice(0, 80)}`)
if (!batchHeader.includes(runId)) die('BATCH header does not carry the runId — refusing to apply a mismatched block')
const date = dateMatch[1]

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

// ---- target 1: agents/lifecycle.md (block + counter, one atomic write) ----
if (!existsSync(lifecyclePath)) die(`missing ${lifecyclePath} — not a deployed AI.Team root? (pass TEAM_ROOT)`)
let lifecycle = await readFile(lifecyclePath, 'utf8')
const lcHasRun = lifecycle.split('\n').some(l => l.startsWith('### BATCH ') && l.includes(runId))
let lifecycleChanged = false
if (lcHasRun) {
  actions.push(`SKIP - lifecycle: runId ${runId} already applied`)
} else {
  lifecycle = lifecycle.replace(/\n*$/, '\n\n') + todo.lifecycleEntries.join('\n') + '\n'
  lifecycleChanged = true
  actions.push(`APPLY - lifecycle: BATCH block (${todo.lifecycleEntries.length - 1} entries) appended`)
}
// Counter update (drift fix): the paste block never carried it; the tool owns it.
const counterRe = /(Next NNN to assign[^\d]*)(\d+)/
const counterMatch = counterRe.exec(lifecycle)
if (!counterMatch) {
  actions.push('WARN - lifecycle: no "Next NNN to assign" counter line found — update it manually')
} else {
  const current = parseInt(counterMatch[2], 10)
  const target = todo.nextLifecycleNumberAfter
  if (current === target) {
    actions.push(`OK   - lifecycle counter already ${NNN(target)}`)
  } else if (current > target) {
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
if (messages.includes(runId)) {
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
