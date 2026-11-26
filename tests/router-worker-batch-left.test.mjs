// ADR 0010, amendment of 2026-11-26: left saves the work an archived batch left in the product work tree as one patch
// per ticket, and before counts the earlier runs of a ticket's work that the kit did not commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, chmodSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { beforeBatch, abortBatch } from '../src/router-worker/batch.mjs';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { earlierRuns } from '../src/router-worker/earlier-runs.mjs';
import { acquireLease, releaseLease } from '../src/router-worker/lease.mjs';
import { reviewBoundary, closeBoundary } from '../src/router-worker/write-boundary.mjs';
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

test('the work of a ticket that after set aside, applied back by the PM, is that ticket\'s work to left, not the work of no ticket', async t => {
  const f = live(t);
  const { open, after } = await runBatch(f, [ticket('US-01', ['src/list/a.js']), ticket('US-02', ['src/app.js'])], { 'src/list/a.js': '// a\n', 'src/app.js': 'export const x = 2;\n' }, {}, checker(2));
  const at = `left/${open.runId}/US-02.patch`;
  assert.deepEqual(after.setAside.map(entry => [entry.ticket, entry.patch, entry.paths]), [['US-02', at, ['src/app.js']]]);
  assert.equal(f.commit().errors, undefined);
  git(f.product, 'apply', join(f.root, at));
  const saved = left(f);
  assert.equal(saved.status, 0, JSON.stringify(saved.refused));
  assert.deepEqual(saved.out.tickets, [{ ticket: 'US-02', state: 'patch', patch: at, by: 'after', resume: at }]);
  assert.deepEqual(saved.out.outside, []); assert.doesNotMatch(saved.out.next, /no ticket's work/);
  assert.deepEqual(changed(f), [], 'left took the ticket\'s work out again');
});

test('left saves the work each ticket of an archived batch left in the work tree as a patch, takes it out, and prints its resume; a second run changes nothing', async t => {
  const f = live(t);
  // US-01 passes and is not flagged, US-03 passes and is flagged for Security, US-02 does not pass. notes.txt is no ticket's.
  const tickets = [ticket('US-01', ['src/list/a.js']), ticket('US-03', ['src/authz.js']), ticket('US-02', ['src/app.js', 'src/list/new/**'], { expectedPaths: ['src/app.js'] })];
  const work = { 'src/list/a.js': '// a\n', 'src/authz.js': 'export const token = "x";\n', 'src/app.js': 'export const x = 2;\n', 'src/list/new/c.js': '// c\n', 'notes.txt': 'scratch\n' };
  const { open, after } = await runBatch(f, tickets, work, {}, checker(3));
  assert.deepEqual(after.tickets.map(entry => [entry.id, entry.status]), [['US-01', 'passed'], ['US-03', 'passed'], ['US-02', 'not-passed']]);
  assert.match(after.next.join(' '), /rw-batch\.mjs left --instance/, 'after names the command for the work it leaves');
  const at = id => `left/${open.runId}/${id}.patch`;
  assert.deepEqual(after.setAside.map(entry => [entry.ticket, entry.patch]), [['US-02', at('US-02')]], 'after set aside the ticket that did not pass');
  const tree = changed(f), early = left(f);
  assert.equal(early.status, 2); assert.match(early.refused.reason, /A batch is open/); assert.deepEqual(changed(f), tree, 'nothing is touched while the batch is open');

  const aborted = abortBatch(f.common), held = `reviews/held/${open.runId}/US-03.patch`;
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.deepEqual(aborted.held.map(entry => [entry.ticket, entry.patch]), [['US-03', held]]);
  assert.match(aborted.next, /rw-batch\.mjs left --instance/, 'abort names the command for the rest of the work');
  const saved = left(f);
  assert.equal(saved.status, 0, JSON.stringify(saved.refused));
  assert.deepEqual(saved.out.tickets, [{ ticket: 'US-01', state: 'patch', patch: at('US-01'), by: 'left', resume: at('US-01') },
    { ticket: 'US-03', state: 'patch', patch: held, by: 'abort', resume: held }, { ticket: 'US-02', state: 'patch', patch: at('US-02'), by: 'after', resume: at('US-02') }]);
  assert.deepEqual(saved.out.outside, ['notes.txt']); assert.deepEqual(changed(f), ['notes.txt'], 'the path of no ticket is left as it is');
  assert.equal(inTree(f, 'src/app.js'), 'export const x = 1;\n'); assert.match(saved.out.next, /"resume".*notes\.txt/);
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} LEFT WORK SAVED by rw-batch\\.mjs left: US-01 ${at('US-01')}; 1 path\\(s\\) of no ticket left as they are \\(notes\\.txt\\)\\.`));
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
  assert.deepEqual(two.open.tickets.map(entry => entry.earlierRuns), [{ runs: [{ runId: one.open.runId, ticket: 'US-01', status: 'not-passed' }], count: 1 }, { runs: [], count: 0 }]);
  assert.equal(f.commit().errors, undefined); discard(); settled(f, two.open.runId);

  const runs = [{ runId: one.open.runId, ticket: 'US-01', status: 'not-passed' }, { runId: two.open.runId, ticket: 'US-01', status: 'not-passed' }];
  const third = await f.before(batchOf(ticket('US-01', ['src/list/a.js']), ticket('US-02', ['src/list/b.js']), ticket('US-04', ['src/list/d.js'])));
  assert.equal(third.errors, undefined, JSON.stringify(third.errors));
  assert.deepEqual(third.tickets.map(entry => entry.earlierRuns), [{ runs, count: 2 }, { runs: [], count: 0 }, { runs: [], count: 0 }], 'a ticket the kit committed, or the engine never ran, has none');
  assert.deepEqual(lines(), [`${two.open.openedAt.slice(0, 10)} BATCH ${two.open.runId} RUNS US-01 AGAIN (owner spot review): 1 earlier run(s) by the engine that the kit did not commit: ${one.open.runId} as US-01 (not-passed).`,
    `${third.openedAt.slice(0, 10)} BATCH ${third.runId} RUNS US-01 AGAIN (owner spot review): 2 earlier run(s) by the engine that the kit did not commit: ${one.open.runId} as US-01 (not-passed), ${two.open.runId} as US-01 (not-passed).`]);
  assert.equal(abortBatch(f.common).errors, undefined);

  // The same work under a new id: its folder grant overlaps US-01's file.
  const renamed = await f.before(batchOf(ticket('US-11', ['src/list/**'], { expectedPaths: ['src/list/a.js'] })));
  assert.equal(renamed.errors, undefined, JSON.stringify(renamed.errors)); assert.deepEqual(renamed.tickets[0].earlierRuns, { runs, count: 2 });
  assert.equal(lines().length, 3); assert.match(lines()[2], new RegExp(`BATCH ${renamed.runId} RUNS US-11 AGAIN \\(owner spot review\\): 2 earlier run\\(s\\)`));
});

test('a ticket whose removal failed part-way is named with the patch left saved, the complete one, on every later run, until what is left of it is discarded', async t => {
  const f = live(t), work = { 'src/app.js': 'export const x = 3;\n', 'src/gen/b.js': '// b\n' };
  const { open } = await runBatch(f, [ticket('US-08', ['src/app.js', 'src/gen/**'], { expectedPaths: ['src/app.js', 'src/gen/b.js'] })], work);
  assert.equal(abortBatch(f.common).errors, undefined);
  const patch = `left/${open.runId}/US-08.patch`, whole = new RegExp(`US-08 .*its saved patch ${patch} is the complete one: discard what is left of that ticket`);
  // The edit is restored first; the new file lies in a folder nothing can be deleted from.
  chmodSync(join(f.product, 'src/gen'), 0o555);
  let first; try { first = left(f); } finally { chmodSync(join(f.product, 'src/gen'), 0o755); }
  assert.equal(first.status, 2); assert.deepEqual(first.out.tickets.map(entry => [entry.ticket, entry.state, entry.patch]), [['US-08', 'in-tree', patch]]);
  assert.match(first.out.next, whole); assert.deepEqual(changed(f), ['src/gen/b.js']);
  const saved = readFileSync(join(f.root, patch)), again = left(f);
  assert.equal(again.status, 2); assert.deepEqual(again.out.tickets.map(entry => [entry.ticket, entry.state, entry.patch]), [['US-08', 'in-tree', patch]]);
  assert.match(again.out.next, whole); assert.doesNotMatch(again.out.next, /nothing of it was removed/);
  assert.ok(readFileSync(join(f.root, patch)).equals(saved), 'the saved patch is not written over'); assert.deepEqual(changed(f), ['src/gen/b.js']);
  rmSync(join(f.product, 'src/gen'), { recursive: true });
  const done = left(f);
  assert.equal(done.status, 0, JSON.stringify(done.refused)); assert.deepEqual(done.out.tickets.map(entry => [entry.ticket, entry.state, entry.patch, entry.by]), [['US-08', 'patch', patch, 'left']]);
  git(f.product, 'apply', join(f.root, patch));
  assert.deepEqual(Object.keys(work).map(path => inTree(f, path)), Object.values(work), 'the saved patch holds the edit and the new file');
});

test('left refuses an archive whose after record was changed, and says its work is saved by hand before the work tree is cleaned', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-09', ['src/list/a.js'])], { 'src/list/a.js': '// a\n' });
  const path = join(f.root, 'rw-batch-after.json'); writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), note: 'changed by hand' }));
  assert.equal(abortBatch(f.common).errors, undefined);
  const refused = left(f);
  assert.equal(refused.status, 2); assert.match(refused.refused.reason, /no command of the kit can tell which ticket.*save it by hand before the work tree is cleaned.*git add -A.*git diff --cached --binary HEAD/);
  assert.deepEqual(changed(f), ['src/list/a.js']);
});

test('left refuses while a resolve of the archived batch is still running, and saves the work once that process is gone', async t => {
  const f = live(t);
  const { open } = await runBatch(f, [ticket('US-01', ['src/auth/x.js'])], { 'src/auth/x.js': '// x\n' });
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)']); t.after(() => sleeper.kill());
  writeFileSync(join(f.root, 'rw-batch-resolution.json'), JSON.stringify({ schemaVersion: 1, stage: 'batch-resolving', runId: open.runId, pid: sleeper.pid, removed: [] }));
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.deepEqual(aborted.held.map(entry => [entry.ticket, entry.state]), [['US-01', 'in-tree']]);
  const refused = left(f);
  assert.equal(refused.status, 2); assert.match(refused.refused.reason, new RegExp(`resolve of batch ${open.runId} is still running \\(process ${sleeper.pid}\\)`));
  assert.deepEqual(changed(f), ['src/auth/x.js']); assert.equal(existsSync(join(f.root, 'left')), false);
  sleeper.kill(); await once(sleeper, 'exit');
  const saved = left(f);
  assert.equal(saved.status, 0, JSON.stringify(saved.refused)); assert.deepEqual(saved.out.tickets.map(entry => [entry.ticket, entry.state, entry.by]), [['US-01', 'patch', 'left']]);
  assert.deepEqual(changed(f), []);
});

test('left names the paths an older archived batch left as that batch\'s work, with the command that saves them, not as paths to discard', async t => {
  const f = live(t);
  const x = await runBatch(f, [ticket('US-01', ['src/list/a.js'])], { 'src/list/a.js': '// a\n' }, {}, checker(1));
  assert.equal(abortBatch(f.common).errors, undefined); settled(f, x.open.runId);
  const asIs = { ...f, before: batch => beforeBatch({ ...f.common, batch, startAsIs: true }) };
  const y = await runBatch(asIs, [ticket('US-02', ['src/list/b.js'])], { 'src/list/b.js': '// b\n' });
  assert.equal(abortBatch(f.common).errors, undefined);
  const newest = left(f);
  assert.equal(newest.status, 0, JSON.stringify(newest.refused)); assert.equal(newest.out.runId, y.open.runId);
  assert.deepEqual(newest.out.outside, []); assert.deepEqual(newest.out.claimed, [{ path: 'src/list/a.js', runId: x.open.runId, ticket: 'US-01' }]);
  assert.match(newest.out.next, new RegExp(`src/list/a\\.js \\(US-01 of batch ${x.open.runId}\\).*rw-batch\\.mjs left --instance <instance-root> --run ${x.open.runId}`));
  assert.doesNotMatch(newest.out.next, /discard/); assert.deepEqual(changed(f), ['src/list/a.js']);
  // --run names an archive that is not the newest: left saves that batch's work.
  const older = left(f, '--run', x.open.runId);
  assert.equal(older.status, 0, JSON.stringify(older.refused)); assert.deepEqual(older.out.tickets.map(entry => [entry.ticket, entry.state, entry.patch]), [['US-01', 'patch', `left/${x.open.runId}/US-01.patch`]]);
  assert.deepEqual(changed(f), []);
});

test('left names the patch written last when a ticket has both a held patch and one left saved, and names the other', async t => {
  const f = live(t);
  const { open } = await runBatch(f, [ticket('US-01', ['src/auth/x.js'])], { 'src/auth/x.js': '// x\n' });
  const held = `reviews/held/${open.runId}/US-01.patch`, mine = `left/${open.runId}/US-01.patch`;
  assert.deepEqual(abortBatch(f.common).held.map(entry => [entry.ticket, entry.state, entry.patch]), [['US-01', 'patch', held]]);
  // The PM brings the held work back to read it, and edits it further.
  git(f.product, 'apply', join(f.root, held)); writeFileSync(join(f.product, 'src/auth/x.js'), '// x, edited\n');
  const named = entry => [entry.ticket, entry.state, entry.patch, entry.by, entry.also];
  const saved = left(f);
  assert.equal(saved.status, 0, JSON.stringify(saved.refused)); assert.deepEqual(saved.out.tickets.map(named), [['US-01', 'patch', mine, 'left', [held]]]);
  const again = left(f);
  assert.deepEqual(again.out.tickets.map(named), [['US-01', 'patch', mine, 'left', [held]]]); assert.match(again.out.next, new RegExp(`US-01 .*${held}`));
});

test('a patch left saves gives back, byte for byte, an edit, a new binary file, a deleted file and a mode change', async t => {
  const f = live(t), worker = agentsOf(COMMANDS).worker;
  for (const [path, text] of [['src/old.js', '// old\n'], ['src/run.sh', 'echo run\n']]) writeFileSync(join(f.product, path), text);
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'more files');
  const { open } = await runBatch(f, [ticket('US-10', ['src/app.js', 'src/img.bin', 'src/old.js', 'src/run.sh'])], { 'src/app.js': 'export const x = 4;\r\n', 'src/img.bin': Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 128]) },
    {}, { worker: () => { rmSync(join(f.product, 'src/old.js')); chmodSync(join(f.product, 'src/run.sh'), 0o755); return worker(); } });
  assert.equal(abortBatch(f.common).errors, undefined);
  const paths = ['src/app.js', 'src/img.bin', 'src/old.js', 'src/run.sh'], patch = `left/${open.runId}/US-10.patch`;
  const state = () => paths.map(path => existsSync(join(f.product, path)) ? [readFileSync(join(f.product, path)), statSync(join(f.product, path)).mode & 0o777] : null);
  const worked = state(), out = left(f);
  assert.equal(out.status, 0, JSON.stringify(out.refused)); assert.equal(out.out.tickets[0].patch, patch); assert.deepEqual(changed(f), []);
  assert.deepEqual([worked[2], worked[3][1]], [null, 0o755], 'the work deleted a file and made one executable');
  git(f.product, 'apply', join(f.root, patch));
  assert.deepEqual(state(), worked, 'the patch gives back the same bytes, the deletion and the mode');
});

test('left refuses during a review, while another command holds the lock, and for a run no archive holds; it touches nothing', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-05', ['src/list/e.js'])], { 'src/list/e.js': '// e\n' });
  assert.equal(abortBatch(f.common).errors, undefined);
  reviewBoundary({ teamRoot: f.root, runId: 'periodic-1', reviewers: { security: 'fixture-security-reviewer' }, periodic: true });
  assert.match(left(f).refused.reason, /write boundary is in the review state/); closeBoundary({ teamRoot: f.root });
  const lease = acquireLease({ teamRoot: f.root, productRoot: f.product });
  try { assert.match(left(f).refused.reason, /lock on the product repository could not be taken/); } finally { releaseLease({ productRoot: f.product, lease: lease.lease.digest }); }
  assert.match(left(f, '--run', 'rw-none').refused.reason, /No batch rw-none is archived/);
  assert.deepEqual(changed(f), ['src/list/e.js']); assert.equal(existsSync(join(f.root, 'left')), false);
});

test('the earlier runs frozen for a ticket are the newest twenty, oldest first, with how many there are', t => {
  const instance = mkdtempSync(join(tmpdir(), 'rw-earlier-')); t.after(() => rmSync(instance, { recursive: true, force: true }));
  const archived = Array.from({ length: 25 }, (_, i) => ({ id: `rw-run-${String(i).padStart(2, '0')}`, record: { openedAt: `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z`, tickets: [{ id: 'US-01', paths: ['src/a.js'] }] } }));
  for (const { id } of archived) { mkdirSync(join(instance, 'batches', id), { recursive: true }); writeFileSync(join(instance, 'batches', id, 'after.json'), JSON.stringify({ tickets: [{ id: 'US-01', status: 'not-passed' }] })); }
  const frozen = earlierRuns(instance, archived)({ id: 'US-01', paths: ['src/a.js'] });
  assert.equal(frozen.count, 25); assert.deepEqual(frozen.runs.map(run => run.runId), archived.slice(5).map(({ id }) => id));
});
