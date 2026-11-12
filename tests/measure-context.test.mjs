// Tests for scripts/measure-context.sh (remediation plan P1-05):
// ratchet behavior — pass within budget, fail when a set exceeds it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/measure-context.sh', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('kit is within the recorded context budgets', async () => {
  const { stdout } = await exec('bash', [SCRIPT, ROOT])
  assert.match(stdout, /PASS - PM wake set within budget/)
  assert.match(stdout, /PASS - Worker read set/)
  assert.match(stdout, /CONTEXT-BUDGETS-OK/)
})

test('exceeding a budget exits 1 (ratchet)', async () => {
  try {
    await exec('bash', [SCRIPT, '--budget-pm', '100', ROOT])
    assert.fail('expected nonzero exit when budget is exceeded')
  } catch (e) {
    assert.equal(e.code, 1)
    assert.match(String(e.stdout), /CONTEXT-BUDGET-EXCEEDED/)
  }
})

test('unknown flag fails fast', async () => {
  try {
    await exec('bash', [SCRIPT, '--bogus', ROOT])
    assert.fail('expected nonzero exit for unknown flag')
  } catch (e) {
    assert.equal(e.code, 1)
    assert.match(String(e.stdout), /FAIL - args/)
  }
})

// Review 2026-11-12 R4: a two-root instance reads most of its closure from kit/.
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

function instance(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'measure-two-root-'))), kit = join(root, 'kit')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n')
    .filter(path => path && !/^(tests|src|docs\/design|\.github)\//.test(path))) {
    mkdirSync(dirname(join(kit, path)), { recursive: true }); cpSync(join(ROOT, path), join(kit, path))
  }
  const boot = spawnSync('bash', [join(kit, 'scripts/bootstrap-team.sh'), '--project-name', 'Meter Fixture', root], { encoding: 'utf8' })
  assert.equal(boot.status, 0, boot.stdout + boot.stderr)
  mkdirSync(join(root, '.claude/agents'), { recursive: true })
  writeFileSync(join(root, '.claude/agents/meter-fixture-backend.md'), '---\nname: "meter-fixture-backend"\n---\n\nRead agents/backend.md, profiles/project.md and profiles/stack.md.\n')
  return { root, kit, measure: (...args) => spawnSync('bash', [join(kit, 'scripts/measure-context.sh'), ...args, root], { encoding: 'utf8' }) }
}

test('two-root: required reads that live in kit/ are counted, and both primers are in the PM set', t => {
  const f = instance(t), run = f.measure('--budget-pm', '60000', '--budget-worker', '60000')
  assert.equal(run.status, 0, run.stdout)
  assert.doesNotMatch(run.stdout, /\(missing\)/)
  for (const path of ['kit/agents/pm.md', 'kit/agents/_shared/meta-rules.md', 'kit/docs/workflow-catalog.md', 'kit/CLAUDE.md', 'kit/agents/templates.md', 'kit/agents/backend.md'])
    assert.match(run.stdout, new RegExp(`~ *\\d+ tok  ${path.replace(/[.]/g, '\\.')}\\n`), `${path} is counted`)
  for (const path of ['CLAUDE.md', 'charter.md', 'profiles/project.md', 'agents/lessons.md', '.claude/agents/meter-fixture-backend.md'])
    assert.match(run.stdout, new RegExp(`tok  ${path.replace(/[.]/g, '\\.')}\\n`), `${path} is read from the instance`)
  assert.match(run.stdout, /Worker read set \(\.claude\/agents\/meter-fixture-backend\.md \+ kit\/agents\/backend\.md\)/)
  assert.match(run.stdout, /RESULT: CONTEXT-BUDGETS-OK/)
})

test('two-root: a missing required file fails the measurement instead of being skipped', t => {
  const f = instance(t); rmSync(join(f.kit, 'agents/pm.md'))
  const run = f.measure('--budget-pm', '60000', '--budget-worker', '60000')
  assert.equal(run.status, 1, run.stdout)
  assert.match(run.stdout, /FAIL - .*agents\/pm\.md/); assert.match(run.stdout, /RESULT: CONTEXT-MEASUREMENT-INCOMPLETE/)
  assert.doesNotMatch(run.stdout, /CONTEXT-BUDGETS-OK/)
})

test('two-root: an oversized kit-only policy trips the ratchet', t => {
  const f = instance(t), within = f.measure('--budget-pm', '60000', '--budget-worker', '60000')
  assert.equal(within.status, 0, within.stdout)
  appendFileSync(join(f.kit, 'agents/_shared/meta-rules.md'), 'x'.repeat(400000))
  const run = f.measure('--budget-pm', '60000', '--budget-worker', '60000')
  assert.equal(run.status, 1, run.stdout); assert.match(run.stdout, /RESULT: CONTEXT-BUDGET-EXCEEDED/)
})

test('a missing required file also fails in a single-root kit', t => {
  const f = instance(t), run = spawnSync('bash', [join(f.kit, 'scripts/measure-context.sh'), f.kit], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout)
  rmSync(join(f.kit, 'docs/workflow-catalog.md'))
  const broken = spawnSync('bash', [join(f.kit, 'scripts/measure-context.sh'), f.kit], { encoding: 'utf8' })
  assert.equal(broken.status, 1, broken.stdout); assert.match(broken.stdout, /RESULT: CONTEXT-MEASUREMENT-INCOMPLETE/)
})
