// ADR 0011, decisions 14 and 15, with the owner's answer of 2026-11-20 (decision 15 also for a review not obtained):
// resolve saves each held ticket as a patch, removes it from the work tree, runs the verification commands again
// when a later ticket is still to be committed, and commit takes its plan from the resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bytesDigest } from '../src/loop/contracts.mjs';
import { abortBatch } from '../src/router-worker/batch.mjs';
import { recordNoAnswer } from '../src/router-worker/review-judge.mjs';
import { reviewBrief } from '../src/router-worker/review-brief.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { refusal, ticket, live, changed, runBatch, reportOf, failing, transcriptOf } from './fixtures/router-worker/review.mjs';

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
  for (const attempt of [1, 2]) { assert.equal(f.brief('security').errors, undefined); recordNoAnswer({ ...f.common, reviewer: 'security', reason: `no answer ${attempt}` }); }
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
  assert.equal(f.resolve().errors, undefined);
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors));
  assert.match(aborted.next, /reviews\/held\//);
  assert.ok(existsSync(join(f.root, `reviews/held/${open.runId}/US-02.patch`)));
  assert.deepEqual(changed(f), ['src/list/a.js', 'src/list/b.js'], 'the held ticket is not put back');
  assert.ok(existsSync(join(f.root, 'batches', open.runId, 'resolution.json')));
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
