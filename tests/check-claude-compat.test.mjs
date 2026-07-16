// Tests for scripts/check-claude-compat.sh (remediation plan P0-03):
// version gate for Dynamic Workflows + legacy frontmatter detection.
// Uses a stub `claude` binary on PATH so no real CLI is needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/check-claude-compat.sh', import.meta.url))

async function withStubClaude(version, files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'ai-team-compat-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    if (version !== null) {
      const stub = join(bin, 'claude')
      await writeFile(stub, `#!/bin/sh\necho "${version} (Claude Code)"\n`)
      await chmod(stub, 0o755)
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
    }
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
    try {
      const { stdout } = await exec('bash', [SCRIPT, root], { env })
      return await fn({ code: 0, out: stdout })
    } catch (e) {
      return await fn({ code: e.code, out: (e.stdout || '') + (e.stderr || '') })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const GOOD_WRAPPER = { '.claude/agents/proj-builder.md': '---\nname: proj-builder\neffort: "high"\nmaxTurns: 40\n---\nBody.\n' }
const LEGACY_WRAPPER = { '.claude/agents/proj-builder.md': '---\nname: proj-builder\nreasoning_effort: "high"\ntoken_budget: "60000"\n---\nBody.\n' }

test('version >= minimum with clean wrappers -> COMPATIBLE', async () => {
  await withStubClaude('2.1.154', GOOD_WRAPPER, ({ code, out }) => {
    assert.equal(code, 0, out)
    assert.match(out, /COMPATIBLE/)
  })
})

test('version below minimum -> FAIL', async () => {
  await withStubClaude('2.1.120', GOOD_WRAPPER, ({ code, out }) => {
    assert.equal(code, 1, out)
    assert.match(out, /claude-version/)
    assert.match(out, /INCOMPATIBLE/)
  })
})

test('newer major/minor versions pass the numeric compare', async () => {
  await withStubClaude('2.2.3', GOOD_WRAPPER, ({ code, out }) => {
    assert.equal(code, 0, out)
  })
})

test('missing claude CLI -> FAIL', async () => {
  await withStubClaude(null, GOOD_WRAPPER, ({ code, out }) => {
    assert.equal(code, 1, out)
    assert.match(out, /claude-cli/)
  })
})

test('legacy reasoning_effort/token_budget frontmatter in an active wrapper -> FAIL', async () => {
  await withStubClaude('2.1.200', LEGACY_WRAPPER, ({ code, out }) => {
    assert.equal(code, 1, out)
    assert.match(out, /wrapper-frontmatter/)
    assert.match(out, /reasoning_effort|token_budget/)
  })
})

test('legacy fields in a .template.md are exempt (templates are seeds, not active wrappers)', async () => {
  await withStubClaude('2.1.200', {
    '.claude/agents/role-wrapper.template.md': '---\nname: x\nreasoning_effort: "high"\n---\nSeed.\n',
  }, ({ code, out }) => {
    assert.equal(code, 0, out)
  })
})
