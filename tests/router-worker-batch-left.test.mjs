// ADR 0010, amendment of 2026-11-26: left saves the work an archived batch left in the product work tree as one patch
// per ticket, and before counts the earlier runs of a ticket's work that the kit did not commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeBatch, abortBatch } from '../src/router-worker/batch.mjs';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { ticket, live, changed, runBatch, batchOf, agentsOf, edits, COMMANDS } from './fixtures/router-worker/review.mjs';

const failed = { pass: false, staticPass: false, e2ePass: false, summary: 'broken', commandsRun: COMMANDS.map(command => ({ command, exitCode: 1 })), failures: ['a test fails'] };
// The checker fails the checks named by their order, 1 being the first ticket's.
const checker = (...failing) => { let n = 0; const pass = agentsOf(COMMANDS).verifier; return { verifier: () => failing.includes(++n) ? failed : pass() }; };
const inTree = (f, path) => existsSync(join(f.product, path)) ? readFileSync(join(f.product, path), 'utf8') : null;
const left = (f, ...args) => {
  const run = spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'left', '--instance', f.root, ...args], { encoding: 'utf8' });
  return { status: run.status, out: run.stdout ? JSON.parse(run.stdout) : null, refused: run.stderr ? JSON.parse(run.stderr).errors?.[0] : null };
};
const settled = (f, runId) => assert.equal(markNotMetered({ ...f.common, reason: 'not measured in this test', runId }).errors, undefined);

test('left saves the work each ticket of an archived batch left in the work tree as a patch, takes it out, and prints its resume; a second run changes nothing', async t => {
  const f = live(t);
  // US-01 passes and is not flagged, US-03 passes and is flagged for Security, US-02 does not pass. notes.txt is no ticket's.
  const tickets = [ticket('US-01', ['src/list/a.js']), ticket('US-03', ['src/authz.js']), ticket('US-02', ['src/app.js', 'src/list/new/**'], { expectedPaths: ['src/app.js'] })];
  const work = { 'src/list/a.js': '// a\n', 'src/authz.js': 'export const token = "x";\n', 'src/app.js': 'export const x = 2;\n', 'src/list/new/c.js': '// c\n', 'notes.txt': 'scratch\n' };
  const { open, after } = await runBatch(f, tickets, work, {}, checker(3));
  assert.deepEqual(after.tickets.map(entry => [entry.id, entry.status]), [['US-01', 'passed'], ['US-03', 'passed'], ['US-02', 'not-passed']]);
  assert.match(after.next.join(' '), /rw-batch\.mjs left --instance/, 'after names the command for the work it leaves');
  const early = left(f);
  assert.equal(early.status, 2); assert.match(early.refused.reason, /A batch is open/); assert.deepEqual(changed(f), Object.keys(work).sort(), 'nothing is touched while the batch is open');

  const aborted = abortBatch(f.common), held = `reviews/held/${open.runId}/US-03.patch`, at = id => `left/${open.runId}/${id}.patch`;
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.deepEqual(aborted.held.map(entry => [entry.ticket, entry.patch]), [['US-03', held]]);
  assert.match(aborted.next, /rw-batch\.mjs left --instance/, 'abort names the command for the rest of the work');
  const saved = left(f);
  assert.equal(saved.status, 0, JSON.stringify(saved.refused));
  assert.deepEqual(saved.out.tickets, [{ ticket: 'US-01', state: 'patch', patch: at('US-01'), by: 'left', resume: at('US-01') },
    { ticket: 'US-03', state: 'patch', patch: held, by: 'abort', resume: held }, { ticket: 'US-02', state: 'patch', patch: at('US-02'), by: 'left', resume: at('US-02') }]);
  assert.deepEqual(saved.out.outside, ['notes.txt']); assert.deepEqual(changed(f), ['notes.txt'], 'the path of no ticket is left as it is');
  assert.equal(inTree(f, 'src/app.js'), 'export const x = 1;\n'); assert.match(saved.out.next, /"resume".*notes\.txt/);
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} LEFT WORK SAVED by rw-batch\\.mjs left: US-01 ${at('US-01')}, US-02 ${at('US-02')}; 1 path\\(s\\) of no ticket left as they are \\(notes\\.txt\\)\\.`));
  for (const [id, paths] of [['US-01', ['src/list/a.js']], ['US-02', ['src/app.js', 'src/list/new/c.js']]]) {
    git(f.product, 'apply', join(f.root, at(id)));
    assert.deepEqual(paths.map(path => inTree(f, path)), paths.map(path => work[path]), `${id}: the patch gives back the same bytes`);
    git(f.product, 'apply', '-R', join(f.root, at(id)));
  }

  const ledger = f.ledger(), bytes = ['US-01', 'US-02'].map(id => f.read(at(id))), again = left(f);
  assert.equal(again.status, 0); assert.deepEqual(again.out.tickets, saved.out.tickets); assert.deepEqual(changed(f), ['notes.txt']);
  assert.deepEqual(['US-01', 'US-02'].map(id => f.read(at(id))), bytes); assert.equal(f.ledger(), ledger, 'nothing was left to save, so no line');

  // The printed resume values open a batch that resumes both tickets.
  settled(f, open.runId);
  const [one, , two] = saved.out.tickets;
  const next = await beforeBatch({ ...f.common, startAsIs: true, batch: batchOf(ticket('US-01', ['src/list/a.js'], { resume: one.resume }), ticket('US-02', ['src/app.js', 'src/list/new/**'], { expectedPaths: ['src/app.js'], resume: two.resume })) });
  assert.equal(next.errors, undefined, JSON.stringify(next.errors)); assert.deepEqual(next.tickets.map(entry => entry.resume.patch), [at('US-01'), at('US-02')]);
  const resumed = ['src/list/a.js', 'src/app.js', 'src/list/new/c.js'];
  assert.deepEqual(resumed.map(path => inTree(f, path)), resumed.map(path => work[path]));
});

test('left keeps in the work tree, whole, a ticket it cannot save or take out, names it, and takes it out once the cause is gone; it refuses off the batch\'s branch or during a Git operation', async t => {
  const f = live(t);
  const { open } = await runBatch(f, [ticket('US-04', ['src/gen/**'], { expectedPaths: ['src/gen/x.js'] }), ticket('US-05', ['src/list/e.js'])], { 'src/gen/x.js': '// x\n', 'src/list/e.js': '// e\n' });
  assert.equal(abortBatch(f.common).errors, undefined);
  const at = id => `left/${open.runId}/${id}.patch`;
  // A file already where US-05's patch goes is never written over; US-04's new file lies in a folder nothing can be deleted from.
  mkdirSync(join(f.root, at('US-05'), '..'), { recursive: true }); writeFileSync(join(f.root, at('US-05')), 'another patch\n');
  chmodSync(join(f.product, 'src/gen'), 0o555);
  let stuck; try { stuck = left(f); } finally { chmodSync(join(f.product, 'src/gen'), 0o755); }
  assert.equal(stuck.status, 2, 'exit 2: a ticket is still in the work tree');
  assert.deepEqual(stuck.out.tickets.map(entry => [entry.ticket, entry.state, entry.paths, entry.patch]), [['US-04', 'in-tree', ['src/gen/x.js'], at('US-04')], ['US-05', 'in-tree', ['src/list/e.js'], undefined]]);
  assert.match(stuck.out.tickets[1].problem, /already holds another patch/);
  assert.deepEqual(changed(f), ['src/gen/x.js', 'src/list/e.js'], 'each keeps all its work in the tree'); assert.equal(f.read(at('US-05')), 'another patch\n');
  assert.match(stuck.out.next, /LEFT IN THE WORK TREE.*US-04.*US-05/);
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} LEFT WORK SAVED by rw-batch\\.mjs left: nothing saved; LEFT IN THE WORK TREE: US-04 .*US-05 `));

  rmSync(join(f.root, at('US-05'))); const first = f.read(at('US-04'));
  const freed = left(f);
  assert.equal(freed.status, 0, JSON.stringify(freed.refused)); assert.deepEqual(freed.out.tickets.map(entry => [entry.ticket, entry.state, entry.by]), [['US-04', 'patch', 'left'], ['US-05', 'patch', 'left']]);
  assert.equal(f.read(at('US-04')), first, 'the patch the first run saved is used as it is'); assert.deepEqual(changed(f), []);

  git(f.product, 'checkout', '-q', '-b', 'elsewhere');
  assert.match(left(f).refused.reason, /not on the batch's branch \(work\)/); git(f.product, 'checkout', '-q', 'work');
  writeFileSync(join(f.product, '.git/index.lock'), '');
  try { assert.match(left(f).refused.reason, /Git operation is in progress.*index\.lock/); } finally { rmSync(join(f.product, '.git/index.lock')); }
});

test('left does not save again a ticket abort saved and could not take out: it names abort\'s patch as the complete one, and as the patch once the rest is discarded', async t => {
  const f = live(t);
  const { open } = await runBatch(f, [ticket('US-07', ['src/auth/a.js'])], { 'src/auth/a.js': '// a\n' });
  chmodSync(join(f.product, 'src/auth'), 0o555);
  let aborted; try { aborted = abortBatch(f.common); } finally { chmodSync(join(f.product, 'src/auth'), 0o755); }
  const held = `reviews/held/${open.runId}/US-07.patch`;
  assert.deepEqual(aborted.held.map(entry => [entry.ticket, entry.state, entry.patch]), [['US-07', 'in-tree', held]]);
  const named = left(f);
  assert.equal(named.status, 2); assert.deepEqual(named.out.tickets.map(entry => [entry.ticket, entry.state, entry.paths, entry.patch]), [['US-07', 'in-tree', ['src/auth/a.js'], held]]);
  assert.match(named.out.next, new RegExp(`US-07.*its saved patch ${held} is the complete one: discard what is left of that ticket`));
  assert.equal(existsSync(join(f.root, `left/${open.runId}`)), false, 'left saves nothing of it');
  rmSync(join(f.product, 'src/auth'), { recursive: true });
  const done = left(f);
  assert.equal(done.status, 0, JSON.stringify(done.refused)); assert.deepEqual(done.out.tickets, [{ ticket: 'US-07', state: 'patch', patch: held, by: 'abort', resume: held }]);
});

test('left names a patch before would refuse as a resume, and says the ticket must declare its moves and deletes or the patch be made again', async t => {
  const f = live(t), worker = agentsOf(COMMANDS).worker;
  // The worker deletes a tracked file its ticket did not declare in deletes.
  const { open } = await runBatch(f, [ticket('US-06', ['src/app.js', 'src/list/f.js'])], { 'src/list/f.js': '// f\n' }, {}, { worker: () => { rmSync(join(f.product, 'src/app.js'), { force: true }); return worker(); } });
  assert.equal(abortBatch(f.common).errors, undefined);
  const out = left(f), patch = `left/${open.runId}/US-06.patch`;
  assert.equal(out.status, 0, JSON.stringify(out.refused));
  assert.deepEqual(out.out.tickets.map(entry => [entry.ticket, entry.state, entry.patch, entry.resume]), [['US-06', 'patch', patch, null]]);
  assert.match(out.out.tickets[0].resumeProblem, /deletes, renames/); assert.match(out.out.next, /US-06.*moves.*deletes/);
  assert.deepEqual(changed(f), []); git(f.product, 'apply', join(f.root, patch));
  assert.deepEqual([inTree(f, 'src/app.js'), inTree(f, 'src/list/f.js')], [null, '// f\n'], 'the work is saved whole all the same');
});

test('before freezes and logs the earlier runs of a ticket the kit did not commit, found by its id or by paths that overlap', async t => {
  const f = live(t), discard = () => { git(f.product, 'checkout', '-q', '--', '.'); git(f.product, 'clean', '-fdq'); };
  const lines = () => f.ledger().split('\n').filter(line => / RUNS \S+ AGAIN \(owner spot review\)/.test(line));
  // Batch 1: US-02 passes and is committed; US-01 does not pass.
  const one = await runBatch(f, [ticket('US-02', ['src/list/b.js']), ticket('US-01', ['src/list/a.js'])], edits(['src/list/b.js', 'src/list/a.js']), {}, checker(2));
  assert.equal(f.commit().errors, undefined); discard(); settled(f, one.open.runId);
  // Batch 2: US-01 does not pass again, and the engine halts before it runs US-04.
  const two = await runBatch(f, [ticket('US-01', ['src/list/a.js']), ticket('US-04', ['src/list/d.js'])], edits(['src/list/a.js']), {}, checker(1));
  assert.deepEqual(two.after.tickets.map(entry => entry.status), ['not-passed', 'not-run']);
  assert.deepEqual(two.open.tickets.map(entry => entry.earlierRuns), [[{ runId: one.open.runId, ticket: 'US-01', status: 'not-passed' }], []]);
  assert.equal(f.commit().errors, undefined); discard(); settled(f, two.open.runId);

  const runs = [{ runId: one.open.runId, ticket: 'US-01', status: 'not-passed' }, { runId: two.open.runId, ticket: 'US-01', status: 'not-passed' }];
  const third = await f.before(batchOf(ticket('US-01', ['src/list/a.js']), ticket('US-02', ['src/list/b.js']), ticket('US-04', ['src/list/d.js'])));
  assert.equal(third.errors, undefined, JSON.stringify(third.errors));
  assert.deepEqual(third.tickets.map(entry => entry.earlierRuns), [runs, [], []], 'a ticket the kit committed, or the engine never ran, has none');
  assert.deepEqual(lines(), [`${two.open.openedAt.slice(0, 10)} BATCH ${two.open.runId} RUNS US-01 AGAIN (owner spot review): 1 earlier run(s) by the engine that the kit did not commit: ${one.open.runId} as US-01 (not-passed).`,
    `${third.openedAt.slice(0, 10)} BATCH ${third.runId} RUNS US-01 AGAIN (owner spot review): 2 earlier run(s) by the engine that the kit did not commit: ${one.open.runId} as US-01 (not-passed), ${two.open.runId} as US-01 (not-passed).`]);
  assert.equal(abortBatch(f.common).errors, undefined);

  // The same work under a new id: its folder grant overlaps US-01's file.
  const renamed = await f.before(batchOf(ticket('US-11', ['src/list/**'], { expectedPaths: ['src/list/a.js'] })));
  assert.equal(renamed.errors, undefined, JSON.stringify(renamed.errors)); assert.deepEqual(renamed.tickets[0].earlierRuns, runs);
  assert.equal(lines().length, 3); assert.match(lines()[2], new RegExp(`BATCH ${renamed.runId} RUNS US-11 AGAIN \\(owner spot review\\): 2 earlier run\\(s\\)`));
});
