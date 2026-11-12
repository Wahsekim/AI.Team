import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, renameSync, readdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { preflight } from '../src/router-worker/preflight.mjs';
import { loadMethods, methodCatalog } from '../src/router-worker/methods.mjs';
import { bytesDigest, digest } from '../src/loop/contracts.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';

const cli = fileURLToPath(new URL('../scripts/preflight-router-worker.mjs', import.meta.url));
const DUTIES = ['exec', 'check', 'guard'];

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-preflight-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = inputFixture(), sources = [], nodes = [];
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const addSource = (field, value) => {
    const keys = field.split('.'), parent = keys.slice(0, -1).reduce((v, k) => v[k], input), key = keys.at(-1);
    const id = parent[key].id; parent[key] = { id, digest: digest(value) };
    const path = `sources/${id}.json`; write(path, JSON.stringify({ id, value })); sources.push({ field, path });
  };
  addSource('policy.approvalRef', { note: 'Synthetic policy approval for offline tests only' });
  addSource('policy.stackRef', { verificationCommands: input.policy.verificationCommands });
  addSource('policy.runtimeRef', { runtime: 'mock-only' });
  addSource('policy.rosterRef', { wrappers: Object.fromEntries(DUTIES.map(d => [d, input.policy.profiles[d].wrapper])) });
  for (const duty of DUTIES) addSource(`policy.profiles.${duty}.permissionRef`, { duty, fixtureOnly: true });
  addSource('mandate.approvalRef', { note: 'Synthetic task approval; not human authorization' });
  input.mandate.policyDigest = digest(input.policy);
  const addNode = (path, content, reads) => { write(path, content); nodes.push({ path, sha256: bytesDigest(content), reads }); };
  addNode('agents/shared.md', 'No worker delegation. No commits. 中文约束。\n', []);
  const roots = {};
  for (const duty of DUTIES) {
    const path = `.claude/agents/${input.policy.profiles[duty].wrapper}.md`;
    addNode(path, `Fixture ${duty}: read agents/shared.md\n`, ['agents/shared.md']); roots[duty] = [path];
  }
  const approval = { schemaVersion: 1, purpose: 'offline-preflight', status: 'approved', inputDigest: digest(input), sources,
    context: { metric: 'ceil-utf8-bytes/4', roots, limits: { exec: 10000, check: 10000, guard: 10000 }, nodes } };
  const saveApproval = () => { const bytes = JSON.stringify(approval); write('approval.json', bytes); return bytesDigest(bytes); };
  return { root, input, approval, write, saveApproval, options: () => ({ input, teamRoot: root, approvalPath: 'approval.json', expectedApprovalDigest: saveApproval() }) };
}

test('preflight binds local sources and a deduplicated read graph without authorizing launch', t => {
  const f = fixture(t), options = f.options(), output = preflight(options);
  assert.equal(output.errors, undefined);
  assert.deepEqual(preflight(options), output);
  assert.equal(output.preflight.launchable, false);
  assert.equal(output.preview.manifest.launchable, false);
  for (const duty of DUTIES) {
    const measured = output.preflight.context[duty];
    assert.equal(measured.paths.length, 2);
    const sourceBytes = measured.paths.reduce((sum, path) => sum + readFileSync(join(f.root, path)).length, 0);
    const briefBytes = duty === 'guard' ? 0 : Buffer.byteLength(output.preview.renderedBriefs[duty]);
    assert.equal(measured.sourceBytes, sourceBytes);
    assert.equal(measured.briefBytes, briefBytes);
    assert.equal(measured.estimatedTokens, Math.ceil((sourceBytes + briefBytes) / 4));
    assert.equal(measured.completeInvocation, false);
  }
  const { digest: resultDigest, ...body } = output.preflight;
  assert.equal(resultDigest, digest(body));
  assert.equal(output.preflight.files.length, 13);
});

for (const [name, mutate, code] of [
  ['unapproved input revision', f => { f.input.ticket.title = 'Changed'; }, 'INPUT_NOT_APPROVED'],
  ['unapproved status', f => { f.approval.status = 'draft'; }, 'INVALID_PREFLIGHT'],
  ['wrong purpose', f => { f.approval.purpose = 'live-launch'; }, 'INVALID_PREFLIGHT'],
  ['missing source', f => { f.approval.sources.pop(); }, 'INVALID_PREFLIGHT'],
  ['duplicate source field', f => { f.approval.sources[1] = f.approval.sources[0]; }, 'INVALID_PREFLIGHT'],
  ['unknown source field', f => { f.approval.sources[0].field = '__proto__.id'; }, 'INVALID_PREFLIGHT'],
  ['source traversal', f => { f.approval.sources[0].path = '../secret'; }, 'INVALID_PREFLIGHT'],
  ['changed referenced source', f => { f.write(f.approval.sources[0].path, JSON.stringify({ id: 'other', value: {} })); }, 'SOURCE_MISMATCH'],
  ['changed context file', f => { f.write('agents/shared.md', 'Changed'); }, 'CONTEXT_SOURCE_CHANGED'],
  ['missing read dependency', f => { f.approval.context.nodes[1].reads.push('agents/missing.md'); }, 'MISSING_CONTEXT_SOURCE'],
  ['missing wrapper root', f => { f.approval.context.roots.exec = ['agents/shared.md']; }, 'INVALID_PREFLIGHT'],
  ['duplicate context node', f => { f.approval.context.nodes.push(f.approval.context.nodes[0]); }, 'INVALID_PREFLIGHT'],
  ['unreachable context node', f => { f.write('orphan.md', 'Orphan'); f.approval.context.nodes.push({ path: 'orphan.md', sha256: bytesDigest('Orphan'), reads: [] }); }, 'INVALID_PREFLIGHT'],
  ['context overflow', f => { f.approval.context.limits.check = 1; }, 'CONTEXT_BUDGET_EXCEEDED'],
  ['missing context limit', f => { delete f.approval.context.limits.guard; }, 'INVALID_PREFLIGHT'],
  ['unknown context metric', f => { f.approval.context.metric = 'tokens'; }, 'INVALID_PREFLIGHT'],
  ['empty hash', f => { f.approval.context.nodes[0].sha256 = ''; }, 'INVALID_PREFLIGHT'],
]) test(`preflight rejects ${name} without partial success`, t => {
  const f = fixture(t); mutate(f);
  const output = preflight(f.options());
  assert.deepEqual(Object.keys(output), ['errors']); assert.equal(output.errors[0].code, code);
});

test('file hash anchor is mandatory and cannot silently follow a changed approval', t => {
  const f = fixture(t), options = f.options();
  assert.equal(preflight({ ...options, expectedApprovalDigest: undefined }).errors[0].code, 'APPROVAL_ANCHOR_REQUIRED');
  f.approval.context.limits.exec++;
  f.saveApproval();
  assert.equal(preflight(options).errors[0].code, 'APPROVAL_CHANGED');
});

test('source content can match its ref yet disagree with the proposed stack or roster', t => {
  const f = fixture(t), source = f.approval.sources.find(s => s.field === 'policy.stackRef');
  const value = { verificationCommands: ['echo fake'] };
  f.input.policy.stackRef.digest = digest(value);
  f.write(source.path, JSON.stringify({ id: f.input.policy.stackRef.id, value }));
  f.input.mandate.policyDigest = digest(f.input.policy); f.approval.inputDigest = digest(f.input);
  assert.equal(preflight(f.options()).errors[0].code, 'SOURCE_MISMATCH');
});

test('shared and cyclic read references count once per duty', t => {
  const f = fixture(t), wrapper = f.approval.context.roots.exec[0];
  f.approval.context.nodes[0].reads = [wrapper];
  const result = preflight(f.options());
  assert.equal(result.errors, undefined);
  assert.equal(result.preflight.context.exec.paths.length, 2);
});

test('source symlinks are refused even when target bytes match', t => {
  const f = fixture(t);
  renameSync(join(f.root, 'agents/shared.md'), join(f.root, 'shared-real.md'));
  symlinkSync(join(f.root, 'shared-real.md'), join(f.root, 'agents/shared.md'));
  assert.equal(preflight(f.options()).errors[0].code, 'UNSAFE_SOURCE_PATH');
});

test('v2 preflight resolves pinned methods and charges the injected body to check context', t => {
  const f = fixture(t), root = fileURLToPath(new URL('../', import.meta.url));
  for (const relative of ['config/router-worker', 'agents/skill-packs', 'src/router-worker/adapters'])
    cpSync(join(root, relative), join(f.root, relative), { recursive: true });
  f.input.schemaVersion = 2; f.input.policy.schemaVersion = 2;
  f.input.catalog = methodCatalog(loadMethods({ teamRoot: f.root }));
  f.input.policy.maxBriefChars = 20000;
  f.input.policy.methodAllowlist = { exec: [], check: ['pstack-blast-radius'], guard: [] };
  f.input.proposal.checkMethodIds = ['pstack-blast-radius'];
  f.input.proposal.checkSelectionReason = 'Check downstream retry effects';
  f.input.mandate.policyDigest = digest(f.input.policy); f.approval.inputDigest = digest(f.input);
  const result = preflight(f.options());
  assert.equal(result.errors, undefined);
  assert.equal(result.preview.assignment.skills[0].id, 'pstack-blast-radius');
  assert.equal(result.preflight.context.check.briefBytes, Buffer.byteLength(result.preview.renderedBriefs.check));
  assert.ok(result.preflight.context.check.briefBytes > result.preflight.context.exec.briefBytes);
  f.write('agents/skill-packs/pstack/skills/blast-radius/SKILL.md', 'Changed');
  assert.equal(preflight(f.options()).errors[0].code, 'METHOD_INTEGRITY_FAILED');
});

test('CLI emits a read-only preview; wrong anchor has empty stdout', t => {
  const f = fixture(t), options = f.options();
  const file = join(f.root, 'input.json'); writeFileSync(file, JSON.stringify(f.input));
  const before = readdirSync(f.root).sort();
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: f.root, encoding: 'utf8', timeout: 10000 });
  const result = run(file, f.root, 'approval.json', options.expectedApprovalDigest);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), preflight(options));
  assert.deepEqual(readdirSync(f.root).sort(), before);
  const refused = run(file, f.root, 'approval.json', `sha256:${'0'.repeat(64)}`);
  assert.equal(refused.status, 2); assert.equal(refused.stdout, '');
  assert.equal(run(file).status, 1);
});
