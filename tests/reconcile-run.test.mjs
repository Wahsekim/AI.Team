// Tests for scripts/reconcile-run.mjs (reassessment N-09): atomic multi-target
// reconciliation, per-target idempotency (partial-write repair), counter update.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/reconcile-run.mjs', import.meta.url))

const RESULT = {
  runId: 'run-2026-07-16-002',
  mainSessionTodo: {
    nextLifecycleNumberAfter: 4,
    lifecycleEntries: [
      '### BATCH 2026-07-16 run-2026-07-16-002 — run-n-rounds N=1, dispatched 1, halt: count-complete',
      '## [002] proj-builder T-1 — verifier PASS, ~500 tok worker / ~200 tok verifier, done',
      '## [003] guardian (chaos) — status: ok, verdict: clean, runaway=false, missedHalt=false, budgetGate=true, droppedFixRetest=false, ~100 tok',
    ],
    messagesLogBlock: [
      '## 2026-07-16 — run-n-rounds batch run-2026-07-16-002 (N=1, dispatched 1, halt: count-complete)',
      '',
      '- [002] iter1 T-1 (proj-builder): verifier PASS — done',
      '- Halt reason: count-complete; fixRetestQueue=0; recoveryQueue=0; guardian=ok/clean',
    ].join('\n'),
  },
}

const LIFECYCLE = '# Lifecycle\n\n## [001] bootstrap — deployed\n\nNext NNN to assign: 002\n'

async function withDeployment(fn) {
  const root = await mkdtemp(join(tmpdir(), 'ai-team-reconcile-'))
  try {
    await mkdir(join(root, 'agents'), { recursive: true })
    await mkdir(join(root, 'messages'), { recursive: true })
    await writeFile(join(root, 'agents', 'lifecycle.md'), LIFECYCLE)
    const resultPath = join(root, 'result.json')
    await writeFile(resultPath, JSON.stringify(RESULT))
    return await fn(root, resultPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runTool(resultPath, root) {
  try {
    const { stdout } = await exec('node', [SCRIPT, resultPath, root])
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.code, out: (e.stdout || '') + (e.stderr || '') }
  }
}

test('fresh apply: blocks appended to lifecycle + messages, counter advanced', async () => {
  await withDeployment(async (root, resultPath) => {
    const { code, out } = await runTool(resultPath, root)
    assert.equal(code, 0, out)
    assert.match(out, /RESULT: RECONCILED/)
    const lc = await readFile(join(root, 'agents', 'lifecycle.md'), 'utf8')
    assert.match(lc, /### BATCH 2026-07-16 run-2026-07-16-002/)
    assert.match(lc, /## \[002\] proj-builder/)
    assert.match(lc, /## \[003\] guardian/)
    assert.match(lc, /Next NNN to assign: 004/, 'counter must advance to nextLifecycleNumberAfter (N-09 drift fix)')
    const msg = await readFile(join(root, 'messages', '2026-07-16.md'), 'utf8')
    assert.match(msg, /run-n-rounds batch run-2026-07-16-002/)
  })
})

test('second run: fully idempotent, nothing duplicated', async () => {
  await withDeployment(async (root, resultPath) => {
    await runTool(resultPath, root)
    const { code, out } = await runTool(resultPath, root)
    assert.equal(code, 0, out)
    assert.match(out, /ALREADY-RECONCILED/)
    const lc = await readFile(join(root, 'agents', 'lifecycle.md'), 'utf8')
    assert.equal(lc.match(/### BATCH/g).length, 1, 'BATCH block must not duplicate')
    const msg = await readFile(join(root, 'messages', '2026-07-16.md'), 'utf8')
    assert.equal(msg.match(/run-n-rounds batch/g).length, 1)
  })
})

test('N-09: partial earlier write (lifecycle only) is detected and repaired, not masked', async () => {
  await withDeployment(async (root, resultPath) => {
    // Simulate: a previous manual paste reached lifecycle, then crashed before messages.
    const lc = LIFECYCLE + '\n' + RESULT.mainSessionTodo.lifecycleEntries.join('\n') + '\n'
    await writeFile(join(root, 'agents', 'lifecycle.md'), lc)
    const { code, out } = await runTool(resultPath, root)
    assert.equal(code, 0, out)
    assert.match(out, /SKIP - lifecycle/)
    assert.match(out, /APPLY - messages/)
    assert.match(out, /PARTIAL-REPAIRED/)
    const msg = await readFile(join(root, 'messages', '2026-07-16.md'), 'utf8')
    assert.match(msg, /run-2026-07-16-002/)
  })
})

test('counter ahead of this run is left untouched with a warning (later batch already advanced it)', async () => {
  await withDeployment(async (root, resultPath) => {
    await writeFile(join(root, 'agents', 'lifecycle.md'), LIFECYCLE.replace('002', '009'))
    const { code, out } = await runTool(resultPath, root)
    assert.equal(code, 0, out)
    assert.match(out, /WARN - lifecycle counter 009 is AHEAD/)
    const lc = await readFile(join(root, 'agents', 'lifecycle.md'), 'utf8')
    assert.match(lc, /Next NNN to assign: 009/)
  })
})

test('malformed result JSON -> exit 1', async () => {
  await withDeployment(async (root, resultPath) => {
    await writeFile(resultPath, '{broken')
    const { code, out } = await runTool(resultPath, root)
    assert.equal(code, 1, out)
    assert.match(out, /FAIL/)
  })
})

test('result whose BATCH header lacks the runId is refused', async () => {
  await withDeployment(async (root, resultPath) => {
    const bad = structuredClone(RESULT)
    bad.mainSessionTodo.lifecycleEntries[0] = '### BATCH 2026-07-16 some-other-run — run-n-rounds N=1'
    await writeFile(resultPath, JSON.stringify(bad))
    const { code, out } = await runTool(resultPath, root)
    assert.equal(code, 1, out)
    assert.match(out, /mismatched/)
  })
})

test('missing lifecycle.md (wrong root) fails instead of creating ledgers in the void', async () => {
  await withDeployment(async (root, resultPath) => {
    await rm(join(root, 'agents', 'lifecycle.md'))
    const { code, out } = await runTool(resultPath, root)
    assert.equal(code, 1, out)
    assert.match(out, /missing/)
  })
})
