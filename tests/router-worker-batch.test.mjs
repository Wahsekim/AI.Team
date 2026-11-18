// ADR 0010, decisions 8 to 12: the command a PM runs before a batch in a standing Router/Worker team.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, appendFileSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeBatch, abortBatch, BATCH_FILE, AFTER_FILE } from '../src/router-worker/batch.mjs';
import { afterBatch, commitBatch, HOLD_ALL } from '../src/router-worker/batch-close.mjs';
import { settleBatch } from '../src/router-worker/batch-settle.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { fileURLToPath } from 'node:url';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { readLease, acquireLease, releaseLease } from '../src/router-worker/lease.mjs';
import { observeIsolation } from '../src/router-worker/isolation.mjs';
import { readBoundary, decideWrite, closeBoundary } from '../src/router-worker/write-boundary.mjs';
import { DEFAULT_LIMITS } from '../src/router-worker/switch.mjs';
import { fixture, git } from './fixtures/router-worker/standing-team.mjs';
import { digest } from '../src/loop/contracts.mjs';

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
async function ran(t, { tickets, agents = {}, edits = {}, hook = true, extra = {}, hooks = () => ({}) }) {
  const f = live(t);
  // Commit hooks the repository had before the batch; one written later is a finding.
  for (const [name, script] of Object.entries(hooks(f))) writeFileSync(join(f.product, '.git/hooks', name), script, { mode: 0o755 });
  const open = await f.before(batchOf(...tickets), extra);
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
  assert.equal(git(f.product, 'rev-parse', 'HEAD').trim(), f.open.productHead, 'after commits nothing');
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(done.stage, 'batch-committed'); assert.equal(done.pushed, false);
  assert.deepEqual(f.log(), ['US-01: Ticket US-01', 'feat(api): tags endpoint']); assert.equal(f.status(), '', 'the product is clean again');
  assert.deepEqual(git(f.product, 'show', '--name-only', '--format=', 'HEAD~1').trim().split('\n').sort(), ['src/app.js', 'src/list/view.js'], 'each commit holds its ticket\'s files only');
  assert.equal(git(f.product, 'symbolic-ref', '--short', 'HEAD').trim(), 'work');
  assert.deepEqual(readdirSync(join(f.root, 'batches', f.open.runId)).sort(), ['after.json', 'batch.json', 'commit.json', 'commits.json', 'return.json']); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.equal(existsSync(join(f.root, AFTER_FILE)), false);
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
  assert.match(refusal(f.commit()).reason, /not the batch's start plus the commits this command made.*rw-batch\.mjs abort/);
  assert.match(closed.next.join(' '), /No ticket of this batch is committed by the kit.*rw-batch\.mjs abort/, 'the record says what to do');
  // The way out of a closed batch the kit will not commit: its records are archived, the work stays in the tree.
  const out = abortBatch({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(out.errors, undefined, JSON.stringify(out.errors)); assert.equal(out.stage, 'batch-archived-without-commit');
  assert.deepEqual(readdirSync(join(f.root, 'batches', f.open.runId)).sort(), ['abandoned.json', 'after.json', 'batch.json', 'return.json']); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  assert.match(f.read('pm-decisions.md'), /ARCHIVED WITHOUT COMMIT by rw-batch\.mjs abort/); assert.ok(f.status().includes('src/app.js'), 'the work is still there');
  assert.equal((await f.before(batchOf(ticket('US-07', ['src/q.js'])), { startAsIs: true })).errors, undefined, 'and the team can open its next batch');
  const noHook = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n' }, hook: false });
  assert.ok(noHook.after().findings.some(finding => finding.code === 'HOOK_SAW_NO_WORKER'), 'files changed and the hook logged no worker: the write limits were not enforced');
  const edited = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n' } });
  writeFileSync(join(edited.root, BATCH_FILE), JSON.stringify({ ...edited.open, branch: 'main' }));
  assert.match(refusal(edited.after()).reason, /was changed after the batch opened/);
});

test('commit refuses when the product changed after the batch was closed, keeps paths changed before the batch out of every commit, and resumes after a failure', async t => {
  const blocking = f => ({ 'pre-commit': `#!/bin/sh\n[ -e "${join(f.base, 'block')}" ] && git diff --cached --name-only | grep -q tags.js && exit 1\nexit 0\n` });
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n', 'src/api/tags.js': 'tags\n' }, hooks: blocking });
  assert.equal(f.after().errors, undefined);
  writeFileSync(join(f.product, 'src/app.js'), 'export const x = 3;\n'); writeFileSync(join(f.product, 'src/late.js'), 'late\n');
  assert.match(refusal(f.commit()).reason, /changed since the batch was closed/); assert.deepEqual(f.log(), []); assert.equal(readLease({ productRoot: f.product }).status, 'free');
  rmSync(join(f.product, 'src/late.js'));
  // A commit hook that refuses the second commit: the first stays, and a second run makes only what is missing.
  writeFileSync(join(f.base, 'block'), '');
  assert.match(refusal(f.commit()).reason, /git commit failed for ticket US-02 \(1 of 2 made\)/); assert.deepEqual(f.log(), ['US-01: Ticket US-01']); assert.ok(existsSync(join(f.root, BATCH_FILE)));
  rmSync(join(f.base, 'block'));
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

const sealAgain = record => { const { digest: _old, ...body } = record; return { ...body, digest: digest(body) }; };

test('commit handles what a worker did through Git: a staged deletion, a staged rename inside a ticket, and many paths', async t => {
  const f = live(t); mkdirSync(join(f.product, 'lib')); for (const name of ['one.js', 'mv.js']) writeFileSync(join(f.product, 'lib', name), name + '\n');
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  const open = await f.before(batchOf(ticket('US-01', ['lib/**'], { expectedPaths: ['lib/one.js'] })));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  git(f.product, 'rm', '-q', 'lib/one.js'); git(f.product, 'mv', 'lib/mv.js', 'lib/moved.js');
  for (let i = 0; i < 300; i++) writeFileSync(join(f.product, 'lib', `gen ${i} é.js`), 'x\n');
  appendFileSync(join(f.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Bash', agentType: 'tag-list-fixture-worker-exec', decision: 'allow' }) + '\n');
  assert.equal(afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result }).status, 'clean');
  const done = commitBatch({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(git(f.product, 'status', '--porcelain').trim(), '');
  const names = git(f.product, 'show', '--name-status', '--no-renames', '--format=', 'HEAD');
  assert.match(names, /D\tlib\/one\.js/); assert.match(names, /D\tlib\/mv\.js/); assert.match(names, /A\tlib\/moved\.js/); assert.equal(names.trim().split('\n').length, 303);
});

test('a commit hook written or moved during a batch holds it; a hook that stages more than the ticket is found out; another repository in the environment is ignored', async t => {
  // Hooks kept in the work tree, in the layouts teams use: no ticket may write where they live.
  const husky = live(t); git(husky.product, 'config', 'core.hooksPath', '.husky');
  assert.match(refusal(await husky.before(batchOf(ticket('US-01', ['.husky/**'], { expectedPaths: ['.husky/pre-commit'] })))).reason, /commit hooks live in \.husky; no ticket writes there/);
  const nine = live(t); mkdirSync(join(nine.product, '.husky/_'), { recursive: true }); git(nine.product, 'config', 'core.hooksPath', '.husky/_');
  assert.match(refusal(await nine.before(batchOf(ticket('US-01', ['.husky/pre-commit'])))).reason, /no ticket writes there/, 'husky 9: the stub folder runs the scripts beside it');
  const linked = live(t); mkdirSync(join(linked.product, 'tools/githooks'), { recursive: true }); symlinkSync('tools/githooks', join(linked.product, 'hooks')); git(linked.product, 'config', 'core.hooksPath', 'hooks');
  git(linked.product, 'add', '-A'); git(linked.product, 'commit', '-q', '-m', 'hooks');
  assert.match(refusal(await linked.before(batchOf(ticket('US-01', ['tools/githooks/**'], { expectedPaths: ['tools/githooks/pre-commit'] })))).reason, /no ticket writes there/, 'the folder the link points to');
  // A hook that appears in .git/hooks during the batch, as a worker's shell could write it; and a hooks path that is moved.
  const written = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } });
  writeFileSync(join(written.product, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch /tmp/never\n', { mode: 0o755 });
  const caught = written.after(); assert.ok(caught.findings.some(finding => finding.code === 'HOOKS_CHANGED')); assert.equal(caught.holdAll, true); assert.deepEqual(caught.commits, []);
  const moved = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); git(moved.product, 'config', 'core.hooksPath', 'hooks');
  assert.ok(moved.after().findings.some(finding => finding.code === 'HOOKS_CHANGED'));
  const late = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(late.after().status, 'clean');
  writeFileSync(join(late.product, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.match(refusal(late.commit()).reason, /commit hooks were changed or moved/); assert.deepEqual(late.log(), []);
  // Husky 9, and a worker's shell writing the script beside the stub folder, which no ticket granted.
  const stub = live(t); mkdirSync(join(stub.product, '.husky/_'), { recursive: true }); writeFileSync(join(stub.product, '.husky/_/pre-commit'), '#!/bin/sh\n. "$(dirname "$0")/../pre-commit"\n', { mode: 0o755 });
  git(stub.product, 'add', '-A'); git(stub.product, 'commit', '-q', '-m', 'husky'); git(stub.product, 'config', 'core.hooksPath', '.husky/_');
  const opened = await stub.before(batchOf(...two)), ranStub = await runWorkflow({ scriptPath: join(stub.root, '.claude/workflows/run-n-rounds.js'), args: opened.args, agentImpl: makeAgentImpl({}) });
  writeFileSync(join(stub.product, 'src/app.js'), 'x\n'); writeFileSync(join(stub.product, '.husky/pre-commit'), `#!/bin/sh\ntouch "${join(stub.base, 'ran-as-pm')}"\n`, { mode: 0o755 });
  appendFileSync(join(stub.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Bash', agentType: 'tag-list-fixture-worker-exec', decision: 'allow' }) + '\n');
  const stubbed = afterBatch({ teamRoot: stub.kit, instanceRoot: stub.root, result: ranStub.result });
  assert.deepEqual(stubbed.findings.find(finding => finding.code === 'HOOKS_WRITTEN')?.paths, ['.husky/pre-commit']); assert.equal(stubbed.holdAll, true);
  assert.ok(refusal(commitBatch({ teamRoot: stub.kit, instanceRoot: stub.root })) || true); assert.equal(existsSync(join(stub.base, 'ran-as-pm')), false, 'the script never ran');
  // A hook the repository already had that stages more than the ticket's paths: the commit is found out and the batch stops there.
  const greedy = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 'tags\n' }, hooks: () => ({ 'pre-commit': '#!/bin/sh\ngit add -A\n' }) });
  assert.equal(greedy.after().errors, undefined);
  assert.match(refusal(greedy.commit()).reason, /does not hold exactly that ticket's paths.*rw-batch\.mjs abort/);
  // An ambient GIT_DIR pointing elsewhere is ignored; an identity given in the environment is kept.
  const other = join(greedy.base, 'elsewhere'); mkdirSync(other); git(other, 'init', '-q'); git(other, 'commit', '-q', '--allow-empty', '-m', 'other');
  const env = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(env.after().errors, undefined);
  Object.assign(process.env, { GIT_DIR: join(other, '.git'), GIT_AUTHOR_NAME: 'PM Session', GIT_AUTHOR_EMAIL: 'pm@example.invalid', GIT_COMMITTER_NAME: 'PM Session', GIT_COMMITTER_EMAIL: 'pm@example.invalid' });
  const clear = () => { for (const key of ['GIT_DIR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[key]; }; t.after(clear);
  const done = env.commit(); clear();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(env.log(), ['US-01: Ticket US-01']); assert.equal(git(other, 'log', '--format=%s').trim(), 'other');
  assert.equal(git(env.product, 'log', '-1', '--format=%an <%ae>').trim(), 'PM Session <pm@example.invalid>');
});

test('after reports a repository created inside the product and a path from before the batch that was changed again', async t => {
  const f = live(t); writeFileSync(join(f.product, 'notes.txt'), 'mine\n');
  const open = await f.before(batchOf(ticket('US-01', ['lib/**'], { expectedPaths: ['lib/a.js'] })), { startAsIs: true });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  mkdirSync(join(f.product, 'lib')); writeFileSync(join(f.product, 'lib/a.js'), 'a\n'); writeFileSync(join(f.product, 'notes.txt'), 'changed by a worker\n');
  mkdirSync(join(f.product, 'lib/sub')); git(join(f.product, 'lib/sub'), 'init', '-q'); git(join(f.product, 'lib/sub'), 'commit', '-q', '--allow-empty', '-m', 'inner');
  appendFileSync(join(f.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Write', agentType: 'tag-list-fixture-worker-exec', decision: 'allow' }) + '\n');
  const closed = afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result });
  assert.deepEqual(closed.findings.find(finding => finding.code === 'NESTED_REPOSITORY').paths, ['lib/sub/']); assert.deepEqual(closed.findings.find(finding => finding.code === 'PREEXISTING_PATH_CHANGED').paths, ['notes.txt']);
  assert.deepEqual(closed.commits[0].paths, ['lib/a.js'], 'the nested repository is not in the commit'); assert.ok(closed.left.includes('lib/sub/'));
  assert.equal(commitBatch({ teamRoot: f.kit, instanceRoot: f.root }).errors, undefined);
  assert.deepEqual(git(f.product, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['lib/a.js']);
});

test('commit resumes by the commits it recorded, and refuses a branch that is not the batch\'s start plus those', async t => {
  assert.match(refusal(await live(t).before(batchOf(ticket('US-01', ['src/a.js'], { commitMessage: 'feat: x ' })))).reason, /no space at either end/);
  // A hook that rewrites the subject does not confuse the resume.
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 'tags\n' }, hooks: g => ({ 'prepare-commit-msg': '#!/bin/sh\nprintf "[auto] %s" "$(cat "$1")" > "$1"\n',
    'pre-commit': `#!/bin/sh\n[ -e "${join(g.base, 'block')}" ] && git diff --cached --name-only | grep -q tags.js && exit 1\nexit 0\n` }) });
  assert.equal(f.after().errors, undefined); writeFileSync(join(f.base, 'block'), '');
  assert.match(refusal(f.commit()).reason, /git commit failed for ticket US-02 \(1 of 2 made\)/);
  rmSync(join(f.base, 'block'));
  const done = f.commit(); assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(f.log(), ['[auto] US-01: Ticket US-01', '[auto] feat(api): tags endpoint']);
  assert.deepEqual(readdirSync(join(f.root, 'batches', f.open.runId)).sort(), ['after.json', 'batch.json', 'commit.json', 'commits.json', 'return.json']);
  // The branch rewound between after and commit.
  const rewound = live(t); git(rewound.product, 'commit', '-q', '--allow-empty', '-m', 'extra');
  const open = await rewound.before(batchOf(ticket('US-01', ['src/new.js'])));
  const { result } = await runWorkflow({ scriptPath: join(rewound.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  writeFileSync(join(rewound.product, 'src/new.js'), 'n\n'); appendFileSync(join(rewound.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Write', agentType: 'tag-list-fixture-worker-exec', decision: 'allow' }) + '\n');
  assert.equal(afterBatch({ teamRoot: rewound.kit, instanceRoot: rewound.root, result }).errors, undefined);
  git(rewound.product, 'reset', '-q', '--hard', 'HEAD~1'); writeFileSync(join(rewound.product, 'src/new.js'), 'n\n');
  assert.match(refusal(commitBatch({ teamRoot: rewound.kit, instanceRoot: rewound.root })).reason, /not the batch's start plus the commits/);
});

test('after is taken up again after a death, refuses a second caller, and is not a refusal when only the ledger fails', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), afterPath = join(f.root, AFTER_FILE);
  // An after that claimed the batch a moment ago is running.
  writeFileSync(afterPath, JSON.stringify({ stage: 'batch-closing', runId: f.open.runId, claimedAt: new Date().toISOString() }));
  assert.match(refusal(f.after()).reason, /Another after is closing this batch/); assert.match(refusal(f.commit()).reason, /has not been closed/);
  // One that died after it closed the boundary and released the lock: the next call finishes it, with no false alarm.
  closeBoundary({ teamRoot: f.root }); releaseLease({ productRoot: f.product, lease: f.open.lease });
  writeFileSync(afterPath, JSON.stringify({ stage: 'batch-closing', runId: f.open.runId, claimedAt: new Date(Date.now() - 120000).toISOString() }));
  const closed = f.after();
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.status, 'clean', JSON.stringify(closed.findings)); assert.equal(closed.commits.length, 1);
  // The ledger cannot be written: the batch is closed all the same, and says so.
  const mute = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); chmodSync(join(mute.root, 'pm-decisions.md'), 0o444);
  const quiet = mute.after(); chmodSync(join(mute.root, 'pm-decisions.md'), 0o644);
  assert.equal(quiet.errors, undefined, JSON.stringify(quiet.errors)); assert.ok(quiet.findings.some(finding => finding.code === 'LEDGER_NOT_WRITTEN')); assert.equal(readLease({ productRoot: mute.product }).status, 'free');
  // A boundary that cannot be read: the record says how it is rebuilt, and so does the next before.
  const broken = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); writeFileSync(join(broken.root, '.claude/rw-write-boundary.json'), '{}');
  const record = broken.after(); assert.ok(record.findings.some(finding => finding.code === 'BOUNDARY_NOT_RESTORED')); assert.match(record.next.join(' '), /mode switch/);
  assert.equal(abortBatch({ teamRoot: broken.kit, instanceRoot: broken.root }).stage, 'batch-archived-without-commit');
  assert.match(refusal(await broken.before(batchOf(ticket('US-08', ['src/z.js'])), { startAsIs: true })).reason, /rebuilt by a mode switch/);
});

test('a commit that died after archiving is finished by the next call; nothing in a record the PM can write reaches a path, the ledger or a commit unchecked', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(f.after().errors, undefined);
  // The records leave the root one after another, the batch record first: a death in between leaves the after record.
  const closedText = readFileSync(join(f.root, AFTER_FILE), 'utf8'), done = f.commit(); assert.equal(done.errors, undefined);
  writeFileSync(join(f.root, AFTER_FILE), closedText);
  assert.deepEqual(f.commit(), done, 'the archived result is returned'); assert.equal(existsSync(join(f.root, AFTER_FILE)), false); assert.deepEqual(f.log(), ['US-01: Ticket US-01']);
  // A death before the first removal leaves both records; they are the archived batch's own.
  writeFileSync(join(f.root, AFTER_FILE), closedText); writeFileSync(join(f.root, BATCH_FILE), readFileSync(join(f.root, 'batches', f.open.runId, 'batch.json')));
  assert.deepEqual(f.commit(), done); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.deepEqual(f.log(), ['US-01: Ticket US-01']);

  // The engine return says "done" for a ticket whose own record says it failed.
  let checks = 0;
  const lied = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' }, agents: { verifier: () => ++checks === 1 ? { pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: [{ command: 'npm test', exitCode: 0 }], failures: [] }
    : { pass: false, staticPass: false, e2ePass: false, summary: 'broken', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['x'] } } });
  const flipped = { ...lied.result, results: lied.result.results.map((entry, i) => i === 1 ? { ...entry, done: true } : entry) };
  assert.deepEqual(afterBatch({ teamRoot: lied.kit, instanceRoot: lied.root, result: flipped }).tickets.map(entry => entry.status), ['passed', 'not-passed']);

  // Records sealed again by hand.
  const escaped = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } });
  writeFileSync(join(escaped.root, BATCH_FILE), JSON.stringify(sealAgain({ ...escaped.open, runId: '../../escaped' })));
  assert.match(refusal(escaped.after()).reason, /plain run id/); assert.equal(existsSync(join(escaped.base, 'escaped')), false);
  const stray = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'stray.txt': 's\n' } }), closed = stray.after();
  writeFileSync(join(stray.root, AFTER_FILE), JSON.stringify(sealAgain({ ...closed, commits: [{ ...closed.commits[0], paths: ['src/app.js', 'stray.txt'] }], left: [] })));
  assert.match(refusal(stray.commit()).reason, /plans a commit that is not a passed ticket's own paths/); assert.deepEqual(stray.log(), []);
});

test('each finding that questions the run holds every commit; each check of commit refuses on its own', async t => {
  assert.deepEqual([...HOLD_ALL].sort(), ['BOUNDARY_CHANGED', 'GUARDIAN_NOT_CLEAN', 'HOOKS_CHANGED', 'HOOKS_WRITTEN', 'PRODUCT_BRANCH_CHANGED', 'PRODUCT_HEAD_MOVED']);
  const edits = { 'src/app.js': 'x\n' }, holds = (closed, code) => { assert.ok(closed.findings.some(finding => finding.code === code), `${code}: ${JSON.stringify(closed.findings)}`); assert.equal(closed.holdAll, true); assert.deepEqual(closed.commits, []); };
  const boundary = await ran(t, { tickets: two, edits }), file = join(boundary.root, '.claude/rw-write-boundary.json'), body = (({ digest: _old, ...rest }) => rest)(JSON.parse(readFileSync(file, 'utf8')));
  const widened = { ...body, wrappers: { ...body.wrappers, 'tag-list-fixture-worker-exec': { duty: 'exec', writePaths: ['**'] } } };
  writeFileSync(file, JSON.stringify({ ...widened, digest: digest(widened) })); holds(boundary.after(), 'BOUNDARY_CHANGED');
  const branch = await ran(t, { tickets: two, edits }); git(branch.product, 'checkout', '-q', '-b', 'elsewhere'); holds(branch.after(), 'PRODUCT_BRANCH_CHANGED');
  const guard = await ran(t, { tickets: two, edits, agents: { guardian: () => ({ verdict: 'runaway', findings: ['the worker looped'], summary: 'not clean' }) } }); holds(guard.after(), 'GUARDIAN_NOT_CLEAN');
  // A lock another team holds when the batch ends, and hook log lines from before the batch opened.
  const stolen = await ran(t, { tickets: two, edits }); releaseLease({ productRoot: stolen.product, lease: stolen.open.lease }); acquireLease({ teamRoot: fixture(t).root, productRoot: stolen.product });
  assert.ok(stolen.after().findings.some(finding => finding.code === 'LOCK_NOT_HELD_BY_THIS_BATCH'));
  const old = live(t); appendFileSync(join(old.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', tool: 'Edit', agentType: 'tag-list-fixture-worker-exec', decision: 'allow' }) + '\n');
  const opened = await old.before(batchOf(...two)), { result } = await runWorkflow({ scriptPath: join(old.root, '.claude/workflows/run-n-rounds.js'), args: opened.args, agentImpl: makeAgentImpl({}) });
  writeFileSync(join(old.product, 'src/app.js'), 'x\n');
  assert.ok(afterBatch({ teamRoot: old.kit, instanceRoot: old.root, result }).findings.some(finding => finding.code === 'HOOK_SAW_NO_WORKER'), 'a line from an earlier batch does not count');
  // A ticket that did not pass says why.
  const failed = await ran(t, { tickets: two, edits, agents: { verifier: () => ({ pass: false, staticPass: false, e2ePass: false, summary: 'no', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['x'] }) } });
  const first = failed.after().tickets[0]; assert.equal(first.status, 'not-passed'); assert.equal(first.verificationStatus, 'failed'); assert.equal(typeof first.workerStatus, 'string');

  const onBranch = await ran(t, { tickets: two, edits }); assert.equal(onBranch.after().errors, undefined); git(onBranch.product, 'checkout', '-q', '-b', 'side');
  assert.match(refusal(onBranch.commit()).reason, /no longer on the batch's branch/);
  const busy = await ran(t, { tickets: two, edits }); assert.equal(busy.after().errors, undefined); writeFileSync(join(busy.product, '.git/MERGE_HEAD'), 'x\n');
  assert.match(refusal(busy.commit()).reason, /Git operation is in progress/);
  const edited = await ran(t, { tickets: two, edits }), closed = edited.after();
  writeFileSync(join(edited.root, AFTER_FILE), JSON.stringify({ ...closed, holdAll: false, status: 'clean' }).replace('"review"', '"clean"').replace(closed.closedAt, '2020-01-01T00:00:00.000Z'));
  assert.match(refusal(edited.commit()).reason, /was changed, or belongs to another batch/);
});

test('abort after a claimed or closed batch always frees the team; a forged archive never stands in for a commit', async t => {
  // An after that died right after its claim, whatever the claim says about its time.
  for (const claimedAt of [new Date().toISOString(), undefined, '2999-01-01T00:00:00.000Z']) {
    const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } });
    writeFileSync(join(f.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: f.open.runId, claimedAt }));
    if (claimedAt === undefined || claimedAt.startsWith('2999')) { const resumed = f.after(); assert.equal(resumed.errors, undefined, `a claim with no usable time is taken up: ${JSON.stringify(resumed.errors)}`); continue; }
    const out = abortBatch({ teamRoot: f.kit, instanceRoot: f.root });
    assert.equal(out.stage, 'batch-archived-without-commit'); assert.equal(out.lockReleased, true); assert.equal(out.boundary, 'closed'); f.untouched();
  }
  // A stale claim does not excuse a boundary that names other workers.
  const tampered = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), other = { schemaVersion: 1, productRoot: tampered.product, wrappers: { a: { duty: 'exec', writePaths: [] }, b: { duty: 'check', writePaths: [] }, c: { duty: 'guard', writePaths: [] } } };
  writeFileSync(join(tampered.root, '.claude/rw-write-boundary.json'), JSON.stringify({ ...other, digest: digest(other) })); releaseLease({ productRoot: tampered.product, lease: tampered.open.lease });
  writeFileSync(join(tampered.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: tampered.open.runId, claimedAt: '2020-01-01T00:00:00.000Z' }));
  assert.ok(tampered.after().findings.some(finding => finding.code === 'BOUNDARY_CHANGED'));
  // A commit.json planted under the run id of an open batch.
  const forged = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), planted = { schemaVersion: 1, stage: 'batch-committed', runId: forged.open.runId, batchDigest: forged.open.digest, commits: [], left: [], pushed: false };
  mkdirSync(join(forged.root, 'batches', forged.open.runId), { recursive: true }); writeFileSync(join(forged.root, 'batches', forged.open.runId, 'commit.json'), JSON.stringify({ ...planted, digest: digest(planted) }));
  assert.match(refusal(forged.commit()).reason, /has not been closed/); assert.ok(existsSync(join(forged.root, BATCH_FILE))); assert.equal(readLease({ productRoot: forged.product }).status, 'held');
  assert.equal(forged.after().errors, undefined); assert.match(refusal(forged.commit()).reason, /batches\/\S+ already exists/); assert.deepEqual(forged.log(), [], 'nothing is committed into a batch whose archive was started');
  // A commit made just before the command died is taken up; a recorded commit that is not the ticket's is refused; abort names the commits made.
  const died = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } }); assert.equal(died.after().errors, undefined);
  git(died.product, 'add', 'src/app.js'); git(died.product, 'commit', '-q', '-m', 'US-01: Ticket US-01');
  const taken = died.commit(); assert.equal(taken.errors, undefined, JSON.stringify(taken.errors)); assert.equal(taken.commits.length, 2); assert.equal(died.log().length, 2);
  const fake = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } }); assert.equal(fake.after().errors, undefined);
  writeFileSync(join(fake.product, 'zzz.js'), 'z\n'); git(fake.product, 'add', 'zzz.js', 'src/app.js'); git(fake.product, 'commit', '-q', '-m', 'by hand');
  writeFileSync(join(fake.root, 'rw-batch-commits.json'), JSON.stringify({ commits: [{ ticket: 'US-01', sha: git(fake.product, 'rev-parse', 'HEAD').trim() }] }));
  assert.match(refusal(fake.commit()).reason, /does not hold its ticket's paths/);
  const partial = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' }, hooks: g => ({ 'pre-commit': `#!/bin/sh\n[ -e "${join(g.base, 'block')}" ] && git diff --cached --name-only | grep -q tags.js && exit 1\nexit 0\n` }) });
  assert.equal(partial.after().errors, undefined); writeFileSync(join(partial.base, 'block'), ''); assert.ok(partial.commit().errors);
  const left = abortBatch({ teamRoot: partial.kit, instanceRoot: partial.root });
  assert.equal(left.commitsMade.length, 1); assert.match(left.next, /1 commit\(s\) were already made by the kit and stay on the branch/); assert.match(partial.read('pm-decisions.md'), /ARCHIVED WITHOUT COMMIT.*1 commit\(s\) were already made/);
});

// The session's transcripts as the runtime leaves them, read by the kit's meter: one agent per call, in the engine's order.
const METER = fileURLToPath(new URL('../scripts/measure-spawn.mjs', import.meta.url));
function meterOf(f, tokens, { briefOf = brief => brief } = {}) {
  const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n', dir = join(f.base, 'projects'), wf = join(dir, 'sess/subagents/workflows/wf_1');
  const usage = (id, agentId, create) => ({ type: 'assistant', isSidechain: Boolean(agentId), agentId, requestId: `req_${id}`, message: { id: `msg_${id}`, model: 'm', role: 'assistant', content: [],
    usage: { input_tokens: 10, cache_creation_input_tokens: create, cache_read_input_tokens: 0, output_tokens: 100 } } });
  const relayed = text => ({ type: 'user', message: { role: 'user', content: `The computed task text follows:\n${text.split('\n').map(line => '  ' + line).join('\n')}\n  ` } });
  const agents = [...f.open.args.plan.flatMap((item, i) => [[`exec${i}`, item.agentType, briefOf(item.brief)], [`check${i}`, item.verifierAgentType, item.verifierBrief]]), ['guard', f.open.args.guardianAgentType, 'Audit this run.']];
  mkdirSync(wf, { recursive: true }); writeFileSync(join(dir, 'sess.jsonl'), jsonl([usage('main', undefined, 7000)]));
  agents.forEach(([id, agentType, brief], i) => {
    writeFileSync(join(wf, `agent-${id}.jsonl`), jsonl([{ type: 'user', message: { role: 'user', content: 'harness preamble' } }, relayed(brief), usage(id, id, tokens[i])]));
    writeFileSync(join(wf, `agent-${id}.meta.json`), JSON.stringify({ agentType, description: id }));
  });
  writeFileSync(join(wf, 'journal.jsonl'), jsonl([{ type: 'launched' }, ...agents.flatMap(([agentId]) => [{ type: 'started', agentId }, { type: 'result', agentId, result: {} }])]));
  const run = spawnSync(process.execPath, [METER, join(dir, 'sess'), '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('settle sets each ticket\'s measured usage against its authorization, before or after the commit, and reports a ticket over it', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } }), rules = loadRetryRules({ teamRoot: f.kit, instanceRoot: f.root });
  const settle = (meter, extra = {}) => settleBatch({ teamRoot: f.kit, instanceRoot: f.root, meter, rules, ...extra });
  assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1]))).reason, /No closed batch is waiting/);
  assert.equal(f.after().errors, undefined);
  assert.match(refusal(settle({ subagents: [] })).reason, /meter/i, 'a meter that does not hold the run');
  const returnPath = join(f.root, 'rw-batch-return.json'), kept = readFileSync(returnPath, 'utf8'), edited = JSON.parse(kept);
  edited.results[1].verificationStatus = 'failed'; writeFileSync(returnPath, JSON.stringify(edited));
  assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1]))).reason, /missing or was changed/, 'a return edited after the batch was closed');
  writeFileSync(returnPath, kept);
  assert.equal(existsSync(join(f.root, 'rw-batch-settlement.json')), false);
  const settled = settle(meterOf(f, [12000, 6000, 150000, 60000, 5000]));
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors)); assert.equal(settled.stage, 'batch-settled');
  assert.deepEqual(settled.tickets.map(entry => [entry.ticket, entry.authorizedTokens, entry.spentTokens, entry.budgetGate]), [['US-01', 200000, 18020, 'clear'], ['US-02', 200000, 210020, 'blocked']]);
  assert.equal(settled.status, 'review', 'a ticket over its authorization puts the batch in review'); assert.equal(settled.calls.length, 5); assert.equal(settled.mainSessionTokens, 7010);
  assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1]))).reason, /already settled/);
  assert.match(f.read('pm-decisions.md'), /BATCH \S+ SETTLED \(review\): 228040 token\(s\) on 2 ticket\(s\) of 400000 authorized, Guardian 5010/);
  // Cost is reported, not enforced: the commits are made, and the settlement is archived with the batch.
  assert.equal(f.commit().errors, undefined); assert.equal(f.log().length, 2);
  assert.ok(readdirSync(join(f.root, 'batches', f.open.runId)).includes('settlement.json'));

  // An archived batch is settled by its id; a transcript that does not carry the frozen brief is a finding.
  const late = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), lateRules = loadRetryRules({ teamRoot: late.kit, instanceRoot: late.root });
  assert.equal(late.after().errors, undefined); assert.equal(late.commit().errors, undefined);
  const archived = settleBatch({ teamRoot: late.kit, instanceRoot: late.root, meter: meterOf(late, [12000, 6000, 12000, 6000, 5000], { briefOf: brief => brief.replace('Ticket US-01', 'Another task') }), rules: lateRules, runId: late.open.runId });
  assert.equal(archived.errors, undefined, JSON.stringify(archived.errors)); assert.ok(archived.findings.some(finding => finding.code === 'BRIEF_NOT_FOUND' && finding.ticket === 'US-01'));
  assert.ok(existsSync(join(late.root, 'batches', late.open.runId, 'settlement.json')));
  assert.match(refusal(settleBatch({ teamRoot: late.kit, instanceRoot: late.root, meter: {}, rules: lateRules, runId: '../x' })).reason, /No archived batch/);
  // CLI
  const cli = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(cli.after().errors, undefined);
  const meterFile = join(cli.base, 'meter.json'); writeFileSync(meterFile, JSON.stringify(meterOf(cli, [12000, 6000, 12000, 6000, 5000])));
  const run = (...argv) => spawnSync(process.execPath, [join(cli.kit, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  assert.equal(run('settle', meterFile).status, 1); assert.equal(run('settle', meterFile, '--instance', cli.root, '--run').status, 1);
  const done = run('settle', meterFile, '--instance', cli.root);
  assert.equal(done.status, 0, done.stdout + done.stderr); assert.equal(JSON.parse(done.stdout).status, 'clear');
});
