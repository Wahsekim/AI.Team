// Tests for scripts/lessons-stats.sh (teamai port P03): lesson citation
// counts from lifecycle `- Lessons:` lines, printed to stdout, never written
// into the index; threshold advisories are WARN-only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/lessons-stats.sh', import.meta.url))

const entry = (n, role, roleId, lessons) => [
  `## [${String(n).padStart(3, '0')}] ${role} (${roleId}) - 2026-11-05T00:00:00Z`,
  '- Ticket: T1',
  '- Status: completed',
  ...(lessons === undefined ? [] : [`- Lessons: ${lessons}`]),
  '',
].join('\n')

function makeRoot({ index, active, archive }) {
  const root = mkdtempSync(join(tmpdir(), 'lessons-stats-'))
  mkdirSync(join(root, 'agents', 'archive'), { recursive: true })
  writeFileSync(join(root, 'agents', 'lessons.md'), `# Lessons Index\n\n## Index\n\n${index}`)
  writeFileSync(join(root, 'agents', 'lifecycle.md'), `# Agent Lifecycle Log\n\n## Counter\n\nNext NNN to assign: **999**\n\n---\n\n${active}`)
  if (archive) writeFileSync(join(root, 'agents', 'archive', 'lifecycle-001_002.md'), archive)
  return root
}

const INDEX = [
  '- L01 - active - estimate before dispatch (owning file: agents/pm.md)',
  '- L02 - candidate - QA cites exact exit codes (owning file: agents/qa.md)',
  '- L03 - active - never trust self-report (owning file: _shared/meta-rules.md)',
  '- L04 - folded-M4 - dual-record divergence (owning file: _shared/meta-rules.md)',
  '',
].join('\n')

test('counts distinct citing entries, roles and last entry per lesson', async () => {
  const root = makeRoot({
    index: INDEX,
    active: [
      entry(3, 'QA', 'qa', 'L02, L01'),
      entry(4, 'Implementer', 'implementer', 'L01'),
      entry(5, 'Implementer', 'implementer', 'L01, L01'), // same entry twice counts once
      entry(6, 'Coach', 'coach', 'none'),
      entry(7, 'QA', 'qa'),
    ].join('\n'),
    archive: [entry(1, 'QA', 'qa', 'L01'), entry(2, 'QA', 'qa', 'L02')].join('\n'),
  })
  const { stdout } = await exec('bash', [SCRIPT, root])
  assert.match(stdout, /^L01 active cited=4 roles=2 last=\[005\]$/m)
  assert.match(stdout, /^L02 candidate cited=2 roles=1 last=\[003\]$/m)
  assert.match(stdout, /^L03 active cited=0 roles=0 last=none$/m)
  assert.match(stdout, /^L04 folded-M4 cited=0 roles=0 last=none$/m)
  assert.match(stdout, /LESSONS-STATS-OK/)
})

test('candidate with >=2 distinct citing entries gets a promote advisory', async () => {
  const root = makeRoot({
    index: INDEX,
    active: [entry(1, 'QA', 'qa', 'L02'), entry(2, 'QA', 'qa', 'L02')].join('\n'),
  })
  const { stdout } = await exec('bash', [SCRIPT, root])
  assert.match(stdout, /^WARN - promote: L02 candidate cited=2 \(>=2 distinct entries\)/m)
})

test('>=5 citations across >=2 roles gets a fold advisory', async () => {
  const root = makeRoot({
    index: INDEX,
    active: [1, 2, 3, 4].map(n => entry(n, 'QA', 'qa', 'L01')).concat(entry(5, 'Coach', 'coach', 'L01')).join('\n'),
  })
  const { stdout } = await exec('bash', [SCRIPT, root])
  assert.match(stdout, /^WARN - fold: L01 cited=5 roles=2/m)
})

test('active lesson uncited in the last 30 active entries gets a stale advisory, only once 30 exist', async () => {
  const thirty = Array.from({ length: 30 }, (_, i) => entry(i + 1, 'QA', 'qa', i === 0 ? 'L01' : 'none')).join('\n')
  const root = makeRoot({ index: INDEX, active: thirty })
  const { stdout } = await exec('bash', [SCRIPT, root])
  assert.match(stdout, /^WARN - stale: L03 active uncited in last 30 dispatches/m)
  assert.doesNotMatch(stdout, /WARN - stale: L01/) // cited within the window
  assert.doesNotMatch(stdout, /WARN - stale: L04/) // folded, not active

  const few = makeRoot({ index: INDEX, active: entry(1, 'QA', 'qa', 'none') })
  const r2 = await exec('bash', [SCRIPT, few])
  assert.doesNotMatch(r2.stdout, /WARN - stale/)
})

test('citation of a lesson missing from the index is reported; tokens inside words are not', async () => {
  const root = makeRoot({ index: INDEX, active: entry(1, 'QA', 'qa', 'L77, HTML100') })
  const { stdout } = await exec('bash', [SCRIPT, root])
  assert.match(stdout, /^WARN - unknown: L77 cited in \[001\] but not in the index/m)
  assert.doesNotMatch(stdout, /L100/)
})

test('a Lessons line before any entry header is ignored, and a root path with spaces works', async () => {
  const root = makeRoot({ index: INDEX, active: '- Lessons: L01\n\n' + entry(1, 'QA', 'qa', 'L01'), archive: '- Lessons: L01\n' })
  const { stdout } = await exec('bash', [SCRIPT, root])
  assert.match(stdout, /^L01 active cited=1 roles=1 last=\[001\]$/m)
  const spaced = join(mkdtempSync(join(tmpdir(), 'lessons stats ')), 'my kit')
  mkdirSync(join(spaced, 'agents'), { recursive: true })
  writeFileSync(join(spaced, 'agents', 'lessons.md'), INDEX)
  writeFileSync(join(spaced, 'agents', 'lifecycle.md'), entry(1, 'QA', 'qa', 'L01'))
  const r2 = await exec('bash', [SCRIPT, spaced])
  assert.match(r2.stdout, /^L01 active cited=1 roles=1 last=\[001\]$/m)
})

test('empty index is reported without failing', async () => {
  const root = makeRoot({ index: '<!-- none yet -->\n', active: entry(1, 'QA', 'qa', 'none') })
  const { stdout } = await exec('bash', [SCRIPT, root])
  assert.match(stdout, /no lessons in index/)
  assert.match(stdout, /LESSONS-STATS-OK/)
})

// The kit ships ledgers as seeds only (ADR 0009); a root seeded from them must run clean.
test('ledgers freshly seeded from the kit templates run clean', async () => {
  const KIT = fileURLToPath(new URL('..', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'lessons-stats-seeded-'))
  try {
    mkdirSync(join(root, 'agents'))
    for (const name of ['lessons', 'lifecycle']) copyFileSync(join(KIT, `agents/${name}.template.md`), join(root, `agents/${name}.md`))
    const { stdout } = await exec('bash', [SCRIPT, root])
    assert.match(stdout, /LESSONS-STATS-OK/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('missing files and unknown flags fail fast', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'lessons-stats-empty-'))
  for (const args of [[empty], ['--bogus']]) {
    try {
      await exec('bash', [SCRIPT, ...args])
      assert.fail('expected exit 1')
    } catch (e) {
      assert.equal(e.code, 1)
      assert.match(String(e.stdout), /FAIL - /)
    }
  }
})
