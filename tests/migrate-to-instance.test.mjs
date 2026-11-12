// ADR 0009: migrate a legacy single-root deployment into a two-root instance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, access, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIGRATE = join(ROOT, 'scripts/migrate-to-instance.sh')
const git = (dir, ...args) => exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args])
const exists = p => access(p).then(() => true, () => false)
const snapshot = async dir => (await exec('bash', ['-c', 'cd "$1" && find . -path ./.git -prune -o -type f -exec shasum -a 256 {} + | sort; git status --porcelain --ignored', 'sh', dir])).stdout

const KIT = {
  'charter.template.md': '# {{PROJECT_NAME}} charter\n',
  'profiles/project.template.md': 'name: fixed\n',
  'profiles/stack.template.md': '# Stack\n',
  'agents/roster.template.md': '# Roster\n',
  'agents/_shared/verify-discipline.template.md': '# Verify\n',
  'CLAUDE.md': 'Kit primer. start {{PROJECT_NAME | localized at bootstrap}}\n',
  'CLAUDE.instance.template.md': 'Instance primer. start {{PROJECT_NAME | localized at bootstrap}}\n',
  '.claude/workflows/run-n-rounds.js': '// engine\n',
  'agents/lifecycle.template.md': '# Lifecycle\n', 'agents/lessons.template.md': '# Lessons\n',
  'memory/pm.template.md': '# PM Memory\n', 'pm-decisions.template.md': '# PM Decisions\n',
  // An older kit tracked its live ledgers; the legacy deployment edits them in place.
  'agents/lifecycle.md': '# Lifecycle\n', 'agents/lessons.md': '# Lessons\n', 'memory/pm.md': '# PM Memory\n', 'pm-decisions.md': '# PM Decisions\n',
  'agents/backend.md': '# Backend\n\n## Base Agent\n\nsynthetic\n', 'agents/qa.md': '# QA\n\n## Base Agent\n\nsynthetic\n',
  'agents/pm.md': '# PM\n', 'docs/process-index.md': '# Process index\n',
  '.gitignore': 'charter.md\nprofiles/project.md\nprofiles/stack.md\nagents/roster.md\nagents/_shared/verify-discipline.md\n.claude/agents/*.md\n.venv/\nmessages/*.md\n',
}

async function write(root, files) {
  for (const [rel, content] of Object.entries(files)) { await mkdir(dirname(join(root, rel)), { recursive: true }); await writeFile(join(root, rel), content) }
}

// old = a legacy deployment (kit clone bootstrapped and edited in place); next = empty instance root with kit/.
async function withLegacy(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-team-migrate-'))
  try {
    const upstream = join(dir, 'upstream'), old = join(dir, 'AI.Team'), next = join(dir, 'Product.team')
    await mkdir(upstream); await write(upstream, KIT)
    for (const script of ['bootstrap-team.sh', 'validate-team.sh', 'check-claude-compat.sh']) await cp(join(ROOT, 'scripts', script), join(upstream, 'scripts', script))
    await git(upstream, 'init', '-q'); await git(upstream, 'add', '-A'); await git(upstream, 'commit', '-q', '-m', 'kit')
    await exec('git', ['clone', '-q', upstream, old])
    await write(old, {
      'charter.md': '# Demo charter\n', 'profiles/project.md': 'name: Demo\n', 'profiles/stack.md': '# Flutter\n', 'agents/roster.md': '# Demo roster\n',
      'agents/_shared/verify-discipline.md': '# Demo verify\n', '.claude/agents/demo-backend.md': '---\nname: demo-backend\n---\n',
      'messages/2026-09-24.md': 'hello\n', '.venv/lib/big.py': 'junk\n', 'scripts/notify-owner.sh': '#!/bin/bash\n', 'reference.yaml': 'k: v\n',
      'agents/backend.md': '# Basile (Backend)\n\n## Base Agent\n\nsynthetic\n',
    })
    await appendFile(join(old, 'agents/lifecycle.md'), '\n## [001] project entry\n')
    await appendFile(join(old, 'CLAUDE.md'), '\nProject rule: never push ledgers.\n')
    await appendFile(join(old, 'docs/process-index.md'), '\n| product truth | ../product/CLAUDE.md |\n')
    await mkdir(next); await exec('git', ['clone', '-q', upstream, join(next, 'kit')])
    return await fn({ old, next })
  } finally { await rm(dir, { recursive: true, force: true }) }
}
const migrate = (...args) => exec('bash', [MIGRATE, ...args]).then(r => ({ code: 0, out: r.stdout }), e => ({ code: e.code, out: (e.stdout || '') + (e.stderr || '') }))

test('migration copies project state, leaves kit-file edits for manual porting, and never touches the old checkout or kit/', async () => {
  await withLegacy(async ({ old, next }) => {
    const before = await snapshot(old)
    const { code, out } = await migrate('--project-name', 'Demo', old, next)
    assert.equal(code, 0, out)
    assert.equal(await snapshot(old), before, 'the old checkout must be untouched')
    assert.equal((await git(join(next, 'kit'), 'status', '--porcelain')).stdout, '', 'kit/ must stay clean')
    for (const [path, content] of [['charter.md', '# Demo charter\n'], ['agents/roster.md', '# Demo roster\n'], ['.claude/agents/demo-backend.md', '---\nname: demo-backend\n---\n'],
      ['messages/2026-09-24.md', 'hello\n'], ['scripts/notify-owner.sh', '#!/bin/bash\n'], ['reference.yaml', 'k: v\n'],
      ['agents/backend.md', '# Basile (Backend)\n\n## Base Agent\n\nsynthetic\n'], ['agents/lifecycle.md', '# Lifecycle\n\n## [001] project entry\n']]) {
      assert.equal(await readFile(join(next, path), 'utf8'), content, path)
    }
    assert.equal(await readFile(join(next, 'agents/lessons.md'), 'utf8'), '# Lessons\n', 'an unmodified ledger is seeded fresh')
    assert.ok(!(await exists(join(next, '.venv'))), 'environment junk is not migrated')
    assert.ok(!(await exists(join(next, 'agents/qa.md'))), 'unmodified role files stay in the kit')
    assert.ok(!(await exists(join(next, 'docs/process-index.md'))), 'an edited kit file is not copied (it would shadow the kit)')
    assert.match(await readFile(join(next, 'CLAUDE.md'), 'utf8'), /^Instance primer\. start Demo/, 'CLAUDE.md comes from the instance seed')
    assert.match(await readFile(join(next, 'migration-review/CLAUDE.md.diff'), 'utf8'), /\+Project rule: never push ledgers\./)
    assert.match(await readFile(join(next, 'migration-review/docs/process-index.md.diff'), 'utf8'), /\+\| product truth/)
    const review = await readFile(join(next, 'kit-upgrade-review.md'), 'utf8')
    assert.match(review, /^- \[ \] CLAUDE\.md <- local edits to a kit file \(migration-review\/CLAUDE\.md\.diff\)$/m)
    assert.match(review, /^- \[ \] docs\/process-index\.md <- /m)
    assert.match(out, /PORT - CLAUDE\.md/); assert.match(out, /RESULT: MIGRATED/)
    assert.equal(await readFile(join(next, 'kit.lock'), 'utf8').then(t => t.split('\n')[0]), 'instance_schema=1')
  })
})

test('--dry-run plans the migration and writes nothing', async () => {
  await withLegacy(async ({ old, next }) => {
    const files = async dir => (await exec('bash', ['-c', 'cd "$1" && find . -type f | sort', 'sh', dir])).stdout
    const before = await files(next)
    const { code, out } = await migrate('--dry-run', old, next)
    assert.equal(code, 0, out); assert.match(out, /PLAN - copy charter\.md/); assert.match(out, /PORT - CLAUDE\.md/); assert.match(out, /RESULT: DRY-RUN/)
    assert.equal(await files(next), before)
  })
})

test('migration refuses unsafe or wrong roots before writing', async () => {
  await withLegacy(async ({ old, next }) => {
    for (const args of [[old, old], [next, next], [join(next, 'kit'), next], [old, join(next, 'missing')], [old]]) {
      const { code, out } = await migrate(...args)
      assert.equal(code, 1, out); assert.match(out, /RESULT: MIGRATION-FAILED/, JSON.stringify(args))
    }
    await writeFile(join(next, 'charter.md'), '# already an instance\n')
    const { code, out } = await migrate(old, next)
    assert.equal(code, 1, out); assert.match(out, /already holds an instance/)
    assert.equal(await readFile(join(next, 'charter.md'), 'utf8'), '# already an instance\n')
  })
})
