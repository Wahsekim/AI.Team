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
