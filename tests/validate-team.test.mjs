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
  // Status is the LAST column (matches roster.template.md's Recommended Roster
  // shape — the R5-05 contract reads role_id from the first cell, status from
  // the last). Every active row needs agents/<role_id>.md + a dispatch path.
  'agents/roster.md': '# Roster\n\n| role | wrapper | status |\n|---|---|---|\n| builder | .claude/agents/proj-builder.md | active |\n',
  // Role files must carry the seed sections (R6-07c): Base Agent + overlay/
  // dispatch guidance — a bare title stub is hollow staffing.
  'agents/builder.md': '# Builder role\n\n## Base Agent\n\nsynthetic\n\n## Project Overlay\n\nScope, verify gates, and handoff format for the builder role.\n\n## Dispatch Assembly\n\nBrief = base agent + overlay + templates.md section.\n',
  'agents/_shared/verify-discipline.md': '# Verify discipline\n',
  'agents/lifecycle.md': '# Lifecycle\n\n## [001] bootstrap — deployed\n\nNext NNN to assign: 002\n',
  'agents/lessons.md': '# Lessons index\n',
  'memory/pm.md': '# PM memory\n',
  'pm-decisions.md': '# PM decisions\n',
  '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription: builder for tests\nmodel: sonnet\neffort: "high"\nmaxTurns: 40\ntools: Read, Grep, Bash, Write, Edit\npermissionMode: default\n---\n\nBuilder wrapper.\n',
}

const FRESH_KIT = {
  'charter.template.md': '# Charter template {{PROJECT_NAME}}\n',
  'profiles/project.template.md': '# {{PROJECT_NAME}}\n',
}

const MANDATORY = [
  'CLAUDE.md',
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

test('complete deployment passes --mode deployment with DEPLOYMENT-STRUCTURALLY-COMPLETE verdict', async () => {
  await withFixture(COMPLETE_DEPLOYMENT, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 0, out)
    assert.match(out, /DEPLOYMENT-STRUCTURALLY-COMPLETE/)
  })
})

test('complete deployment auto-detects as deployment', async () => {
  await withFixture(COMPLETE_DEPLOYMENT, async root => {
    const { code, out } = await runValidator(root)
    assert.equal(code, 0, out)
    assert.match(out, /validating as deployment/)
    assert.match(out, /DEPLOYMENT-STRUCTURALLY-COMPLETE/)
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

test('roster ROW referencing missing browser-access.md FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': COMPLETE_DEPLOYMENT['agents/roster.md'] + '| ux | needs agents/_shared/browser-access.md | dormant |\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /browser-access-ref/)
  })
})

test('N-06 false-red: PROSE mention of browser-access.md (kit docs style) does NOT fail a non-UI deployment', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/pm.md': 'For UI projects, ensure agents/_shared/browser-access.md exists, instantiated from the seed.\n',
    'agents/roster.md': COMPLETE_DEPLOYMENT['agents/roster.md'] + '\nUI verifies would follow agents/_shared/browser-access.md (only if UI roles are hired).\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 0, `conditional prose must not be read as config:\n${out}`)
  })
})

test('profiles reference to missing browser-access.md FAILS (operative config)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'profiles/project.md': '# Project\nui_verify_discipline: agents/_shared/browser-access.md\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /browser-access-ref/)
  })
})

test('N-06 false-green: EMPTY mandatory artifact fails (hollow deployment)', async () => {
  const files = { ...COMPLETE_DEPLOYMENT, 'profiles/stack.md': '' }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /mandatory-artifacts.*empty/)
  })
})

test('N-06 false-green: no wrapper rows AND no inline instantiation fails (no dispatch path)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': '# Roster\n\nNo wrappers configured yet.\n',
  }
  delete files['.claude/agents/proj-builder.md']
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /no sanctioned dispatch path/)
  })
})

test('N-06 false-red: roster PROSE mentioning INLINE_BASE_AGENT_MODE.md does not demand the file', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': COMPLETE_DEPLOYMENT['agents/roster.md']
      + '\nAll-purpose dispatch is a fallback only (inline mode — .claude/agents/INLINE_BASE_AGENT_MODE.md on every row).\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 0, `prose must not be read as inline-mode declaration:\n${out}`)
  })
})

test('roster ROW declaring inline mode without the file FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': '# Roster\n\n| role | wrapper | status |\n|---|---|---|\n| builder | .claude/agents/INLINE_BASE_AGENT_MODE.md | active |\n',
  }
  delete files['.claude/agents/proj-builder.md']
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /roster-wrappers/)
  })
})

test('R-05: shell wrapper with only a name fails the frontmatter schema', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\n---\n\nShell wrapper.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /wrapper-frontmatter/)
    assert.match(out, /missing:.*description/)
  })
})

test('R-05: wrapper without tools/permissionMode passes with a least-privilege WARN', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription: b\nmodel: sonnet\neffort: "high"\nmaxTurns: 40\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 0, out)
    assert.match(out, /WARN - wrapper-frontmatter.*inherits ALL tools/)
  })
})

test('F-05: empty frontmatter VALUES fail (key alone is a shell, not config)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription:\nmodel:\neffort:\nmaxTurns: 40\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /wrapper-frontmatter/)
    assert.match(out, /description/)
  })
})

test('F-05: wrapper without a positive-integer maxTurns fails (template contract)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription: b\nmodel: sonnet\neffort: "high"\nmaxTurns: 0\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /maxTurns/)
  })
})

test('F-05/R5-06: one-byte INLINE_BASE_AGENT_MODE.md is not a dispatch configuration', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': '# Roster\n\n| role | wrapper | status |\n|---|---|---|\n| builder | .claude/agents/INLINE_BASE_AGENT_MODE.md | active |\n',
    '.claude/agents/INLINE_BASE_AGENT_MODE.md': 'x',
  }
  delete files['.claude/agents/proj-builder.md']
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /missing-or-hollow/)
    assert.match(out, /roster-wrappers/)
  })
})

test('R5-05: active roster row with no wrapper path, main session, or inline mode FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': COMPLETE_DEPLOYMENT['agents/roster.md'] + '| qa | — | active |\n',
    'agents/qa.md': '# QA role\n\n## Base Agent\n\nsynthetic\n\n## Project Overlay\n\nQA scope.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /roster-contract/)
    assert.match(out, /qa\(no-dispatch-path/)
  })
})

test('R5-05: active roster row whose agents/<role_id>.md is missing FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': COMPLETE_DEPLOYMENT['agents/roster.md'] + '| qa | .claude/agents/proj-qa.md | active |\n',
    '.claude/agents/proj-qa.md': '---\nname: proj-qa\ndescription: qa for tests\nmodel: sonnet\neffort: medium\nmaxTurns: 40\ntools: Read, Grep, Bash\npermissionMode: default\n---\n\nQA wrapper.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /roster-contract/)
    assert.match(out, /agents\/qa\.md missing-or-empty/)
  })
})

test('R5-05: dormant (active if UI) row does NOT trigger the active-row checks', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': COMPLETE_DEPLOYMENT['agents/roster.md'] + '| ux | (not yet) | dormant (active if UI) |\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 0, `status keyword is the FIRST word of the cell — parenthetical 'active' must not count:\n${out}`)
  })
})

test('R5-06: wrapper with name: "" (YAML-empty value) FAILS the frontmatter schema', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: ""\ndescription: b\nmodel: sonnet\neffort: high\nmaxTurns: 40\ntools: Read\npermissionMode: default\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /wrapper-frontmatter/)
    assert.match(out, /missing:.*name/)
  })
})

test('R5-06: wrapper with unterminated frontmatter (no closing ---) FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription: b\nmodel: sonnet\neffort: high\nmaxTurns: 40\n\nBody without a closing fence.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /unterminated-frontmatter/)
  })
})

test('R5-06: wrapper with effort: low-medium FAILS (not a runtime effort value)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription: b\nmodel: sonnet\neffort: low-medium\nmaxTurns: 40\ntools: Read\npermissionMode: default\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /invalid-effort:low-medium/)
  })
})

test('R6-06a: prose before the frontmatter block FAILS (strict flat subset: line 1 is ---)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': 'Intro prose the runtime would treat as body.\n---\nname: proj-builder\ndescription: b\nmodel: sonnet\neffort: high\nmaxTurns: 40\ntools: Read\npermissionMode: default\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /no-frontmatter-at-line-1/)
    assert.match(out, /strict flat frontmatter subset/)
  })
})

test('R6-06c: unquoted trailing comments on values PASS (effort: high # note, maxTurns: 40 # cap)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription: builder for tests\nmodel: sonnet\neffort: high # supported enum\nmaxTurns: 40 # turn cap\ntools: Read, Grep, Bash\npermissionMode: default\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 0, `comments must be stripped before validation, not read as values:\n${out}`)
    assert.match(out, /PASS - wrapper-frontmatter/)
  })
})

test('R6-06c: comment-only value is empty — description: # no value FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription: # no value\nmodel: sonnet\neffort: high\nmaxTurns: 40\ntools: Read\npermissionMode: default\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /missing:.*description/)
  })
})

test('R6-06d: duplicate key FAILS (model: sonnet + model: "" must not false-green on the first value)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    '.claude/agents/proj-builder.md': '---\nname: proj-builder\ndescription: b\nmodel: sonnet\nmodel: ""\neffort: high\nmaxTurns: 40\ntools: Read\npermissionMode: default\n---\nBody.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /duplicate-key:model/)
  })
})

test('R6-07a: README.md referenced as an active row wrapper FAILS (kit fixture, not a wrapper)', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': '# Roster\n\n| role | wrapper | status |\n|---|---|---|\n| builder | .claude/agents/README.md | active |\n',
    '.claude/agents/README.md': '# Wrapper directory readme\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /roster-wrappers/)
    assert.match(out, /README\.md\(not-a-dispatch-wrapper/)
  })
})

test('R6-07a: role-wrapper.template.md referenced as an active row wrapper FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': '# Roster\n\n| role | wrapper | status |\n|---|---|---|\n| builder | .claude/agents/role-wrapper.template.md | active |\n',
    '.claude/agents/role-wrapper.template.md': '---\nname: "{{PROJECT_AGENT_SLUG}}"\n---\nSeed body.\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /roster-wrappers/)
    assert.match(out, /role-wrapper\.template\.md\(not-a-dispatch-wrapper/)
  })
})

// Mirrors the real seed (.claude/agents/INLINE_BASE_AGENT_MODE.template.md):
// heading, 'Base Agent' requirement, dispatch assembly rule, >= 200 bytes —
// a genuine bootstrap copy of the seed must satisfy inline_mode_ok (R6-07d).
const GENUINE_INLINE =
  '# Inline Base Agent Mode\n\n'
  + 'Use this file only when the runtime cannot install one concrete Claude wrapper per role.\n\n'
  + 'The PM dispatches workers by reading each role file in `agents/`. Each active role file must contain:\n\n'
  + '1. the base agency-agent path, or `synthetic`;\n'
  + '2. the project-specific overlay;\n'
  + '3. the dispatch assembly rule.\n\n'
  + 'This mode is valid only while every active role file has a verified `Base Agent` section.\n'

test('R6-07a: bare INLINE_BASE_AGENT_MODE.md as a WRAPPER path FAILS even when the file is genuine', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': '# Roster\n\n| role | wrapper | status |\n|---|---|---|\n| builder | .claude/agents/INLINE_BASE_AGENT_MODE.md | active |\n',
    '.claude/agents/INLINE_BASE_AGENT_MODE.md': GENUINE_INLINE,
  }
  delete files['.claude/agents/proj-builder.md']
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /inline-mode-file-used-as-wrapper-path/)
  })
})

test('R6-07d control: sanctioned inline-mode roster note + genuine seed copy PASSES', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': '# Roster\n\n| role | wrapper | status |\n|---|---|---|\n| builder | inline mode — .claude/agents/INLINE_BASE_AGENT_MODE.md | active |\n',
    '.claude/agents/INLINE_BASE_AGENT_MODE.md': GENUINE_INLINE,
  }
  delete files['.claude/agents/proj-builder.md']
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 0, `a genuine bootstrap inline instantiation must validate:\n${out}`)
  })
})

test('R6-07d: hollow inline file (heading + padding, no base-agent/dispatch text) FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/roster.md': '# Roster\n\n| role | wrapper | status |\n|---|---|---|\n| builder | inline mode — .claude/agents/INLINE_BASE_AGENT_MODE.md | active |\n',
    '.claude/agents/INLINE_BASE_AGENT_MODE.md': '# Inline Mode\n\n' + 'filler text that pads the file well past the size floor. '.repeat(6),
  }
  delete files['.claude/agents/proj-builder.md']
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /missing-or-hollow/)
  })
})

test('R6-07c: one-byte role file FAILS the roster contract (hollow staffing)', async () => {
  const files = { ...COMPLETE_DEPLOYMENT, 'agents/builder.md': '#' }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /roster-contract/)
    assert.match(out, /builder\(agents\/builder\.md hollow/)
  })
})

test('R-05: deployment lifecycle without a counter line FAILS', async () => {
  const files = {
    ...COMPLETE_DEPLOYMENT,
    'agents/lifecycle.md': '# Lifecycle\n\n## [001] bootstrap — deployed\n',
  }
  await withFixture(files, async root => {
    const { code, out } = await runValidator(root, '--mode', 'deployment')
    assert.equal(code, 1, out)
    assert.match(out, /lifecycle-counter/)
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
