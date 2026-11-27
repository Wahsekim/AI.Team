// ADR 0010, amendment of 2026-11-26: after sets aside the work of each ticket that did not pass, runs the passed tickets'
// verification commands on a tree that holds only the planned commits, before it pins what it would commit; a failure holds
// every commit. A claim on the close names its process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bytesDigest } from '../src/loop/contracts.mjs';
import { afterBatch } from '../src/router-worker/batch-close.mjs';
import { AFTER_FILE, beforeBatch, abortBatch } from '../src/router-worker/batch.mjs';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { git, passing } from './fixtures/router-worker/standing-team.mjs';
import { refusal, ticket, live, changed, engineRun, batchOf, agentsOf, COMMANDS } from './fixtures/router-worker/review.mjs';

// Neither ticket is flagged for review.
const TWO = [ticket('US-01', ['src/list/a.js']), ticket('US-03', ['src/list/b.js'])], EDITS = { 'src/list/a.js': '// a\n', 'src/list/b.js': '// b\n' };
const outcome = (exit, timedOut = false) => ({ command }) => ({ command, exit: command === 'pwd' ? exit : 0, timedOut: command === 'pwd' && timedOut, outputDigest: 'sha256:run', tail: 'output' });
const runner = (calls, each) => args => { calls.push(args); return args.commands.map(command => each({ command })); };
const log = (f, open) => git(f.product, 'log', '--format=%s', `${open.productHead}..HEAD`).trim();
const reclose = (f, open, run) => { writeFileSync(join(f.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: open.runId, claimedAt: '2000-01-01T00:00:00.000Z' })); return run; };

test('after runs the batch\'s commands on the product as it stands; a failed or timed-out one holds every commit, since the kit cannot tell which ticket broke the tree', async t => {
  const f = live(t), { open, result } = await engineRun(f, TWO, EDITS), calls = [];
  const closed = afterBatch({ ...f.common, result, run: runner(calls, outcome(1)) });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(calls.map(call => [call.productRoot, call.commands, call.frozen]), [[f.product, COMMANDS, COMMANDS], [f.product, ['pwd'], COMMANDS]], 'the frozen commands the owner confirms, from the product root, then the failed one once more');
  const run = { timedOut: false, outputDigest: 'sha256:run', tail: 'output' };
  assert.deepEqual(closed.verification, { ran: true, failed: true, commands: [{ command: 'echo verified-by-kit', exit: 0, ...run }, { command: 'pwd', exit: 1, ...run, again: { exit: 1, ...run } }], dropped: [] });
  assert.deepEqual(closed.findings.find(finding => finding.code === 'VERIFICATION_FAILED'), { code: 'VERIFICATION_FAILED', commands: [{ command: 'pwd', exit: 1, timedOut: false }], dropped: [] });
  assert.equal(closed.holdAll, true); assert.deepEqual(closed.commits, []); assert.deepEqual(closed.left, ['src/list/a.js', 'src/list/b.js']);
  const next = closed.next.join('\n');
  assert.match(next, /verification commands on the product as it stands.*pwd \(exit 1\)/); assert.match(next, /rw-batch\.mjs abort/); assert.match(next, /rw-batch\.mjs left/);
  assert.match(f.ledger(), /CLOSED \(review\).*findings: VERIFICATION_FAILED/);
  assert.match(refusal(f.commit()).reason, /Every commit of this batch is held \(VERIFICATION_FAILED\)/); assert.equal(log(f, open), '');
  assert.deepEqual(changed(f), ['src/list/a.js', 'src/list/b.js'], 'the work stays in the tree');
  const slow = afterBatch({ ...f.common, result, run: reclose(f, open, runner([], outcome(null, true))) });
  assert.deepEqual(slow.findings.find(finding => finding.code === 'VERIFICATION_FAILED')?.commands, [{ command: 'pwd', exit: null, timedOut: true }]); assert.equal(slow.holdAll, true);
  assert.match(slow.next.join('\n'), /pwd \(timed out\)/);
});

test('with the commands passing both tickets are planned and the after record holds the run; what a command writes is pinned and committed, or reported and left', async t => {
  const f = live(t, { commands: ['echo verified-by-kit', 'printf \'// formatted\\n\' > src/list/a.js', 'echo built > build.txt'] });
  const { open, result } = await engineRun(f, TWO, EDITS);
  // The real runner: the commands run from the product root.
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.verification.commands.map(run => [run.command, run.exit, run.timedOut]), f.commands.map(command => [command, 0, false]));
  assert.match(closed.verification.commands[0].tail, /verified-by-kit/); assert.match(closed.verification.commands[0].outputDigest, /^sha256:/);
  assert.equal(closed.verification.failed, false); assert.ok(!closed.findings.some(finding => finding.code === 'VERIFICATION_FAILED'));
  assert.deepEqual(closed.commits.map(commit => [commit.ticket, commit.paths]), [['US-01', ['src/list/a.js']], ['US-03', ['src/list/b.js']]]);
  assert.equal(closed.tickets[0].content['src/list/a.js'], bytesDigest(Buffer.from('// formatted\n')), 'what is pinned is what the commands left');
  assert.deepEqual(closed.findings.find(finding => finding.code === 'WRITE_OUTSIDE_PATHS')?.paths, ['build.txt']); assert.deepEqual(closed.left, ['build.txt']); assert.equal(closed.holdAll, false);
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(done.commits.map(commit => commit.ticket), ['US-01', 'US-03']); assert.deepEqual(done.left, ['build.txt']);
  assert.equal(git(f.product, 'show', `${done.commits[0].sha}:src/list/a.js`), '// formatted\n');
  assert.deepEqual(changed(f), ['build.txt']); assert.equal(log(f, open).split('\n').length, 2);
});

test('after runs no command on a batch another finding already holds, or with no ticket passed; with no confirmed command left to run, every commit is held', async t => {
  const none = () => assert.fail('no command is run');
  const moved = live(t), first = await engineRun(moved, TWO, EDITS);
  git(moved.product, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  const held = afterBatch({ ...moved.common, result: first.result, run: none });
  assert.equal(held.errors, undefined, JSON.stringify(held.errors)); assert.ok(held.findings.some(finding => finding.code === 'PRODUCT_HEAD_MOVED'));
  assert.deepEqual(held.verification, { ran: false, failed: false, commands: [], dropped: [] }); assert.ok(!held.findings.some(finding => finding.code === 'VERIFICATION_FAILED'));
  const failed = { pass: false, staticPass: false, e2ePass: false, summary: 'no', commandsRun: COMMANDS.map(command => ({ command, exitCode: 1 })), failures: ['x'] };
  const g = live(t), other = await engineRun(g, TWO, EDITS, {}, { verifier: () => failed });
  const nothing = afterBatch({ ...g.common, result: other.result, run: none });
  assert.deepEqual(nothing.tickets.map(entry => entry.status), ['not-passed', 'not-run']); assert.equal(nothing.verification.ran, false);
  // The limits no ledger line binds: no command is confirmed for the team any more.
  const h = live(t), third = await engineRun(h, TWO, EDITS), mode = join(h.root, 'profiles/team-mode.json'), profile = JSON.parse(readFileSync(mode, 'utf8'));
  writeFileSync(mode, JSON.stringify({ ...profile, limits: { ...profile.limits, note: 'unbound' } }));
  const empty = afterBatch({ ...h.common, result: third.result });
  assert.deepEqual(empty.verification, { ran: true, failed: true, commands: [], dropped: COMMANDS });
  assert.deepEqual(empty.findings.find(finding => finding.code === 'VERIFICATION_FAILED'), { code: 'VERIFICATION_FAILED', commands: [], dropped: COMMANDS });
  assert.equal(empty.holdAll, true); assert.deepEqual(empty.commits, []); assert.match(empty.next.join('\n'), /no verification command confirmed for the team was left to run/);
});

test('a claim on the close names its process: one whose process is alive is running however old it is; one whose process is gone is taken over', async t => {
  const f = live(t), { open, result } = await engineRun(f, TWO, EDITS), path = join(f.root, AFTER_FILE);
  const claim = pid => writeFileSync(path, JSON.stringify({ stage: 'batch-closing', runId: open.runId, claimedAt: new Date(Date.now() - 600000).toISOString(), pid }));
  claim(process.ppid);
  assert.match(refusal(afterBatch({ ...f.common, result, run: passing })).reason, new RegExp(`Another after is closing this batch \\(process ${process.ppid}\\)`));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.ppid, 'the running claim is left as it is');
  claim(spawnSync(process.execPath, ['-e', '0']).pid);
  let seen = null;
  const closed = afterBatch({ ...f.common, result, run: args => { seen = JSON.parse(readFileSync(path, 'utf8')); return passing(args); } });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.stage, 'batch-closed'); assert.equal(closed.commits.length, 2);
  assert.deepEqual([seen.stage, seen.pid], ['batch-closing', process.pid], 'while the commands run, the claim names this process');
});

// The command fails while any file under src holds the word; the second ticket writes it and does not pass.
const BROKEN = '! grep -rq BROKEN src';
const LEFT_TWO = [ticket('US-01', ['src/list/a.js']), ticket('US-03', ['src/app.js'])], LEFT_WORK = { 'src/list/a.js': '// a\n', 'src/app.js': 'export const x = 2; // BROKEN\n' };
const failedCheck = commands => ({ pass: false, staticPass: false, e2ePass: false, summary: 'broken', commandsRun: commands.map(command => ({ command, exitCode: 1 })), failures: ['a test fails'] });
const secondFails = commands => { let n = 0; const pass = agentsOf(commands).verifier; return { verifier: () => ++n === 2 ? failedCheck(commands) : pass() }; };
const inTree = (f, path) => readFileSync(join(f.product, path), 'utf8');
const left = (f, ...args) => {
  const run = spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'left', '--instance', f.root, ...args], { encoding: 'utf8' });
  return { status: run.status, out: run.stdout ? JSON.parse(run.stdout) : null, refused: run.stderr ? JSON.parse(run.stderr).errors?.[0] : null };
};
const none = () => assert.fail('no command is run');

test('after sets aside the work of a ticket that did not pass as a patch, then runs the real commands on the passed tickets alone; commit commits them, left names the patch, a later batch resumes it', async t => {
  const f = live(t, { commands: [BROKEN] }), { open, result } = await engineRun(f, LEFT_TWO, LEFT_WORK, {}, secondFails([BROKEN]));
  const closed = afterBatch({ ...f.common, result }), patch = `left/${open.runId}/US-03.patch`;
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.tickets.map(entry => [entry.id, entry.status]), [['US-01', 'passed'], ['US-03', 'not-passed']]);
  assert.deepEqual(closed.setAside, [{ ticket: 'US-03', state: 'patch', patch, paths: ['src/app.js'], resume: patch }]);
  assert.equal(inTree(f, 'src/app.js'), git(f.product, 'show', 'HEAD:src/app.js'), 'the ticket\'s path holds what HEAD holds');
  assert.deepEqual(closed.verification.commands.map(run => [run.command, run.exit, run.timedOut]), [[BROKEN, 0, false]]); assert.equal(closed.verification.failed, false);
  assert.ok(!closed.findings.some(finding => ['VERIFICATION_FAILED', 'VERIFICATION_NOT_RUN'].includes(finding.code)), JSON.stringify(closed.findings));
  assert.equal(closed.holdAll, false); assert.deepEqual(closed.commits.map(commit => [commit.ticket, commit.paths]), [['US-01', ['src/list/a.js']]]); assert.deepEqual(closed.left, []);
  assert.match(closed.next.join('\n'), new RegExp(`US-03 \\(${patch}\\).*set aside`)); assert.match(closed.next.join('\n'), new RegExp(`US-03 "resume": "${patch}"`));
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} CLOSED .*set aside as patches: US-03 ${patch}`));
  git(f.product, 'apply', join(f.root, patch));
  assert.equal(inTree(f, 'src/app.js'), LEFT_WORK['src/app.js'], 'the patch gives back the same bytes');
  git(f.product, 'apply', '-R', join(f.root, patch));
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(done.commits.map(commit => commit.ticket), ['US-01']);
  assert.equal(git(f.product, 'log', '--format=%s', `${open.productHead}..HEAD`).trim(), 'US-01: Ticket US-01'); assert.deepEqual(changed(f), []);
  const ledger = f.ledger(), saved = left(f);
  assert.equal(saved.status, 0, JSON.stringify(saved.refused));
  assert.deepEqual(saved.out.tickets, [{ ticket: 'US-03', state: 'patch', patch, by: 'after', resume: patch }]); assert.equal(f.ledger(), ledger, 'left saved nothing');
  assert.equal(markNotMetered({ ...f.common, reason: 'not measured in this test', runId: open.runId }).errors, undefined);
  const next = await beforeBatch({ ...f.common, batch: { ...batchOf(ticket('US-03', ['src/app.js'], { resume: saved.out.tickets[0].resume, replan: { cause: 'Its verification command failed', feasible: 'The command passes on the work as saved', change: 'The saved work is resumed and finished' } })), verificationCommands: f.commands } });
  assert.equal(next.errors, undefined, JSON.stringify(next.errors)); assert.equal(inTree(f, 'src/app.js'), LEFT_WORK['src/app.js']);
});

test('abort of a closed batch leaves the patches after set aside and names them; left names them as after\'s', async t => {
  const f = live(t, { commands: [BROKEN] }), { open, result } = await engineRun(f, LEFT_TWO, LEFT_WORK, {}, secondFails([BROKEN]));
  assert.equal(afterBatch({ ...f.common, result }).errors, undefined);
  const patch = `left/${open.runId}/US-03.patch`, bytes = f.read(patch), aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.match(aborted.next, new RegExp(`Set aside by after as patches, out of the work tree: US-03 ${patch}`));
  assert.match(f.ledger(), new RegExp(`ARCHIVED WITHOUT COMMIT.*Set aside by after as patches, out of the work tree: US-03 ${patch}`));
  const saved = left(f);
  assert.equal(saved.status, 0, JSON.stringify(saved.refused));
  assert.deepEqual(saved.out.tickets.map(entry => [entry.ticket, entry.state, entry.patch, entry.by]), [['US-01', 'patch', `left/${open.runId}/US-01.patch`, 'left'], ['US-03', 'patch', patch, 'after']]);
  assert.equal(f.read(patch), bytes, 'the patch after saved is not saved again'); assert.deepEqual(changed(f), []);
});

test('a ticket that did not pass and cannot be set aside stays whole in the tree; no command runs, the record says why, and the passed ticket is planned', async t => {
  const f = live(t, { commands: [BROKEN] }), { open, result } = await engineRun(f, LEFT_TWO, LEFT_WORK, {}, secondFails([BROKEN]));
  const taken = join(f.root, `left/${open.runId}/US-03.patch`);
  mkdirSync(dirname(taken), { recursive: true }); writeFileSync(taken, 'another patch\n');
  const closed = afterBatch({ ...f.common, result, run: none });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.setAside.map(entry => [entry.ticket, entry.state, entry.paths]), [['US-03', 'in-tree', ['src/app.js']]]); assert.match(closed.setAside[0].problem, /already holds another patch/);
  assert.equal(inTree(f, 'src/app.js'), LEFT_WORK['src/app.js'], 'nothing of it is removed'); assert.equal(readFileSync(taken, 'utf8'), 'another patch\n');
  assert.equal(closed.verification.ran, false); assert.deepEqual(closed.verification.paths, ['src/app.js']); assert.match(closed.verification.reason, /did not pass/);
  const notRun = closed.findings.find(finding => finding.code === 'VERIFICATION_NOT_RUN');
  assert.deepEqual(notRun?.paths, ['src/app.js']); assert.equal(notRun.reason, closed.verification.reason);
  assert.equal(closed.holdAll, false); assert.deepEqual(closed.commits.map(commit => commit.ticket), ['US-01']); assert.deepEqual(closed.left, ['src/app.js']);
  assert.match(closed.next.join('\n'), /did not verify the tree it will commit/); assert.match(closed.next.join('\n'), /LEFT IN THE WORK TREE: US-03/);
});

test('a path outside every ticket, or one changed before a batch started as is, keeps the kit from running the commands; the tickets are still planned', async t => {
  const f = live(t), outside = await engineRun(f, TWO, { ...EDITS, 'notes.txt': 'scratch\n' });
  const first = afterBatch({ ...f.common, result: outside.result, run: none });
  assert.equal(first.errors, undefined, JSON.stringify(first.errors));
  assert.deepEqual(first.findings.find(finding => finding.code === 'VERIFICATION_NOT_RUN')?.paths, ['notes.txt']); assert.equal(first.verification.ran, false);
  assert.equal(first.verification.reason, 'the work tree also holds a path no planned commit holds');
  assert.deepEqual(first.commits.map(commit => commit.ticket), ['US-01', 'US-03']); assert.match(first.next.join('\n'), /did not verify the tree it will commit/);
  assert.match(first.next.join('\n'), /a command writes outside every ticket.*in every batch.*\.gitignore/, 'next names the cause that repeats and its remedy');
  const g = live(t);
  writeFileSync(join(g.product, 'stray.txt'), 'pre-existing\n');
  const asIs = await engineRun({ ...g, before: batch => beforeBatch({ ...g.common, batch, startAsIs: true }) }, TWO, EDITS);
  const second = afterBatch({ ...g.common, result: asIs.result, run: none });
  assert.equal(second.errors, undefined, JSON.stringify(second.errors));
  assert.deepEqual(second.findings.find(finding => finding.code === 'VERIFICATION_NOT_RUN')?.paths, ['stray.txt']); assert.match(second.verification.reason, /before the batch/);
  assert.deepEqual(second.commits.map(commit => commit.ticket), ['US-01', 'US-03']);
});

test('after runs the union of the passed tickets\' own commands, in the batch\'s order; a command no passed ticket lists is not run', async t => {
  const commands = ['pwd', 'test -e no-such-file', 'echo verified-by-kit'];
  const f = live(t, { commands }), tickets = [ticket('US-01', ['src/list/a.js'], { verificationCommands: ['echo verified-by-kit'] }), ticket('US-03', ['src/list/b.js'], { verificationCommands: ['pwd'] })];
  const { result } = await engineRun(f, tickets, EDITS);
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.verification.commands.map(run => [run.command, run.exit]), [['pwd', 0], ['echo verified-by-kit', 0]]);
  assert.equal(closed.verification.failed, false); assert.equal(closed.holdAll, false); assert.deepEqual(closed.commits.map(commit => commit.ticket), ['US-01', 'US-03']);
});

test('a command that writes where Git runs the hooks from, or beside husky\'s stub folder, holds every commit', async t => {
  const f = live(t, { commands: ['pwd', 'echo hook > .git/hooks/pre-commit'] }), { result } = await engineRun(f, TWO, EDITS);
  const changedHooks = afterBatch({ ...f.common, result });
  assert.equal(changedHooks.errors, undefined, JSON.stringify(changedHooks.errors));
  assert.ok(changedHooks.findings.some(finding => finding.code === 'HOOKS_CHANGED'), JSON.stringify(changedHooks.findings));
  assert.equal(changedHooks.holdAll, true); assert.deepEqual(changedHooks.commits, []); assert.match(changedHooks.next.join('\n'), /remove every hook the batch added or changed/);
  const g = live(t, { commands: ['pwd', 'echo hook > .husky/pre-commit'] });
  mkdirSync(join(g.product, '.husky/_'), { recursive: true }); writeFileSync(join(g.product, '.husky/_/h'), '# husky\n');
  git(g.product, 'add', '-A'); git(g.product, 'commit', '-q', '-m', 'husky'); git(g.product, 'config', 'core.hooksPath', '.husky/_');
  const husky = await engineRun(g, TWO, EDITS), written = afterBatch({ ...g.common, result: husky.result });
  assert.equal(written.errors, undefined, JSON.stringify(written.errors));
  assert.deepEqual(written.findings.find(finding => finding.code === 'HOOKS_WRITTEN')?.paths, ['.husky/pre-commit']);
  assert.equal(written.holdAll, true); assert.deepEqual(written.commits, []);
});

test('a claim whose process is alive names abort for the case where that process is no longer an after of this batch', async t => {
  const f = live(t), { open, result } = await engineRun(f, TWO, EDITS);
  writeFileSync(join(f.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: open.runId, claimedAt: new Date().toISOString(), pid: process.ppid }));
  assert.match(refusal(afterBatch({ ...f.common, result, run: passing })).reason, new RegExp(`process ${process.ppid}.*not an after of this batch.*rw-batch\\.mjs abort`));
});

test('a command that fails once and passes when run again holds nothing and both runs are recorded; one that fails twice, or whose output passes the buffer limit, holds every commit', async t => {
  // The command fails until the marker outside the product exists, and makes it.
  const f = live(t, { commands: base => ['pwd', `test -e "${base}/ran" || { touch "${base}/ran"; exit 3; }`] }), { result } = await engineRun(f, TWO, EDITS);
  const flaky = afterBatch({ ...f.common, result });
  assert.equal(flaky.errors, undefined, JSON.stringify(flaky.errors));
  assert.deepEqual(flaky.verification.commands.map(run => [run.command, run.exit, run.again?.exit]), [['pwd', 0, undefined], [f.commands[1], 3, 0]]);
  assert.equal(flaky.verification.failed, false); assert.ok(!flaky.findings.some(finding => finding.code === 'VERIFICATION_FAILED'), JSON.stringify(flaky.findings));
  assert.equal(flaky.holdAll, false); assert.deepEqual(flaky.commits.map(commit => commit.ticket), ['US-01', 'US-03']);
  const loud = 'yes | head -c 70000000', g = live(t, { commands: ['false', loud] }), second = await engineRun(g, TWO, EDITS);
  const broken = afterBatch({ ...g.common, result: second.result });
  assert.equal(broken.errors, undefined, JSON.stringify(broken.errors));
  assert.deepEqual(broken.verification.commands.map(run => [run.command, run.exit, run.again?.exit]), [['false', 1, 1], [loud, null, null]]);
  assert.deepEqual(broken.findings.find(finding => finding.code === 'VERIFICATION_FAILED')?.commands, [{ command: 'false', exit: 1, timedOut: false }, { command: loud, exit: null, timedOut: false, overflowed: true }]);
  assert.equal(broken.holdAll, true); assert.deepEqual(broken.commits, []);
  assert.match(broken.next.join('\n'), /false \(exit 1\), yes \| head -c 70000000 \(output over the kit's buffer limit\) did not pass, again when run a second time/);
});

test('an after that takes over from one that died between two set-asides names both tickets with their patches and paths, and takes the second out now', async t => {
  const tickets = [ticket('US-01', ['src/list/a.js']), ticket('US-02', ['src/app.js']), ticket('US-03', ['src/list/new/**'], { expectedPaths: ['src/list/new/c.js'] })];
  const work = { 'src/list/a.js': '// a\n', 'src/app.js': 'export const x = 2;\n', 'src/list/new/c.js': '// c\n' };
  let n = 0; const pass = agentsOf(COMMANDS).verifier, f = live(t);
  const { open, result } = await engineRun(f, tickets, work, {}, { verifier: () => ++n === 1 ? pass() : failedCheck(COMMANDS) });
  const at = id => `left/${open.runId}/${id}.patch`, first = join(f.root, at('US-02'));
  // What the dead after left: its claim, US-02's patch saved and its path restored, US-03 still in the tree.
  writeFileSync(join(f.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: open.runId, claimedAt: new Date().toISOString(), pid: spawnSync(process.execPath, ['-e', '0']).pid }));
  mkdirSync(dirname(first), { recursive: true }); writeFileSync(first, git(f.product, 'diff', '--binary', '--full-index', 'HEAD', '--', 'src/app.js'));
  git(f.product, 'checkout', 'HEAD', '--', 'src/app.js');
  const closed = afterBatch({ ...f.common, result, run: passing });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.setAside.map(entry => [entry.ticket, entry.state, entry.patch, entry.paths]), [['US-02', 'patch', at('US-02'), ['src/app.js']], ['US-03', 'patch', at('US-03'), ['src/list/new/c.js']]]);
  assert.deepEqual(changed(f), ['src/list/a.js'], 'the second ticket is out of the tree');
  assert.match(closed.next.join('\n'), new RegExp(`US-02 \\(${at('US-02')}\\), US-03 \\(${at('US-03')}\\), which did not pass, was set aside`));
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} CLOSED .*set aside as patches: US-02 ${at('US-02')}, US-03 ${at('US-03')}`));
  assert.deepEqual(closed.commits.map(commit => commit.ticket), ['US-01']);
});

test('after sets aside a new file, a deleted file and a binary file of a ticket that did not pass; its patch gives back the same bytes', async t => {
  const blob = Buffer.from([0, 1, 2, 255, 0, 10, 13, 0]), f = live(t);
  const { open, result } = await engineRun(f, [ticket('US-01', ['src/list/a.js']), ticket('US-03', ['src/app.js', 'src/bin/**'])],
    { 'src/list/a.js': '// a\n', 'src/bin/new.txt': 'new\n', 'src/bin/blob.bin': blob }, {}, secondFails(COMMANDS));
  rmSync(join(f.product, 'src/app.js'));
  const closed = afterBatch({ ...f.common, result, run: passing }), patch = `left/${open.runId}/US-03.patch`;
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.setAside.map(entry => [entry.ticket, entry.state, entry.patch, [...entry.paths].sort()]), [['US-03', 'patch', patch, ['src/app.js', 'src/bin/blob.bin', 'src/bin/new.txt']]]);
  assert.deepEqual(changed(f), ['src/list/a.js']); assert.ok(existsSync(join(f.product, 'src/app.js')), 'the deleted file is back');
  git(f.product, 'apply', join(f.root, patch));
  assert.equal(existsSync(join(f.product, 'src/app.js')), false); assert.equal(inTree(f, 'src/bin/new.txt'), 'new\n'); assert.ok(readFileSync(join(f.product, 'src/bin/blob.bin')).equals(blob));
});
