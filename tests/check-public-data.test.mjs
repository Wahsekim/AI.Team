import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = fileURLToPath(new URL('../scripts/check-public-data.sh', import.meta.url))
const TRACKER_ID = ['op', '7'].join('#')

function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'public-data-'))
  execFileSync('git', ['init', '-q', root])
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  execFileSync('git', ['-C', root, 'add', '.'])
  return root
}

const run = (root, denylist) => spawnSync('bash', [SCRIPT, root], {
  encoding: 'utf8', env: { ...process.env, PUBLIC_DATA_DENYLIST: denylist ?? '' },
})

test('a clean tree passes', () => {
  const r = run(repoWith({ 'a.md': 'Sample Project, ticket T-1\n' }), 'acme\n')
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /RESULT: CLEAN — 2 pattern\(s\)/)
})

test('a tracker id fails without any denylist', () => {
  const r = run(repoWith({ 'a.md': `ok\nfix: ${TRACKER_ID} thing\n` }))
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL - pattern 1 matches at a\.md:2/)
})

test('a denylisted name fails case-insensitively and the log never shows it', () => {
  const r = run(repoWith({ 'a.md': 'x\n', 'b.json': '{"name": "ACME Widget"}\n' }), 'acme widget\n\nzeta\n')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL - pattern 2 matches at b\.json:1/)
  assert.doesNotMatch(r.stdout, /acme|widget/i)
  assert.match(r.stdout, /RESULT: CLIENT-DATA-FOUND — 1 line/)
})

test('an untracked file is not scanned', () => {
  const root = repoWith({ 'a.md': 'clean\n' })
  writeFileSync(join(root, 'scratch.md'), `${TRACKER_ID}\n`)
  assert.equal(run(root).status, 0)
})
