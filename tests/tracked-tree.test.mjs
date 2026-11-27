// Every tracked file lands in each deployed team's kit/ folder, so the kit
// tracks no development traces and keeps its README short.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const README_MAX_LINES = 200

const tracked = () => execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)

test('docs track no development history folder and no dated file or folder', () => {
  const traces = tracked().filter(path => path.startsWith('docs/')
    && (/(^|\/)history\//i.test(path) || /\d{4}-\d{2}-\d{2}/.test(path)))
  assert.deepEqual(traces, [], `development traces are tracked: ${traces.join(', ')}. `
    + 'Move each to dev-notes/ at the repository root, which Git ignores, and repair the links to it')
})

test(`README.md stays within ${README_MAX_LINES} lines`, () => {
  const lines = readFileSync(`${ROOT}/README.md`, 'utf8').trimEnd().split('\n').length
  assert.ok(lines <= README_MAX_LINES, `README.md has ${lines} lines, over ${README_MAX_LINES}. `
    + 'Move the detail to the doc that owns the subject and link to it from the README')
})
