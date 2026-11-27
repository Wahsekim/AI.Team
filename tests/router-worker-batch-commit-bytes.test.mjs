// Review finding R23-01: a commit holds the bytes "after" saw, not what a commit hook made of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { digest } from '../src/loop/contracts.mjs';
import { git, checksRan, afterBatch } from './fixtures/router-worker/standing-team.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { live, ticket, batchOf, refusal, engineRun } from './fixtures/router-worker/review.mjs';

const write = (root, path, text, mode) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text, mode ? { mode } : undefined); };

async function closedWith(t, hook) {
  const f = live(t);
  write(f.product, 'src/app.js', 'x = 1\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  if (hook) write(f.product, '.git/hooks/pre-commit', hook, 0o755);
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/app.js'])), verificationCommands: f.commands });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const worker = () => { writeFileSync(join(f.product, 'src/app.js'), 'x = 2\n'); return { outcome: 'done', progress: true, filesTouched: ['src/app.js'], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'set x' }; };
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker, verifier }) });
  checksRan(f.root, open);
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.commits.length, 1);
  return f;
}

test('a commit hook that rewrites and stages a ticket\'s file stops the commit, and says so', async t => {
  const f = await closedWith(t, '#!/bin/sh\necho "x = 999" > src/app.js\ngit add src/app.js\n');
  assert.match(refusal(f.commit())?.reason ?? '', /The commit of ticket T-1 \(\w+\) holds other content than after saw in src\/app\.js; a commit hook may have rewritten them/);
});

test('a commit hook that leaves the bytes alone commits as before', async t => {
  const f = await closedWith(t, '#!/bin/sh\nexit 0\n');
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors));
  assert.equal(git(f.product, 'show', 'HEAD:src/app.js'), 'x = 2\n');
});

test('a batch whose commits are all held is not put in review: no verdict could release them', async t => {
  const f = live(t);
  write(f.product, 'src/authz.js', 'a = 1\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/authz.js'])), verificationCommands: f.commands });
  const worker = () => { writeFileSync(join(f.product, 'src/authz.js'), 'a = 2\n'); return { outcome: 'done', progress: true, filesTouched: ['src/authz.js'], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'ok' }; };
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker, verifier }) });
  git(f.product, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.holdAll, true); assert.deepEqual(closed.reviews, {}); assert.equal(f.state(), 'closed', 'the reviewers are not let in');
});

// Review finding F2: what a commit records for a path is its Git entry (mode, type, blob), or its absence, as after saw it.
// `work` is what the workers did besides `edits`, before after closes the batch.
async function closedOn(t, seed, tickets, edits, { fileMode = true, hook, work = () => {} } = {}) {
  const f = live(t);
  for (const [path, text] of Object.entries(seed)) write(f.product, path, text);
  if (!fileMode) git(f.product, 'config', 'core.fileMode', 'false');
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  if (hook) write(f.product, '.git/hooks/pre-commit', hook, 0o755);
  const { open, result } = await engineRun(f, tickets, edits);
  work(f.product);
  const after = afterBatch({ ...f.common, result });
  assert.equal(after.errors, undefined, JSON.stringify(after.errors)); assert.equal(after.commits.length, tickets.length, JSON.stringify(after.findings));
  return { ...f, open, after, head: () => git(f.product, 'rev-parse', 'HEAD').trim() };
}
const commitsNot = (f, pattern) => { const head = f.head(); assert.match(refusal(f.commit())?.reason ?? '', pattern); assert.equal(f.head(), head, 'nothing is committed'); };
const entryAt = (f, path) => git(f.product, 'ls-tree', 'HEAD', '--', path).split('\t')[0].split(' ')[0];

test('a file made executable after the batch was closed is not committed', async t => {
  const f = await closedOn(t, { 'src/app.js': 'x = 1\n' }, [ticket('T-1', ['src/app.js'])], { 'src/app.js': 'x = 2\n' });
  chmodSync(join(f.product, 'src/app.js'), 0o755);
  commitsNot(f, /src\/app\.js changed since the batch was closed/);
});

test('a link a ticket made, pointed elsewhere after the batch was closed, is not committed', async t => {
  const f = await closedOn(t, { 'src/app.js': 'x = 1\n' }, [ticket('T-1', ['src/link'])], { 'src/link': { link: 'app.js' } });
  rmSync(join(f.product, 'src/link')); symlinkSync('other.js', join(f.product, 'src/link'));
  commitsNot(f, /src\/link changed since the batch was closed/);
});

test('a file replaced by a link after the batch was closed is not committed', async t => {
  const f = await closedOn(t, { 'src/app.js': 'x = 1\n' }, [ticket('T-1', ['src/app.js'])], { 'src/app.js': 'x = 2\n' });
  rmSync(join(f.product, 'src/app.js')); symlinkSync('elsewhere.js', join(f.product, 'src/app.js'));
  commitsNot(f, /src\/app\.js changed since the batch was closed/);
});

test('a commit hook that brings back a path the ticket deleted stops the commit, which is left as it is', async t => {
  const f = await closedOn(t, { 'src/app.js': 'x = 1\n', 'src/old.js': 'old\n' }, [ticket('T-1', ['src/old.js'])], {},
    { hook: '#!/bin/sh\necho "restored" > src/old.js\ngit add src/old.js\n', work: product => rmSync(join(product, 'src/old.js')) });
  assert.match(refusal(f.commit())?.reason ?? '', /The commit of ticket T-1 \(\w+\) holds other content than after saw in src\/old\.js; a commit hook may have rewritten them/);
  assert.equal(git(f.product, 'show', 'HEAD:src/old.js'), 'restored\n', 'the landed commit is not rewritten');
});

test('a commit found after a commit that died, or one recorded, whose mode is not what after saw is not taken', async t => {
  const closed = () => closedOn(t, { 'src/app.js': 'x = 1\n' }, [ticket('T-1', ['src/app.js'])], { 'src/app.js': 'x = 2\n' }, { fileMode: false });
  const byHand = f => { git(f.product, 'add', 'src/app.js'); git(f.product, 'update-index', '--chmod=+x', 'src/app.js'); git(f.product, 'commit', '-q', '-m', 'T-1: Ticket T-1'); assert.equal(entryAt(f, 'src/app.js'), '100755'); };
  const found = await closed(); byHand(found);
  commitsNot(found, /The commit \w+ found for ticket T-1 does not hold what after saw \(src\/app\.js\)/);
  const recorded = await closed(); byHand(recorded);
  writeFileSync(join(recorded.root, 'rw-batch-commits.json'), JSON.stringify({ schemaVersion: 1, runId: recorded.open.runId, commits: [{ ticket: 'T-1', sha: recorded.head() }] }));
  assert.match(refusal(recorded.commit())?.reason ?? '', /A commit recorded for this batch does not hold what after saw \(T-1: src\/app\.js\)/);
});

test('an edit, an executable file a ticket made, a deletion and a move still commit, each as after saw it', async t => {
  const f = await closedOn(t, { 'src/app.js': 'x = 1\n', 'src/gone.js': 'g\n', 'src/from.js': 'm\n' },
    [ticket('T-1', ['src/app.js']), ticket('T-2', ['src/run.sh']), ticket('T-3', ['src/gone.js']), ticket('T-4', ['src/from.js', 'src/to.js'])],
    { 'src/app.js': 'x = 2\n', 'src/run.sh': '#!/bin/sh\n', 'src/to.js': 'm\n' },
    { work: product => { chmodSync(join(product, 'src/run.sh'), 0o755); rmSync(join(product, 'src/gone.js')); rmSync(join(product, 'src/from.js')); } });
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(done.commits.length, 4);
  assert.equal(git(f.product, 'show', 'HEAD:src/app.js'), 'x = 2\n'); assert.equal(entryAt(f, 'src/run.sh'), '100755');
  assert.equal(git(f.product, 'ls-tree', 'HEAD', '--', 'src/gone.js', 'src/from.js'), ''); assert.equal(git(f.product, 'show', 'HEAD:src/to.js'), 'm\n');
});

test('an after record of an earlier kit, with no Git entries, is bound by the bytes of its files as before', async t => {
  const f = await closedOn(t, { 'src/app.js': 'x = 1\n' }, [ticket('T-1', ['src/app.js'])], { 'src/app.js': 'x = 2\n' });
  const { digest: _, ...body } = f.after, earlier = { ...body, tickets: body.tickets.map(({ entries, ...rest }) => rest) };
  writeFileSync(join(f.root, 'rw-batch-after.json'), JSON.stringify({ ...earlier, digest: digest(earlier) }));
  writeFileSync(join(f.product, 'src/app.js'), 'x = 3\n');
  commitsNot(f, /src\/app\.js changed since the batch was closed/);
  writeFileSync(join(f.product, 'src/app.js'), 'x = 2\n');
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(git(f.product, 'show', 'HEAD:src/app.js'), 'x = 2\n');
});

test('a path Git cannot record holds every commit; the close is still written and the lock released', async t => {
  const f = live(t);
  write(f.product, 'src/app.js', 'x = 1\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/app.js'])), verificationCommands: f.commands });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  // A repository with no commit where the file was: git add refuses it.
  const worker = () => { rmSync(join(f.product, 'src/app.js')); mkdirSync(join(f.product, 'src/app.js')); git(join(f.product, 'src/app.js'), 'init', '-q'); return { outcome: 'done', progress: true, filesTouched: ['src/app.js'], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'replaced' }; };
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker, verifier }) });
  checksRan(f.root, open);
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.findings.find(finding => finding.code === 'ENTRIES_NOT_READ')?.tickets, ['T-1']);
  assert.equal(closed.holdAll, true); assert.deepEqual(closed.commits, []); assert.equal(closed.leaseReleased, true);
  assert.equal(readLease({ productRoot: f.product }).status, 'free');
  assert.match(closed.next.join('\n'), /could not read what Git would record/);
});
