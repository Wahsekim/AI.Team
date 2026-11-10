import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, symlinkSync, linkSync, renameSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { digest } from '../src/loop/contracts.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { createRetryStore, openRetryStore } from '../src/router-worker/retry-store.mjs';

const supported = Number(process.versions.node.split('.')[0]) >= 24;
const storeTest = (name, fn) => test(name, { timeout: 10000, skip: !supported && 'Node 24+ SQLite capability required' }, fn);
const MODULE = fileURLToPath(new URL('../src/router-worker/retry-store.mjs', import.meta.url));
const rules = loadRetryRules(), ref = id => ({ id, digest: digest(id) });
const admission = { sourceRef: ref('fixture-admission'), gates: Object.fromEntries(
  ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'].map(k => [k, 'clear'])) };
const prepare = { eventId: 'prepare-1', type: 'prepare', assignmentId: 'exec-1', duty: 'exec', planRef: ref('plan-1'),
  candidateRef: ref('baseline'), continuationOf: null, resumeSessionRef: null, divergence: null, admission };
const start = { eventId: 'start-1', type: 'start', assignmentId: 'exec-1', sessionRef: ref('author-session'), callRef: ref('host-call-1'), admission };
const close = { eventId: 'close-1', type: 'close', assignmentId: 'exec-1', outcome: 'candidate', progress: true,
  outcomeKey: 'candidate-produced', candidateRef: ref('candidate-1'), receiptRef: ref('receipt-1') };
const stop = (id = 'stop-1') => ({ eventId: id, type: 'stop', reason: 'operator-stop', evidenceRef: ref(id) });
const options = filename => ({ filename, ticketId: 'US-08', rules });
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-retry-store-'))), filename = join(root, 'ticket.rw-retries.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await createRetryStore(options(filename)); return { root, filename };
}
const append = (store, event) => store.append({ expectedDigest: store.read().journal.digest, event });
async function edit(filename, sql) {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(filename);
  try { db.exec(sql); } finally { db.close(); }
}

storeTest('new store is private, inert, separately versioned and survives close/reopen', async t => {
  const { filename } = await fixture(t);
  let store = await openRetryStore(options(filename));
  const initial = store.read(); assert.equal(initial.storage.eventCount, 0);
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  append(store, prepare); append(store, start); const before = store.read(); store.close();
  store = await openRetryStore(options(filename));
  assert.deepEqual(store.read(), before); assert.equal(store.read().state.started.exec, 1);
  assert.equal(store.read().state.launchable, false); assert.equal(store.read().storage.exclusiveTargetOwner, false);
  assert.ok(!store.read().state.unresolved.includes('durable-journal'));
  assert.ok(store.read().state.unresolved.includes('exclusive-target-owner'));
  assert.ok(store.read().state.unresolved.includes('stable-ticket-store-binding'));
  append(store, close); assert.equal(store.read().state.closes.length, 1); store.close();
  assert.throws(() => store.read(), error => error.code === 'RETRY_STORE_CLOSED');
});

storeTest('rule inputs are captured before asynchronous capability loading', async t => {
  const { root, filename } = await fixture(t), mutable = structuredClone(rules);
  const opening = openRetryStore({ ...options(filename), rules: mutable });
  mutable.sourceDigests['agents/pm.md'] = digest('changed-during-open');
  const store = await opening; assert.equal(store.read().journal.rulesDigest, digest(rules)); store.close();
  const creationRules = structuredClone(rules), created = join(root, 'second.rw-retries.sqlite');
  const creating = createRetryStore({ ...options(created), rules: creationRules });
  creationRules.sourceDigests['agents/pm.md'] = digest('changed-during-create');
  await creating; const reopened = await openRetryStore(options(created));
  assert.equal(reopened.read().journal.rulesDigest, digest(rules)); reopened.close();
});

storeTest('exclusive creation never overwrites existing data or symlinks and cleans staging files', async t => {
  const { root, filename } = await fixture(t), before = readFileSync(filename);
  await assert.rejects(createRetryStore(options(filename)), error => error.code === 'EEXIST');
  assert.deepEqual(readFileSync(filename), before);
  const link = join(root, 'alias.rw-retries.sqlite'); symlinkSync(filename, link);
  await assert.rejects(createRetryStore(options(link)), error => error.code === 'EEXIST');
  await assert.rejects(openRetryStore(options(link)), /regular file/);
  const dangling = join(root, 'dangling.rw-retries.sqlite'); symlinkSync(join(root, 'absent'), dangling);
  await assert.rejects(createRetryStore(options(dangling)), error => error.code === 'EEXIST');
  assert.equal(readdirSync(root).some(name => name.startsWith('.rw-retries-')), false);
});

storeTest('opening missing, unrelated, unsafe, shared or mismatched stores never initializes them', async t => {
  const { root, filename } = await fixture(t);
  await assert.rejects(openRetryStore(options(join(root, 'missing.rw-retries.sqlite'))), error => error.code === 'ENOENT');
  const unrelated = join(root, 'unrelated.rw-retries.sqlite'); writeFileSync(unrelated, 'HUMAN DATA', { mode: 0o600 });
  await assert.rejects(openRetryStore(options(unrelated))); assert.equal(readFileSync(unrelated, 'utf8'), 'HUMAN DATA');
  await assert.rejects(openRetryStore({ ...options(filename), ticketId: 'US-09' }), /binding mismatch/);
  const otherRules = structuredClone(rules); otherRules.sourceDigests['agents/pm.md'] = digest('changed');
  await assert.rejects(openRetryStore({ ...options(filename), rules: otherRules }), /binding mismatch/);
  const hard = join(root, 'hard.rw-retries.sqlite'); linkSync(filename, hard);
  await assert.rejects(openRetryStore(options(filename)), /hard-link/); rmSync(hard);
  chmodSync(filename, 0o644); await assert.rejects(openRetryStore(options(filename)), /permissions/); chmodSync(filename, 0o600);
  await assert.rejects(createRetryStore(options(join(root, 'not-a-retry.db'))), /dedicated/);
});

storeTest('read-only inspection cannot append and leaves a healthy file byte-for-byte unchanged', async t => {
  const { filename } = await fixture(t), before = readFileSync(filename);
  const store = await openRetryStore({ ...options(filename), readOnly: true });
  assert.equal(store.read().storage.readOnly, true);
  assert.throws(() => append(store, prepare), error => error.code === 'RETRY_STORE_READ_ONLY');
  store.close(); assert.deepEqual(readFileSync(filename), before);
});

storeTest('inspection CLI is read-only and never initializes a missing file', async t => {
  const { root, filename } = await fixture(t), before = readFileSync(filename);
  const cli = fileURLToPath(new URL('../scripts/inspect-router-worker-retries.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
  const inspected = run(filename, 'US-08'); assert.equal(inspected.status, 0, inspected.stderr);
  const output = JSON.parse(inspected.stdout);
  assert.equal(output.stage, 'offline-retry-inspection'); assert.equal(output.storage.readOnly, true);
  assert.equal(output.state.launchable, false); assert.deepEqual(readFileSync(filename), before);
  const names = readdirSync(root).sort(), missing = run(join(root, 'missing.rw-retries.sqlite'), 'US-08');
  assert.equal(missing.status, 2); assert.equal(missing.stdout, ''); assert.deepEqual(readdirSync(root).sort(), names);
  const wrong = run(filename, 'US-09'); assert.equal(wrong.status, 2); assert.equal(wrong.stdout, '');
  assert.equal(run(filename).status, 1); assert.deepEqual(readFileSync(filename), before);
});

storeTest('foreign SQLite schema and WAL format are rejected before adopting or migrating them', async t => {
  const { root, filename } = await fixture(t), foreign = join(root, 'foreign.rw-retries.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(foreign); db.exec('CREATE TABLE human_data(value TEXT); INSERT INTO human_data VALUES (\'keep\')'); db.close(); chmodSync(foreign, 0o600);
  const original = readFileSync(foreign); await assert.rejects(openRetryStore(options(foreign)), /schema/);
  assert.deepEqual(readFileSync(foreign), original);
  await edit(filename, 'PRAGMA journal_mode=WAL');
  const wal = readFileSync(filename), names = readdirSync(root).sort();
  await assert.rejects(openRetryStore(options(filename)), /rollback-journal/);
  assert.deepEqual(readFileSync(filename), wal); assert.deepEqual(readdirSync(root).sort(), names);
});

storeTest('same event can recover a lost response using its original version without double counting', async t => {
  const { filename } = await fixture(t), store = await openRetryStore(options(filename)); t.after(() => store.close());
  const firstDigest = store.read().journal.digest;
  const first = store.append({ expectedDigest: firstDigest, event: prepare }); assert.equal(first.applied, true);
  append(store, start);
  const replay = store.append({ expectedDigest: firstDigest, event: prepare });
  assert.equal(replay.applied, false); assert.equal(replay.storage.eventCount, 2); assert.equal(replay.state.started.exec, 1);
  assert.throws(() => store.append({ expectedDigest: firstDigest, event: { ...prepare, planRef: ref('changed') } }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.throws(() => store.append({ expectedDigest: digest('unrelated'), event: prepare }), error => error.code === 'STALE_RETRY_JOURNAL');
});

storeTest('two handles use atomic version checks and rejected transitions leave no event or head update', async t => {
  const { filename } = await fixture(t), a = await openRetryStore(options(filename)), b = await openRetryStore(options(filename));
  t.after(() => { a.close(); b.close(); });
  const old = b.read().journal.digest; append(a, prepare);
  assert.throws(() => b.append({ expectedDigest: old, event: stop() }), error => error.code === 'STALE_RETRY_JOURNAL');
  const before = a.read(); assert.throws(() => append(b, close), /bound started session/);
  assert.deepEqual(a.read(), before); append(b, start); assert.equal(a.read().state.started.exec, 1);
});

storeTest('reopening started/unknown work never resets counters or makes redispatch eligible', async t => {
  const { filename } = await fixture(t); let store = await openRetryStore(options(filename));
  append(store, prepare); append(store, start); store.close();
  store = await openRetryStore(options(filename));
  assert.throws(() => append(store, { ...prepare, eventId: 'new', assignmentId: 'new' }), error => error.code === 'RETRY_PENDING');
  append(store, { eventId: 'unknown', type: 'unknown', assignmentId: 'exec-1', reasonRef: ref('lost-process') }); store.close();
  store = await openRetryStore(options(filename)); t.after(() => store.close());
  assert.equal(store.read().state.started.exec, 1); assert.deepEqual(store.read().state.stops, ['unknown-execution']);
  append(store, close); assert.deepEqual(store.read().state.stops, ['unknown-execution']);
  assert.throws(() => append(store, { ...prepare, eventId: 'new', assignmentId: 'new' }), error => error.code === 'RETRY_STOPPED');
});

for (const [name, sql] of [
  ['body edit', `UPDATE rw_events SET body='{}' WHERE seq=1`],
  ['event digest edit', `UPDATE rw_events SET event_digest='invalid' WHERE seq=1`],
  ['prefix chain edit', `UPDATE rw_events SET previous_digest='invalid' WHERE seq=2`],
  ['missing event', `DELETE FROM rw_events WHERE seq=1`],
  ['head edit', `UPDATE rw_metadata SET head_digest='invalid'`],
  ['schema version edit', `UPDATE rw_metadata SET version=2`],
  ['extra trigger', `CREATE TRIGGER extra AFTER INSERT ON rw_events BEGIN DELETE FROM rw_events WHERE seq=1; END`],
]) storeTest(`corrupt history is refused without automatic repair: ${name}`, async t => {
  const { filename } = await fixture(t), store = await openRetryStore(options(filename));
  append(store, prepare); append(store, start); store.close(); await edit(filename, sql);
  const corrupted = readFileSync(filename);
  await assert.rejects(openRetryStore(options(filename)));
  assert.deepEqual(readFileSync(filename), corrupted);
});

storeTest('open handles detect path replacement and unsafe SQLite sidecars before writing', async t => {
  const { filename } = await fixture(t), store = await openRetryStore(options(filename)); t.after(() => store.close());
  symlinkSync(filename, filename + '-journal');
  assert.throws(() => append(store, prepare), /sidecar/); rmSync(filename + '-journal');
  renameSync(filename, filename + '.old'); await createRetryStore(options(filename));
  const fresh = readFileSync(filename);
  assert.throws(() => append(store, prepare), error => error.code === 'RETRY_STORE_REPLACED');
  assert.deepEqual(readFileSync(filename), fresh);
});

storeTest('two real processes racing the same version cannot both append different events', async t => {
  const { filename } = await fixture(t), store = await openRetryStore(options(filename)), expectedDigest = store.read().journal.digest; store.close();
  const code = `import {openRetryStore} from ${JSON.stringify(MODULE)};
    const [config, digest, event] = process.argv.slice(1).map(JSON.parse);
    const s=await openRetryStore(config); console.log('ready');
    process.stdin.once('data',()=>{try{const r=s.append({expectedDigest:digest,event});console.log(r.applied?'applied':'replay');}
    catch(e){console.log(e.code)}finally{s.close();}});`;
  const children = [1, 2].map(n => spawn(process.execPath, ['--input-type=module', '-e', code,
    JSON.stringify(options(filename)), JSON.stringify(expectedDigest), JSON.stringify(stop(`race-${n}`))], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); }));
  const outputs = ['', ''];
  await Promise.all(children.map((child, i) => new Promise((resolve, reject) => {
    child.stdout.on('data', data => { outputs[i] += data; if (outputs[i].includes('ready\n')) resolve(); });
    child.once('error', reject); child.once('exit', () => { if (!outputs[i].includes('ready\n')) reject(Error('Child exited before ready')); });
  })));
  const exits = children.map(child => once(child, 'exit')); children.forEach(child => child.stdin.end('go'));
  await Promise.all(exits);
  assert.equal(outputs.filter(text => text.includes('applied')).length, 1);
  assert.equal(outputs.filter(text => text.includes('STALE_RETRY_JOURNAL')).length, 1);
  const reopened = await openRetryStore(options(filename)); assert.equal(reopened.read().storage.eventCount, 1); reopened.close();
});

storeTest('a killed writer with an uncommitted SQLite transaction cannot leave a partial event', async t => {
  const { filename } = await fixture(t);
  const code = `import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);
    d.exec("BEGIN IMMEDIATE;UPDATE rw_metadata SET head_digest='partial',event_count=1");console.log('transaction-open');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, filename], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(Error('Child exited before transaction'))); });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const store = await openRetryStore(options(filename)); assert.equal(store.read().storage.eventCount, 0);
  append(store, prepare); assert.equal(store.read().storage.eventCount, 1); store.close();
});

storeTest('a committed start survives writer death and replay of its lost response cannot start another call', async t => {
  const { filename } = await fixture(t);
  const code = `import {openRetryStore} from ${JSON.stringify(MODULE)};
    const [config,prepare,start]=process.argv.slice(1).map(JSON.parse);const s=await openRetryStore(config);
    s.append({expectedDigest:s.read().journal.digest,event:prepare});const beforeStart=s.read().journal.digest;
    s.append({expectedDigest:beforeStart,event:start});console.log(JSON.stringify({beforeStart}));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options(filename)), JSON.stringify(prepare), JSON.stringify(start)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const result = await new Promise((resolve, reject) => {
    let output = ''; child.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) resolve(JSON.parse(output.trim())); });
    child.once('error', reject); child.once('exit', () => reject(Error('Child exited before committed start')));
  });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const store = await openRetryStore(options(filename)); t.after(() => store.close());
  assert.equal(store.read().state.started.exec, 1);
  const replay = store.append({ expectedDigest: result.beforeStart, event: start });
  assert.equal(replay.applied, false); assert.equal(replay.storage.eventCount, 2);
  assert.equal(replay.state.assignments[0].status, 'started');
  assert.throws(() => append(store, { ...prepare, eventId: 'second-call', assignmentId: 'second-call' }), error => error.code === 'RETRY_PENDING');
});

test('unsupported Node versions refuse persistence rather than silently falling back', { skip: supported && 'Runs only on Node < 24' }, async () => {
  await assert.rejects(createRetryStore(options('/nonexistent/ticket.rw-retries.sqlite')), error => error.code === 'CAPABILITY_MISSING');
});
