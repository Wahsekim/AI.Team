// ADR 0010, decisions 4 to 7: a deployed team is switched between specialist and Router/Worker mode.
// The live mode's own files go on holiday; shared history stays; the owner confirms the proposal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { proposeSwitch, switchMode, DEFAULT_LIMITS } from '../src/router-worker/switch.mjs';
import { acquireLease } from '../src/router-worker/lease.mjs';
import { bytesDigest } from '../src/loop/contracts.mjs';
import { draftSpecFixture } from './fixtures/router-worker/draft-spec.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/team-mode.mjs', import.meta.url));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
const GOVERNANCE = ['architect', 'coach', 'auditor', 'security'];
const readOnly = { model: 'fixture-governance-model', effort: 'medium', maxTurns: 12, tools: ['Read', 'Grep', 'Glob'] };
const SHARED = ['charter.md', 'CLAUDE.md', 'agents/lifecycle.md', 'agents/lessons.md', 'memory/pm.md', 'profiles/project.md', 'profiles/stack.md', 'kit.lock'];

// A bootstrapped two-root specialist team with one delivery role (backend) and its wrapper, and a clean product repository.
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-switch-'))), root = join(base, 'fixture.team'), kit = join(root, 'kit'), product = join(base, 'product');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n')
    .filter(path => path && !/^(tests|src|docs\/design|\.github)\//.test(path));
  for (const path of tracked) { mkdirSync(dirname(join(kit, path)), { recursive: true }); cpSync(join(ROOT, path), join(kit, path)); }
  mkdirSync(join(product, 'src'), { recursive: true }); writeFileSync(join(product, 'src/app.js'), 'export const x = 1;\n');
  git(product, 'init', '-q'); git(product, 'add', '-A'); git(product, 'commit', '-q', '-m', 'product');
  const boot = spawnSync('bash', [join(kit, 'scripts/bootstrap-team.sh'), '--project-name', 'Tag List Fixture', '--product-repo', product, '--roles', 'backend', root], { encoding: 'utf8' });
  assert.equal(boot.status, 0, boot.stdout + boot.stderr);
  for (const path of ['charter.md', 'profiles/project.md', 'profiles/stack.md', 'agents/_shared/verify-discipline.md', 'CLAUDE.md'])
    writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace(/\{\{[^}]*\}\}/g, 'fixture-answer'));
  mkdirSync(join(root, '.claude/agents'), { recursive: true });
  writeFileSync(join(root, '.claude/agents/tag-list-fixture-backend.md'), '---\nname: "tag-list-fixture-backend"\ndescription: "specialist backend"\nmodel: "m"\n---\n\nRead agents/backend.md.\n');
  const spec = { ...draftSpecFixture(), project: { ...draftSpecFixture().project, productRoot: product },
    governance: Object.fromEntries(GOVERNANCE.map(role => [role, ['architect', 'coach'].includes(role) ? { ...readOnly, tools: [...readOnly.tools, 'Write', 'Edit'] } : readOnly])) };
  const common = { teamRoot: kit, instanceRoot: root, productRoot: product };
  const propose = (to = 'router-worker', request = { spec }) => proposeSwitch({ to, request, ...common });
  const apply = (to = 'router-worker', request = { spec }, confirm) => switchMode({ to, request, ...common, confirm: confirm ?? propose(to, request).digest });
  const read = path => readFileSync(join(root, path), 'utf8'), digests = paths => Object.fromEntries(paths.map(path => [path, existsSync(join(root, path)) ? bytesDigest(readFileSync(join(root, path))) : null]));
  return { base, root, kit, product, spec, propose, apply, read, digests, wrappers: () => readdirSync(join(root, '.claude/agents')).sort() };
}
const refusal = result => result.errors?.[0];
const OWN_SPECIALIST = ['agents/roster.md', 'agents/backend.md', '.claude/agents/tag-list-fixture-backend.md'];

test('a proposal names the staffing, the limits and the files that move, and changes nothing', t => {
  const f = fixture(t), before = f.digests([...OWN_SPECIALIST, ...SHARED]), proposal = f.propose();
  assert.equal(proposal.errors, undefined, JSON.stringify(proposal.errors));
  assert.equal(proposal.from, 'specialist'); assert.equal(proposal.to, 'router-worker'); assert.equal(proposal.dispatch, 'engine');
  assert.deepEqual(proposal.limits, DEFAULT_LIMITS);
  assert.deepEqual(DEFAULT_LIMITS, { attemptsPerTicket: 1, outputAllowancePerTicket: 15000, guardianOutputShare: 6000, authorizationPerTicket: 200000 });
  assert.deepEqual(proposal.staffing.exec, f.spec.profiles.exec); assert.deepEqual(proposal.staffing.security, f.spec.governance.security);
  assert.deepEqual(proposal.pack, [...OWN_SPECIALIST].sort());
  assert.ok(proposal.install.includes('.claude/agents/tag-list-fixture-worker-exec.md') && proposal.install.includes('agents/roster.md') && proposal.install.includes('profiles/team-mode.json'));
  assert.match(proposal.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(f.digests([...OWN_SPECIALIST, ...SHARED]), before); assert.equal(existsSync(join(f.root, 'holiday')), false);
  assert.deepEqual(f.propose({ ...{} }.to, { spec: f.spec, limits: { outputAllowancePerTicket: 20000 } }).limits, { ...DEFAULT_LIMITS, outputAllowancePerTicket: 20000 }, 'the owner may change a limit in the request');
});

test('the switch packs the specialist team into holiday/ and makes the three workers live; shared history is untouched', t => {
  const f = fixture(t), shared = f.digests(SHARED), packed = f.digests(OWN_SPECIALIST), ledgerBefore = f.read('pm-decisions.md');
  assert.equal(refusal(f.apply('router-worker', { spec: f.spec }, 'sha256:' + '0'.repeat(64))).code, 'SWITCH_NOT_CONFIRMED', 'the owner confirms the exact proposal');
  assert.equal(existsSync(join(f.root, 'holiday')), false);
  const result = f.apply();
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.stage, 'mode-switched'); assert.equal(result.mode, 'router-worker'); assert.match(result.validator, /^DEPLOYMENT-STRUCTURALLY-COMPLETE/);
  for (const path of OWN_SPECIALIST) assert.equal(bytesDigest(readFileSync(join(f.root, 'holiday/specialist', path))), packed[path], `${path} is on holiday, unchanged`);
  assert.equal(existsSync(join(f.root, 'agents/backend.md')), false, 'the delivery role is not live');
  assert.deepEqual(f.wrappers(), ['architect', 'auditor', 'coach', 'security', 'worker-check', 'worker-exec', 'worker-guard'].map(role => `tag-list-fixture-${role}.md`).sort());
  assert.ok(!f.read('.claude/agents/tag-list-fixture-worker-exec.md').includes('Do not run from this draft'), 'the workers are live, not drafts');
  assert.match(f.read('agents/roster.md'), /\| worker-exec \|/);
  const mode = JSON.parse(f.read('profiles/team-mode.json'));
  assert.equal(mode.mode, 'router-worker'); assert.equal(mode.status, 'live'); assert.equal(mode.dispatch, 'engine'); assert.deepEqual(mode.limits, DEFAULT_LIMITS);
  assert.equal(mode.confirmedProposal, result.proposalDigest); assert.ok(mode.ownFiles.includes('agents/worker-exec.md'));
  assert.deepEqual(f.digests(SHARED), shared, 'charter, ledgers, lessons, memory and profiles are not packed and not changed');
  const ledger = f.read('pm-decisions.md');
  assert.ok(ledger.startsWith(ledgerBefore), 'the PM ledger is appended, never rewritten'); assert.match(ledger.slice(ledgerBefore.length), /switched from specialist to router-worker/);
  assert.equal(refusal(f.apply()).code, 'SWITCH_REFUSED', 'already in that mode');
});

test('switching back unpacks the specialist team exactly as it was, and Router/Worker goes on holiday in turn', t => {
  const f = fixture(t), before = f.digests(OWN_SPECIALIST);
  f.apply(); appendFileSync(join(f.root, 'agents/lessons.md'), '\n- a lesson learned in Router/Worker mode\n');
  const back = f.apply('specialist', {});
  assert.equal(back.errors, undefined, JSON.stringify(back.errors)); assert.equal(back.mode, 'specialist');
  assert.deepEqual(f.digests(OWN_SPECIALIST), before, 'roster, delivery role and wrapper are back byte for byte');
  assert.deepEqual(f.wrappers(), ['tag-list-fixture-backend.md']); assert.equal(existsSync(join(f.root, 'holiday/specialist')), false);
  assert.ok(existsSync(join(f.root, 'holiday/router-worker/agents/worker-exec.md')) && existsSync(join(f.root, 'holiday/router-worker/manifest.json')));
  assert.match(f.read('agents/lessons.md'), /a lesson learned in Router\/Worker mode/, 'history written in between is kept');
  assert.equal(existsSync(join(f.root, 'profiles/team-mode.json')), false, 'the specialist team had no mode profile, and has none again');
  const again = f.apply('router-worker', {});
  assert.equal(again.errors, undefined, JSON.stringify(again.errors)); assert.equal(again.mode, 'router-worker');
  assert.deepEqual(JSON.parse(f.read('profiles/team-mode.json')).staffing.exec, f.spec.profiles.exec, 'the staffing confirmed the first time is proposed again from the holiday record');
});

test('a switch is refused, and nothing moves, when the product is dirty, a batch holds the lock, or a packed team was edited', t => {
  const unchanged = (f, to, request, pattern) => { const before = f.digests([...OWN_SPECIALIST, 'profiles/team-mode.json']), result = f.propose(to, request);
    assert.equal(refusal(result)?.code, 'SWITCH_REFUSED', JSON.stringify(result).slice(0, 200)); assert.match(refusal(result).reason, pattern); assert.deepEqual(f.digests([...OWN_SPECIALIST, 'profiles/team-mode.json']), before); };
  const dirty = fixture(t); writeFileSync(join(dirty.product, 'notes.txt'), 'x\n');
  unchanged(dirty, 'router-worker', { spec: dirty.spec }, /uncommitted.*notes\.txt/);
  const busy = fixture(t); acquireLease({ teamRoot: busy.root, productRoot: busy.product });
  unchanged(busy, 'router-worker', { spec: busy.spec }, /batch|lock/);
  const edited = fixture(t); edited.apply(); appendFileSync(join(edited.root, 'holiday/specialist/agents/roster.md'), 'edited by hand\n');
  unchanged(edited, 'specialist', {}, /holiday/);
  const none = fixture(t);
  unchanged(none, 'specialist', {}, /already/);
  assert.equal(refusal(proposeSwitch({ to: 'router-worker', request: { spec: none.spec }, teamRoot: none.kit, instanceRoot: none.kit, productRoot: none.product })).code, 'SWITCH_REFUSED', 'a single-root layout');
  assert.equal(refusal(none.propose('holiday', {})).code, 'SWITCH_REFUSED');
});

test('CLI proposes without --confirm and switches with it; exit 0 done, 2 refused or proposal only, 1 usage', t => {
  const f = fixture(t), file = join(f.base, 'switch.json'), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify({ spec: f.spec }));
  const proposed = run('switch', 'router-worker', file, '--instance', f.root, '--product-root', f.product);
  assert.equal(proposed.status, 2, 'a proposal is not a switch'); const proposal = JSON.parse(proposed.stdout);
  assert.equal(proposal.stage, 'switch-proposed'); assert.equal(existsSync(join(f.root, 'holiday')), false);
  const done = run('switch', 'router-worker', file, '--instance', f.root, '--product-root', f.product, '--confirm', proposal.digest);
  assert.equal(done.status, 0, done.stderr); assert.equal(JSON.parse(done.stdout).stage, 'mode-switched');
  assert.equal(run('switch', 'router-worker').status, 1);
});
