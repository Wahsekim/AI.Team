// ADR 0010, decisions 4 to 7: a deployed team is switched between specialist and Router/Worker mode.
// The live mode's own files go on holiday; shared history stays; the owner confirms the proposal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { proposeSwitch, switchMode, recoverSwitch, DEFAULT_LIMITS } from '../src/router-worker/switch.mjs';
import { acquireLease, readLease } from '../src/router-worker/lease.mjs';
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
  const apply = (to = 'router-worker', request = { spec }, confirm, extra = {}) => switchMode({ to, request, ...common, ...extra, confirm: confirm ?? propose(to, request).digest });
  const read = path => readFileSync(join(root, path), 'utf8'), digests = paths => Object.fromEntries(paths.map(path => [path, existsSync(join(root, path)) ? bytesDigest(readFileSync(join(root, path))) : null]));
  const tree = () => execFileSync('bash', ['-c', 'cd "$1" && find . -path ./kit -prune -o -type f -exec shasum -a 256 {} + | sort', 'sh', root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { base, root, kit, product, spec, common, propose, apply, read, digests, tree, wrappers: () => readdirSync(join(root, '.claude/agents')).sort() };
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
  assert.deepEqual(f.propose('router-worker', { spec: f.spec, limits: { outputAllowancePerTicket: 20000 } }).limits, { ...DEFAULT_LIMITS, outputAllowancePerTicket: 20000 }, 'the owner may change a limit in the request');
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
  assert.ok(ledger.startsWith(ledgerBefore), 'the PM ledger is appended, never rewritten'); assert.match(ledger.slice(ledgerBefore.length), /MODE SWITCH: from specialist to router-worker/);
  assert.doesNotMatch(ledger.slice(ledgerBefore.length), /OWNER/, 'the line does not claim who confirmed');
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
  const unchanged = (f, to, request, pattern) => { const before = f.tree();
    for (const result of [f.propose(to, request), switchMode({ to, request, ...f.common, confirm: 'sha256:' + '0'.repeat(64) })]) {
      assert.equal(refusal(result)?.code, 'SWITCH_REFUSED', JSON.stringify(result).slice(0, 200)); assert.match(refusal(result).reason, pattern); }
    assert.equal(f.tree(), before, 'neither the proposal nor the switch moved anything'); };
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
  assert.equal(run('switch', 'bogus', '/nonexistent', '--instance', f.root, '--product-root', f.product).status, 1, 'an unknown mode is a usage error, before any file is read');
  assert.equal(run('switch', 'specialist', file, '--instance', f.root, '--instance', f.root, '--product-root', f.product).status, 1, 'a repeated flag');
  const nothing = run('switch', 'recover', '--instance', f.root);
  assert.equal(nothing.status, 2); assert.match(nothing.stderr, /no interrupted switch/);
});

test('an existing holiday folder is never touched by a refused switch', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'holiday/specialist/agents'), { recursive: true }); writeFileSync(join(f.root, 'holiday/specialist/agents/precious.md'), 'kept by hand\n');
  const before = f.tree();
  for (const result of [f.propose(), switchMode({ to: 'router-worker', request: { spec: f.spec }, ...f.common, confirm: 'sha256:' + '0'.repeat(64) })]) {
    assert.equal(refusal(result)?.code, 'SWITCH_REFUSED'); assert.match(refusal(result).reason, /holiday\/specialist already exists/); }
  assert.equal(f.tree(), before);
});

test('a switch that fails after the files moved puts everything back, including the product lock', t => {
  const f = fixture(t), before = f.tree();
  const failed = f.apply('router-worker', { spec: f.spec }, undefined, { validate: () => ({ ok: false, verdict: 'DEPLOYMENT-INCOMPLETE — injected' }) });
  assert.equal(refusal(failed)?.code, 'SWITCH_REFUSED'); assert.match(refusal(failed).reason, /injected/);
  assert.equal(f.tree(), before, 'the tree is byte for byte what it was, with no empty holiday folder left'); assert.equal(existsSync(join(f.root, 'holiday')), false);
  assert.equal(readLease({ productRoot: f.product }).status, 'free');
});

test('an interrupted switch is found by its journal and rolled back by recover; nothing is lost', t => {
  const f = fixture(t), before = f.tree();
  // A switch that died after packing the roster and one wrapper: the journal is what it wrote first.
  const proposal = f.propose();
  mkdirSync(join(f.root, 'holiday/specialist/agents'), { recursive: true }); mkdirSync(join(f.root, 'holiday/specialist/.claude/agents'), { recursive: true });
  writeFileSync(join(f.root, 'holiday/.switch-in-progress.json'), JSON.stringify({ schemaVersion: 1, from: 'specialist', to: 'router-worker', kind: 'draft', pack: proposal.pack, install: proposal.install, lease: null }));
  for (const path of ['agents/roster.md', '.claude/agents/tag-list-fixture-backend.md']) cpSync(join(f.root, path), join(f.root, 'holiday/specialist', path)), rmSync(join(f.root, path));
  writeFileSync(join(f.root, 'agents/worker-exec.md'), 'half written\n');
  for (const result of [f.propose(), switchMode({ to: 'router-worker', request: { spec: f.spec }, ...f.common, confirm: proposal.digest })]) {
    assert.equal(refusal(result)?.code, 'SWITCH_INTERRUPTED'); assert.match(refusal(result).reason, /recover/); }
  const recovered = recoverSwitch({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(recovered.errors, undefined, JSON.stringify(recovered.errors)); assert.equal(recovered.stage, 'switch-rolled-back');
  assert.equal(f.tree(), before, 'the specialist team is whole again');
  assert.equal(f.apply().errors, undefined, 'and the switch can be made');
  assert.equal(refusal(recoverSwitch({ teamRoot: f.kit, instanceRoot: f.root })).code, 'SWITCH_REFUSED', 'nothing to recover');
});

test('work done in Router/Worker mode survives going on holiday and coming back', t => {
  const f = fixture(t); f.apply();
  appendFileSync(join(f.root, 'agents/roster.md'), '\nmodel changed by the owner in Router/Worker mode\n');
  appendFileSync(join(f.root, 'agents/coach.md'), '\ncoach overlay written in Router/Worker mode\n');
  // A wrapper the owner added in Router/Worker mode: a copy of a live one under another name.
  writeFileSync(join(f.root, '.claude/agents/tag-list-fixture-extra.md'), f.read('.claude/agents/tag-list-fixture-auditor.md').replaceAll('tag-list-fixture-auditor', 'tag-list-fixture-extra'));
  const live = f.digests(['agents/roster.md', '.claude/agents/tag-list-fixture-extra.md', 'profiles/team-mode.json']);
  assert.equal(f.apply('specialist', {}).errors, undefined);
  assert.match(f.read('agents/coach.md'), /coach overlay written in Router\/Worker mode/, 'a governance role file is shared: it stays live in specialist mode');
  assert.deepEqual(f.wrappers(), ['tag-list-fixture-backend.md'], 'a wrapper added in Router/Worker mode went on holiday with its mode');
  const back = f.apply('router-worker', {});
  assert.equal(back.errors, undefined, JSON.stringify(back.errors));
  assert.deepEqual(f.digests(Object.keys(live)), live, 'the Router/Worker team comes back as it was packed, edits included');
  assert.equal(existsSync(join(f.root, 'holiday/router-worker')), false);
});

test('the specialist team\'s own files are read from the roster table, whatever its markup, and never include a shared ledger', t => {
  const f = fixture(t), roster = join(f.root, 'agents/roster.md');
  writeFileSync(roster, ['| Role id | Display | Role file | Wrapper file | Status |', '|---|---|---|---|---|',
    '| `pm` | PM | `agents/pm.md` | main session | active |', '| **backend** | B | `agents/backend.md` | `.claude/agents/tag-list-fixture-backend.md` | active |',
    '|`data-2`| D | agents/data-2.md | `.claude/agents/sub/tag-list-fixture-data-2.md` | active |', '| lessons | L | `agents/lessons.md` | none | active |',
    '| coach | C | `agents/coach.md` | none | active |', '', '| Tier | Roles |', '|---|---|', '| Mid tier | lifecycle, backend |'].join('\n') + '\n');
  writeFileSync(join(f.root, 'agents/data-2.md'), '# data role\n'); mkdirSync(join(f.root, '.claude/agents/sub')); writeFileSync(join(f.root, '.claude/agents/sub/tag-list-fixture-data-2.md'), 'nested wrapper\n');
  const pack = f.propose().pack;
  assert.deepEqual(pack, ['.claude/agents/sub/tag-list-fixture-data-2.md', '.claude/agents/tag-list-fixture-backend.md', 'agents/backend.md', 'agents/data-2.md', 'agents/roster.md']);
});

test('the product repository is the one the team is bound to, and it must be at rest', t => {
  const f = fixture(t), other = join(f.base, 'other'); mkdirSync(other); git(other, 'init', '-q'); writeFileSync(join(other, 'a'), 'x'); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'x');
  f.apply(); writeFileSync(join(f.product, 'dirty.txt'), 'x\n');
  const elsewhere = proposeSwitch({ to: 'specialist', request: {}, ...f.common, productRoot: other });
  assert.equal(refusal(elsewhere)?.code, 'SWITCH_REFUSED'); assert.match(refusal(elsewhere).reason, /product/, 'another clean repository does not get a dirty one past the check');
  rmSync(join(f.product, 'dirty.txt')); writeFileSync(join(f.product, '.git/MERGE_HEAD'), 'x\n');
  assert.match(refusal(f.propose('specialist', {})).reason, /in progress/);
});

test('a mode profile or a manifest that names a shared file is refused, not obeyed', t => {
  const f = fixture(t); f.apply();
  const profile = join(f.root, 'profiles/team-mode.json'), mode = JSON.parse(readFileSync(profile, 'utf8'));
  writeFileSync(profile, JSON.stringify({ ...mode, ownFiles: [...mode.ownFiles, 'charter.md', 'agents/lessons.md'] }));
  assert.match(refusal(f.propose('specialist', {})).reason, /charter\.md/); assert.ok(existsSync(join(f.root, 'charter.md')));
  const { ownFiles, ...without } = mode; writeFileSync(profile, JSON.stringify(without));
  assert.equal(refusal(f.propose('specialist', {})).code, 'SWITCH_REFUSED');
  writeFileSync(profile, JSON.stringify(mode));
  const manifest = join(f.root, 'holiday/specialist/manifest.json'), packed = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, JSON.stringify({ ...packed, files: [...packed.files, { path: '../outside.md', digest: 'sha256:' + '0'.repeat(64) }] }));
  assert.match(refusal(f.propose('specialist', {})).reason, /outside\.md/);
});
