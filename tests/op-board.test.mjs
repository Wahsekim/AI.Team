// Runs the Python failure-injection suite for scripts/op-board.py (review
// F-04) under the standard `node --test tests/*.test.mjs` command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
const hasPython = !probe.error && probe.status === 0

test('op-board.py: Python unittest suite (target-first journaled move, failure injection)',
  { skip: hasPython ? false : 'python3 not on PATH — Python suite not executed' }, () => {
    const r = spawnSync('python3', ['-m', 'unittest', 'tests/op_board_test.py'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /^OK/m)
  })
