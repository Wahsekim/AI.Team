// ADR 0011, decisions 14 and 15, with the owner's answer of 2026-11-20 (decision 15 also for a review not obtained):
// resolve saves each held ticket as a patch, removes it from the work tree, runs the verification commands again
// when a later ticket is still to be committed, and commit takes its plan from the resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, appendFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { bytesDigest, digest } from '../src/loop/contracts.mjs';
import { abortBatch, beforeBatch } from '../src/router-worker/batch.mjs';
import { AT_TERMINAL } from '../src/router-worker/switch.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { reviewBrief } from '../src/router-worker/review-brief.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { git, checksRan, afterBatch } from './fixtures/router-worker/standing-team.mjs';
import { refusal, ticket, live, changed, runBatch, reportOf, failing, transcriptOf, batchOf, agentsOf } from './fixtures/router-worker/review.mjs';

// The engine refuses a no-op verification command such as true, so pwd stands for a command that passes.
// US-02 is flagged for Security (its path holds "auth") and edits a tracked file too; US-01 and US-03 are not flagged.
const TICKETS = [ticket('US-01', ['src/list/a.js']), ticket('US-02', ['src/authz.js', 'src/app.js']), ticket('US-03', ['src/list/b.js'])];
const EDITS = { 'src/list/a.js': '// a\n', 'src/authz.js': 'export const token = "x";\n', 'src/app.js': 'export const x = 2;\n', 'src/list/b.js': '// b\n' };
const RESOLUTION = 'rw-batch-resolution.json';

async function rejected(t, options) {
  const f = live(t, options), ran = await runBatch(f, TICKETS, EDITS);
  const made = f.brief('security');
  assert.equal(made.errors, undefined, JSON.stringify(made.errors));
  assert.equal(f.judge('security', transcriptOf(f, made, { report: failing(reportOf(made), 'US-02', 'kit.sec.secret-in-code') })).outcome, 'accepted');
  return { f, ...ran };
}
const removedOf = resolved => resolved.removed.map(entry => [entry.ticket, entry.reason]);

test('a rejected ticket is saved as a patch that applies on the batch head and removed; a later ticket commits when the commands pass again', async t => {
  const { f, open } = await rejected(t, { commands: ['pwd'] });
  assert.match(refusal(f.commit()).reason, /rw-batch\.mjs resolve --instance/, 'commit refuses a flagged batch without a resolution');
  const cli = spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'resolve', '--instance', f.root], { encoding: 'utf8' });
  assert.equal(cli.status, 2, `exit 2: a ticket is held. ${cli.stderr}`);
  const resolved = JSON.parse(cli.stdout);
  assert.equal(resolved.stage, 'batch-resolved');
  assert.deepEqual(removedOf(resolved), [['US-02', 'rejected']]);
  const [held] = resolved.removed;
  assert.equal(held.patch, `reviews/held/${open.runId}/US-02.patch`); assert.deepEqual(held.paths, ['src/app.js', 'src/authz.js']);
  const patch = join(f.root, held.patch);
  assert.equal(bytesDigest(readFileSync(patch)), held.patchDigest);
  assert.deepEqual(changed(f), ['src/list/a.js', 'src/list/b.js'], 'the rejected ticket is gone from the work tree, staged state included');
  assert.equal(git(f.product, 'rev-parse', 'HEAD').trim(), open.productHead);
  git(f.product, 'apply', '--check', patch);
  assert.deepEqual(git(f.product, 'apply', '--numstat', patch).trim().split('\n').map(line => line.split('\t')[2]).sort(), ['src/app.js', 'src/authz.js']);
  assert.equal(resolved.verification.ran, true); assert.deepEqual(resolved.verification.commands.map(run => [run.command, run.exit]), [['pwd', 0]]);
  assert.deepEqual(resolved.commits.map(commit => commit.ticket), ['US-01', 'US-03']);
  assert.equal(f.state(), 'closed', 'resolve ends the review state'); assert.equal(readLease({ productRoot: f.product }).status, 'free');
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} RESOLVED: held US-02 \\(rejected\\)`));
  assert.equal(JSON.parse(spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'resolve', '--instance', f.root], { encoding: 'utf8' }).stdout).digest, resolved.digest, 'a second resolve returns the same resolution');
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01', 'US-03']);
  assert.deepEqual(committed.held, [{ ticket: 'US-02', reason: 'rejected', patch: held.patch }]);
  assert.deepEqual(changed(f), []); assert.ok(existsSync(patch), 'the patch stays for the PM');
  assert.ok(existsSync(join(f.root, 'batches', open.runId, 'resolution.json')), 'the resolution is archived with the batch');
});

test('when a command fails after the removal, every ticket after the first removed one is held too', async t => {
  const { f, open } = await rejected(t, { commands: ['false'] });
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(removedOf(resolved), [['US-02', 'rejected'], ['US-03', 'verification-failed-after-removal']]);
  assert.deepEqual(resolved.verification.commands.map(run => [run.command, run.exit]), [['false', 1]]);
  assert.deepEqual(resolved.failedAtBrief, [{ reviewer: 'security', attempt: 1, command: 'false', exit: 1, timedOut: false }], 'the tree the brief ran on held a rejected ticket: its failure is recorded, not held on');
  assert.deepEqual(resolved.commits.map(commit => commit.ticket), ['US-01']);
  assert.deepEqual(changed(f), ['src/list/a.js']);
  git(f.product, 'apply', '--check', join(f.root, `reviews/held/${open.runId}/US-03.patch`));
  assert.deepEqual(f.commit().commits.map(commit => commit.ticket), ['US-01']);
});

test('a command that changes a file still to be committed holds the rest; what else it wrote is recorded and left uncommitted', async t => {
  // The commands act only once the marker exists, so the brief, which runs them too, sees the tickets as after left them.
  const { f } = await rejected(t, { commands: base => [`test ! -e ${base}/edit || echo built > build.txt`, `test ! -e ${base}/edit || echo x >> src/list/b.js`] });
  writeFileSync(join(f.base, 'edit'), '');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(removedOf(resolved), [['US-02', 'rejected'], ['US-03', 'verification-failed-after-removal']]);
  assert.deepEqual(resolved.verification.commands.map(run => run.exit), [0, 0]);
  assert.deepEqual(resolved.verification.changed, ['src/list/b.js']); assert.deepEqual(resolved.verification.wrote, ['build.txt']);
  assert.deepEqual(changed(f), ['build.txt', 'src/list/a.js']);
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01']); assert.deepEqual(committed.left, ['build.txt']);
});

test('a ticket held because its review was not obtained runs the same re-verification', async t => {
  const f = live(t, { commands: ['false'] });
  await runBatch(f, TICKETS, EDITS);
  for (const attempt of [1, 2]) { assert.equal(f.brief('security').errors, undefined); f.noAnswer('security', `no answer ${attempt}`); }
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(removedOf(resolved), [['US-02', 'review-not-obtained'], ['US-03', 'verification-failed-after-removal']]);
  assert.equal(resolved.verification.ran, true);
});

test('a resolve that died after removing a ticket is finished by the next one, with the same patch', async t => {
  const { f } = await rejected(t, { commands: ['pwd'] });
  const module = new URL('../src/router-worker/review-resolve.mjs', import.meta.url).href;
  const died = spawnSync(process.execPath, ['--input-type=module', '-e', `import { resolveBatch } from ${JSON.stringify(module)};
resolveBatch({ ...${JSON.stringify(f.common)}, run: () => process.exit(9) });`], { encoding: 'utf8' });
  assert.equal(died.status, 9, died.stderr);
  const journal = JSON.parse(f.read(RESOLUTION));
  assert.equal(journal.stage, 'batch-resolving'); assert.deepEqual(journal.removed.map(entry => entry.ticket), ['US-02']);
  assert.equal(readLease({ productRoot: f.product }).status, 'held', 'the dead resolve still holds the lock');
  assert.deepEqual(changed(f), ['src/list/a.js', 'src/list/b.js']);
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(removedOf(resolved), [['US-02', 'rejected']]); assert.equal(resolved.removed[0].patchDigest, journal.removed[0].patchDigest);
  assert.deepEqual(resolved.commits.map(commit => commit.ticket), ['US-01', 'US-03']);
  assert.equal(readLease({ productRoot: f.product }).status, 'free');
  assert.deepEqual(f.commit().commits.map(commit => commit.ticket), ['US-01', 'US-03']);
});

test('resolve refuses a product changed since after; abort after resolve re-applies nothing and keeps the patches', async t => {
  const { f, open } = await rejected(t, { commands: ['pwd'] });
  writeFileSync(join(f.product, 'src/list/b.js'), '// edited by hand\n');
  assert.match(refusal(f.resolve()).reason, /src\/list\/b\.js.*changed since after/);
  assert.equal(f.state(), 'review'); assert.equal(readLease({ productRoot: f.product }).status, 'free');
  writeFileSync(join(f.product, 'src/list/b.js'), EDITS['src/list/b.js']);
  const resolved = f.resolve(), patch = `reviews/held/${open.runId}/US-02.patch`;
  assert.equal(resolved.errors, undefined);
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors));
  assert.deepEqual(aborted.held, [{ ticket: 'US-02', reason: 'rejected', state: 'patch', patch, by: 'resolve' }]);
  assert.match(aborted.next, new RegExp(`US-02 \\(rejected, by resolve\\) ${patch}`));
  assert.equal(bytesDigest(readFileSync(join(f.root, patch))), resolved.removed[0].patchDigest, 'the patch resolve saved is not written again');
  assert.deepEqual(changed(f), ['src/list/a.js', 'src/list/b.js'], 'the held ticket is not put back');
  assert.ok(existsSync(join(f.root, 'batches', open.runId, 'resolution.json')));
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} ARCHIVED WITHOUT COMMIT .*US-02 \\(rejected, by resolve\\) ${patch}`));
});

test('abort of a batch in review takes out each flagged ticket no review passed, rejected or never reviewed, and keeps the one that passed', async t => {
  const f = live(t, { commands: ['pwd'] });
  // US-01 and US-03 are flagged for Security, US-02 for Architect only; US-04 is not flagged.
  const { open } = await runBatch(f, [ticket('US-01', ['src/authz.js']), ticket('US-02', ['tsconfig.json']), ticket('US-03', ['src/session.js']), ticket('US-04', ['src/list/a.js'])],
    { 'src/authz.js': 'export const token = "x";\n', 'tsconfig.json': '{}\n', 'src/session.js': '// s\n', 'src/list/a.js': '// a\n' });
  const made = f.brief('security');
  assert.equal(f.judge('security', transcriptOf(f, made, { report: failing(reportOf(made), 'US-01', 'kit.sec.secret-in-code') })).outcome, 'accepted');
  const aborted = abortBatch(f.common), at = id => `reviews/held/${open.runId}/${id}.patch`;
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.equal(f.state(), 'closed');
  assert.deepEqual(aborted.held, [{ ticket: 'US-01', reason: 'rejected', state: 'patch', patch: at('US-01'), by: 'abort' }, { ticket: 'US-02', reason: 'not-reviewed', state: 'patch', patch: at('US-02'), by: 'abort' }]);
  assert.deepEqual(changed(f), ['src/list/a.js', 'src/session.js'], 'the ticket the review passed and the unflagged one stay');
  for (const id of ['US-01', 'US-02']) git(f.product, 'apply', '--check', join(f.root, at(id)));
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} ARCHIVED WITHOUT COMMIT .*US-01 \\(rejected\\) ${at('US-01')}, US-02 \\(not-reviewed\\) ${at('US-02')}`));
});

test('abort that archives under another name still names the patch resolve saved under the batch\'s own run id', async t => {
  const { f, open } = await rejected(t, { commands: ['pwd'] });
  const resolved = f.resolve(), patch = `reviews/held/${open.runId}/US-02.patch`;
  assert.deepEqual(resolved.removed.map(entry => entry.patch), [patch]);
  // An earlier abort died inside the archive: the batch's own name is taken, so this one archives under an unreadable- name.
  mkdirSync(join(f.root, 'batches', open.runId), { recursive: true });
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.match(aborted.runId, /^unreadable-/);
  assert.deepEqual(aborted.held, [{ ticket: 'US-02', reason: 'rejected', state: 'patch', patch, by: 'resolve' }]);
});

// US-01 is declared sensitive (src/auth/**) and flagged for Security; US-04 is not flagged. The batch is in review.
async function flaggedBatch(t) {
  const f = live(t, { commands: ['pwd'] });
  const { open } = await runBatch(f, [ticket('US-01', ['src/auth/x.js', 'src/auth/y.js']), ticket('US-04', ['src/list/a.js'])], { 'src/auth/x.js': '// x\n', 'src/auth/y.js': '// y\n', 'src/list/a.js': '// a\n' });
  assert.equal(f.state(), 'review');
  return { f, open };
}
// The bytes resolve and abort write for these paths: their change against HEAD, made through an index of its own.
function patchBytes(product, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'rw-test-patch-')), env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }, run = (...args) => execFileSync('git', ['-C', product, ...args], { env });
  try { run('read-tree', 'HEAD'); run('--literal-pathspecs', 'add', '-A', '--', ...paths); return run('diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD'); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a second abort reuses the patch an abort that died saved with the same bytes, and takes the ticket out', async t => {
  const { f, open } = await flaggedBatch(t), patch = `reviews/held/${open.runId}/US-01.patch`, bytes = patchBytes(f.product, ['src/auth/x.js', 'src/auth/y.js']);
  mkdirSync(join(f.root, patch, '..'), { recursive: true }); writeFileSync(join(f.root, patch), bytes);
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors));
  assert.deepEqual(aborted.held, [{ ticket: 'US-01', reason: 'not-reviewed', state: 'patch', patch, by: 'abort' }]);
  assert.deepEqual(changed(f), ['src/list/a.js']); assert.ok(readFileSync(join(f.root, patch)).equals(bytes), 'the patch is used as it is');
});

test('a ticket abort saved and could not take out is named with its patch, the complete one: what is left of it is discarded, not saved again', async t => {
  const { f, open } = await flaggedBatch(t), patch = `reviews/held/${open.runId}/US-01.patch`;
  chmodSync(join(f.product, 'src/auth'), 0o555);
  let aborted; try { aborted = abortBatch(f.common); } finally { chmodSync(join(f.product, 'src/auth'), 0o755); }
  assert.deepEqual(aborted.held.map(entry => [entry.ticket, entry.state, entry.patch]), [['US-01', 'in-tree', patch]]);
  assert.match(aborted.next, new RegExp(`US-01 .*its saved patch ${patch} is the complete one: discard what is left of that ticket in the work tree, and do not save it again`));
  assert.doesNotMatch(aborted.next, /save it as a patch/);
  rmSync(join(f.product, 'src/auth'), { recursive: true }); git(f.product, 'apply', join(f.root, patch));
  assert.deepEqual(['src/auth/x.js', 'src/auth/y.js'].map(path => readFileSync(join(f.product, path), 'utf8')), ['// x\n', '// y\n']);
});

test('abort takes nothing out while a resolve of the batch is still running, and names each flagged ticket as left with that reason', async t => {
  const { f, open } = await flaggedBatch(t);
  writeFileSync(join(f.root, RESOLUTION), JSON.stringify({ schemaVersion: 1, stage: 'batch-resolving', runId: open.runId, pid: process.ppid, removed: [] }));
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors));
  assert.deepEqual(aborted.held.map(entry => [entry.ticket, entry.state, entry.paths]), [['US-01', 'in-tree', ['src/auth/x.js', 'src/auth/y.js']]]);
  assert.match(aborted.held[0].problem, new RegExp(`resolve of this batch is still running \\(process ${process.ppid}\\)`));
  assert.deepEqual(changed(f), ['src/auth/x.js', 'src/auth/y.js', 'src/list/a.js']); assert.equal(existsSync(join(f.root, `reviews/held/${open.runId}`)), false);
});

test('abort trusts no flag of an after record changed since after wrote it: it takes nothing out and names each ticket\'s changed paths as not reviewed', async t => {
  const { f } = await flaggedBatch(t), path = join(f.root, 'rw-batch-after.json'), after = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...after, tickets: after.tickets.map(entry => ({ ...entry, review: { ...entry.review, required: [] } })) }));
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors));
  assert.deepEqual(aborted.held.map(entry => [entry.ticket, entry.reason, entry.state, entry.paths]), [['US-01', 'not-reviewed', 'in-tree', ['src/auth/x.js', 'src/auth/y.js']], ['US-04', 'not-reviewed', 'in-tree', ['src/list/a.js']]]);
  assert.match(aborted.held[0].problem, /changed since after wrote it/);
  assert.deepEqual(changed(f), ['src/auth/x.js', 'src/auth/y.js', 'src/list/a.js']);
});

test('abort of a batch whose after record was changed says no command of the kit can tell the tickets\' work apart, and how to save it by hand before the tree is cleaned', async t => {
  const { f, open } = await flaggedBatch(t), path = join(f.root, 'rw-batch-after.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), note: 'changed by hand' }));
  const aborted = abortBatch(f.common), byHand = /no command of the kit can tell which ticket.*save it by hand before the work tree is cleaned.*git add -A.*git diff --cached --binary HEAD/;
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors));
  assert.match(aborted.next, byHand); assert.doesNotMatch(aborted.next, /rw-batch\.mjs left|left saves it/);
  assert.match(f.ledger().split('\n').find(line => line.includes(`BATCH ${open.runId} ARCHIVED WITHOUT COMMIT`)), byHand);
});

test('abort takes a flagged ticket out when the resolve its record names is a process that has ended', async t => {
  const { f, open } = await flaggedBatch(t), ended = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(join(f.root, RESOLUTION), JSON.stringify({ schemaVersion: 1, stage: 'batch-resolving', runId: open.runId, pid: ended, removed: [] }));
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors));
  assert.deepEqual(aborted.held, [{ ticket: 'US-01', reason: 'not-reviewed', state: 'patch', patch: `reviews/held/${open.runId}/US-01.patch`, by: 'abort' }]);
  assert.deepEqual(changed(f), ['src/list/a.js']);
});

// The kit's own run of the commands when a reviewer is briefed; the command fails only once the marker exists.
const GATE = base => [`test ! -f "${base}/gate-fails"`];
test('a command that failed or timed out when the review was briefed holds resolve when the tree held only what would be committed; the verdict is left as the reviewer gave it', async t => {
  const f = live(t, { commands: GATE });
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  writeFileSync(join(f.base, 'gate-fails'), '');
  const made = f.brief('security');
  assert.equal(made.record.verification[0].exit, 1);
  const verdict = f.judge('security', transcriptOf(f, made));
  assert.equal(verdict.outcome, 'accepted'); assert.deepEqual(verdict.tickets.map(item => [item.id, item.verdict]), [['US-01', 'passed']]);
  assert.match(refusal(f.resolve()).reason, /failed when the review was briefed.*gate-fails.*security's brief 1: exit 1/);
  assert.equal(f.state(), 'review'); assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, RESOLUTION)), false);
  assert.match(refusal(f.commit()).reason, /resolve it first/); assert.deepEqual(changed(f), ['src/authz.js']);
  const g = live(t);
  await runBatch(g, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  const slow = reviewBrief({ ...g.common, reviewer: 'security', run: ({ commands }) => commands.map(command => ({ command, exit: null, timedOut: true, outputDigest: 'none', tail: '' })) });
  assert.equal(g.judge('security', transcriptOf(g, slow)).outcome, 'accepted');
  assert.match(refusal(g.resolve()).reason, /security's brief 1: timed out/);
});

test('a command that failed when the review was briefed on a tree holding more than what would be committed is recorded in the resolution and the ledger, and holds nothing', async t => {
  const f = live(t, { commands: GATE });
  const { open, after } = await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n', 'notes.txt': 'outside every ticket\n' });
  assert.deepEqual(after.left, ['notes.txt']);
  writeFileSync(join(f.base, 'gate-fails'), '');
  assert.equal(f.judge('security', transcriptOf(f, f.brief('security'))).outcome, 'accepted');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.failedAtBrief, [{ reviewer: 'security', attempt: 1, command: f.commands[0], exit: 1, timedOut: false }]); assert.deepEqual(resolved.removed, []);
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} RESOLVED: nothing held; 1 to commit; verification failed when the review was briefed: .*gate-fails.* \\(security's brief 1: exit 1\\)`));
  assert.deepEqual(f.commit().commits.map(commit => commit.ticket), ['US-01']);
});

test('a path that appeared after after closed the batch, outside every ticket to commit, is recorded by resolve and left uncommitted by commit', async t => {
  // A cache the commands write once the marker exists, as the brief runs them.
  const f = live(t, { commands: base => [`test ! -e "${base}/briefed" || echo cache > cache.txt`] });
  const { open } = await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  writeFileSync(join(f.base, 'briefed'), '');
  const made = f.brief('security');
  assert.equal(made.record.verification[0].exit, 0); assert.deepEqual(changed(f), ['cache.txt', 'src/authz.js']);
  assert.equal(f.judge('security', transcriptOf(f, made)).outcome, 'accepted');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.equal(resolved.verification.ran, false); assert.deepEqual(resolved.verification.wrote, ['cache.txt']); assert.deepEqual(resolved.commits.map(commit => commit.ticket), ['US-01']);
  assert.match(f.ledger(), new RegExp(`BATCH ${open.runId} RESOLVED: nothing held; 1 to commit; written since after, left uncommitted: cache\\.txt`));
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01']); assert.deepEqual(committed.left, ['cache.txt']);
  assert.deepEqual(changed(f), ['cache.txt']); assert.match(f.ledger(), /COMMITTED on work: 1 commit\(s\).*1 changed path\(s\) left uncommitted \(cache\.txt\)/);
});

test('the most recent run of the commands decides, whichever reviewer it was briefed for: a later passing brief clears an earlier failure, which is recorded; review-brief tells the PM of a failure', async t => {
  const f = live(t, { commands: GATE });
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  writeFileSync(join(f.base, 'gate-fails'), '');
  const cli = spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'review-brief', '--reviewer', 'security', '--instance', f.root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /^# Batch review brief: security/);
  assert.match(cli.stderr, /failed or timed out when this brief was made: .*gate-fails.*exit 1.*review-brief --reviewer security --instance <instance-root> before dispatching the reviewer/);
  const failed = JSON.parse(f.read('rw-batch-review-security.json')).entries.at(-1);
  rmSync(join(f.base, 'gate-fails'));
  const passed = f.brief('architect', ['US-01']);
  assert.equal(passed.record.verification[0].exit, 0); assert.equal(passed.notice, undefined, 'a brief whose commands passed carries no notice');
  assert.deepEqual([failed.seq, passed.record.seq], [1, 2], 'the briefs of a batch are numbered across reviewers');
  assert.equal(f.judge('security', transcriptOf(f, { brief: cli.stdout, record: failed })).outcome, 'accepted');
  assert.equal(f.judge('architect', transcriptOf(f, passed)).outcome, 'accepted');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.failedAtBrief, [{ reviewer: 'security', attempt: 1, command: f.commands[0], exit: 1, timedOut: false }], 'the earlier failure is recorded');
  assert.match(f.ledger(), /verification failed when the review was briefed: .*gate-fails.* \(security's brief 1: exit 1\)/);
  assert.deepEqual(f.commit().commits.map(commit => commit.ticket), ['US-01']);
});

// A reviewer's brief records rewritten and sealed again, as a record of another kit version or clock would be.
function rewritten(f, reviewer, made, change) {
  const path = join(f.root, `rw-batch-review-${reviewer}.json`), kept = JSON.parse(readFileSync(path, 'utf8'));
  kept.entries = kept.entries.map(({ digest: _digest, ...body }) => { const next = change(body); return { ...next, digest: digest(next) }; });
  writeFileSync(path, JSON.stringify(kept, null, 2) + '\n');
  return { brief: made.brief, record: kept.entries.at(-1) };
}

test('a later failure after an earlier pass holds resolve, even when the clock stepped back between the briefs', async t => {
  const f = live(t, { commands: GATE });
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  const first = f.brief('security');
  writeFileSync(join(f.base, 'gate-fails'), '');
  const last = f.brief('architect', ['US-01']);
  assert.match(last.notice, /failed or timed out when this brief was made/);
  const stepped = rewritten(f, 'architect', last, body => ({ ...body, madeAt: '2000-01-01T00:00:00.000Z' }));
  assert.equal(f.judge('security', transcriptOf(f, first)).outcome, 'accepted'); assert.equal(f.judge('architect', transcriptOf(f, stepped)).outcome, 'accepted');
  assert.match(refusal(f.resolve()).reason, /failed when the review was briefed.*architect's brief 1: exit 1/);
});

test('a failing command that writes an untracked file still holds resolve', async t => {
  const f = live(t, { commands: base => [`test ! -f "${base}/gate-fails" || { echo log > out.log; exit 1; }`] });
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  writeFileSync(join(f.base, 'gate-fails'), '');
  const made = f.brief('security');
  assert.equal(made.record.verification[0].exit, 1); assert.ok(existsSync(join(f.product, 'out.log')), 'the failing command wrote its log');
  assert.equal(f.judge('security', transcriptOf(f, made)).outcome, 'accepted');
  assert.match(refusal(f.resolve()).reason, /failed when the review was briefed.*security's brief 1: exit 1/);
  rmSync(join(f.product, 'out.log'));
  assert.match(refusal(f.resolve()).reason, /failed when the review was briefed/, 'removing the log does not clear the failure');
  assert.match(refusal(f.commit()).reason, /resolve it first/);
});

test('brief records made before they were numbered are ordered by madeAt, and the latest one still holds', async t => {
  const f = live(t, { commands: GATE });
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  const first = f.brief('security');
  writeFileSync(join(f.base, 'gate-fails'), '');
  const last = f.brief('architect', ['US-01']);
  const unnumbered = (reviewer, made) => rewritten(f, reviewer, made, ({ seq: _seq, ...body }) => body);
  assert.equal(f.judge('security', transcriptOf(f, unnumbered('security', first))).outcome, 'accepted');
  assert.equal(f.judge('architect', transcriptOf(f, unnumbered('architect', last))).outcome, 'accepted');
  assert.match(refusal(f.resolve()).reason, /failed when the review was briefed.*architect's brief 1: exit 1/);
});

test('a batch started as is holds more than what would be committed: a failure when the review was briefed is recorded, not held on', async t => {
  const f = live(t, { commands: GATE });
  writeFileSync(join(f.product, 'stray.txt'), 'pre-existing\n');
  const open = await beforeBatch({ ...f.common, batch: { ...batchOf(ticket('US-01', ['src/authz.js'])), verificationCommands: f.commands }, startAsIs: true });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl(agentsOf(f.commands)) });
  mkdirSync(join(f.product, 'src'), { recursive: true }); writeFileSync(join(f.product, 'src/authz.js'), 'export const x = 2;\n');
  checksRan(f.root, open);
  const after = afterBatch({ ...f.common, result });
  assert.equal(after.errors, undefined, JSON.stringify(after.errors)); assert.deepEqual(after.left, [], 'a path changed before the batch is not left by after');
  writeFileSync(join(f.base, 'gate-fails'), '');
  assert.equal(f.judge('security', transcriptOf(f, f.brief('security'))).outcome, 'accepted');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.failedAtBrief, [{ reviewer: 'security', attempt: 1, command: f.commands[0], exit: 1, timedOut: false }]);
  assert.deepEqual(f.commit().commits.map(commit => commit.ticket), ['US-01']);
});

test('a brief that ran no command, or dropped a frozen one, cannot clear an earlier failure', async t => {
  const f = live(t, { commands: base => [`test ! -f "${base}/gate-fails"`] });
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  writeFileSync(join(f.base, 'gate-fails'), '');
  const failed = f.brief('security');
  assert.equal(failed.record.verification[0].exit, 1);
  const mode = join(f.root, 'profiles/team-mode.json'), original = readFileSync(mode, 'utf8'), profile = JSON.parse(original);
  writeFileSync(mode, JSON.stringify({ ...profile, limits: { ...profile.limits, note: 'unbound' } }));
  const empty = f.brief('architect', ['US-01']);
  assert.deepEqual(empty.record.verification, []); assert.equal(empty.record.dropped.length, 1);
  writeFileSync(mode, original);
  assert.equal(f.judge('security', transcriptOf(f, failed)).outcome, 'accepted'); assert.equal(f.judge('architect', transcriptOf(f, empty)).outcome, 'accepted');
  const resolved = f.resolve();
  assert.match(resolved.errors?.[0]?.reason ?? '', /security's brief 1: exit 1/, 'the zero-command brief clears nothing');
  assert.ok(f.commit().errors, 'and nothing commits while the gate fails');
});

test('a later partial brief that failed still holds after an earlier complete pass', async t => {
  const f = live(t, { commands: base => [`test ! -f "${base}/gate-fails"`, 'pwd'] });
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], { 'src/authz.js': 'export const x = 2;\n' });
  const passed = f.brief('security');
  assert.equal(passed.record.verification.length, 2);
  writeFileSync(join(f.base, 'gate-fails'), '');
  const mode = join(f.root, 'profiles/team-mode.json'), profile = JSON.parse(readFileSync(mode, 'utf8')), limits = { ...profile.limits, allowedCommands: [f.commands[0]] };
  writeFileSync(mode, JSON.stringify({ ...profile, limits }));
  appendFileSync(join(f.root, 'pm-decisions.md'), `2026-11-24 LIMITS CHANGED: test; proposal sha256:${'0'.repeat(64)} was confirmed ${AT_TERMINAL}; limits ${digest(limits)}.\n`);
  const partial = f.brief('architect', ['US-01']);
  assert.deepEqual(partial.record.dropped, ['pwd']); assert.equal(partial.record.verification[0].exit, 1);
  assert.equal(f.judge('security', transcriptOf(f, passed)).outcome, 'accepted'); assert.equal(f.judge('architect', transcriptOf(f, partial)).outcome, 'accepted');
  assert.match(f.resolve().errors?.[0]?.reason ?? '', /architect's brief 1: exit 1/);
});
