// ADR 0011, decisions 14 and 15, with the owner's answer of 2026-11-20 (decision 15 also for a review not obtained):
// resolve saves each held ticket as a patch, removes it from the work tree, runs the verification commands again
// when a later ticket is still to be committed, and commit takes its plan from the resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bytesDigest, digest } from '../src/loop/contracts.mjs';
import { abortBatch, beforeBatch } from '../src/router-worker/batch.mjs';
import { afterBatch } from '../src/router-worker/batch-close.mjs';
import { AT_TERMINAL } from '../src/router-worker/switch.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { recordNoAnswer } from '../src/router-worker/review-judge.mjs';
import { reviewBrief } from '../src/router-worker/review-brief.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
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
  appendFileSync(join(f.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Edit', agentType: 'tag-list-fixture-worker-exec', judged: true, decision: 'allow' }) + '\n');
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
