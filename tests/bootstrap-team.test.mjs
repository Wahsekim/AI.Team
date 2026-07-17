// Tests for scripts/bootstrap-team.sh (remediation plan P1-02, lean scope):
// idempotent instantiation, never-overwrite, --dry-run, substitutions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/bootstrap-team.sh', import.meta.url))

const SEEDS = {
  'charter.template.md': '# {{PROJECT_NAME}} - AI Team Charter\n\nBody.\n',
  'profiles/project.template.md': 'name: "{{PROJECT_NAME | ask:first_start}}"\nrepo: "{{PRODUCT_REPO_PATH | ask:first_start | e.g. ../x}}"\ntracker: "{{ISSUE_TRACKER | ask:first_start | default:file-ledger}}"\n',
  'profiles/stack.template.md': '# Stack {{STACK | ask:first_start}}\n',
  'agents/roster.template.md': '# Roster for {{PROJECT_NAME}}\n',
  'agents/_shared/verify-discipline.template.md': '# Verify {{VERIFY_COMMANDS | ask:first_start}}\n',
  'agents/_shared/browser-access.template.md': '# Browser {{BROWSER_TOOL | ask:first_use}}\n',
  'CLAUDE.md': 'When the owner says `start {{PROJECT_NAME | localized at bootstrap}}`...\n',
}

async function withKit(fn) {
  const root = await mkdtemp(join(tmpdir(), 'ai-team-bootstrap-'))
  try {
    for (const [rel, content] of Object.entries(SEEDS)) {
      const abs = join(root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
    }
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const run = async (root, ...flags) => {
  const { stdout } = await exec('bash', [SCRIPT, ...flags, root])
  return stdout
}
const exists = p => access(p).then(() => true, () => false)

test('fresh run instantiates all seeds and substitutes provided values', async () => {
  await withKit(async root => {
    const out = await run(root, '--project-name', 'StockUp', '--product-repo', '/abs/product')
    assert.match(out, /RESULT: INSTANTIATED-PENDING-INTERVIEW/, 'ask:first_start placeholders remain, so the verdict must say the interview is pending')
    for (const target of ['charter.md', 'profiles/project.md', 'profiles/stack.md', 'agents/roster.md', 'agents/_shared/verify-discipline.md']) {
      assert.ok(await exists(join(root, target)), `${target} missing`)
    }
    const charter = await readFile(join(root, 'charter.md'), 'utf8')
    assert.match(charter, /# StockUp - AI Team Charter/)
    const project = await readFile(join(root, 'profiles/project.md'), 'utf8')
    assert.match(project, /name: "StockUp"/)
    assert.match(project, /repo: "\/abs\/product"/)
    assert.match(project, /\{\{ISSUE_TRACKER/, 'unrelated placeholders stay for the PM interview')
    const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8')
    assert.match(claude, /`start StockUp`/)
  })
})

test('browser-access.md is created only with --ui', async () => {
  await withKit(async root => {
    await run(root)
    assert.ok(!(await exists(join(root, 'agents/_shared/browser-access.md'))))
    await run(root, '--ui')
    assert.ok(await exists(join(root, 'agents/_shared/browser-access.md')))
  })
})

test('idempotent: second run changes nothing and reports skips', async () => {
  await withKit(async root => {
    await run(root, '--project-name', 'X')
    const before = await readFile(join(root, 'charter.md'), 'utf8')
    const out2 = await run(root, '--project-name', 'DIFFERENT')
    assert.match(out2, /SKIP - charter\.md: already instantiated/)
    const after = await readFile(join(root, 'charter.md'), 'utf8')
    assert.equal(after, before, 'second run must not rewrite instantiated files')
  })
})

test('never overwrites human edits', async () => {
  await withKit(async root => {
    await run(root)
    await writeFile(join(root, 'profiles/project.md'), 'HUMAN EDITED\n')
    await run(root, '--project-name', 'Y')
    assert.equal(await readFile(join(root, 'profiles/project.md'), 'utf8'), 'HUMAN EDITED\n')
  })
})

test('--dry-run writes nothing', async () => {
  await withKit(async root => {
    const out = await run(root, '--dry-run', '--project-name', 'Z')
    assert.match(out, /DRY-RUN/)
    assert.ok(!(await exists(join(root, 'charter.md'))))
    const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8')
    assert.match(claude, /\{\{PROJECT_NAME/, 'dry-run must not localize CLAUDE.md')
  })
})

test('relative --product-repo is normalized to an absolute path', async () => {
  await withKit(async root => {
    await run(root, '--product-repo', '../product')
    const project = await readFile(join(root, 'profiles/project.md'), 'utf8')
    const m = /repo: "([^"]+)"/.exec(project)
    assert.ok(m && m[1].startsWith('/'), `expected absolute path, got: ${m && m[1]}`)
  })
})

test('reports remaining ask:first_start placeholders as TODO', async () => {
  await withKit(async root => {
    const out = await run(root)
    assert.match(out, /TODO - profiles\/project\.md: \d+ ask:first_start/)
  })
})

test('unknown flag fails fast', async () => {
  await withKit(async root => {
    try {
      await exec('bash', [SCRIPT, '--bogus', root])
      assert.fail('expected nonzero exit for unknown flag')
    } catch (e) {
      assert.equal(e.code, 1)
      assert.match(String(e.stdout), /FAIL - args/)
      assert.match(String(e.stdout), /BOOTSTRAP-FAILED/)
    }
  })
})

test('N-07: flag without a value fails fast instead of hanging the arg loop', async () => {
  await withKit(async root => {
    try {
      // timeout guards against the old infinite-shift bug regressing
      await exec('bash', [SCRIPT, root, '--project-name'], { timeout: 5000 })
      assert.fail('expected nonzero exit for missing flag value')
    } catch (e) {
      assert.equal(e.code, 1, `expected clean failure, got: ${e.killed ? 'TIMEOUT (arg loop hang regressed)' : e.code}`)
      assert.match(String(e.stdout), /requires a value/)
      assert.match(String(e.stdout), /BOOTSTRAP-FAILED/)
    }
  })
})

test('N-07: missing mandatory seed -> BOOTSTRAP-FAILED exit 1, not a silent SKIP', async () => {
  await withKit(async root => {
    await rm(join(root, 'charter.template.md'))
    try {
      await exec('bash', [SCRIPT, root])
      assert.fail('expected nonzero exit for missing mandatory seed')
    } catch (e) {
      assert.equal(e.code, 1)
      assert.match(String(e.stdout), /mandatory seed charter\.template\.md missing/)
      assert.match(String(e.stdout), /BOOTSTRAP-FAILED/)
    }
  })
})

test('N-07: already-instantiated target satisfies the mandatory-seed check', async () => {
  await withKit(async root => {
    await rm(join(root, 'charter.template.md'))
    await writeFile(join(root, 'charter.md'), '# Charter already instantiated\n')
    const out = await run(root)
    assert.match(out, /RESULT: INSTANTIATED-PENDING-INTERVIEW|RESULT: PENDING-STAFFING|RESULT: BOOTSTRAPPED/)
  })
})

test('R-09: BOOTSTRAPPED is never printed over an incomplete deployment', async () => {
  await withKit(async root => {
    // Seeds without ask:first_start placeholders — old logic would print
    // BOOTSTRAPPED although wrappers/ledgers are absent.
    await writeFile(join(root, 'profiles/project.template.md'), 'name: fixed\n')
    await writeFile(join(root, 'profiles/stack.template.md'), '# Stack fixed\n')
    await writeFile(join(root, 'agents/_shared/verify-discipline.template.md'), '# Verify fixed\n')
    const out = await run(root, '--project-name', 'X')
    assert.match(out, /RESULT: PENDING-STAFFING/, `must not claim BOOTSTRAPPED without a structurally-complete deployment:\n${out}`)
    assert.ok(!/RESULT: BOOTSTRAPPED/.test(out))
  })
})

test('F-07/R5-12a: a lock held by a LIVE owner pid blocks a concurrent run', async () => {
  await withKit(async root => {
    await mkdir(join(root, '.bootstrap-lock'))
    await writeFile(join(root, '.bootstrap-lock', 'pid'), `${process.pid}\n`)
    try {
      await exec('bash', [SCRIPT, root])
      assert.fail('expected nonzero exit while the lock is held')
    } catch (e) {
      assert.equal(e.code, 1)
      assert.match(String(e.stdout), /another bootstrap appears to be in progress/)
      assert.match(String(e.stdout), /BOOTSTRAP-FAILED/)
    }
  })
})

test('R5-12a: stale lock with a dead owner pid is reclaimed and the run proceeds', async () => {
  await withKit(async root => {
    // A shell that echoes its own pid and exits: a guaranteed-dead owner.
    const { stdout: pidOut } = await exec('sh', ['-c', 'echo $$'])
    await mkdir(join(root, '.bootstrap-lock'))
    await writeFile(join(root, '.bootstrap-lock', 'pid'), pidOut)
    const out = await run(root)
    assert.match(out, /WARN - lock: stale .*reclaiming/, 'must announce the stale-lock takeover')
    assert.match(out, /RESULT: /)
    assert.ok(!(await exists(join(root, '.bootstrap-lock'))), 'reclaimed lock must be released after the run')
  })
})

test('F-07: bootstrap lock is released after a run (subsequent run proceeds)', async () => {
  await withKit(async root => {
    await run(root)
    const out = await run(root)
    assert.match(out, /RESULT: /)
  })
})

// R5-08 fixtures: copy the script into a scripts dir we control so the compat
// and validator gates run against fakes instead of the real kit checkers.
async function withGateFakes(root, { compatBody, compatMode = 0o644 } = {}) {
  const sdir = join(root, 'kit-scripts')
  await mkdir(sdir, { recursive: true })
  await copyFile(SCRIPT, join(sdir, 'bootstrap-team.sh'))
  await writeFile(join(sdir, 'validate-team.sh'), '#!/bin/bash\necho "RESULT: PASS (fake validator)"\nexit 0\n', { mode: 0o755 })
  if (compatBody !== undefined) {
    await writeFile(join(sdir, 'check-claude-compat.sh'), compatBody, { mode: compatMode })
  }
  return join(sdir, 'bootstrap-team.sh')
}

// Seeds without ask:first_start placeholders, so the verdict is decided by the
// gates alone (same shape as the R-09 test above).
async function stripInterviewPlaceholders(root) {
  await writeFile(join(root, 'profiles/project.template.md'), 'name: fixed\n')
  await writeFile(join(root, 'profiles/stack.template.md'), '# Stack fixed\n')
  await writeFile(join(root, 'agents/_shared/verify-discipline.template.md'), '# Verify fixed\n')
}

test('R5-08: non-executable FAILING compat checker still runs and blocks BOOTSTRAPPED', async () => {
  await withKit(async root => {
    await stripInterviewPlaceholders(root)
    const script = await withGateFakes(root, {
      compatBody: '#!/bin/bash\necho "compat: FAIL (fake)"\nexit 1\n',
      compatMode: 0o644, // exec bit dropped (copy/unzip shape) — gate must run anyway
    })
    const { stdout } = await exec('bash', [script, '--project-name', 'X', root])
    assert.match(stdout, /RESULT: PENDING-RUNTIME-COMPAT/, `failing checker must gate the verdict:\n${stdout}`)
    assert.ok(!/RESULT: BOOTSTRAPPED/.test(stdout))
  })
})

test('R5-08: MISSING compat checker fails closed — never BOOTSTRAPPED', async () => {
  await withKit(async root => {
    await stripInterviewPlaceholders(root)
    const script = await withGateFakes(root) // no check-claude-compat.sh at all
    const { stdout } = await exec('bash', [script, '--project-name', 'X', root])
    assert.match(stdout, /WARN - compat: .*missing.*fail-closed/, 'the unrun gate must be announced')
    assert.match(stdout, /RESULT: PENDING-RUNTIME-COMPAT/)
    assert.ok(!/RESULT: BOOTSTRAPPED/.test(stdout))
  })
})

test('R5-08 control: passing compat checker + clean validator -> BOOTSTRAPPED', async () => {
  await withKit(async root => {
    await stripInterviewPlaceholders(root)
    const script = await withGateFakes(root, {
      compatBody: '#!/bin/bash\necho "compat: PASS (fake)"\nexit 0\n',
    })
    const { stdout } = await exec('bash', [script, '--project-name', 'X', root])
    assert.match(stdout, /RESULT: BOOTSTRAPPED/, `fail-closed gate must still be satisfiable:\n${stdout}`)
  })
})

test('R-09: no render-tmp litter is left behind after a successful run', async () => {
  await withKit(async root => {
    await run(root, '--project-name', 'X')
    const { readdir } = await import('node:fs/promises')
    const all = []
    for (const dir of ['.', 'profiles', 'agents/_shared']) {
      for (const f of await readdir(join(root, dir))) all.push(f)
    }
    assert.ok(all.every(f => !f.includes('.render-tmp.')), `tmp litter: ${all.filter(f => f.includes('.render-tmp.'))}`)
  })
})
