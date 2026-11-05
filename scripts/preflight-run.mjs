#!/usr/bin/env node
// preflight-run.mjs — static launch preflight + frozen launch manifest for a
// run-n-rounds invocation (review 2026-09-25, F-02 + Slice B).
//
// Usage: node scripts/preflight-run.mjs <args.json> [--team-root DIR] [--product-root DIR]
//          [--session-started ISO-8601] [--allow-dirty-product] [--out manifest.json]
//
// Exit 0: PASS — manifest JSON on stdout (or --out); stderr carries the digest
//         to pass as args.launchManifestDigest.
// Exit 2: FAIL — one 'FAIL - <check>: ...' line per problem on stderr, no manifest.
// Exit 1: usage / unreadable input.
//
// What it proves (statically, before any paid dispatch):
//   1. the engine's OWN validator accepts the args (dry run through the mock
//      harness with an aborting agent — zero real dispatch);
//   2. every agentType the plan will dispatch exists as a live wrapper file in
//      .claude/agents/ whose frontmatter name matches, with no placeholder;
//   3. no seed (*.template.md / '{{' name) sits in the runtime registry;
//   4. optionally, no wrapper or engine file changed after --session-started
//      (the runtime's agent hot-reload has documented exceptions);
//   5. optionally, the product root is a git repo with a clean tree; its HEAD is
//      the candidate the run starts from.
// It then hashes the full policy/input bundle (wrappers, role files, charter,
// profiles, shared rules, decisions, product primer, engine, args) so a
// mid-run edit is detectable at reconciliation. Static only: it cannot see the
// runtime's registry — record capability uncertainty rather than pretend.

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join, relative, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from './lib/workflow-harness.mjs'
import { canonical } from '../src/loop/contracts.mjs'

const usage = 'usage: node scripts/preflight-run.mjs <args.json> [--team-root DIR] [--product-root DIR] [--session-started ISO-8601] [--allow-dirty-product] [--out FILE]'
const opts = { teamRoot: '.', productRoot: null, sessionStarted: null, allowDirty: false, out: null, argsPath: null }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--team-root') opts.teamRoot = argv[++i]
  else if (a === '--product-root') opts.productRoot = argv[++i]
  else if (a === '--session-started') opts.sessionStarted = argv[++i]
  else if (a === '--allow-dirty-product') opts.allowDirty = true
  else if (a === '--out') opts.out = argv[++i]
  else if (a.startsWith('--')) { console.error(`FAIL - args: unknown flag ${a}\n${usage}`); process.exit(1) }
  else if (!opts.argsPath) opts.argsPath = a
  else { console.error(`FAIL - args: unexpected argument ${a}\n${usage}`); process.exit(1) }
}
if (!opts.argsPath || !opts.teamRoot) { console.error(usage); process.exit(1) }

const ROOT = resolve(opts.teamRoot)
const ENGINE = join(ROOT, '.claude', 'workflows', 'run-n-rounds.js')
const REGISTRY = join(ROOT, '.claude', 'agents')
const failures = []
const warnings = []
const fail = (check, msg) => failures.push(`FAIL - ${check}: ${msg}`)
const warn = (check, msg) => warnings.push(`WARN - ${check}: ${msg}`)
const sha256 = buf => `sha256:${createHash('sha256').update(buf).digest('hex')}`
const rel = p => relative(ROOT, p).split('\\').join('/')
const fileRecord = p => {
  const st = statSync(p)
  return { path: rel(p), sha256: sha256(readFileSync(p)), bytes: st.size, mtimeUtc: new Date(st.mtimeMs).toISOString() }
}
const frontmatterName = text => {
  const lines = text.split('\n')
  if (lines[0] !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return null
    const m = /^name:\s*(.*)$/.exec(lines[i])
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return null
}

// ---- 0. args file
let argsText
try { argsText = readFileSync(resolve(opts.argsPath), 'utf8') } catch (e) { console.error(`FAIL - args: cannot read ${opts.argsPath}: ${e.message}`); process.exit(1) }
if (Buffer.byteLength(argsText) > 8 * 1024 * 1024) { console.error('FAIL - args: file exceeds 8 MiB'); process.exit(1) }
let A
try { A = JSON.parse(argsText) } catch (e) { console.error(`FAIL - args: not valid JSON (${e.message})`); process.exit(1) }
if (!A || typeof A !== 'object' || Array.isArray(A)) { console.error('FAIL - args: top-level JSON object required'); process.exit(1) }
if (!existsSync(ENGINE)) { console.error(`FAIL - engine: ${rel(ENGINE)} not found — is --team-root an AI.Team root?`); process.exit(1) }

// ---- 1. engine dry run: the REAL validator, an aborting agent, zero dispatch
const dry = await runWorkflow({ scriptPath: ENGINE, args: A, agentImpl: () => { throw new Error('preflight-abort: no dispatch in preflight') } })
if (dry.result && dry.result.errorCode === 'invalid-args') {
  for (const v of dry.result.validationErrors) fail('engine-args', v)
}
const plan = Array.isArray(A.plan) ? A.plan.filter(p => p && typeof p === 'object') : []
const wrappersMode = A.executionMode === 'wrappers'

// ---- 2+3. registry: live wrappers for every dispatched type, no seeds
const agents = {}
const registryFiles = existsSync(REGISTRY) ? readdirSync(REGISTRY).filter(f => f.endsWith('.md')).sort() : []
for (const f of registryFiles) {
  if (f.endsWith('.template.md')) { fail('registry-seeds', `${rel(join(REGISTRY, f))} is a seed inside the runtime registry — the runtime registers it as a live agent type; move it to agents/_seeds/`); continue }
  if (f === 'README.md' || f === 'INLINE_BASE_AGENT_MODE.md') continue
  const name = frontmatterName(readFileSync(join(REGISTRY, f), 'utf8'))
  if (name && name.includes('{{')) fail('registry-seeds', `${rel(join(REGISTRY, f))} has placeholder agent name '${name}'`)
}
const usedTypes = new Set()
if (wrappersMode) {
  for (const p of plan) { if (typeof p.agentType === 'string') usedTypes.add(p.agentType); if (typeof p.verifierAgentType === 'string') usedTypes.add(p.verifierAgentType) }
  if (typeof A.guardianAgentType === 'string') usedTypes.add(A.guardianAgentType)
  else fail('registry', 'wrappers mode without guardianAgentType — the guardian would be discovered missing only after productive work')
  for (const t of [...usedTypes].sort()) {
    const p = join(REGISTRY, `${t}.md`)
    if (!/^[A-Za-z0-9._-]+$/.test(t)) { fail('registry', `agentType '${t}' is not a wrapper identifier`); continue }
    if (!existsSync(p)) { fail('registry', `agentType '${t}' has no wrapper file at ${rel(p)} — the runtime cannot dispatch it (a guardian/verifier discovered missing mid-run wastes the whole batch)`); continue }
    const text = readFileSync(p, 'utf8')
    const name = frontmatterName(text)
    if (name !== t) fail('registry', `${rel(p)} frontmatter name is '${name}' but the plan dispatches '${t}' — the runtime registers wrappers by frontmatter name`)
    agents[t] = { ...fileRecord(p), roleFiles: [...new Set((text.match(/agents\/[a-z][a-z0-9_-]*\.md/g) || []).filter(r => !/_shared|_seeds|templates|lessons|roster|pm\.md|lifecycle/.test(r)))].sort() }
  }
} else if (A.executionMode === 'inline') {
  const inline = join(REGISTRY, 'INLINE_BASE_AGENT_MODE.md')
  if (!existsSync(inline) || statSync(inline).size < 200) fail('registry', 'inline mode declared but .claude/agents/INLINE_BASE_AGENT_MODE.md is missing or hollow')
  else agents['INLINE_BASE_AGENT_MODE'] = { ...fileRecord(inline), roleFiles: [] }
}

// ---- 4. session freshness (optional): wrappers/engine must predate the session
let session = { startedAtUtc: null, freshness: 'unknown' }
if (opts.sessionStarted) {
  const started = Date.parse(opts.sessionStarted)
  if (Number.isNaN(started)) fail('session', `--session-started '${opts.sessionStarted}' is not an ISO-8601 timestamp`)
  else {
    session = { startedAtUtc: new Date(started).toISOString(), freshness: 'verified' }
    for (const [t, a] of Object.entries(agents)) {
      if (Date.parse(a.mtimeUtc) > started) { fail('session', `wrapper ${a.path} (${t}) changed at ${a.mtimeUtc}, AFTER the session started at ${session.startedAtUtc} — the runtime's hot reload has documented exceptions; restart the session or re-verify with /agents`); session.freshness = 'stale' }
    }
    if (statSync(ENGINE).mtimeMs > started) { fail('session', `engine ${rel(ENGINE)} changed after the session started — restart before launching`); session.freshness = 'stale' }
  }
} else warn('session', 'no --session-started given: wrapper freshness vs the live session is UNKNOWN (the runtime may not have reloaded new wrappers)')

// ---- 5. product root (optional): git repo, clean tree, candidate = HEAD
let product = null
if (opts.productRoot) {
  const pr = resolve(opts.productRoot)
  if (!existsSync(pr) || !statSync(pr).isDirectory()) fail('product-root', `${pr} does not exist or is not a directory`)
  else if (!existsSync(join(pr, '.git'))) fail('product-root', `${pr} is not a git repository root (no .git) — wrong product root`)
  else {
    const git = args => spawnSync('git', ['-C', pr, ...args], { encoding: 'utf8', timeout: 10000 })
    const head = git(['rev-parse', 'HEAD'])
    const status = git(['status', '--porcelain'])
    if (head.status !== 0) fail('product-root', `git rev-parse HEAD failed in ${pr}: ${(head.stderr || '').trim()}`)
    const dirty = status.status === 0 ? status.stdout.trim().length > 0 : null
    if (dirty === true) (opts.allowDirty ? warn : fail)('product-root', `${pr} has uncommitted changes — the candidate is not a clean attested tree${opts.allowDirty ? ' (allowed by --allow-dirty-product)' : ' (pass --allow-dirty-product to record it as a warning)'}`)
    const primerPath = ['CLAUDE.md', 'AGENTS.md'].map(f => join(pr, f)).find(existsSync) || null
    product = {
      root: pr, candidate: head.status === 0 ? head.stdout.trim() : null, dirty,
      primer: primerPath ? { path: relative(pr, primerPath), sha256: sha256(readFileSync(primerPath)) } : null,
    }
  }
}

// ---- 6. policy/input bundle hashes
const POLICY = ['charter.md', 'profiles/project.md', 'profiles/stack.md', 'agents/pm.md', 'agents/roster.md', 'agents/templates.md',
  'agents/_shared/meta-rules.md', 'agents/_shared/verify-discipline.md', 'agents/_shared/browser-access.md', 'CLAUDE.md']
const REQUIRED = wrappersMode ? ['charter.md', 'profiles/project.md', 'profiles/stack.md', 'agents/roster.md'] : []
const policies = {}
const decisionsDir = join(ROOT, 'decisions')
const decisionFiles = existsSync(decisionsDir) ? readdirSync(decisionsDir).filter(f => f.endsWith('.md')).sort().map(f => `decisions/${f}`) : []
const roleFiles = [...new Set(Object.values(agents).flatMap(a => a.roleFiles))].sort()
for (const p of [...POLICY, ...decisionFiles, ...roleFiles]) {
  const abs = join(ROOT, p)
  if (existsSync(abs)) policies[p] = sha256(readFileSync(abs))
  else if (REQUIRED.includes(p) || roleFiles.includes(p)) fail('policy-bundle', `${p} is missing but a dispatched wrapper or the deployment contract requires it`)
}

// ---- 7. runtime identity (recorded, never a gate here — the compat gate owns the version rule)
const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 })
const claudeVersion = claude.status === 0 ? claude.stdout.trim().split('\n')[0] : null
if (!claudeVersion) warn('runtime', 'claude CLI version could not be read — runtime identity recorded as unknown')

if (failures.length) {
  for (const w of warnings) console.error(w)
  for (const f of failures) console.error(f)
  console.error(`RESULT: PREFLIGHT-FAILED — ${failures.length} problem(s); nothing may be dispatched.`)
  process.exit(2)
}

const bundle = {
  teamRoot: ROOT,
  engine: fileRecord(ENGINE),
  args: { path: resolve(opts.argsPath), sha256: sha256(argsText), canonicalDigest: sha256(canonical(A)), bytes: Buffer.byteLength(argsText),
    planItems: plan.length, executionMode: A.executionMode ?? null, rounds: A.rounds ?? null, runId: A.runId ?? null,
    titledItems: plan.filter(p => typeof p.title === 'string').length, deliveryRequiredItems: plan.filter(p => p.deliveryRequired === true).length },
  agents, policies, product,
  runtime: { claudeVersion, node: process.version },
  session,
}
const manifest = { schemaVersion: 1, createdAtUtc: new Date().toISOString(), launchManifestDigest: sha256(canonical(bundle)), bundle }
const text = `${JSON.stringify(manifest, null, 2)}\n`
if (opts.out) writeFileSync(resolve(opts.out), text)
else process.stdout.write(text)
for (const w of warnings) console.error(w)
console.error(`RESULT: PREFLIGHT-PASS — launchManifestDigest: ${manifest.launchManifestDigest} (pass it as args.launchManifestDigest; ${Object.keys(agents).length} wrapper(s), ${Object.keys(policies).length} policy file(s) frozen${product ? `, product candidate ${product.candidate}` : ''})`)
