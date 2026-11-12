// ADR 0009: a kit upgrade is a fast-forward of kit/ plus a recorded pin change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const BOOTSTRAP = fileURLToPath(new URL('../scripts/bootstrap-team.sh', import.meta.url))
const PIN = fileURLToPath(new URL('../scripts/pin-kit.sh', import.meta.url))
const git = (dir, ...args) => exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args])
const head = async dir => (await git(dir, 'rev-parse', 'HEAD')).stdout.trim()

const KIT = {
  'charter.template.md': '# {{PROJECT_NAME}} charter v1\n',
  'profiles/project.template.md': 'name: fixed\n',
  'profiles/stack.template.md': '# Stack\n',
  'agents/roster.template.md': '# Roster\n',
  'agents/_shared/verify-discipline.template.md': '# Verify\n',
  'CLAUDE.instance.template.md': 'start {{PROJECT_NAME | localized at bootstrap}}\n',
  '.claude/workflows/run-n-rounds.js': '// engine v1\n',
  'agents/lifecycle.template.md': '# Lifecycle\n',
  'agents/lessons.template.md': '# Lessons\n',
  'memory/pm.template.md': '# PM Memory\n',
  'pm-decisions.template.md': '# PM Decisions\n',
  'agents/backend.md': '# Backend\n\n## Base Agent\n\nsynthetic\n',
  'agents/pm.md': '# PM v1\n',
}

async function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
}

// upstream = the kit's own repository; instance/kit = a clone of it.
async function withUpgradeableInstance(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-team-pin-'))
  try {
    const upstream = join(dir, 'upstream'), root = join(dir, 'instance'), kit = join(root, 'kit')
    await mkdir(upstream); await write(upstream, KIT)
    await git(upstream, 'init', '-q'); await git(upstream, 'add', '-A'); await git(upstream, 'commit', '-q', '-m', 'v1')
    await mkdir(root); await exec('git', ['clone', '-q', upstream, kit])
    await exec('bash', [BOOTSTRAP, '--project-name', 'Demo', '--roles', 'backend', root])
    return await fn({ upstream, root, kit })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

async function release(upstream, files, message) {
  await write(upstream, files); await git(upstream, 'add', '-A'); await git(upstream, 'commit', '-q', '-m', message)
}

const pin = (root, ...flags) => exec('bash', [PIN, ...flags, root]).then(r => ({ code: 0, out: r.stdout }), e => ({ code: e.code, out: (e.stdout || '') + (e.stderr || '') }))

test('a kit upgrade fast-forwards with project state present and never touches instance files', async () => {
  await withUpgradeableInstance(async ({ upstream, root, kit }) => {
    await appendFile(join(root, 'agents/lifecycle.md'), '\n## [001] Backend - project entry\n')
    await appendFile(join(root, 'pm-decisions.md'), '2026-11-12 T-1 -> Backend\n')
    await writeFile(join(root, 'agents/backend.md'), '# Basile (Backend)\n\n## Base Agent\n\nsynthetic\n')
    await writeFile(join(root, 'CLAUDE.md'), 'start Demo, project edit\n')
    const before = Object.fromEntries(await Promise.all(['agents/lifecycle.md', 'pm-decisions.md', 'agents/backend.md', 'CLAUDE.md', 'charter.md']
      .map(async f => [f, await readFile(join(root, f), 'utf8')])))
    await release(upstream, {
      'agents/lifecycle.template.md': '# Lifecycle v2\n\n## [001] kit entry\n', 'pm-decisions.template.md': '# PM Decisions v2\n',
      'agents/backend.md': '# Backend v2\n\n## Base Agent\n\nsynthetic\n', 'CLAUDE.instance.template.md': 'v2 {{PROJECT_NAME}}\n',
      'charter.template.md': '# charter v2\n', '.claude/workflows/run-n-rounds.js': '// engine v2\n', 'agents/pm.md': '# PM v2\n',
    }, 'v2')
    await git(kit, 'pull', '-q', '--ff-only')
    assert.equal(await head(kit), await head(upstream), 'kit must fast-forward with instance state present')
    const { code, out } = await pin(root)
    assert.equal(code, 0, out)
    assert.equal(await readFile(join(root, 'kit.lock'), 'utf8'), `instance_schema=1\nkit_commit=${await head(upstream)}\n`)
    assert.equal(await readFile(join(root, '.claude/workflows/run-n-rounds.js'), 'utf8'), '// engine v2\n')
    for (const [f, content] of Object.entries(before)) assert.equal(await readFile(join(root, f), 'utf8'), content, `${f} must not change on upgrade`)
    for (const seed of ['agents/lifecycle.template.md', 'pm-decisions.template.md', 'agents/backend.md', 'CLAUDE.instance.template.md', 'charter.template.md']) {
      assert.match(out, new RegExp(`REVIEW - .*${seed.replace(/\./g, '\\.')}`), `changed seed ${seed} must be listed for manual porting`)
    }
    assert.doesNotMatch(out, /REVIEW - .*agents\/pm\.md/, 'kit-only files need no porting')
    const review = await readFile(join(root, 'kit-upgrade-review.md'), 'utf8')
    assert.equal((review.match(/^- \[ \] /gm) || []).length, 5, 'every changed seed becomes an open checklist item')
    assert.match(review, /^- \[ \] charter\.md <- kit\/charter\.template\.md \([0-9a-f]{7}\.\.[0-9a-f]{7}\)$/m)
    await release(upstream, { 'charter.template.md': '# charter v3\n' }, 'v3'); await git(kit, 'pull', '-q', '--ff-only')
    assert.equal((await pin(root)).code, 0)
    const again = await readFile(join(root, 'kit-upgrade-review.md'), 'utf8')
    assert.ok(again.startsWith(review), 'earlier items are kept; new ones are appended')
    assert.equal((again.match(/^- \[ \] /gm) || []).length, 6)
    assert.match(out, /RESULT: KIT-PINNED/)
    assert.equal((await git(kit, 'status', '--porcelain')).stdout, '')
  })
})

test('pin-kit refuses a dirty kit and changes nothing', async () => {
  await withUpgradeableInstance(async ({ root, kit }) => {
    const lock = await readFile(join(root, 'kit.lock'), 'utf8')
    await writeFile(join(kit, 'agents/pm.md'), '# edited in the deployment\n')
    const { code, out } = await pin(root)
    assert.equal(code, 1, out); assert.match(out, /RESULT: PIN-FAILED/); assert.match(out, /agents\/pm\.md/)
    assert.equal(await readFile(join(root, 'kit.lock'), 'utf8'), lock)
  })
})

test('pin-kit is a no-op when the pin already matches, and --dry-run writes nothing', async () => {
  await withUpgradeableInstance(async ({ upstream, root, kit }) => {
    let r = await pin(root); assert.equal(r.code, 0, r.out); assert.match(r.out, /RESULT: KIT-PIN-UNCHANGED/)
    const lock = await readFile(join(root, 'kit.lock'), 'utf8')
    await release(upstream, { '.claude/workflows/run-n-rounds.js': '// engine v2\n' }, 'v2'); await git(kit, 'pull', '-q', '--ff-only')
    r = await pin(root, '--dry-run'); assert.equal(r.code, 0, r.out); assert.match(r.out, /RESULT: DRY-RUN/)
    await assert.rejects(readFile(join(root, 'kit-upgrade-review.md')), 'a dry run or an upgrade without changed seeds writes no checklist')
    assert.equal(await readFile(join(root, 'kit.lock'), 'utf8'), lock)
    assert.equal(await readFile(join(root, '.claude/workflows/run-n-rounds.js'), 'utf8'), '// engine v1\n')
  })
})

test('pin-kit refuses a root that is not a two-root instance, an unversioned kit, and a locally edited engine copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-team-pin-'))
  try {
    let r = await pin(dir); assert.equal(r.code, 1, r.out); assert.match(r.out, /RESULT: PIN-FAILED/)
    await write(join(dir, 'kit'), KIT); await exec('bash', [BOOTSTRAP, dir])
    r = await pin(dir); assert.equal(r.code, 1, r.out); assert.match(r.out, /not a Git checkout/)
  } finally { await rm(dir, { recursive: true, force: true }) }
  await withUpgradeableInstance(async ({ upstream, root, kit }) => {
    await writeFile(join(root, '.claude/workflows/run-n-rounds.js'), '// engine patched in the instance\n')
    await release(upstream, { '.claude/workflows/run-n-rounds.js': '// engine v2\n' }, 'v2'); await git(kit, 'pull', '-q', '--ff-only')
    const r = await pin(root)
    assert.equal(r.code, 1, r.out); assert.match(r.out, /engine copy was edited/)
    assert.equal(await readFile(join(root, '.claude/workflows/run-n-rounds.js'), 'utf8'), '// engine patched in the instance\n')
  })
})

// Review 2026-11-12 R2: the pin is the commit point; review items are recorded before it.
const lockOf = root => readFile(join(root, 'kit.lock'), 'utf8')
const openItems = async root => ((await readFile(join(root, 'kit-upgrade-review.md'), 'utf8')).match(/^- \[ \] charter\.md <- /gm) || []).length
async function upgradeCharter(upstream, kit) {
  await release(upstream, { 'charter.template.md': '# charter v2\n', '.claude/workflows/run-n-rounds.js': '// engine v2\n' }, 'v2')
  await git(kit, 'pull', '-q', '--ff-only')
}

test('a failed review publication leaves the old pin, and the retry records the items before pinning', async () => {
  await withUpgradeableInstance(async ({ upstream, root, kit }) => {
    const oldLock = await lockOf(root)
    await upgradeCharter(upstream, kit)
    await mkdir(join(root, 'kit-upgrade-review.md'))
    const failed = await pin(root)
    assert.equal(failed.code, 1, failed.out); assert.match(failed.out, /RESULT: PIN-FAILED/)
    assert.equal(await lockOf(root), oldLock, 'the pin must not advance without its review items')
    assert.equal(await readFile(join(root, '.claude/workflows/run-n-rounds.js'), 'utf8'), '// engine v1\n')
    await rm(join(root, 'kit-upgrade-review.md'), { recursive: true })
    const retry = await pin(root)
    assert.equal(retry.code, 0, retry.out); assert.match(retry.out, /RESULT: KIT-PINNED/)
    assert.equal(await openItems(root), 1)
    assert.equal(await lockOf(root), `instance_schema=1\nkit_commit=${await head(upstream)}\n`)
  })
})

test('a failure after the review items are written is retried without duplicating or reopening them', async () => {
  await withUpgradeableInstance(async ({ upstream, root, kit }) => {
    const oldLock = await lockOf(root), workflows = join(root, '.claude/workflows')
    await upgradeCharter(upstream, kit)
    await exec('chmod', ['555', workflows])
    const failed = await pin(root)
    await exec('chmod', ['755', workflows])
    assert.equal(failed.code, 1, failed.out)
    assert.equal(await lockOf(root), oldLock)
    assert.equal(await openItems(root), 1, 'the obligation is already visible while the upgrade is incomplete')
    const reviewPath = join(root, 'kit-upgrade-review.md')
    await writeFile(reviewPath, (await readFile(reviewPath, 'utf8')).replace(/^- \[ \] (charter\.md <- .*)$/m, '- [x] $1 — ported by the PM'))
    const retry = await pin(root)
    assert.equal(retry.code, 0, retry.out); assert.match(retry.out, /RESULT: KIT-PINNED/)
    const review = await readFile(reviewPath, 'utf8')
    assert.equal((review.match(/charter\.md <- kit\/charter\.template\.md/g) || []).length, 1, 'the item is not appended twice')
    assert.match(review, /^- \[x\] charter\.md <- .* — ported by the PM$/m, 'a decision made in between is kept')
    assert.equal((await pin(root)).out.includes('KIT-PIN-UNCHANGED'), true)
  })
})

test('pin-kit refuses to run while another pin-kit holds the instance lock', async () => {
  await withUpgradeableInstance(async ({ upstream, root, kit }) => {
    const oldLock = await lockOf(root)
    await upgradeCharter(upstream, kit)
    await mkdir(join(root, '.pin-lock'))
    const { code, out } = await pin(root)
    assert.equal(code, 1, out); assert.match(out, /pin-lock/)
    assert.equal(await lockOf(root), oldLock)
    await rm(join(root, '.pin-lock'), { recursive: true })
    assert.equal((await pin(root)).code, 0)
    await assert.rejects(readFile(join(root, '.pin-lock')), 'the lock is released after a run')
  })
})
