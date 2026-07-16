// Deployment-integrity tests for scripts/validate-team.sh (remediation plan P0-08).
// Builds throwaway fixture trees and asserts the validator's exit code + verdict:
// a deployment missing ANY bootstrap-mandatory artifact must FAIL, never pass green.
// Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const VALIDATOR = fileURLToPath(new URL('../scripts/validate-team.sh', import.meta.url))

async function runValidator(root, ...modeArgs) {
  try {
    const { stdout } = await exec('bash', [VALIDATOR, ...modeArgs, root])
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.code, out: (e.stdout || '') + (e.stderr || '') }
  }
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
}

const COMPLETE_DEPLOYMENT = {
  'charter.md': '# Charter\n\nLoop modes and budget table live here.\n',
  'CLAUDE.md': '# Team index\n',
  'profiles/project.md': '# Project profile\n',
  'profiles/stack.md': '# Stack profile\n',
  'agents/roster.md': '# Roster\n\n| role | status | wrapper |\n|---|---|---|\n| builder | active | .claude/agents/proj-builder.md |\n',
  'agents/_shared/verify-discipline.md': '# Verify discipline\n',
  'agents/lifecycle.md': '# Lifecycle\n\n## [001] bootstrap — deployed\n\nNext NNN to assign: 002\n',
  'agents/lessons.md': '# Lessons index\n',
  'memory/pm.md': '# PM memory\n',
  'pm-decisions.md': '# PM decisions\n',
  '.claude/agents/proj-builder.md': '---\nname: proj-builder\n---\n\nBuilder wrapper.\n',
}

const FRESH_KIT = {
  'charter.template.md': '# Charter template {{PROJECT_NAME}}\n',
  'profiles/project.template.md': '# {{PROJECT_NAME}}\n',
}

const MANDATORY = [
  'charter.md',
  'profiles/project.md',
  'profiles/stack.md',
  'agents/roster.md',
  'agents/_shared/verify-discipline.md',
  'agents/lifecycle.md',
  'agents/lessons.md',
  'memory/pm.md',
  'pm-decisions.md',
]

async function withFixture(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'ai-team-validator-'))
  try {
    await writeTree(root, files)
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('fresh kit passes in kit/auto mode with KIT-VALID verdict', async () => {
  await withFixture(FRESH_KIT, async root => {
    const { code, out } = await runValidator(root)
    assert.equal(code, 0, out)
    assert.match(out, /KIT-VALID/)
  })
})

test('fresh kit FAILS under --mode deployment (incomplete deployment must not validate)', async () => {
  await withFixture(FRESH_KIT, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /DEPLOYMENT-INCOMPLETE/)
    assert.match(out, /mandatory-artifacts/)
  })
})

test('complete deployment passes --mode deployment with DEPLOYMENT-READY verdict', async () => {
  await withFixture(COMPLETE_DEPLOYMENT, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 0, out)
    assert.match(out, /DEPLOYMENT-READY/)
  })
})

test('complete deployment auto-detects as deployment', async () => {
  await withFixture(COMPLETE_DEPLOYMENT, async root => {
    const { code, out } = await runValidator(root)
    assert.equal(code, 0, out)
    assert.match(out, /validating as deployment/)
    assert.match(out, /DEPLOYMENT-READY/)
  })
})

for (const artifact of MANDATORY) {
  test(`deployment missing ${artifact} -> exit 1, DEPLOYMENT-INCOMPLETE`, async () => {
    const files = { ...COMPLETE_DEPLOYMENT }
    delete files[artifact]
    await withFixture(files, async root => {
      const { code, out } = await runValidator(root, '--mode', 'deployment')
      assert.equal(code, 1, `expected FAIL when ${artifact} is missing:\n${out}`)
      assert.match(out, /DEPLOYMENT-INCOMPLETE/)
    })
  })
}

test('staleness check never claims a missing state file is fresh', async () => {
  const files = { ...COMPLETE_DEPLOYMENT }
  delete files['memory/pm.md']
  await withFixture(files, async root => {
    const { out } = await runValidator(root, '--mode', 'deployment')
    assert.ok(!/PASS - staleness:.*memory\/pm\.md/.test(out), `misleading staleness PASS:\n${out}`)
  })
})

test('roster pointing at a nonexistent wrapper FAILS', async () => {
  const files = { ...COMPLETE_DEPLOYMENT }
  delete files['.claude/agents/proj-builder.md']
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /roster-wrappers/)
  })
})

test('operative reference to missing browser-access.md FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': COMPLETE_DEPLOYMENT['agents/roster.md'] + '\nUI verifies follow agents/_shared/browser-access.md.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /browser-access-ref/)
  })
})

test('invalid --mode value fails fast', async () => {
  await withFixture(FRESH_KIT, async root => {
    const { code, out } = await runValidator(root, '--mode', 'bogus')
    assert.equal(code, 1, out)
    assert.match(out, /--mode must be/)
  })
})

test('lifecycle duplicate entry numbers still FAIL in deployment mode', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/lifecycle.md': '# Lifecycle\n\n## [001] a\n## [001] b\n\nNext NNN to assign: 002\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /lifecycle-duplicates/)
  })
})
