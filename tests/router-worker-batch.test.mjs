// ADR 0010, decisions 8 to 12: the command a PM runs before a batch in a standing Router/Worker team.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeBatch, BATCH_FILE } from '../src/router-worker/batch.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
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
  assert.match(refusal(await f.before(batchOf(ticket('US-03', ['src/x.js'])))).reason, /already open/);
});

test('before refuses, and leaves the lock free and the boundary closed, when the batch or the repository is not fit', async t => {
  const f = live(t), refused = async (batch, pattern, extra) => { const result = await f.before(batch, extra); assert.match(refusal(result)?.reason ?? JSON.stringify(result).slice(0, 200), pattern); f.untouched(); };
  await refused(batchOf(ticket('US-01', ['src/a.js']), ticket('US-02', ['src/a.js'])), /US-01 and US-02 claim the same file \(src\/a\.js\)/);
  await refused(batchOf(ticket('US-01', ['src/list/**']), ticket('US-02', ['src/list/view.js'])), /claim the same file/);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { acceptance: [] })), /US-01 is incomplete: acceptance missing/);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { goal: undefined })), /incomplete: goal/);
  await refused({ ...batchOf(ticket('US-01', ['src/a.js'])), budgetCeilingTokens: 999999 }, /must carry/, undefined);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { estimate: { execTokens: 150000, checkTokens: 60000, reworkTokens: 6000 } })), /cannot be frozen.*estimate/i);
  await refused(batchOf(ticket('US-01', ['src/auth/login.js'])), /cannot be frozen/, undefined);
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
  const record = await f.before(batchOf(ticket('US-01', ['src/a.js'])), { startAsIs: true });
  assert.equal(record.errors, undefined, JSON.stringify(record.errors)); assert.equal(record.startedAsIs, true); assert.deepEqual(record.preexisting, ['notes.txt']);
  assert.match(f.read('pm-decisions.md'), /BATCH \S+ STARTED AS IS: 1 path\(s\) were already changed.*notes\.txt/);
});

test('CLI: before prints the batch record with the preflight manifest chained into the arguments; exit 0 open, 2 refused, 1 usage', t => {
  const f = live(t), file = join(f.base, 'batch.json'), run = (...argv) => spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify(batchOf(ticket('US-01', ['src/a.js']))));
  assert.equal(run('before').status, 1); assert.equal(run('before', file, '--instance', f.root, '--bogus').status, 1); assert.equal(run('after', file, '--instance', f.root).status, 1);
  const done = run('before', file, '--instance', f.root);
  assert.equal(done.status, 0, done.stdout + done.stderr); const record = JSON.parse(done.stdout);
  assert.equal(record.stage, 'batch-open'); assert.equal(record.launchManifest, 'chained'); assert.match(record.args.launchManifestDigest, /^sha256:[a-f0-9]{64}$/);
  const again = run('before', file, '--instance', f.root);
  assert.equal(again.status, 2); assert.match(again.stderr, /already open/);
  assert.equal(run('before', join(f.base, 'absent.json'), '--instance', f.root).status, 2);
});
