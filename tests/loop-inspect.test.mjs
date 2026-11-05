import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesDigest, canonical, digest, specDigest } from '../src/loop/contracts.mjs';
import { command, demoBundle, driveDemo } from '../src/loop/demo.mjs';
import { openStore, openStoreReadOnly } from '../src/loop/store.mjs';
import { LOCK_FILE } from '../src/loop/execution-owner.mjs';
import { publishProjection } from '../src/loop/projector.mjs';
import { snapshotRepository } from '../src/loop/snapshots.mjs';
import { gateDigest } from '../src/loop/gates.mjs';

// R05a. Child hosts self-exit within 10 s (driver-crash-host) or 8 s (execution-owner-host); fixture workers within 5 s.
const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Inspection tests require Node 24+ (node:sqlite)' : false, timeout: 30000 };
const cli = fileURLToPath(new URL('../scripts/team-run.mjs', import.meta.url));
const crashHost = fileURLToPath(new URL('./fixtures/driver-crash-host.mjs', import.meta.url));
const ownerHost = fileURLToPath(new URL('./fixtures/execution-owner-host.mjs', import.meta.url));
const env = { PATH: process.env.PATH ?? '' };
const INSPECTION = ['status', 'events', 'audit', 'show', 'inspect'];
const tick = { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null };

const run = (args, timeout = 10000) => {
  const started = Date.now(), result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout, killSignal: 'SIGKILL', env });
  let json = null; try { json = JSON.parse(result.stdout); } catch { /* show prints text */ }
  return { status: result.status, stdout: result.stdout, json, ms: Date.now() - started };
};
const scratch = t => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'ai-inspect-'))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// Everything inspection could change: each file's bytes, mtime and mode; schema, table list and state version.
async function fingerprint(directory, runId) {
  const files = Object.fromEntries(readdirSync(directory).filter(n => statSync(join(directory, n)).isFile())
    .map(n => [n, { sha: sha(join(directory, n)), mtime: statSync(join(directory, n)).mtimeMs, mode: statSync(join(directory, n)).mode }]));
  const { DatabaseSync } = await import('node:sqlite'), raw = new DatabaseSync(join(directory, 'loop.sqlite'), { readOnly: true });
  try {
    return { files, schemaVersion: raw.prepare('PRAGMA schema_version').get().schema_version,
      tables: raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name),
      stateVersion: raw.prepare('SELECT version FROM runs WHERE id=?').get(runId).version };
  } finally { raw.close(); }
}

// A real product clone and trusted gate, as in loop-driver-crash.test.mjs.
function prepare(directory, request) {
  const root = join(directory, 'product');
  mkdirSync(root); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/check.cjs'), "process.stdout.write('gate ok');");
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const oracle = [{ path: 'src/check.cjs', digest: bytesDigest(readFileSync(join(root, 'src/check.cjs'))) }];
  const gate = { id: 'test', repoId: 'product', executableRef: { id: 'node', digest: bytesDigest(readFileSync(process.execPath)) },
    argv: ['check.cjs'], cwd: { repoId: 'product', relativePath: 'src' }, envProfileId: 'empty', timeoutMs: 1000,
    successExitCodes: [0], oracleBundleRef: { id: 'oracle', digest: digest(oracle) }, networkPolicyId: 'local-attended-inherit' };
  gate.specDigest = gateDigest(gate);
  const { spec, artifacts } = demoBundle('run', { schemaVersion: 2 });
  artifacts.snapshot = snapshotRepository({ root }); artifacts.gate = gate;
  artifacts.manifest.gates[0].artifactRef.digest = digest(gate);
  spec.manifestRef.digest = digest(artifacts.manifest); spec.initialSnapshotRef.digest = digest(artifacts.snapshot); spec.approvedSpecDigest = specDigest(spec);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ root, gate, oracle, request }));
  return { spec, artifacts };
}
async function createRun(directory, bundle) {
  const store = await openStore(join(directory, 'loop.sqlite'));
  try { store.create(bundle.spec, bundle.artifacts, { simulation: true }); } finally { store.close(); }
}

// A line-oriented child host; teardown signals only this handle, never a saved PID.
function startHost(t, args) {
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const events = [], waiters = []; let buffer = '', stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  child.stdout.on('data', bytes => {
    buffer += bytes;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) { events.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
    for (const w of [...waiters]) w();
  });
  const next = (predicate, ms = 8000) => new Promise((resolve, reject) => {
    const check = () => { const event = events.find(predicate); if (event) { done(); resolve(event); } };
    const timer = setTimeout(() => { done(); reject(new Error(`host did not report in ${ms} ms: ${stderr}`)); }, ms);
    const done = () => { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); };
    waiters.push(check); check();
  });
  return { child, exited, next, events };
}
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function assertGroupsGone(pids, ms = 7000) {
  const deadline = Date.now() + ms;
  for (const pid of pids) while (groupAlive(pid)) {
    assert.ok(Date.now() < deadline, `orphan process group ${pid} outlived its ${ms} ms bound`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('I1: a missing control store is STORE_MISSING for every inspection command and stop; nothing is created', sqlite, async t => {
  const parent = scratch(t), empty = join(parent, 'empty'), absent = join(parent, 'absent');
  mkdirSync(empty);
  for (const args of [...INSPECTION.map(a => [a]), ['stop'], ['stop', '--hard']]) {
    for (const directory of [empty, absent]) {
      const result = run([args[0], directory, 'run', ...args.slice(1)]);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}`);
      assert.equal(JSON.parse(result.stdout).code, 'STORE_MISSING', args.join(' '));
    }
    assert.deepEqual(readdirSync(empty), [], `${args.join(' ')} created no file, -journal or -wal`);
    assert.equal(existsSync(absent), false, `${args.join(' ')} created no directory`);
  }
  await assert.rejects(openStoreReadOnly(join(empty, 'loop.sqlite')), e => e.code === 'STORE_MISSING');
  await assert.rejects(openStore(join(empty, 'loop.sqlite'), { create: false }), e => e.code === 'STORE_MISSING');
  assert.deepEqual(readdirSync(empty), []);
});

test('I2: inspection twice leaves bytes, mtimes, modes, schema, state version and the lock database unchanged', sqlite, async t => {
  const parent = scratch(t), directory = join(parent, 'fx');
  assert.equal(run(['fixture', directory, 'run'], 20000).status, 0);
  // A mode other than 0600 makes a chmod visible.
  chmodSync(join(directory, 'loop.sqlite'), 0o640);
  // A store without `executions` and without `requests`: any CREATE TABLE IF NOT EXISTS would change its schema.
  const bare = join(parent, 'bare'); mkdirSync(bare);
  const store = await openStore(join(bare, 'loop.sqlite'));
  try { const { spec, artifacts } = demoBundle('run'); store.create(spec, artifacts, { simulation: true }); store.apply('tick', command(store, 'run', tick)); } finally { store.close(); }
  const { DatabaseSync } = await import('node:sqlite'), raw = new DatabaseSync(join(bare, 'loop.sqlite'));
  try { raw.exec('DROP TABLE requests'); } finally { raw.close(); }
  chmodSync(join(bare, 'loop.sqlite'), 0o640);
  for (const target of [directory, bare]) {
    const before = await fingerprint(target, 'run');
    for (let round = 0; round < 2; round++) {
      for (const action of INSPECTION) assert.equal(run([action, target, 'run']).status, 0, `${action} on ${target}`);
    }
    assert.deepEqual(await fingerprint(target, 'run'), before, target);
  }
  const bareAfter = await fingerprint(bare, 'run');
  assert.equal(bareAfter.tables.includes('executions'), false, 'no marker table is created');
  assert.equal(bareAfter.tables.includes('requests'), false, 'no DDL ran');
  assert.ok((await fingerprint(directory, 'run')).files[LOCK_FILE], 'the fixture lock database exists and was compared');
});

test('I3: inspection succeeds while another process holds the execution and drives a step; the lock stays held', { ...sqlite, timeout: 40000 }, async t => {
  const directory = scratch(t), bundle = prepare(directory, { scenario: 'pass', delayMs: 300, timeoutMs: 2000 });
  await createRun(directory, bundle);
  const host = startHost(t, [ownerHost, 'drive', directory]);
  const lock = join(directory, LOCK_FILE);
  // Mid-step: the build worker was spawned and the step awaits it.
  await host.next(e => e.source === 'adapter' && e.phase === 'spawned-before-pid-save');
  const during = run(['inspect', directory, 'run']);
  assert.equal(during.status, 0, during.stdout); assert.ok(during.ms < 2000, `inspect took ${during.ms} ms`);
  assert.equal(during.json.value.marker.open, true);
  assert.ok(['STARTED', 'ACKNOWLEDGED'].includes(during.json.value.dispatches[0].status));
  const paused = await host.next(e => e.paused);
  const lockBefore = { bytes: readFileSync(lock), mtime: statSync(lock).mtimeMs };
  for (const action of INSPECTION) {
    const result = run([action, directory, 'run']);
    assert.equal(result.status, 0, `${action}: ${result.stdout}`); assert.ok(result.ms < 2000, `${action} took ${result.ms} ms`);
  }
  const inspected = run(['inspect', directory, 'run']).json.value;
  assert.equal(inspected.marker.ownerId, paused.ownerId); assert.equal(inspected.marker.lockFile.read, false);
  assert.equal(inspected.marker.lockFile.matchesMarkerLockIno, true);
  assert.deepEqual(readFileSync(lock), lockBefore.bytes); assert.equal(statSync(lock).mtimeMs, lockBefore.mtime);
  // The holder's lock is intact: a third process is still refused at once.
  const third = JSON.parse(execFileSync(process.execPath, [ownerHost, 'try', join(directory, 'loop.sqlite')], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env }));
  assert.equal(third.acquire.code, 'EXECUTION_OWNER_ACTIVE');
  host.child.stdin.end('go\n');
  const done = await host.next(e => e.done);
  assert.equal(done.status, 'COMPLETED'); assert.deepEqual(done.released, { markerClosed: true });
  assert.equal((await host.exited).code, 0);
});

async function killedHost(t, boundary, request) {
  const directory = scratch(t), bundle = prepare(directory, request);
  await createRun(directory, bundle);
  const host = startHost(t, [crashHost, directory, boundary]);
  await host.next(e => e.paused);
  host.child.kill('SIGKILL'); assert.equal((await host.exited).signal, 'SIGKILL');
  const pids = host.events.filter(e => e.source === 'adapter' && e.phase === 'spawned-before-pid-save').map(e => e.pid);
  return { directory, pids, ownerId: host.events.find(e => e.source === 'owner').ownerId };
}

test('I4a: after a SIGKILLed host, inspect shows the unknown dispatch, its saved PID without authority, the open marker and suggestions', sqlite, async t => {
  const k = await killedHost(t, 'process-before-receipt', { scenario: 'pass', delayMs: 0, timeoutMs: 1000 });
  await assertGroupsGone(k.pids);
  const before = await fingerprint(k.directory, 'run');
  const result = run(['inspect', k.directory, 'run']); assert.equal(result.status, 0, result.stdout);
  const v = result.json.value, d1 = v.dispatches.find(d => d.id === 'd-1');
  assert.equal(v.readOnly, true); assert.equal(v.eventChain.verified, true);
  assert.equal(d1.status, 'STARTED'); assert.equal(d1.settled, false); assert.match(d1.effect, /^unknown/);
  assert.equal(d1.savedPid.value, k.pids[0]); assert.strictEqual(d1.savedPid.pidAuthority, false);
  assert.equal(d1.receipt.present, false); assert.equal(d1.receipt.durable, false);
  assert.equal(d1.settle.possible, false);
  assert.deepEqual(v.unresolved, { dispatches: ['d-1'], projection: null, recoveryRequired: false, markerOpen: true });
  assert.equal(v.marker.ownerId, k.ownerId); assert.strictEqual(v.marker.pid.pidAuthority, false); assert.equal(v.marker.openedAt.informational, true);
  assert.deepEqual(v.recoverySteps.map(s => s.action), ['abandon', 'close-execution-marker']);
  assert.ok(v.recoverySteps.every(s => s.automatic === false && s.availableIn === 'R05b'));
  assert.deepEqual(v.recoverySteps[0].dispatchIds, ['d-1']);
  // Unknown spend is never reported as known zero.
  assert.equal(v.usage.tokens.status, 'partial'); assert.deepEqual(v.usage.tokens.missing, ['d-1']);
  const show = run(['show', k.directory, 'run']).stdout;
  assert.match(show, /^unresolved effects:$/m); assert.match(show, /^d-1 build STARTED {2}no receipt {2}saved pid \d+ \(no authority\)$/m);
  assert.match(show, /^execution marker open · owner /m); assert.match(show, /^suggested \(R05b, not automatic\): abandon · close-execution-marker$/m);
  assert.deepEqual(await fingerprint(k.directory, 'run'), before, 'inspection after a crash changed nothing');
});

test('I4d: when receipt presence is unknown (journal absent or unreadable), abandon is never suggested', sqlite, async t => {
  const k = await killedHost(t, 'process-before-receipt', { scenario: 'pass', delayMs: 0, timeoutMs: 1000 });
  await assertGroupsGone(k.pids);
  const journal = join(k.directory, 'fixture.sqlite'), saved = readFileSync(journal);
  for (const [label, prepareJournal] of [['absent', () => rmSync(journal)], ['unreadable', () => writeFileSync(journal, Buffer.from('not a database '.repeat(64)))]]) {
    prepareJournal();
    const v = run(['inspect', k.directory, 'run']).json.value, d1 = v.dispatches.find(d => d.id === 'd-1');
    assert.equal(d1.receipt.present, null, label); assert.equal(v.journals.fixture, label);
    assert.deepEqual(v.recoverySteps.map(s => [s.action, s.dispatchIds ?? null]), [['receipt-unknown', ['d-1']], ['close-execution-marker', null]], label);
    assert.match(v.recoverySteps[0].requires, /before any abandon/);
    assert.match(run(['show', k.directory, 'run']).stdout, /^suggested \(R05b, not automatic\): receipt-unknown · close-execution-marker$/m, label);
  }
  writeFileSync(journal, saved);
  assert.deepEqual(run(['inspect', k.directory, 'run']).json.value.recoverySteps.map(s => s.action), ['abandon', 'close-execution-marker'], 'readable journal without a result');
});

test('I4b: a durable receipt left by a killed host is reported as ingestible, as a suggestion only', sqlite, async t => {
  const k = await killedHost(t, 'receipt-before-settle', { scenario: 'pass', delayMs: 0, timeoutMs: 1000 });
  await assertGroupsGone(k.pids);
  const v = run(['inspect', k.directory, 'run']).json.value, d1 = v.dispatches.find(d => d.id === 'd-1');
  assert.equal(d1.receipt.durable, true); assert.equal(d1.receipt.integrity, 'ok'); assert.equal(d1.receipt.result, 'pass');
  assert.equal(d1.settle.possible, true); assert.match(d1.settle.notEvaluated, /host re-checks/);
  assert.deepEqual(v.recoverySteps.map(s => [s.action, s.dispatchId ?? null]), [['ingest-receipt', 'd-1'], ['close-execution-marker', null]]);
  assert.equal(v.status, 'RUNNING', 'inspection did not settle or interrupt anything');
});

test('I4c: a normal completion has nothing unresolved; a hard stop shows the dropped projection, stop view and unknown usage', sqlite, async t => {
  const parent = scratch(t), done = join(parent, 'done');
  assert.equal(run(['fixture', done, 'run'], 20000).status, 0);
  const complete = run(['inspect', done, 'run']).json.value;
  assert.deepEqual(complete.unresolved, { dispatches: [], projection: null, recoveryRequired: false, markerOpen: false });
  assert.deepEqual(complete.recoverySteps, []); assert.equal(complete.usage.tokens.status, 'known');
  assert.deepEqual(complete.projections.map(p => [p.disposition, p.publishedFile]), [['acknowledged', 'present, matches']]);
  assert.match(run(['show', done, 'run']).stdout, /^unresolved effects: none$/m);

  const stopped = join(parent, 'stopped'); mkdirSync(stopped);
  const store = await openStore(join(stopped, 'loop.sqlite'));
  t.after(() => store.close());
  const { spec, artifacts } = demoBundle('run'); store.create(spec, artifacts, { simulation: true });
  // Drive the demo to its closing projection, publish it, then hard-stop before its acknowledgement.
  const atProjection = new Error('at projection');
  const halting = { ...store, apply(action, cmd, now) { if (action === 'claim' && cmd.payload.effectId.startsWith('projection-')) throw atProjection; return store.apply(action, cmd, now); } };
  assert.throws(() => driveDemo(halting, 'run'), e => e === atProjection);
  const effect = store.effects('run').find(e => e.kind === 'projection');
  publishProjection({ directory: stopped, runId: 'run', effect: { id: effect.id, kind: effect.kind, payload: effect.payload } });
  assert.equal(store.requestStop('run', { kind: 'hard', requestedBy: 'cli' }).recorded, true);
  let v = run(['inspect', stopped, 'run']).json.value;
  assert.equal(v.status, 'RECOVERY_REQUIRED');
  assert.deepEqual(v.projections.map(p => [p.id, p.outboxStatus, p.disposition, p.publishedFile]), [[effect.id, 'DROPPED', 'dropped', 'present, matches']]);
  assert.equal(v.stop.record.kind, 'hard'); assert.equal(v.stop.view.cancellation, 'unconfirmed'); assert.equal(v.stop.view.observed, false);
  assert.deepEqual(v.recoverySteps.map(s => s.action), ['abandon']); assert.equal(v.marker.table, 'absent or empty');
  // The existing reducer abandon (R05b wires it) makes spend unknown; inspection must say so, never 0.
  store.apply('abandon', command(store, 'run', { confirmedProcessesExited: true }));
  v = run(['inspect', stopped, 'run']).json.value;
  assert.deepEqual(v.usage.tokens, { status: 'unknown', recorded: null }); assert.deepEqual(v.usage.costMicroUsd, { status: 'unknown', recorded: null });
  assert.match(run(['show', stopped, 'run']).stdout, /^usage tokens unknown$/m);
});

// Writes a stop event exactly as the pre-R04a code did (same as loop-stop-record.test.mjs S9).
async function writeLegacyStop(file, runId, now) {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(file);
  try {
    const r = db.prepare('SELECT state, version FROM runs WHERE id=?').get(runId), s = JSON.parse(r.state);
    s.lastAt = now; s.reason = 'user_stop'; s.status = 'QUIESCING';
    for (const d of Object.values(s.dispatches)) if (!d.receipt && d.status === 'PENDING') { d.status = 'ACKNOWLEDGED'; d.receipt = { result: 'cancelled', tokens: 0, costMicroUsd: 0 }; }
    s.stopRequest = { mode: 'graceful', detail: 'CLI operator stop' };
    const version = r.version + 1, payload = { mode: 'graceful', reason: 'CLI operator stop' };
    const previous = db.prepare('SELECT digest FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(runId).digest;
    const event = { runId, seq: version, action: 'stop', payload, stateDigest: digest(s), at: now, previousDigest: previous };
    db.prepare('UPDATE runs SET state=?, version=? WHERE id=?').run(canonical(s), version, runId);
    for (const d of Object.values(s.dispatches)) db.prepare('UPDATE outbox SET status=? WHERE run_id=? AND id=?').run(d.status, runId, d.id);
    db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(runId, version, canonical(event), digest(event));
  } finally { db.close(); }
}

test('I5: a store without a marker table and with a legacy stop event inspects cleanly', sqlite, async t => {
  const directory = scratch(t), file = join(directory, 'loop.sqlite'), store = await openStore(file);
  try { const { spec, artifacts } = demoBundle('run'); store.create(spec, artifacts, { simulation: true }); store.apply('tick', command(store, 'run', tick)); }
  finally { store.close(); }
  await writeLegacyStop(file, 'run', Date.now() + 1);
  const before = await fingerprint(directory, 'run');
  const result = run(['inspect', directory, 'run']); assert.equal(result.status, 0, result.stdout);
  const v = result.json.value;
  assert.equal(v.eventChain.verified, true); assert.deepEqual(v.stop.record, { mode: 'graceful', detail: 'CLI operator stop' });
  assert.equal(v.stop.view.kind, 'graceful'); assert.equal(v.marker.open, false); assert.equal(v.marker.history, 0);
  assert.equal(v.marker.lockFile.present, false); assert.deepEqual(v.journals, { fixture: 'absent', evidence: 'absent' });
  assert.equal(v.dispatches[0].receipt.present, null, 'an absent journal is unknown, not "no receipt"');
  assert.match(run(['show', directory, 'run']).stdout, /^stop graceful · legacy record$/m);
  assert.deepEqual(await fingerprint(directory, 'run'), before);
  assert.equal(before.tables.includes('executions'), false);
});

test('I6: a corrupt, empty, foreign or unreadable file is a clear error and is left untouched', sqlite, async t => {
  const directory = scratch(t), file = join(directory, 'loop.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const foreign = join(directory, 'foreign.sqlite'), db = new DatabaseSync(foreign); db.exec('CREATE TABLE other(a)'); db.close();
  const cases = [['corrupt', Buffer.from('not a database '.repeat(64))], ['empty', Buffer.alloc(0)], ['foreign', readFileSync(foreign)]];
  for (const [label, bytes] of cases) {
    writeFileSync(file, bytes); chmodSync(file, 0o640);
    for (const action of [...INSPECTION, 'stop']) {
      const result = run([action, directory, 'run']);
      assert.equal(result.status, 2, `${label} ${action}: ${result.stdout}`); assert.equal(result.json.code, 'STORE_UNREADABLE', `${label} ${action}`);
      assert.deepEqual(readFileSync(file), bytes, `${label} ${action} left the bytes`);
      assert.equal(statSync(file).mode & 0o777, 0o640, `${label} ${action} left the mode`);
    }
    assert.deepEqual(readdirSync(directory).sort(), ['foreign.sqlite', 'loop.sqlite'], `${label}: no journal or other file`);
  }
  if (process.getuid?.() !== 0) {
    const store = await openStore(file.replace('loop.sqlite', 'real.sqlite')); store.close();
    renameSync(join(directory, 'real.sqlite'), file); chmodSync(file, 0o000);
    const result = run(['inspect', directory, 'run']);
    assert.equal(result.status, 2); assert.equal(result.json.code, 'STORE_UNREADABLE');
    assert.equal(statSync(file).mode & 0o777, 0o000);
  }
});

test('I7: read-only and writing stores agree on status, events, effects and replay for the same store', sqlite, async t => {
  const parent = scratch(t), directory = join(parent, 'fx');
  assert.equal(run(['fixture', directory, 'run'], 20000).status, 0);
  const file = join(directory, 'loop.sqlite'), reader = await openStoreReadOnly(file);
  t.after(() => reader.close());
  const expected = await (async () => { const w = await openStore(file); try { return [w.status('run'), w.events('run', -1, 1000), w.effects('run'), w.verify('run'), w.executions()]; } finally { w.close(); } })();
  assert.deepEqual([reader.status('run'), reader.events('run', -1, 1000), reader.effects('run'), reader.verify('run'), reader.executions()], expected);
  assert.equal(typeof reader.apply, 'undefined'); assert.equal(typeof reader.requestStop, 'undefined'); assert.equal(typeof reader.openExecution, 'undefined');
  assert.deepEqual(run(['audit', directory, 'run']).json.value, expected[3]);
});

// ADR 0002 P3 / probe L2: inspection only lstats the lock file. A FIFO there blocks any open, so an open would hang.
test('I8: inspection never opens the lock file (a FIFO in its place does not block)', { ...sqlite, timeout: 5000 }, async t => {
  const directory = scratch(t), store = await openStore(join(directory, 'loop.sqlite'));
  try { const { spec, artifacts } = demoBundle('run'); store.create(spec, artifacts, { simulation: true }); } finally { store.close(); }
  execFileSync('mkfifo', [join(directory, LOCK_FILE)]);
  t.after(() => rmSync(join(directory, LOCK_FILE), { force: true }));
  for (const action of ['inspect', 'status', 'show']) {
    const result = run([action, directory, 'run'], 1500);
    assert.equal(result.status, 0, `${action} blocked or failed: ${result.stdout}`); assert.ok(result.ms < 1500, `${action} took ${result.ms} ms`);
  }
  const lockFile = run(['inspect', directory, 'run'], 1500).json.value.marker.lockFile;
  assert.equal(lockFile.present, true); assert.equal(lockFile.regularFile, false); assert.equal(lockFile.read, false);
  assert.ok(statSync(join(directory, LOCK_FILE)).isFIFO());
});
