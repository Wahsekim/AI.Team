// Tests for scripts/preflight-run.mjs (review 2026-09-25, F-02 + Slice B):
// static launch preflight must reject a launch that would fail mid-run and
// must freeze the input bundle behind one digest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/preflight-run.mjs', import.meta.url))
const ENGINE = fileURLToPath(new URL('../.claude/workflows/run-n-rounds.js', import.meta.url))

const wrapper = name => `---\nname: ${name}\ndescription: ${name} for tests\nmodel: sonnet\neffort: high\nmaxTurns: 40\n---\n\nRead before work: agents/builder.md, profiles/project.md, profiles/stack.md.\n`
const BASE_FILES = {
  'charter.md': '# Charter\n', 'profiles/project.md': '# Project\n', 'profiles/stack.md': '# Stack\n', 'agents/roster.md': '# Roster\n',
  'agents/builder.md': '# Builder\n', 'agents/pm.md': '# PM\n', 'decisions/0001-x.md': '# ADR\n', 'CLAUDE.md': '# Team\n',
  '.claude/agents/README.md': '# wrappers\n',
  '.claude/agents/proj-builder.md': wrapper('proj-builder'),
  '.claude/agents/proj-qa.md': wrapper('proj-qa'),
  '.claude/agents/proj-chaos.md': wrapper('proj-chaos'),
}
const ARGS = {
  rounds: 1, date: '2026-09-25', nextLifecycleNumber: 22, executionMode: 'wrappers', budgetCeilingTokens: 100000,
  guardianAgentType: 'proj-chaos', allowedAgentTypes: ['proj-builder', 'proj-qa', 'proj-chaos'],
  plan: [{ ticket: 'US-08', title: 'Dart ASCII layer', agentType: 'proj-builder', brief: 'x', isCodeShipping: true, verifierAgentType: 'proj-qa' }],
}

async function withTeam(files, fn, args = ARGS) {
  const root = await mkdtemp(join(tmpdir(), 'ai-team-preflight-'))
  try {
    for (const [rel, content] of Object.entries(files)) { await mkdir(dirname(join(root, rel)), { recursive: true }); await writeFile(join(root, rel), content) }
    await mkdir(join(root, '.claude', 'workflows'), { recursive: true })
    await copyFile(ENGINE, join(root, '.claude', 'workflows', 'run-n-rounds.js'))
    const argsPath = join(root, 'args.json')
    await writeFile(argsPath, JSON.stringify(args))
    return await fn(root, argsPath)
  } finally { await rm(root, { recursive: true, force: true }) }
}
async function preflight(argsPath, root, ...extra) {
  try {
    const { stdout, stderr } = await exec('node', [SCRIPT, argsPath, '--team-root', root, ...extra])
    return { code: 0, out: stdout, err: stderr }
  } catch (e) { return { code: e.code, out: e.stdout || '', err: e.stderr || '' } }
}

test('valid wrappers-mode launch passes, emits a stable sha256 digest and freezes wrappers + policies', async () => {
  await withTeam(BASE_FILES, async (root, argsPath) => {
    const a = await preflight(argsPath, root)
    assert.equal(a.code, 0, a.err)
    const manifest = JSON.parse(a.out)
    assert.match(manifest.launchManifestDigest, /^sha256:[a-f0-9]{64}$/)
    assert.match(a.err, /PREFLIGHT-PASS/)
    assert.deepEqual(Object.keys(manifest.bundle.agents).sort(), ['proj-builder', 'proj-chaos', 'proj-qa'])
    assert.ok(manifest.bundle.policies['charter.md'] && manifest.bundle.policies['decisions/0001-x.md'] && manifest.bundle.policies['agents/builder.md'])
    assert.equal(manifest.bundle.args.titledItems, 1)
    assert.equal(manifest.bundle.session.freshness, 'unknown')
    const b = await preflight(argsPath, root)
    assert.equal(JSON.parse(b.out).launchManifestDigest, manifest.launchManifestDigest, 'digest is deterministic for an unchanged bundle')
    await writeFile(join(root, 'charter.md'), '# Charter edited\n')
    const c = await preflight(argsPath, root)
    assert.notEqual(JSON.parse(c.out).launchManifestDigest, manifest.launchManifestDigest, 'a policy edit changes the digest')
  })
})

test('missing guardian wrapper FAILS before any dispatch and names the type', async () => {
  const files = { ...BASE_FILES }; delete files['.claude/agents/proj-chaos.md']
  await withTeam(files, async (root, argsPath) => {
    const r = await preflight(argsPath, root)
    assert.equal(r.code, 2)
    assert.equal(r.out, '', 'no manifest on failure')
    assert.match(r.err, /FAIL - registry: agentType 'proj-chaos' has no wrapper file/)
  })
})

test('placeholder frontmatter name and a seed in the registry FAIL', async () => {
  await withTeam({ ...BASE_FILES, '.claude/agents/proj-qa.md': wrapper('{{PROJECT_AGENT_SLUG}}'), '.claude/agents/role-wrapper.template.md': wrapper('{{X}}') }, async (root, argsPath) => {
    const r = await preflight(argsPath, root)
    assert.equal(r.code, 2)
    assert.match(r.err, /registry-seeds: .*role-wrapper\.template\.md is a seed/)
    assert.match(r.err, /placeholder agent name/)
    assert.match(r.err, /frontmatter name is '\{\{PROJECT_AGENT_SLUG\}\}' but the plan dispatches 'proj-qa'/)
  })
})

test('args the engine would reject are reported from the REAL validator (dry run, zero dispatch)', async () => {
  await withTeam(BASE_FILES, async (root, argsPath) => {
    const r = await preflight(argsPath, root)
    assert.equal(r.code, 2)
    assert.match(r.err, /FAIL - engine-args: rounds must be a positive safe integer/)
  }, { ...ARGS, rounds: 0 })
})

test('inline mode without INLINE_BASE_AGENT_MODE.md FAILS; with it, passes', async () => {
  const inlineArgs = { ...ARGS, executionMode: 'inline', guardianAgentType: undefined, allowedAgentTypes: undefined,
    plan: [{ ticket: 'T-1', agentType: 'general-purpose', brief: 'x', isCodeShipping: false }] }
  await withTeam(BASE_FILES, async (root, argsPath) => {
    const r = await preflight(argsPath, root)
    assert.equal(r.code, 2); assert.match(r.err, /INLINE_BASE_AGENT_MODE\.md is missing or hollow/)
  }, inlineArgs)
  await withTeam({ ...BASE_FILES, '.claude/agents/INLINE_BASE_AGENT_MODE.md': '# Inline Mode\n\n' + 'dispatch assembly text. '.repeat(20) }, async (root, argsPath) => {
    const r = await preflight(argsPath, root)
    assert.equal(r.code, 0, r.err)
  }, inlineArgs)
})

test('stale session: a wrapper modified after --session-started FAILS; an older one is verified fresh', async () => {
  await withTeam(BASE_FILES, async (root, argsPath) => {
    const past = new Date(Date.now() - 3600_000)
    for (const f of ['proj-builder', 'proj-qa', 'proj-chaos']) await utimes(join(root, '.claude', 'agents', `${f}.md`), past, past)
    await utimes(join(root, '.claude', 'workflows', 'run-n-rounds.js'), past, past)
    const fresh = await preflight(argsPath, root, '--session-started', new Date(Date.now() - 60_000).toISOString())
    assert.equal(fresh.code, 0, fresh.err)
    assert.equal(JSON.parse(fresh.out).bundle.session.freshness, 'verified')
    const now = new Date()
    await utimes(join(root, '.claude', 'agents', 'proj-chaos.md'), now, now)
    const stale = await preflight(argsPath, root, '--session-started', new Date(Date.now() - 60_000).toISOString())
    assert.equal(stale.code, 2)
    assert.match(stale.err, /FAIL - session: wrapper .*proj-chaos\.md .* changed .* AFTER the session started/)
  })
})

test('product root: missing dir, non-git dir, dirty tree FAIL; clean repo records the HEAD candidate and primer hash', async () => {
  await withTeam(BASE_FILES, async (root, argsPath) => {
    const missing = await preflight(argsPath, root, '--product-root', join(root, 'nope'))
    assert.equal(missing.code, 2); assert.match(missing.err, /product-root: .* does not exist/)
    const plain = join(root, 'plain'); await mkdir(plain)
    const nongit = await preflight(argsPath, root, '--product-root', plain)
    assert.equal(nongit.code, 2); assert.match(nongit.err, /not a git repository root/)
    const repo = join(root, 'product'); await mkdir(repo)
    const git = (...a) => exec('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a])
    await git('init', '-q')
    await writeFile(join(repo, 'CLAUDE.md'), '# product primer\n')
    await git('add', '.'); await git('commit', '-q', '-m', 'init')
    const clean = await preflight(argsPath, root, '--product-root', repo)
    assert.equal(clean.code, 0, clean.err)
    const m = JSON.parse(clean.out)
    assert.match(m.bundle.product.candidate, /^[0-9a-f]{40}$/)
    assert.equal(m.bundle.product.dirty, false)
    assert.equal(m.bundle.product.primer.path, 'CLAUDE.md')
    await writeFile(join(repo, 'dirty.txt'), 'x')
    const dirty = await preflight(argsPath, root, '--product-root', repo)
    assert.equal(dirty.code, 2); assert.match(dirty.err, /has uncommitted changes/)
    const allowed = await preflight(argsPath, root, '--product-root', repo, '--allow-dirty-product')
    assert.equal(allowed.code, 0, allowed.err)
    assert.equal(JSON.parse(allowed.out).bundle.product.dirty, true)
    assert.match(allowed.err, /WARN - product-root/)
  })
})

test('--out writes the manifest file and keeps stdout empty', async () => {
  await withTeam(BASE_FILES, async (root, argsPath) => {
    const out = join(root, 'manifest.json')
    const r = await preflight(argsPath, root, '--out', out)
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, '')
    assert.match(JSON.parse(await readFile(out, 'utf8')).launchManifestDigest, /^sha256:/)
  })
})

test('unreadable or non-object args exit 1 with a FAIL line', async () => {
  await withTeam(BASE_FILES, async (root) => {
    const bad = join(root, 'bad.json'); await writeFile(bad, '[1,2]')
    const r = await preflight(bad, root)
    assert.equal(r.code, 1); assert.match(r.err, /top-level JSON object required/)
    const r2 = await preflight(join(root, 'missing.json'), root)
    assert.equal(r2.code, 1); assert.match(r2.err, /cannot read/)
  })
})
