// ADR 0010, decisions 4 to 7: a deployed team is switched between specialist and Router/Worker mode.
// The live mode's own files go on holiday; shared history stays; the owner confirms the proposal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync, readdirSync, appendFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { proposeSwitch, switchMode, recoverSwitch, DEFAULT_LIMITS } from '../src/router-worker/switch.mjs';
import { acquireLease, readLease } from '../src/router-worker/lease.mjs';
import { readBoundary, decideCall, boundaryGap } from '../src/router-worker/write-boundary.mjs';
import { bytesDigest } from '../src/loop/contracts.mjs';
import { fixture, git, CLI } from './fixtures/router-worker/standing-team.mjs';

const SHARED = ['charter.md', 'CLAUDE.md', 'agents/lifecycle.md', 'agents/lessons.md', 'memory/pm.md', 'profiles/project.md', 'profiles/stack.md', 'kit.lock'];

const refusal = result => result.errors?.[0];
const sansLedger = tree => tree.split('\n').filter(line => !line.endsWith('./pm-decisions.md')).join('\n');
const sansBackup = tree => tree.split('\n').filter(line => !line.includes('./holiday/.switch-backup-')).join('\n');
const passes = () => ({ ok: true, verdict: 'DEPLOYMENT-STRUCTURALLY-COMPLETE (injected)' });
const OWN_SPECIALIST = ['agents/roster.md', 'agents/backend.md', '.claude/agents/tag-list-fixture-backend.md'];

test('a proposal names the staffing, the limits and the files that move, and changes nothing', t => {
  const f = fixture(t), before = f.digests([...OWN_SPECIALIST, ...SHARED]), proposal = f.propose();
  assert.equal(proposal.errors, undefined, JSON.stringify(proposal.errors));
  assert.equal(proposal.from, 'specialist'); assert.equal(proposal.to, 'router-worker'); assert.equal(proposal.dispatch, 'engine');
  assert.deepEqual(proposal.limits, DEFAULT_LIMITS);
  assert.deepEqual(DEFAULT_LIMITS, { attemptsPerTicket: 1, outputAllowancePerTicket: 15000, guardianOutputShare: 6000, authorizationPerTicket: 200000, authorizationPerReviewerCall: 300000, allowedCommands: [] });
  // The commands a worker's shell runs in a batch are in the proposal the owner confirms, as written.
  assert.deepEqual(f.propose('router-worker', { spec: f.spec, limits: { allowedCommands: ['npm test', 'npm run lint -- --max-warnings 0'] } }).limits.allowedCommands, ['npm test', 'npm run lint -- --max-warnings 0']);
  for (const bad of [null, 'npm test', ['npm test', 'npm test'], ['npm test\nrm -rf x'], [' npm test'], [''], [7], ['npm  test'], ['npm test\u202e'], ['npm\u00a0test'], ['x'.repeat(301)], Array.from({ length: 51 }, (_, i) => `make t${i}`)])
    assert.match(refusal(f.propose('router-worker', { spec: f.spec, limits: { allowedCommands: bad } })).reason, /allowedCommands must list at most 50 distinct commands, each on one line/, JSON.stringify(bad).slice(0, 60));
  // The refusal names the command that is refused.
  assert.match(refusal(f.propose('router-worker', { spec: f.spec, limits: { allowedCommands: ['npm test', 'npm  test'] } })).reason, /: "npm  test" is not one such command$/);
  assert.match(refusal(f.propose('router-worker', { spec: f.spec, limits: { allowedCommands: ['npm test', 'make', 'npm test'] } })).reason, /: "npm test" is listed twice$/);
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
  const routing = f.read('agents/router-worker-router.md');
  assert.ok(routing.includes('node kit/scripts/rw-batch.mjs') && routing.includes('kit/docs/design/router-worker/batch.md'), 'the live routing supplement sends the PM to the batch command and its order');
  const mode = JSON.parse(f.read('profiles/team-mode.json'));
  assert.equal(mode.mode, 'router-worker'); assert.equal(mode.status, 'live'); assert.equal(mode.dispatch, 'engine'); assert.deepEqual(mode.limits, DEFAULT_LIMITS);
  assert.equal(mode.confirmedProposal, result.proposalDigest); assert.ok(mode.ownFiles.includes('agents/worker-exec.md'));
  assert.deepEqual(f.digests(SHARED), shared, 'charter, ledgers, lessons, memory and profiles are not packed and not changed');
  const ledger = f.read('pm-decisions.md');
  assert.ok(ledger.startsWith(ledgerBefore), 'the PM ledger is appended, never rewritten'); assert.match(ledger.slice(ledgerBefore.length), /MODE SWITCH: from specialist to router-worker/);
  assert.doesNotMatch(ledger.slice(ledgerBefore.length), /OWNER/, 'the line does not claim who confirmed');
  assert.equal(refusal(f.apply()).code, 'SWITCH_REFUSED', 'already in that mode');
});

test('a switch into Router/Worker is not confirmed by a program that calls it', t => {
  const f = fixture(t), before = f.tree();
  assert.equal(refusal(f.apply('router-worker', { spec: f.spec }, undefined, { atTerminal: false })).code, 'SWITCH_NOT_CONFIRMED');
  assert.equal(f.tree(), before, 'nothing moved, and no ledger line');
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

test('CLI: a switch is confirmed only by a code typed at an interactive terminal; without one it proposes and changes nothing', t => {
  const f = fixture(t), file = join(f.base, 'switch.json'), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', input: 'anything\n' });
  writeFileSync(file, JSON.stringify({ spec: f.spec }));
  const args = ['switch', 'router-worker', file, '--instance', f.root, '--product-root', f.product];
  const proposed = run(...args);
  assert.equal(proposed.status, 2, 'a proposal is not a switch'); const proposal = JSON.parse(proposed.stdout);
  assert.equal(proposal.stage, 'switch-proposed'); assert.match(proposed.stderr, /interactive terminal/); assert.equal(existsSync(join(f.root, 'holiday')), false);
  assert.equal(run(...args, '--confirm', proposal.digest).status, 1, 'the digest on the command line is no longer a confirmation');
  assert.equal(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input: proposal.digest.slice(-8) + '\n' }).status, 2, 'nor is the code on a pipe');
  assert.equal(existsSync(join(f.root, 'holiday')), false);
  // The same command inside a pseudo-terminal, with the answer typed when the question appears.
  const pty = (answer) => spawnSync('python3', ['-c', `
import os, pty, sys
argv, answer = sys.argv[2:], sys.argv[1]
pid, fd = pty.fork()
if pid == 0: os.execvp(argv[0], argv)
seen, sent = b'', False
while True:
    try: chunk = os.read(fd, 4096)
    except OSError: break
    if not chunk: break
    seen += chunk
    if not sent and b'anything else cancels' in seen:
        os.write(fd, ((seen.split(b'Type ')[-1].split(b' ')[0].decode() if answer == 'CODE' else answer) + '\\n').encode()); sent = True
sys.stdout.write(seen.decode(errors='replace')); sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`, answer, process.execPath, CLI, ...args], { encoding: 'utf8' });
  const cancelled = pty('no');
  assert.equal(cancelled.status, 2, cancelled.stdout + cancelled.stderr); assert.match(cancelled.stdout, /Cancelled/); assert.equal(existsSync(join(f.root, 'holiday')), false);
  const done = pty('CODE');
  assert.equal(done.status, 0, done.stdout + done.stderr); assert.match(done.stdout, /"stage": "mode-switched"/);
  assert.match(f.read('pm-decisions.md'), /confirmed by its code, typed at an interactive terminal/);
  assert.equal(run('switch', 'bogus', '/nonexistent', '--instance', f.root, '--product-root', f.product).status, 1, 'an unknown mode is a usage error, before any file is read');
  assert.equal(run('switch', 'specialist', file, '--instance', f.root, '--instance', f.root, '--product-root', f.product).status, 1, 'a repeated flag');
  const nothing = run('switch', 'recover', '--instance', f.root);
  assert.equal(nothing.status, 2); assert.match(nothing.stderr, /no interrupted switch/);
});

test('CLI: the short form runs from the instance root with {} and the product path of profiles/project.md', t => {
  const f = fixture(t), file = join(f.base, 'switch.json');
  writeFileSync(file, JSON.stringify({ spec: f.spec }));
  const run = (cwd, ...argv) => spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: 'utf8', input: '' });
  const project = join(f.root, 'profiles/project.md');
  writeFileSync(project, readFileSync(project, 'utf8').replace(/^(\s*product_repo_path:).*$/m, `$1 "${f.product}"`));
  const long = JSON.parse(run(f.base, 'switch', 'router-worker', file, '--instance', f.root, '--product-root', f.product).stdout);
  const short = run(f.root, 'switch', 'rw', file);
  assert.equal(short.status, 2, short.stderr); assert.equal(JSON.parse(short.stdout).digest, long.digest, 'rw, the current folder and the recorded product are the long form');
  const empty = run(f.root, 'switch', 'rw');
  assert.equal(empty.status, 2); assert.match(empty.stderr, /not the product repository this team is bound to/, 'with no REQUEST.json the request is {}: no spec binds the recorded product');
  writeFileSync(project, readFileSync(project, 'utf8').replace(/^(\s*product_repo_path:).*$/m, '$1 "{{PRODUCT_REPO_PATH}}"'));
  const unrecorded = run(f.root, 'switch', 'rw', file);
  assert.equal(unrecorded.status, 2); assert.match(unrecorded.stderr, /records no product_repo_path; pass --product-root/);
  assert.equal(run(f.root, 'switch', 'rw', file, 'extra').status, 1, 'a stray argument is a usage error');
  const elsewhere = run(f.base, 'switch', 'rw', file);
  assert.equal(elsewhere.status, 2); assert.match(elsewhere.stderr, /is not an instance root \(no kit.lock\)/);
  assert.equal(existsSync(join(f.root, 'holiday')), false);
});

test('an existing holiday folder is never touched by a refused switch', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'holiday/specialist/agents'), { recursive: true }); writeFileSync(join(f.root, 'holiday/specialist/agents/roster.md'), 'kept by hand\n');
  const before = f.tree();
  for (const result of [f.propose(), switchMode({ to: 'router-worker', request: { spec: f.spec }, ...f.common, confirm: 'sha256:' + '0'.repeat(64) })]) {
    assert.equal(refusal(result)?.code, 'SWITCH_REFUSED'); assert.match(refusal(result).reason, /holiday\/specialist already holds a packed team/); }
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
  writeFileSync(join(f.root, 'holiday/.switch-in-progress.json'), JSON.stringify({ schemaVersion: 1, from: 'specialist', to: 'router-worker', kind: 'draft', pack: proposal.pack, install: proposal.install, lease: null, productRoot: f.product, startedAt: new Date().toISOString(), backup: '.switch-backup-0a' }));
  for (const path of ['agents/roster.md', '.claude/agents/tag-list-fixture-backend.md']) cpSync(join(f.root, path), join(f.root, 'holiday/specialist', path)), rmSync(join(f.root, path));
  writeFileSync(join(f.root, 'agents/worker-exec.md'), 'half written\n');
  for (const result of [f.propose(), switchMode({ to: 'router-worker', request: { spec: f.spec }, ...f.common, confirm: proposal.digest })]) {
    assert.equal(refusal(result)?.code, 'SWITCH_INTERRUPTED'); assert.match(refusal(result).reason, /recover/); }
  const recovered = recoverSwitch({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(recovered.errors, undefined, JSON.stringify(recovered.errors)); assert.equal(recovered.stage, 'switch-rolled-back');
  assert.equal(sansLedger(f.tree()), sansLedger(before), 'the specialist team is whole again');
  assert.match(f.read('pm-decisions.md'), /MODE SWITCH ROLLED BACK: the interrupted switch from specialist to router-worker/);
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
  assert.match(refusal(f.propose()).reason, /role file under agents\/ for the role lessons/, 'a row that names a ledger as a role file stops the switch');
  const rows = readFileSync(roster, 'utf8').split('\n').filter(line => !line.startsWith('| lessons |'));
  const expected = ['.claude/agents/sub/tag-list-fixture-data-2.md', '.claude/agents/tag-list-fixture-backend.md', 'agents/backend.md', 'agents/data-2.md', 'agents/roster.md'];
  writeFileSync(roster, rows.join('\n')); assert.deepEqual(f.propose().pack, expected);
  // Other ways the same table is written: a "Role" header, a linked file cell, an escaped pipe in an earlier cell.
  writeFileSync(roster, rows.join('\n').replace('| Role id |', '| Role |').replace('| `agents/backend.md` |', '| [agents/backend.md](agents/backend.md) |').replace('| D |', '| a \\| b |'));
  assert.deepEqual(f.propose().pack, expected);
  // A delivery role whose file cannot be read would stay live in the other mode: the switch stops and names it.
  writeFileSync(roster, rows.join('\n').replace('| `agents/backend.md` |', '| see the wiki |'));
  assert.match(refusal(f.propose()).reason, /for the role backend/);
  writeFileSync(roster, '# Roster\n\nNo table here.\n');
  assert.match(refusal(f.propose()).reason, /no table/);
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

test('the first switch is bound to the product repository bootstrap recorded', t => {
  const f = fixture(t), other = join(f.base, 'other'); mkdirSync(other); git(other, 'init', '-q'); writeFileSync(join(other, 'a'), 'x'); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'x');
  writeFileSync(join(f.product, 'dirty.txt'), 'x\n');
  const spec = { ...f.spec, project: { ...f.spec.project, productRoot: other } };
  const elsewhere = proposeSwitch({ to: 'router-worker', request: { spec }, ...f.common, productRoot: other });
  assert.match(refusal(elsewhere).reason, /recorded in profiles\/project\.md/, 'a spec naming another clean repository does not get the dirty one past the check');
});

test('a packed Router/Worker team comes back with its own staffing and limits, shown in the proposal; other limits are refused', t => {
  const f = fixture(t); f.apply('router-worker', { spec: f.spec, limits: { outputAllowancePerTicket: 20000 } }); f.apply('specialist', {});
  const proposal = f.propose('router-worker', { spec: f.spec });
  assert.equal(proposal.errors, undefined, JSON.stringify(proposal.errors));
  assert.equal(proposal.limits.outputAllowancePerTicket, 20000); assert.deepEqual(proposal.staffing.exec, f.spec.profiles.exec); assert.equal(proposal.dispatch, 'engine');
  const other = f.propose('router-worker', { spec: f.spec, limits: { outputAllowancePerTicket: 99 } });
  assert.match(refusal(other).reason, /limits it was packed with.*20000/);
});

test('a restore that fails is rolled back; a file in its way refuses it; a stray file in a holiday folder blocks nothing', t => {
  const f = fixture(t); f.apply(); f.apply('specialist', {});
  const before = f.tree();
  const failed = f.apply('router-worker', { spec: f.spec }, undefined, { validate: () => ({ ok: false, verdict: 'DEPLOYMENT-INCOMPLETE — injected' }) });
  assert.match(refusal(failed).reason, /injected/); assert.equal(f.tree(), before, 'both teams are where they were'); assert.equal(readLease({ productRoot: f.product }).status, 'free');
  writeFileSync(join(f.root, 'agents/worker-exec.md'), 'in the way\n');
  assert.match(refusal(f.propose()).reason, /in the way.*agents\/worker-exec\.md/); rmSync(join(f.root, 'agents/worker-exec.md'));
  writeFileSync(join(f.root, 'holiday/router-worker/.DS_Store'), 'x');
  const back = f.apply(); assert.equal(back.errors, undefined, JSON.stringify(back.errors)); assert.deepEqual(back.leftInHoliday, ['.DS_Store']);
  const again = f.apply('specialist', {}); assert.equal(again.errors, undefined, 'the stray file does not block the next switch: ' + JSON.stringify(again.errors));
  assert.ok(existsSync(join(f.root, 'holiday/router-worker/.DS_Store')) && existsSync(join(f.root, 'holiday/router-worker/manifest.json')));
});

test('recover obeys a journal only for files a mode may own', t => {
  const f = fixture(t), proposal = f.propose(), shared = ['charter.md', 'agents/lessons.md', 'memory/pm.md', 'pm-decisions.md', 'kit.lock'], before = f.tree();
  mkdirSync(join(f.root, 'holiday'));
  for (const kind of ['draft', 'restore']) {
    writeFileSync(join(f.root, 'holiday/.switch-in-progress.json'), JSON.stringify({ schemaVersion: 1, from: 'specialist', to: 'router-worker', kind, pack: proposal.pack, install: shared, lease: null, productRoot: f.product, startedAt: new Date().toISOString(), backup: '.switch-backup-0a' }));
    assert.match(refusal(recoverSwitch({ teamRoot: f.kit, instanceRoot: f.root })).reason, /not a mode's own.*charter\.md/);
  }
  rmSync(join(f.root, 'holiday'), { recursive: true }); assert.equal(f.tree(), before, 'nothing was moved or deleted');
});

test('CLI: switch recover rolls an interrupted switch back', t => {
  const f = fixture(t), proposal = f.propose();
  mkdirSync(join(f.root, 'holiday/specialist/agents'), { recursive: true });
  writeFileSync(join(f.root, 'holiday/.switch-in-progress.json'), JSON.stringify({ schemaVersion: 1, from: 'specialist', to: 'router-worker', kind: 'draft', pack: proposal.pack, install: proposal.install, lease: null, productRoot: f.product, startedAt: new Date().toISOString(), backup: '.switch-backup-0a' }));
  cpSync(join(f.root, 'agents/roster.md'), join(f.root, 'holiday/specialist/agents/roster.md')); rmSync(join(f.root, 'agents/roster.md'));
  const run = () => spawnSync('node', [CLI, 'switch', 'recover', '--instance', f.root], { encoding: 'utf8' });
  const done = run(); assert.equal(done.status, 0, done.stdout + done.stderr); assert.equal(JSON.parse(done.stdout).stage, 'switch-rolled-back');
  assert.ok(existsSync(join(f.root, 'agents/roster.md')) && !existsSync(join(f.root, 'holiday')));
  assert.equal(run().status, 2, 'nothing left to recover');
});

// The process "dies" at its nth write under `roots`: that write and every later one fail, so nothing after it reaches the disk.
const WRITES = ['renameSync', 'writeFileSync', 'rmSync', 'mkdirSync', 'rmdirSync', 'appendFileSync', 'linkSync', 'unlinkSync', 'copyFileSync'];
function dieAt(n, roots, action) {
  const real = Object.fromEntries(WRITES.map(name => [name, fs[name]]));
  let seen = 0;
  for (const name of WRITES) fs[name] = (path, ...rest) => {
    if (roots.some(root => String(path).startsWith(root)) && ++seen >= n) throw Object.assign(Error('the process died'), { code: 'EDEAD' });
    return real[name](path, ...rest);
  };
  syncBuiltinESMExports();
  try { action(); } catch { /* the death itself */ } finally { Object.assign(fs, real); syncBuiltinESMExports(); }
  return seen;
}

test('a switch that dies at any write is undone by recover: the tree is as before, the lock is free, the next switch is possible', t => {
  const f = fixture(t), roots = [f.root + '/', f.product + '/'], keep = join(f.base, 'snapshot');
  // The team has settings of its own, so every rollback has a file to put back.
  writeFileSync(join(f.root, '.claude/settings.json'), JSON.stringify({ env: { KEEP: '1' } }, null, 4) + '\n');
  const entries = dir => readdirSync(dir).filter(name => name !== 'kit');
  const save = () => { rmSync(keep, { recursive: true, force: true }); mkdirSync(keep); for (const name of entries(f.root)) cpSync(join(f.root, name), join(keep, name), { recursive: true }); };
  const unlock = () => { for (const name of readdirSync(join(f.product, '.git'))) if (name.startsWith('rw-ownership-lease')) rmSync(join(f.product, '.git', name)); };
  const reset = () => { for (const name of entries(f.root)) rmSync(join(f.root, name), { recursive: true, force: true }); for (const name of entries(keep)) cpSync(join(keep, name), join(f.root, name), { recursive: true }); unlock(); };
  const recover = () => recoverSwitch({ teamRoot: f.kit, instanceRoot: f.root });
  // Every write of the two restores; a first switch drafts and stages a team for each attempt, so it is sampled.
  const cases = [['router-worker', { spec: f.spec }, (n, total) => n <= 3 || n > total - 6 || n % 12 === 0],
    ['specialist', {}, () => true], ['router-worker', { spec: f.spec }, () => true]];
  for (const [to, request, sampled] of cases) {
    save();
    const before = sansLedger(f.tree()), confirm = f.propose(to, request).digest, attempt = () => f.apply(to, request, confirm, { validate: passes });
    const total = dieAt(Infinity, roots, attempt), switched = sansLedger(f.tree());
    assert.ok(total > 20, `the switch to ${to} was made (${total} writes)`);
    for (let n = 1; n <= total; n++) {
      if (!sampled(n, total)) continue;
      reset(); dieAt(n, roots, attempt);
      let recovered = recover();
      // A death inside the lock's own release leaves the lock's guard file; its message names it, the operator removes it.
      if (/release-lock/.test(refusal(recovered)?.reason ?? '')) { rmSync(join(f.product, '.git/rw-ownership-lease.json.release-lock')); recovered = recover(); }
      const where = `switch to ${to}, death at write ${n} of ${total}`;
      assert.ok(recovered.stage === 'switch-rolled-back' || /no interrupted switch/.test(refusal(recovered).reason), `${where}: ${JSON.stringify(recovered)}`);
      assert.equal(readLease({ productRoot: f.product }).status, 'free', where);
      // Once the journal is gone the switch is done; only the copy of the settings it kept aside may be left.
      if (!recovered.stage && sansBackup(sansLedger(f.tree())) === switched) continue;
      assert.equal(sansLedger(f.tree()), before, where);
      assert.equal(f.propose(to, request).digest, confirm, `${where}: the same switch can be proposed again`);
    }
    // A recover that dies itself, at each of its writes, is finished by the next recover.
    const late = total - 6, undo = (() => { reset(); dieAt(late, roots, attempt); return dieAt(Infinity, roots, recover); })();
    // Every second write of the recover: enough to land in each of its phases.
    for (let m = 1; m <= undo; m += 2) {
      reset(); dieAt(late, roots, attempt); dieAt(m, roots, recover);
      const again = recover(), where = `switch to ${to}, death at write ${late}, recover dead at its write ${m} of ${undo}`;
      assert.ok(again.stage === 'switch-rolled-back' || /no interrupted switch/.test(refusal(again).reason), `${where}: ${JSON.stringify(again)}`);
      assert.equal(sansLedger(f.tree()), before, where); assert.equal(readLease({ productRoot: f.product }).status, 'free', where);
    }
    reset(); assert.equal(attempt().errors, undefined);
  }
  // A copy that lost a file is never read as "there was no file": recover stops instead of deleting the team's settings.
  const last = () => f.apply('router-worker', { spec: f.spec }, undefined, { validate: passes });
  reset(); const writes = dieAt(Infinity, roots, last); reset(); dieAt(writes - 6, roots, last);
  const backup = readdirSync(join(f.root, 'holiday')).find(name => name.startsWith('.switch-backup-'));
  assert.ok(backup, 'the death left the copy in place'); rmSync(join(f.root, 'holiday', backup, '0'));
  assert.match(refusal(recover()).reason, /settings\.json kept aside by the switch is missing/); assert.ok(existsSync(join(f.root, '.claude/settings.json')));
  // A journal that does not name its copy is not rolled back as if there were none.
  const journalPath = join(f.root, 'holiday/.switch-in-progress.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  for (const bad of [undefined, 7, '../../.claude', '.switch-backup-00']) {
    writeFileSync(journalPath, JSON.stringify({ ...journal, backup: bad })); const tree = f.tree();
    assert.match(refusal(recover()).reason, /copy of the settings/, String(bad)); assert.equal(f.tree(), tree);
  }
});

test('the switch installs the write-limit hook: between batches no worker may write, a governance role is not judged; switching back removes it', t => {
  const f = fixture(t), settings = join(f.root, '.claude/settings.json'), other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo watchdog' }] };
  writeFileSync(settings, JSON.stringify({ env: { KEEP: '1' }, hooks: { PreToolUse: [other], Stop: [other] } }));
  const before = readFileSync(settings, 'utf8');
  assert.equal(f.apply().errors, undefined);
  const boundary = readBoundary(f.root), wrappers = Object.fromEntries(['exec', 'check', 'guard'].map(duty => [duty, `tag-list-fixture-worker-${duty}`]));
  assert.ok(boundary, 'a boundary exists as soon as the team is in Router/Worker mode'); assert.equal(boundary.productRoot, f.product);
  assert.equal(boundaryGap({ teamRoot: f.root, productRoot: f.product, wrappers }), null, 'the hook is registered and its file exists');
  const write = (agent, path) => decideCall({ boundary, input: { tool_name: 'Write', agent_type: agent, cwd: f.product, tool_input: { file_path: path } } }).decision;
  assert.equal(write('tag-list-fixture-worker-exec', 'src/app.js'), 'deny', 'no batch is open'); assert.equal(write('tag-list-fixture-worker-check', 'src/app.js'), 'deny');
  assert.equal(write('tag-list-fixture-architect', join(f.root, 'decisions/0001.md')), 'allow', 'a governance role works between batches');
  // Between batches the workers' shell is closed; the shell of any other agent is not judged.
  const shell = (agent, command) => decideCall({ boundary, input: { tool_name: 'Bash', ...(agent ? { agent_type: agent } : {}), cwd: f.product, tool_input: { command } } });
  assert.equal(shell('tag-list-fixture-worker-exec', 'npm test').decision, 'deny'); assert.match(shell('tag-list-fixture-worker-check', 'ls').reason, /no batch is open/);
  assert.equal(shell('tag-list-fixture-architect', 'ls').decision, 'allow'); assert.equal(shell(null, 'git status').decision, 'allow', 'the main session is not judged');
  const live = JSON.parse(readFileSync(settings, 'utf8'));
  assert.deepEqual(live.env, { KEEP: '1' }); assert.deepEqual(live.hooks.Stop, [other]); assert.deepEqual(live.hooks.PreToolUse[0], other); assert.equal(live.hooks.PreToolUse.length, 2);
  assert.deepEqual(readdirSync(join(f.root, 'holiday')), ['specialist'], 'the copy kept aside is gone');
  // The hook as registered, run as the runtime runs it.
  const hook = (agent, path, root = f.root) => spawnSync('sh', ['-c', live.hooks.PreToolUse[1].hooks[0].command], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify({ tool_name: 'Write', ...(agent ? { agent_type: agent } : {}), cwd: f.product, tool_input: { file_path: path } }) });
  assert.equal(hook('tag-list-fixture-worker-exec', 'src/app.js').status, 2, 'the registered hook loads and refuses a worker');
  assert.equal(hook('tag-list-fixture-architect', 'src/app.js').status, 0); assert.equal(hook(null, 'src/app.js').status, 0, 'the main session is not judged');
  assert.equal(f.apply('specialist', {}).errors, undefined);
  assert.equal(readBoundary(f.root), null); assert.equal(existsSync(join(f.root, '.claude/rw-write-boundary.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), JSON.parse(before), 'the team\'s other settings are as they were');
  // A session opened before the switch back still runs the hook; with no boundary it refuses every agent's write, as before.
  assert.equal(hook('tag-list-fixture-backend', 'src/app.js').status, 2); assert.equal(hook('tag-list-fixture-worker-exec', 'src/app.js', f.product).status, 2, 'whatever the project directory');
  // A failed switch puts the settings back byte for byte.
  const afterRoundTrip = readFileSync(settings, 'utf8');
  const failed = f.apply('router-worker', {}, undefined, { validate: () => ({ ok: false, verdict: 'injected' }) });
  assert.match(refusal(failed).reason, /injected/); assert.equal(readBoundary(f.root), null);
  assert.equal(readFileSync(settings, 'utf8'), afterRoundTrip, 'byte for byte'); assert.deepEqual(readdirSync(join(f.root, 'holiday')), ['router-worker']);
  // A hook of the team's that shares an entry with ours is kept, in and out.
  const shared = fixture(t), ours = { type: 'command', command: 'node "/old/kit/scripts/hooks/rw-write-boundary.mjs"' }, audit = { type: 'command', command: 'echo USER-AUDIT' };
  writeFileSync(join(shared.root, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit|NotebookEdit|MultiEdit|Bash', hooks: [ours, audit] }] } }));
  assert.equal(shared.apply().errors, undefined);
  const kept = JSON.parse(shared.read('.claude/settings.json')).hooks.PreToolUse;
  assert.deepEqual(kept[0].hooks, [audit]); assert.equal(kept.length, 2, 'the old registration is replaced, not doubled');
  writeFileSync(join(shared.root, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'X', hooks: [] }, ...kept] } }));
  assert.equal(shared.apply('specialist', {}).errors, undefined); assert.deepEqual(JSON.parse(shared.read('.claude/settings.json')).hooks.PreToolUse, [{ matcher: 'X', hooks: [] }, { ...kept[0] }], 'an entry of the team\'s that was already empty is kept');
  // A worker is named as the roster names it, not by a convention.
  const renamed = fixture(t); assert.equal(renamed.apply().errors, undefined);
  writeFileSync(join(renamed.root, 'agents/roster.md'), renamed.read('agents/roster.md').replace('.claude/agents/tag-list-fixture-worker-exec.md', '.claude/agents/tlf-exec.md'));
  writeFileSync(join(renamed.root, '.claude/agents/tlf-exec.md'), renamed.read('.claude/agents/tag-list-fixture-worker-exec.md').replace('name: "tag-list-fixture-worker-exec"', 'name: "tlf-exec"'));
  rmSync(join(renamed.root, '.claude/agents/tag-list-fixture-worker-exec.md'));
  assert.equal(renamed.apply('specialist', {}).errors, undefined); assert.equal(renamed.apply('router-worker', {}, undefined, { validate: passes }).errors, undefined);
  assert.ok(Object.hasOwn(readBoundary(renamed.root).wrappers, 'tlf-exec'), 'the renamed worker is bounded');
  // A wrapper whose declared name is not its file name would run under a name the boundary does not carry.
  assert.equal(renamed.apply('specialist', {}).errors, undefined);
  const packedWrapper = join(renamed.root, 'holiday/router-worker/.claude/agents/tlf-exec.md'), manifestPath = join(renamed.root, 'holiday/router-worker/manifest.json');
  writeFileSync(packedWrapper, readFileSync(packedWrapper, 'utf8').replace('name: "tlf-exec"', 'name: "other-name"'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: manifest.files.map(entry => entry.path === '.claude/agents/tlf-exec.md' ? { ...entry, digest: bytesDigest(readFileSync(packedWrapper)) } : entry) }));
  const mismatch = renamed.tree();
  assert.match(refusal(renamed.apply('router-worker', {}, undefined, { validate: passes })).reason, /declares the name other-name/); assert.equal(renamed.tree(), mismatch);
  // Settings the switch cannot change safely stop it before anything moves.
  for (const [content, pattern] of [['not json', /documented shape/], ['[]', /documented shape/], ['{"hooks":[]}', /documented shape/], ['{"hooks":{"PreToolUse":{}}}', /documented shape/], ['{"disableAllHooks":true}', /disables all hooks/]]) {
    const odd = fixture(t); writeFileSync(join(odd.root, '.claude/settings.json'), content); const tree = odd.tree();
    assert.match(refusal(odd.apply()).reason, pattern, content); assert.equal(odd.tree(), tree);
  }
  // Disabled hooks stop a team from entering Router/Worker mode, never from leaving it.
  const leaving = fixture(t); assert.equal(leaving.apply().errors, undefined); writeFileSync(join(leaving.root, '.claude/settings.local.json'), '{"disableAllHooks":true}');
  assert.equal(leaving.apply('specialist', {}).errors, undefined);
  const linked = fixture(t); writeFileSync(join(linked.base, 'elsewhere.json'), '{}'); symlinkSync(join(linked.base, 'elsewhere.json'), join(linked.root, '.claude/settings.json'));
  assert.match(refusal(linked.propose()).reason, /not a regular file/);
  // A team with no settings file gets one, and loses it again.
  const bare = fixture(t); assert.equal(bare.apply().errors, undefined); assert.ok(existsSync(join(bare.root, '.claude/settings.json')));
  assert.equal(bare.apply('specialist', {}).errors, undefined); assert.equal(existsSync(join(bare.root, '.claude/settings.json')), false);
});

test('a product root a quoted shell command cannot hold is refused at the switch, before anything else is checked', t => {
  const f = fixture(t), odd = join(f.base, 'pro!duct');
  const request = { spec: { ...f.spec, project: { ...f.spec.project, productRoot: odd } } };
  assert.match(refusal(proposeSwitch({ to: 'router-worker', request, ...f.common, productRoot: odd })).reason, /cannot be written inside a quoted shell command/);
});
