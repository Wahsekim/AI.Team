// ADR 0010, amendment of 2026-11-25: a ticket may resume the work an earlier batch left, from a patch in the team root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { BATCH_FILE } from '../src/router-worker/batch.mjs';
import { afterBatch } from '../src/router-worker/batch-close.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { live, ticket, batchOf, refusal } from './fixtures/router-worker/review.mjs';

const taskData = brief => JSON.parse(brief.split('\n').find(line => line.startsWith('{"assignmentId"')));
const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

// A live team whose product tracks src/list/a.js, and a patch in the team root made from the given edit of the product.
function withPatch(t, edit, name = 'handoff/T-1/left.patch') {
  const f = live(t);
  write(f.product, 'src/list/a.js', 'a\n'); write(f.product, 'src/app.js', 'app\n');
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  edit(f.product);
  git(f.product, 'add', '-A', '-N');
  write(f.root, name, git(f.product, 'diff', '--binary', 'HEAD'));
  git(f.product, 'reset', '-q', '--hard'); git(f.product, 'clean', '-q', '-fd');
  return f;
}
const leftWork = product => { write(product, 'src/list/a.js', 'a\nresumed\n'); write(product, 'src/list/new.js', 'new\n'); };
const untouched = f => {
  assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  assert.equal(git(f.product, 'status', '--porcelain').trim(), '', 'the product work tree is as it was');
};

test('a ticket resumes from a patch: before applies it, records it, logs it, and the exec brief names the resumed paths', async t => {
  const f = withPatch(t, leftWork);
  const open = await f.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' }), ticket('T-2', ['src/app.js'])));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  assert.equal(readFileSync(join(f.product, 'src/list/a.js'), 'utf8'), 'a\nresumed\n'); assert.equal(readFileSync(join(f.product, 'src/list/new.js'), 'utf8'), 'new\n');
  assert.deepEqual(open.preexisting, [], 'the applied work is the ticket\'s, not work found in the tree');
  const { patch, digest, paths } = open.tickets[0].resume;
  assert.deepEqual([patch, paths], ['handoff/T-1/left.patch', ['src/list/a.js', 'src/list/new.js']]); assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(open.tickets[1].resume, undefined);
  const [first, second] = open.args.plan;
  assert.deepEqual(taskData(first.brief).resumedPaths, ['src/list/a.js', 'src/list/new.js']);
  assert.match(first.brief, /resumedPaths hold an earlier attempt at this ticket, which the host applied before you started/);
  assert.equal(taskData(second.brief).resumedPaths, undefined); assert.doesNotMatch(first.verifierBrief, /resumedPaths/);
  assert.match(f.read('pm-decisions.md'), new RegExp(`BATCH ${open.runId} RESUMES T-1 from handoff/T-1/left\\.patch \\(${digest.slice(0, 19)}`));
});

test('the resumed work and what the worker adds are committed as the ticket\'s', async t => {
  const f = withPatch(t, leftWork), start = git(f.product, 'rev-parse', 'HEAD').trim();
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' })), verificationCommands: f.commands });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const worker = () => { writeFileSync(join(f.product, 'src/list/a.js'), 'a\nresumed\nfinished\n'); return { outcome: 'done', progress: true, filesTouched: ['src/list/a.js'], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'finished' }; };
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker, verifier }) });
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.tickets[0].changedPaths, ['src/list/a.js', 'src/list/new.js']); assert.deepEqual(closed.left, []);
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors));
  assert.equal(git(f.product, 'rev-list', '--count', `${start}..HEAD`).trim(), '1');
  assert.deepEqual(git(f.product, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['src/list/a.js', 'src/list/new.js']);
  assert.equal(git(f.product, 'show', 'HEAD:src/list/a.js'), 'a\nresumed\nfinished\n');
});

test('a patch that is not the ticket\'s to apply is refused, and nothing is applied', async t => {
  const cases = [
    ['outside its paths', product => write(product, 'src/app.js', 'changed\n'), /T-1 resumes a patch that changes src\/app\.js, outside its paths/],
    ['a deletion', product => git(product, 'rm', '-q', 'src/list/a.js'), /deletes, renames, copies or changes the mode of a file, or creates a link/],
    ['a rename', product => git(product, 'mv', 'src/list/a.js', 'src/list/b.js'), /deletes, renames, copies or changes the mode of a file, or creates a link/],
    ['a link', product => symlinkSync('a.js', join(product, 'src/list/l.js')), /deletes, renames, copies or changes the mode of a file, or creates a link/],
    ['nothing', () => {}, /changes nothing/],
    ['a name with a tab', product => write(product, 'src/list/a.js\tx', 'x\n'), /changes a path with a control character/],
    ['a new executable file', product => { write(product, 'src/list/run.sh', 'echo\n'); chmodSync(join(product, 'src/list/run.sh'), 0o755); }, /deletes, renames, copies or changes the mode of a file, or creates a link/],
  ];
  for (const [label, edit, reason] of cases) {
    const f = withPatch(t, edit);
    const open = await f.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' })));
    assert.match(refusal(open)?.reason ?? '', reason, label); untouched(f);
  }
});

test('a patch that does not apply on the product\'s HEAD is refused', async t => {
  const f = withPatch(t, leftWork);
  write(f.product, 'src/list/a.js', 'moved on\n'); git(f.product, 'commit', '-q', '-am', 'later');
  const open = await f.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' })));
  assert.match(refusal(open)?.reason ?? '', /T-1 resumes handoff\/T-1\/left\.patch, which does not apply on the product's HEAD/); untouched(f);
});

test('resume names a file of the team root, outside kit/, by a plain relative path', async t => {
  const f = withPatch(t, leftWork);
  symlinkSync(join(f.root, 'handoff/T-1/left.patch'), join(f.root, 'handoff/link.patch'));
  for (const path of ['/etc/passwd', '../left.patch', 'handoff/../handoff/T-1/left.patch', 'kit/x.patch', 'KIT/x.patch', 'handoff//T-1/left.patch', ''])
    assert.match(refusal(await f.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: path }))))?.reason ?? '', /resume must name a patch file inside the team root, by a relative path outside kit\//, JSON.stringify(path));
  for (const path of ['handoff/missing.patch', 'handoff/link.patch', 'handoff'])
    assert.match(refusal(await f.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: path }))))?.reason ?? '', /is not a file of the team root \(a link is not followed\)/, path);
  untouched(f);
});

test('a batch that fails after the patch was applied takes it back out of the work tree', async t => {
  const f = withPatch(t, leftWork), ledger = join(f.root, 'pm-decisions.md');
  chmodSync(ledger, 0o444);
  const open = await f.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' })));
  chmodSync(ledger, 0o644);
  assert.ok(refusal(open), 'the ledger line cannot be written'); untouched(f);
  assert.equal(f.state(), 'closed');
});

test('a patch may not change an ignored file, nor a file its ticket moves or deletes', async t => {
  const ignored = withPatch(t, product => write(product, 'src/list/conf.local', 'x\n'));
  write(ignored.product, '.gitignore', '*.local\n'); git(ignored.product, 'add', '.gitignore'); git(ignored.product, 'commit', '-q', '-m', 'ignore');
  assert.match(refusal(await ignored.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' }))))?.reason ?? '',
    /T-1 resumes a patch that changes src\/list\/conf\.local, which Git ignores: after and commit would never see it/); untouched(ignored);
  const f = withPatch(t, leftWork);
  for (const extra of [{ deletes: ['src/list/a.js'] }, { moves: [{ from: 'src/list/a.js', to: 'src/list/b.js' }] }, { moves: [{ from: 'src/list/a.js', to: 'src/list/new.js' }] }])
    assert.match(refusal(await f.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch', ...extra }))))?.reason ?? '',
      /T-1 resumes a patch that changes src\/list\/(a|new)\.js, which it also moves or deletes/, JSON.stringify(extra));
  untouched(f);
});

test('after does not take resumed work for a write no worker made, unless it changed since before applied it', async t => {
  const f = withPatch(t, leftWork);
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' })), verificationCommands: f.commands });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  assert.deepEqual(Object.keys(open.tickets[0].resume.content), ['src/list/a.js', 'src/list/new.js']);
  const quiet = () => ({ outcome: 'done', progress: true, filesTouched: [], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'nothing to add' });
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker: quiet, verifier }) });
  writeFileSync(join(f.product, 'src/list/new.js'), 'written outside any worker\n');
  const closed = afterBatch({ ...f.common, result });
  assert.ok(closed.findings.some(finding => finding.code === 'HOOK_SAW_NO_WORKER'), 'a resumed path changed after before applied it');
});

test('resumed work left as before applied it raises no unexplained write', async t => {
  const f = withPatch(t, leftWork);
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/a.js'], resume: 'handoff/T-1/left.patch' })), verificationCommands: f.commands });
  const quiet = () => ({ outcome: 'done', progress: true, filesTouched: [], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'nothing to add' });
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker: quiet, verifier }) });
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.findings.map(finding => finding.code), []); assert.deepEqual(closed.tickets[0].changedPaths, ['src/list/a.js', 'src/list/new.js']);
});
