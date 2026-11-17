// ADR 0010, decisions 8 to 12: the command a PM runs before a batch in a standing Router/Worker team.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeBatch, abortBatch, BATCH_FILE, AFTER_FILE } from '../src/router-worker/batch.mjs';
import { afterBatch, commitBatch } from '../src/router-worker/batch-close.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { readLease, acquireLease, releaseLease } from '../src/router-worker/lease.mjs';
import { observeIsolation } from '../src/router-worker/isolation.mjs';
import { readBoundary, decideWrite } from '../src/router-worker/write-boundary.mjs';
import { DEFAULT_LIMITS } from '../src/router-worker/switch.mjs';
import { fixture, git } from './fixtures/router-worker/standing-team.mjs';

const refusal = result => result.errors?.[0];
const ticket = (id, paths, extra = {}) => ({ id, title: `Ticket ${id}`, goal: `Do ${id}`, acceptance: [`${id} works`], paths, estimate: { execTokens: 12000, checkTokens: 6000, reworkTokens: 6000 }, ...extra });
const batchOf = (...tickets) => ({ tickets, verificationCommands: ['npm test'], sensitivePaths: ['src/auth/**'], nextLifecycleNumber: 1 });
// A live Router/Worker team whose product is on a working branch.
function live(t) {
  const f = fixture(t); assert.equal(f.apply().errors, undefined); git(f.product, 'checkout', '-q', '-b', 'work');
  const before = (batch, extra = {}) => beforeBatch({ teamRoot: f.kit, instanceRoot: f.root, batch, ...extra });
  const untouched = () => { assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
    assert.ok(Object.values(readBoundary(f.root).wrappers).every(entry => entry.writePaths.length === 0), 'the boundary is closed'); };
  return { ...f, before, untouched };
}

test('before freezes N tickets, computes the ceiling, takes the lock and opens the write boundary for the batch only', async t => {
  const f = live(t), record = await f.before(batchOf(ticket('US-01', ['src/list/**', 'src/app.js']), ticket('US-02', ['src/api/tags.js'])));
  assert.equal(record.errors, undefined, JSON.stringify(record.errors));
  assert.equal(record.stage, 'batch-open'); assert.equal(record.branch, 'work'); assert.deepEqual(record.preexisting, []);
  assert.equal(record.args.rounds, 2); assert.equal(record.args.failurePolicy, 'halt-on-failure'); assert.equal(record.args.maxAttemptsPerTicket, 1);
  assert.equal(record.args.budgetCeilingTokens, 2 * DEFAULT_LIMITS.outputAllowancePerTicket + DEFAULT_LIMITS.guardianOutputShare, 'N times the allowance plus the Guardian\'s share');
  assert.deepEqual(record.ceiling, { outputTokens: 36000, stopLine: 28800 });
  assert.equal(record.args.guardianAgentType, 'tag-list-fixture-worker-guard'); assert.equal(record.args.plan.length, 2);
  assert.deepEqual(record.runRecord.items.map(item => [item.ticket, item.authorizedTokens]), [['US-01', 200000], ['US-02', 200000]]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, BATCH_FILE), 'utf8')), record);
  const lease = readLease({ productRoot: f.product }); assert.equal(lease.status, 'held'); assert.equal(lease.lease.digest, record.lease);
  const boundary = readBoundary(f.root), write = (agent, path) => decideWrite({ boundary, input: { tool_name: 'Edit', agent_type: agent, cwd: f.product, tool_input: { file_path: path } } }).decision;
  assert.equal(write('tag-list-fixture-worker-exec', 'src/list/view.js'), 'allow'); assert.equal(write('tag-list-fixture-worker-exec', 'src/api/tags.js'), 'allow');
  assert.equal(write('tag-list-fixture-worker-exec', 'src/other.js'), 'deny'); assert.equal(write('tag-list-fixture-worker-check', 'src/app.js'), 'deny');
  assert.deepEqual(record.sensitivePaths, ['src/auth/**']); assert.deepEqual(record.tickets[1], { id: 'US-02', title: 'Ticket US-02', commitMessage: 'US-02: Ticket US-02', paths: ['src/api/tags.js'], expectedPaths: ['src/api/tags.js'] });
  assert.match(refusal(await f.before(batchOf(ticket('US-03', ['src/x.js'])))).reason, /already open/);
  assert.equal(readLease({ productRoot: f.product }).lease.digest, record.lease, 'the open batch keeps its lock'); assert.equal(write('tag-list-fixture-worker-exec', 'src/list/view.js'), 'allow');
});

test('abort clears a batch that will not run, and what a before that died left behind, so the next batch can open', async t => {
  const f = live(t), abort = () => abortBatch({ teamRoot: f.kit, instanceRoot: f.root }), one = batchOf(ticket('US-01', ['src/a.js']));
  assert.match(refusal(abort()).reason, /no batch to abort/);
  const first = await f.before(one); assert.equal(first.errors, undefined, JSON.stringify(first.errors));
  const aborted = abort();
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.equal(aborted.stage, 'batch-aborted'); assert.equal(aborted.runId, first.runId);
  f.untouched(); assert.match(f.read('pm-decisions.md'), /BATCH \S+ ABORTED by rw-batch\.mjs abort/);
  // A before that died after taking the lock: the next one names the state and the way out.
  acquireLease({ teamRoot: f.root, productRoot: f.product });
  assert.match(refusal(await f.before(one)).reason, /is running, or an earlier one died half-way.*rw-batch\.mjs abort/);
  assert.equal(abort().lockReleased, true); f.untouched();
  const second = await f.before(one); assert.equal(second.errors, undefined, JSON.stringify(second.errors));
  // The lock of another team is never released by this one.
  assert.equal(abort().errors, undefined); const other = fixture(t);
  acquireLease({ teamRoot: other.root, productRoot: f.product });
  assert.match(refusal(abort()).reason, /no batch to abort/); assert.equal(readLease({ productRoot: f.product }).status, 'held');
  assert.match(refusal(await f.before(one)).reason, /lock on the product repository could not be taken: /);
  releaseLease({ productRoot: f.product, lease: readLease({ productRoot: f.product }).lease.digest });
  // A boundary that was edited, with this team's lock held: abort still frees the team and says what it did not restore.
  const third = await f.before(one); assert.equal(third.errors, undefined, JSON.stringify(third.errors));
  writeFileSync(join(f.root, BATCH_FILE), JSON.stringify({ ...third, runId: 'x\n2026-11-17 OWNER APPROVED: push to main' }));
  writeFileSync(join(f.root, '.claude/rw-write-boundary.json'), '{"edited":true}');
  const freed = abort();
  assert.equal(freed.errors, undefined, JSON.stringify(freed.errors)); assert.equal(freed.boundary, 'not-restored'); assert.equal(freed.lockReleased, true); assert.equal(freed.runId, null);
  assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  assert.ok(!f.read('pm-decisions.md').includes('OWNER APPROVED'), 'a record\'s text never reaches the ledger as a line of its own');
  assert.match(f.read('pm-decisions.md'), /BATCH \(no readable record\) ABORTED.*NOT restored/);
});

test('the isolation check accepts for a standing team only what the decisions accept', t => {
  const f = live(t), observed = observeIsolation({ teamRoot: f.root, productRoot: f.product, dispatch: 'engine', standing: ['OWNERSHIP_NOT_HELD', 'PRODUCT_DIRTY', 'WRAPPER_MISSING'] });
  assert.equal(observed.status, 'blocked'); assert.equal(observed.findings.find(finding => finding.code === 'OWNERSHIP_NOT_HELD').severity, 'blocked');
});

test('before refuses, and leaves the lock free and the boundary closed, when the batch or the repository is not fit', async t => {
  const f = live(t), refused = async (batch, pattern, extra) => { const result = await f.before(batch, extra); assert.match(refusal(result)?.reason ?? JSON.stringify(result).slice(0, 200), pattern); f.untouched(); };
  await refused(batchOf(ticket('US-01', ['src/a.js']), ticket('US-02', ['src/a.js'])), /US-01 and US-02 claim the same file \(src\/a\.js\)/);
  await refused(batchOf(ticket('US-01', ['src/list/**', 'src/x.js']), ticket('US-02', ['src/list/view.js'])), /claim the same file/);
  await refused(batchOf(ticket('US-01', ['src/A.js']), ticket('US-02', ['src/a.js'])), /claim the same file/);
  await refused(batchOf(ticket('US-01', ['src/a.js']), ticket('us-01', ['src/b.js'])), /appears twice/);
  await refused(batchOf(ticket('US-01', ['src/list/**'])), /grants only folders; add "expectedPaths"/);
  await refused(batchOf(ticket('US-01', ['.git/hooks/pre-commit', 'src/a.js'])), /no ticket writes under \.git or \.claude/);
  await refused(batchOf(ticket('US-01', ['.claude/**'], { expectedPaths: ['.claude/x'] })), /no ticket writes under/);
  // The worker is bounded by `paths`, so that is what the sensitive paths are judged against, whatever the plan says.
  await refused(batchOf(ticket('US-01', ['src/**'], { expectedPaths: ['src/a.js'] })), /would be able to write a sensitive path \(src\/\*\*\)/);
  await refused(batchOf(ticket('US-01', ['src/auth/login.js', 'src/a.js'], { expectedPaths: ['src/a.js'] })), /sensitive path \(src\/auth\/login\.js\)/);
  await refused({ ...batchOf(ticket('US-01', ['src/auth/login.js'])), sensitivePaths: ['src/auth'] }, /sensitive path/);
  await refused({ ...batchOf(ticket('US-01', ['src/auth/**'], { expectedPaths: ['src/auth/x.js'] })), sensitivePaths: ['src/auth'] }, /sensitive path/);
  await refused(batchOf(ticket('US-01', ['sub/.git/hooks/x'])), /no ticket writes under/);
  await refused(batchOf(...Array.from({ length: 51 }, (_, i) => ticket(`T-${i}`, [`src/f${i}.js`, `src/g${i}.js`]))), /at most 100 paths in all \(102 given\)/);
  await refused(batchOf(...Array.from({ length: 101 }, (_, i) => ticket(`T-${i}`, [`src/f${i}.js`]))), /1 to 100 tickets/);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { estimate: { execTokens: 1, checkTokens: 1, reworkTokens: 1, bonus: 5 } })), /estimate must carry exactly/);
  await refused({ ...batchOf(ticket('US-01', ['src/a.js'])), sensitivePaths: [] }, /sensitivePaths must list/);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { acceptance: [] })), /US-01 is incomplete: acceptance missing/);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { goal: undefined })), /incomplete: goal/);
  await refused({ ...batchOf(ticket('US-01', ['src/a.js'])), budgetCeilingTokens: 999999 }, /must carry/, undefined);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { estimate: { execTokens: 150000, checkTokens: 60000, reworkTokens: 6000 } })), /cannot be frozen.*estimate/i);
  // Refusals that come after the lock was taken give it back.
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /injected preflight/, { manifest: () => ({ errors: [{ reason: 'injected preflight failure' }] }) });
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /could not be prepared: boom/, { manifest: () => { throw Error('boom'); } });
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /changed while the batch was being prepared/, { manifest: () => { writeFileSync(join(f.product, 'late.txt'), 'x'); return { digest: 'sha256:' + 'a'.repeat(64) }; }, startAsIs: true });
  rmSync(join(f.product, 'late.txt'));
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /changed while the batch was being prepared/, { manifest: () => { git(f.product, 'commit', '-q', '--allow-empty', '-m', 'moved on'); return { digest: 'sha256:' + 'a'.repeat(64) }; } });
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /default branch|changed while/, { manifest: () => { git(f.product, 'checkout', '-q', '-'); return { digest: 'sha256:' + 'a'.repeat(64) }; } });
  git(f.product, 'checkout', '-q', 'work');
  // The lock taken by this command is replaced by another holder's while it prepares: the batch does not open, and the other lock is left alone.
  const stolen = await f.before(batchOf(ticket('US-01', ['src/a.js'])), { manifest: () => { releaseLease({ productRoot: f.product, lease: readLease({ productRoot: f.product }).lease.digest }); acquireLease({ teamRoot: f.root, productRoot: f.product }); return { digest: 'sha256:' + 'a'.repeat(64) }; } });
  assert.match(refusal(stolen).reason, /lock on the product repository was released|OWNERSHIP_HELD_BY_OTHER/); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.equal(readLease({ productRoot: f.product }).status, 'held');
  releaseLease({ productRoot: f.product, lease: readLease({ productRoot: f.product }).lease.digest });
  // The limits are the mode profile's, checked again where they are used.
  const profilePath = join(f.root, 'profiles/team-mode.json'), profile = readFileSync(profilePath, 'utf8');
  writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(profile), limits: { ...DEFAULT_LIMITS, attemptsPerTicket: 9 } }));
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /limits in profiles\/team-mode\.json are not valid/);
  writeFileSync(profilePath, profile);
  writeFileSync(join(f.product, 'notes.txt'), 'x\n');
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /uncommitted changes \(notes\.txt\).*start as is/);
  rmSync(join(f.product, 'notes.txt')); writeFileSync(join(f.product, '.git/MERGE_HEAD'), 'x\n');
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /in progress/, { startAsIs: true });
  rmSync(join(f.product, '.git/MERGE_HEAD')); git(f.product, 'checkout', '-q', '-');
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /default branch/, { startAsIs: true });
  git(f.product, 'checkout', '-q', 'work'); mkdirSync(join(f.root, 'holiday'), { recursive: true }); writeFileSync(join(f.root, 'holiday/.switch-in-progress.json'), '{}');
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /interrupted/);
  rmSync(join(f.root, 'holiday/.switch-in-progress.json'));
  const specialist = fixture(t);
  assert.match(refusal(await beforeBatch({ teamRoot: specialist.kit, instanceRoot: specialist.root, batch: batchOf(ticket('US-01', ['src/a.js'])) })).reason, /not live in Router\/Worker mode/);
});

test('start as is: a repository that is not clean starts only on the explicit word, which is logged with the paths; ignored build output never counts', async t => {
  const f = live(t); writeFileSync(join(f.product, '.gitignore'), 'dist/\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'ignore');
  mkdirSync(join(f.product, 'dist')); writeFileSync(join(f.product, 'dist/out.js'), 'built\n');
  writeFileSync(join(f.product, 'notes.txt'), 'x\n');
  git(f.product, 'mv', 'src/app.js', 'src/app 2.js');
  const ledger = f.read('pm-decisions.md');
  assert.match(refusal(await f.before(batchOf(ticket('US-01', ['src/a.js'])), { startAsIs: true, manifest: () => ({ errors: [{ reason: 'injected' }] }) })).reason, /injected/);
  assert.equal(f.read('pm-decisions.md'), ledger, 'a batch that did not open leaves no ledger line');
  const record = await f.before(batchOf(ticket('US-01', ['src/a.js'])), { startAsIs: true });
  assert.equal(record.errors, undefined, JSON.stringify(record.errors)); assert.equal(record.startedAsIs, true);
  assert.deepEqual(record.preexisting, ['notes.txt', 'src/app 2.js', 'src/app.js'], 'plain paths, both sides of a rename');
  assert.match(f.read('pm-decisions.md'), /BATCH \S+ STARTED AS IS: 3 path\(s\) were already changed.*notes\.txt/);
});

test('CLI: before prints the batch record with the preflight manifest chained into the arguments; exit 0 open, 2 refused, 1 usage', t => {
  const f = live(t), file = join(f.base, 'batch.json'), run = (...argv) => spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify(batchOf(ticket('US-01', ['src/a.js']))));
  assert.equal(run('before').status, 1); assert.equal(run('before', file, '--instance', f.root, '--bogus').status, 1); assert.equal(run('finish', file, '--instance', f.root).status, 1);
  const done = run('before', file, '--instance', f.root);
  assert.equal(done.status, 0, done.stdout + done.stderr); const record = JSON.parse(done.stdout);
  assert.equal(record.stage, 'batch-open'); assert.equal(record.launchManifest, 'chained'); assert.match(record.args.launchManifestDigest, /^sha256:[a-f0-9]{64}$/);
  const again = run('before', file, '--instance', f.root);
  assert.equal(again.status, 2); assert.match(again.stderr, /already open/);
  assert.equal(run('before', join(f.base, 'absent.json'), '--instance', f.root).status, 2);
  assert.equal(run('abort').status, 1); const cleared = run('abort', '--instance', f.root);
  assert.equal(cleared.status, 0, cleared.stderr); assert.equal(JSON.parse(cleared.stdout).stage, 'batch-aborted'); assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(run('abort', '--instance', f.root).status, 2);
});

// A batch run by the real engine with mock agents; `edits` is what the workers leave in the product.
async function ran(t, { tickets, agents = {}, edits = {}, hook = true, extra = {} }) {
  const f = live(t), open = await f.before(batchOf(...tickets), extra);
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl(agents) });
  for (const [path, text] of Object.entries(edits)) { mkdirSync(join(f.product, path, '..'), { recursive: true }); writeFileSync(join(f.product, path), text); }
  if (hook) appendFileSync(join(f.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Edit', agentType: 'tag-list-fixture-worker-exec', judged: true, decision: 'allow' }) + '\n');
  const after = () => afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result }), commit = () => commitBatch({ teamRoot: f.kit, instanceRoot: f.root });
  const log = () => git(f.product, 'log', '--format=%s', `${open.productHead}..HEAD`).trim().split('\n').filter(Boolean).reverse();
  return { ...f, open, result, after, commit, log, status: () => git(f.product, 'status', '--porcelain').trim() };
}
const two = [ticket('US-01', ['src/list/**', 'src/app.js'], { expectedPaths: ['src/app.js'] }), ticket('US-02', ['src/api/tags.js'], { commitMessage: 'feat(api): tags endpoint' })];

test('after matches the engine return, closes the boundary and frees the lock; commit makes one commit per ticket and archives the batch', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n', 'src/list/view.js': 'view\n', 'src/api/tags.js': 'tags\n' } });
  assert.match(refusal(f.commit()).reason, /has not been closed/);
  const closed = f.after();
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.stage, 'batch-closed'); assert.equal(closed.status, 'clean', JSON.stringify(closed.findings) + JSON.stringify(closed.account.blockers));
  assert.deepEqual(closed.tickets.map(entry => [entry.id, entry.status, entry.changedPaths]), [['US-01', 'passed', ['src/app.js', 'src/list/view.js']], ['US-02', 'passed', ['src/api/tags.js']]]);
  assert.deepEqual(closed.commits.map(entry => [entry.ticket, entry.message]), [['US-01', 'US-01: Ticket US-01'], ['US-02', 'feat(api): tags endpoint']]); assert.deepEqual(closed.left, []);
  assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.ok(Object.values(readBoundary(f.root).wrappers).every(entry => entry.writePaths.length === 0), 'no worker may write any more');
  assert.match(refusal(f.after()).reason, /already closed/); assert.match(refusal(await f.before(batchOf(ticket('US-09', ['src/z.js'])))).reason, /already open/);
  assert.match(refusal(abortBatch({ teamRoot: f.kit, instanceRoot: f.root })).reason, /already closed by after/);
  assert.equal(git(f.product, 'rev-parse', 'HEAD').trim(), f.open.productHead, 'after commits nothing');
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(done.stage, 'batch-committed'); assert.equal(done.pushed, false);
  assert.deepEqual(f.log(), ['US-01: Ticket US-01', 'feat(api): tags endpoint']); assert.equal(f.status(), '', 'the product is clean again');
  assert.deepEqual(git(f.product, 'show', '--name-only', '--format=', 'HEAD~1').trim().split('\n').sort(), ['src/app.js', 'src/list/view.js'], 'each commit holds its ticket\'s files only');
  assert.equal(git(f.product, 'symbolic-ref', '--short', 'HEAD').trim(), 'work');
  assert.deepEqual(readdirSync(join(f.root, 'batches', f.open.runId)).sort(), ['after.json', 'batch.json', 'commit.json']); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.equal(existsSync(join(f.root, AFTER_FILE)), false);
  assert.match(f.read('pm-decisions.md'), /BATCH \S+ CLOSED \(clean\): 2 of 2 ticket\(s\) passed; 2 to commit, 0 changed path\(s\) left/); assert.match(f.read('pm-decisions.md'), /BATCH \S+ COMMITTED on work: 2 commit\(s\).*Nothing was pushed/);
  const next = await f.before(batchOf(ticket('US-03', ['src/b.js'])));
  assert.equal(next.errors, undefined, JSON.stringify(next.errors)); assert.notEqual(next.runId, f.open.runId);
});

test('a ticket that did not pass is not committed and stays in the work tree; a write outside every ticket is reported and left', async t => {
  let checks = 0;
  const f = await ran(t, { tickets: two, agents: { verifier: () => ++checks === 1 ? { pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: [{ command: 'npm test', exitCode: 0 }], failures: [] }
    : { pass: false, staticPass: false, e2ePass: false, summary: 'broken', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['tags test fails'] } },
    edits: { 'src/app.js': 'export const x = 2;\n', 'src/api/tags.js': 'half done\n', 'package-lock.json': '{}\n' } });
  const closed = f.after();
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.status, 'review');
  assert.deepEqual(closed.tickets.map(entry => [entry.id, entry.status]), [['US-01', 'passed'], ['US-02', 'not-passed']]);
  assert.deepEqual(closed.findings.find(finding => finding.code === 'WRITE_OUTSIDE_PATHS').paths, ['package-lock.json']);
  assert.deepEqual(closed.commits.map(entry => entry.ticket), ['US-01']); assert.deepEqual(closed.left, ['package-lock.json', 'src/api/tags.js']);
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(f.log(), ['US-01: Ticket US-01']); assert.deepEqual(done.left, ['package-lock.json', 'src/api/tags.js']);
  assert.match(f.read('pm-decisions.md'), /COMMITTED on work: 1 commit\(s\).*2 changed path\(s\) left uncommitted \(package-lock\.json, src\/api\/tags\.js\)/);
  // What is left makes the next batch refuse until the PM deals with it, or starts as is.
  assert.match(refusal(await f.before(batchOf(ticket('US-03', ['src/b.js'])))).reason, /uncommitted changes/);
  const next = await f.before(batchOf(ticket('US-03', ['src/b.js'])), { startAsIs: true });
  assert.equal(next.errors, undefined, JSON.stringify(next.errors)); assert.deepEqual(next.preexisting, ['package-lock.json', 'src/api/tags.js']);
});

test('after refuses a return that is not this batch\'s and changes nothing; findings that question the run hold every commit', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n' } });
  for (const bad of [undefined, {}, { ...f.result, runId: 'other' }, { ...f.result, results: f.result.results.slice(0, 1) }]) {
    assert.match(refusal(afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result: bad })).reason, /not the return of this batch/);
    assert.equal(readLease({ productRoot: f.product }).status, 'held'); assert.equal(existsSync(join(f.root, AFTER_FILE)), false); }
  git(f.product, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  const closed = f.after();
  assert.equal(closed.status, 'review'); assert.ok(closed.findings.some(finding => finding.code === 'PRODUCT_HEAD_MOVED')); assert.equal(closed.holdAll, true); assert.deepEqual(closed.commits, []);
  assert.equal(readLease({ productRoot: f.product }).status, 'free', 'the lock does not outlive the batch');
  assert.match(refusal(f.commit()).reason, /commits that are not this batch's/);
  const noHook = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n' }, hook: false });
  assert.ok(noHook.after().findings.some(finding => finding.code === 'HOOK_SAW_NO_WORKER'), 'files changed and the hook logged no worker: the write limits were not enforced');
  const edited = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n' } });
  writeFileSync(join(edited.root, BATCH_FILE), JSON.stringify({ ...edited.open, branch: 'main' }));
  assert.match(refusal(edited.after()).reason, /was changed after the batch opened/);
});

test('commit refuses when the product changed after the batch was closed, keeps paths changed before the batch out of every commit, and resumes after a failure', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n', 'src/api/tags.js': 'tags\n' } });
  assert.equal(f.after().errors, undefined);
  writeFileSync(join(f.product, 'src/app.js'), 'export const x = 3;\n'); writeFileSync(join(f.product, 'src/late.js'), 'late\n');
  assert.match(refusal(f.commit()).reason, /changed since the batch was closed/); assert.deepEqual(f.log(), []); assert.equal(readLease({ productRoot: f.product }).status, 'free');
  rmSync(join(f.product, 'src/late.js'));
  // A commit hook that refuses the second commit: the first stays, and a second run makes only what is missing.
  writeFileSync(join(f.product, '.git/hooks/pre-commit'), '#!/bin/sh\ngit diff --cached --name-only | grep -q tags.js && exit 1\nexit 0\n', { mode: 0o755 });
  assert.match(refusal(f.commit()).reason, /git commit failed for ticket US-02 \(1 of 2 made\)/); assert.deepEqual(f.log(), ['US-01: Ticket US-01']); assert.ok(existsSync(join(f.root, BATCH_FILE)));
  rmSync(join(f.product, '.git/hooks/pre-commit'));
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(f.log(), ['US-01: Ticket US-01', 'feat(api): tags endpoint']); assert.equal(done.commits.length, 2);

  const dirty = await (async () => { const g = live(t); writeFileSync(join(g.product, 'notes.txt'), 'mine\n'); git(g.product, 'add', 'notes.txt'); return g; })();
  assert.match(refusal(await dirty.before(batchOf(ticket('US-01', ['notes.txt', 'src/a.js'])), { startAsIs: true })).reason, /already changed and lie where a ticket of this batch writes \(notes\.txt\)/);
  const open = await dirty.before(batchOf(ticket('US-01', ['src/a.js'])), { startAsIs: true });
  const { result } = await runWorkflow({ scriptPath: join(dirty.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  writeFileSync(join(dirty.product, 'src/a.js'), 'a\n'); appendFileSync(join(dirty.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Write', agentType: 'tag-list-fixture-worker-exec', decision: 'allow' }) + '\n');
  assert.equal(afterBatch({ teamRoot: dirty.kit, instanceRoot: dirty.root, result }).errors, undefined);
  assert.equal(commitBatch({ teamRoot: dirty.kit, instanceRoot: dirty.root }).errors, undefined);
  assert.deepEqual(git(dirty.product, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['src/a.js'], 'the staged path from before the batch is not in the commit');
  assert.equal(git(dirty.product, 'status', '--porcelain').trim(), 'A  notes.txt', 'and is still staged, as the owner left it');
});

test('CLI: after exits 0 clean and 2 in review; commit exits 0', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n', 'stray.txt': 'x\n' } }), file = join(f.base, 'result.json');
  const run = (...argv) => spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify(f.result));
  assert.equal(run('after', file).status, 1); assert.equal(run('after', join(f.base, 'absent.json'), '--instance', f.root).status, 2);
  const closed = run('after', file, '--instance', f.root);
  assert.equal(closed.status, 2, 'a batch in review'); assert.equal(JSON.parse(closed.stdout).status, 'review');
  const done = run('commit', '--instance', f.root);
  assert.equal(done.status, 0, done.stderr); assert.equal(JSON.parse(done.stdout).commits.length, 1); assert.equal(run('commit', '--instance', f.root).status, 2);
});
