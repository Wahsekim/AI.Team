// A command that dies holding the lock on the product leaves it to the next command of the same team, and abort waits for
// a command or an after that still runs; before writes its ledger lines before its record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { abortBatch, BATCH_FILE, AFTER_FILE } from '../src/router-worker/batch.mjs';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { ticket, live, changed, engineRun, runBatch, batchOf, edits } from './fixtures/router-worker/review.mjs';

const PROGRESS = 'rw-batch-commits.json';
const moduleOf = name => JSON.stringify(new URL(`../src/router-worker/${name}`, import.meta.url).href);
// Runs `call` of `module` in a process of its own that is killed (SIGKILL) right after it renames a file whose name ends with `killAt`.
const killedAt = (module, call, killAt) => spawnSync(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync; fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith(${JSON.stringify(killAt)})) process.kill(process.pid, 'SIGKILL'); };
syncBuiltinESMExports();
const imported = await import(${moduleOf(module)}); imported.${call};`], { encoding: 'utf8' });
const left = f => { const run = spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'left', '--instance', f.root], { encoding: 'utf8' }); return { status: run.status, out: run.stdout ? JSON.parse(run.stdout) : null, refused: run.stderr ? JSON.parse(run.stderr).errors?.[0] : null }; };
// A process that takes this team's lock as a command and stays alive until killed.
function lockHolder(t, f) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLease } from ${moduleOf('lease.mjs')};
process.stdout.write(JSON.stringify(acquireLease(${JSON.stringify({ teamRoot: f.root, productRoot: f.product, command: true })})) + '\\n'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  return new Promise(done => { let out = ''; child.stdout.on('data', data => { out += data; if (out.endsWith('\n')) { assert.equal(JSON.parse(out).status, 'held', out); done(child); } }); });
}
const stop = async child => { child.kill('SIGKILL'); await once(child, 'exit'); };
const TWO = [ticket('US-01', ['src/list/a.js']), ticket('US-03', ['src/list/b.js'])];

test('a commit killed between two commits leaves its lock; the next commit takes it over, makes only the commit still missing and archives the batch', async t => {
  const f = live(t), { open } = await runBatch(f, TWO, edits(['src/list/a.js', 'src/list/b.js']));
  const died = killedAt('batch-close.mjs', `commitBatch(${JSON.stringify(f.common)})`, PROGRESS);
  assert.equal(died.signal, 'SIGKILL', died.stderr);
  assert.deepEqual(JSON.parse(f.read(PROGRESS)).commits.map(commit => commit.ticket), ['US-01'], 'the first commit was made and recorded');
  assert.equal(readLease({ productRoot: f.product }).lease.commandPid, died.pid, 'the killed commit still holds the lock');
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01', 'US-03']);
  const log = git(f.product, 'log', '--format=%s', `${open.productHead}..HEAD`).trim().split('\n');
  assert.deepEqual(log, ['US-03: Ticket US-03', 'US-01: Ticket US-01'], 'each ticket is committed once');
  assert.ok(existsSync(join(f.root, 'batches', open.runId, 'commit.json'))); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  assert.deepEqual(changed(f), []); assert.equal(readLease({ productRoot: f.product }).status, 'free');
});

test('left killed after it saved a patch leaves its lock; the next left takes it over and finishes', async t => {
  const f = live(t), { open } = await runBatch(f, [ticket('US-01', ['src/list/a.js'])], edits(['src/list/a.js']));
  assert.equal(abortBatch(f.common).errors, undefined);
  const died = killedAt('batch-left.mjs', `saveLeftWork(${JSON.stringify(f.common)})`, '.patch');
  assert.equal(died.signal, 'SIGKILL', died.stderr);
  const patch = `left/${open.runId}/US-01.patch`;
  assert.ok(existsSync(join(f.root, patch))); assert.deepEqual(changed(f), ['src/list/a.js'], 'killed before it took the work out');
  assert.equal(readLease({ productRoot: f.product }).lease.commandPid, died.pid);
  const saved = left(f);
  assert.equal(saved.status, 0, JSON.stringify(saved.refused));
  assert.deepEqual(saved.out.tickets.map(entry => [entry.ticket, entry.state, entry.patch]), [['US-01', 'patch', patch]]);
  assert.deepEqual(changed(f), []); assert.equal(readLease({ productRoot: f.product }).status, 'free');
});

test('abort is refused while a command of this team holds the lock and runs, and names its process; once it is gone abort frees the team', async t => {
  const f = live(t), { open } = await runBatch(f, TWO, edits(['src/list/a.js', 'src/list/b.js']));
  const holder = await lockHolder(t, f), held = readLease({ productRoot: f.product });
  const refused = abortBatch(f.common).errors?.[0];
  assert.match(refused?.reason, new RegExp(`command of this team holds the lock .* still running \\(process ${holder.pid}\\)`));
  assert.ok(existsSync(join(f.root, BATCH_FILE)) && existsSync(join(f.root, AFTER_FILE)), 'the batch is left as it is');
  assert.deepEqual(readLease({ productRoot: f.product }), held);
  await stop(holder);
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.equal(aborted.lockReleased, true);
  assert.ok(existsSync(join(f.root, 'batches', open.runId, 'abandoned.json'))); assert.equal(readLease({ productRoot: f.product }).status, 'free');
});

test('abort is refused while the after that claimed the batch runs; the claim of an after that died is archived, naming the patches it already saved', async t => {
  const f = live(t), { open } = await engineRun(f, TWO, edits(['src/list/a.js', 'src/list/b.js']));
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); t.after(() => sleeper.kill('SIGKILL'));
  writeFileSync(join(f.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: open.runId, claimedAt: new Date().toISOString(), pid: sleeper.pid }));
  assert.match(abortBatch(f.common).errors?.[0]?.reason, new RegExp(`after of this batch is still running \\(process ${sleeper.pid}\\)`));
  assert.equal(readLease({ productRoot: f.product }).lease.digest, open.lease, 'the batch keeps its lock');
  // The after died while it set a ticket's work aside: its patch is on disk, and its records name it nowhere.
  await stop(sleeper);
  const patch = `left/${open.runId}/US-03.patch`;
  mkdirSync(join(f.root, 'left', open.runId), { recursive: true }); writeFileSync(join(f.root, patch), 'saved by the after that died\n');
  const aborted = abortBatch(f.common);
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.equal(aborted.stage, 'batch-archived-without-commit');
  assert.match(aborted.next, new RegExp(`Already saved as patches for this batch.*${patch}`));
  assert.match(f.ledger().split('\n').find(line => line.includes(`BATCH ${open.runId} ARCHIVED WITHOUT COMMIT`)), new RegExp(patch));
});

test('before writes its ledger lines before its record: a record that cannot be written leaves the lines and no batch, and the next before logs them again', async t => {
  const f = live(t), trigger = { id: 'billing', reviewers: ['security'], match: { glob: ['src/billing/**'] } };
  writeFileSync(join(f.root, 'profiles/review.json'), JSON.stringify({ schemaVersion: 1, triggers: [trigger], rules: [], adrs: [] }));
  const first = await runBatch(f, [ticket('US-01', ['src/list/a.js'])], edits(['src/list/a.js']));
  assert.equal(abortBatch(f.common).errors, undefined);
  assert.equal(markNotMetered({ ...f.common, reason: 'not measured in this test', runId: first.open.runId }).errors, undefined);
  git(f.product, 'checkout', '-q', '--', '.'); git(f.product, 'clean', '-qfd');
  writeFileSync(join(f.root, 'profiles/review.json'), JSON.stringify({ schemaVersion: 1, triggers: [], rules: [], adrs: [] }));
  const narrowed = /REVIEW TRIGGERS REMOVED OR NARROWED \(owner spot review\): trigger billing security glob:src\/billing\/\*\*/g;
  const write = fs.writeFileSync;
  fs.writeFileSync = (path, ...rest) => { if (String(path).endsWith(BATCH_FILE)) throw Object.assign(Error('the process died'), { code: 'EDEAD' }); return write(path, ...rest); };
  syncBuiltinESMExports();
  let failed; try { failed = await f.before(batchOf(ticket('US-02', ['src/list/b.js']))); } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.ok(failed.errors, 'the record could not be written');
  assert.equal(f.ledger().match(narrowed)?.length, 1, 'the narrowed list is logged before the record');
  assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(f.state(), 'closed');
  const opened = await f.before(batchOf(ticket('US-02', ['src/list/b.js'])));
  assert.equal(opened.errors, undefined, JSON.stringify(opened.errors));
  assert.equal(f.ledger().match(narrowed)?.length, 2, 'the next before compares with the same archived list and logs it again');
  assert.equal(JSON.parse(readFileSync(join(f.root, BATCH_FILE), 'utf8')).runId, opened.runId);
});
