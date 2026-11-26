// ADR 0010, amendment of 2026-11-26: after runs the batch's verification commands on the product as it stands, before it
// pins what it would commit; a failure holds every commit. A claim on the close names its process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bytesDigest } from '../src/loop/contracts.mjs';
import { afterBatch } from '../src/router-worker/batch-close.mjs';
import { AFTER_FILE } from '../src/router-worker/batch.mjs';
import { git, passing } from './fixtures/router-worker/standing-team.mjs';
import { refusal, ticket, live, changed, engineRun, COMMANDS } from './fixtures/router-worker/review.mjs';

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
  assert.deepEqual(calls.map(call => [call.productRoot, call.commands, call.frozen]), [[f.product, COMMANDS, COMMANDS]], 'the frozen commands the owner confirms, once, from the product root');
  assert.deepEqual(closed.verification, { ran: true, failed: true, commands: COMMANDS.map(command => ({ command, exit: command === 'pwd' ? 1 : 0, timedOut: false, outputDigest: 'sha256:run', tail: 'output' })), dropped: [] });
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
