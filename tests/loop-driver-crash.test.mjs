import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesDigest, digest, specDigest } from '../src/loop/contracts.mjs';
import { demoBundle } from '../src/loop/demo.mjs';
import { openStore } from '../src/loop/store.mjs';
import { openEvidenceArchive } from '../src/loop/evidence.mjs';
import { snapshotRepository } from '../src/loop/snapshots.mjs';
import { gateDigest } from '../src/loop/gates.mjs';
import { settleRecordedGate } from '../src/loop/host-gates.mjs';
import { settleRecordedFixture } from '../src/loop/host-fixtures.mjs';
import { openFixtureAdapter } from '../src/loop/adapters/fixture-process.mjs';
import { createFixtureDriver } from '../src/loop/fixture-driver.mjs';
import { acquireExecutionOwner, closeOrphanedExecution } from '../src/loop/execution-owner.mjs';
import { projectionContent } from '../src/loop/projector.mjs';

// Lifetime bounds: host self-exits after HOST_PAUSE_MS if never killed; fixture workers
// self-exit within 5 s (adapters/fixture-worker.mjs); gates exit immediately.
const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Driver crash tests require Node 24+ (node:sqlite)' : false, timeout: 15000 };
const hostScript = fileURLToPath(new URL('./fixtures/driver-crash-host.mjs', import.meta.url));
const REACH_MS = 8000, ORPHAN_MS = 6000, REPS = 5;
const runId = 'run';

function prepare(t, request) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-driver-crash-'))), root = join(directory, 'product');
  const marker = join(directory, 'gate-spawns.log');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(root); mkdirSync(join(root, 'src'));
  // The gate counts its own real spawns outside the product snapshot, then exits.
  writeFileSync(join(root, 'src/check.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n'); process.stdout.write('gate ok');`);
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const oracle = [{ path: 'src/check.cjs', digest: bytesDigest(readFileSync(join(root, 'src/check.cjs'))) }];
  const gate = { id: 'test', repoId: 'product', executableRef: { id: 'node', digest: bytesDigest(readFileSync(process.execPath)) },
    argv: ['check.cjs'], cwd: { repoId: 'product', relativePath: 'src' }, envProfileId: 'empty', timeoutMs: 1000,
    successExitCodes: [0], oracleBundleRef: { id: 'oracle', digest: digest(oracle) }, networkPolicyId: 'local-attended-inherit' };
  gate.specDigest = gateDigest(gate);
  const { spec, artifacts } = demoBundle(runId, { schemaVersion: 2 });
  artifacts.snapshot = snapshotRepository({ root }); artifacts.gate = gate;
  artifacts.manifest.gates[0].artifactRef.digest = digest(gate);
  spec.manifestRef.digest = digest(artifacts.manifest); spec.initialSnapshotRef.digest = digest(artifacts.snapshot); spec.approvedSpecDigest = specDigest(spec);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ root, gate, oracle, request }));
  return { directory, root, marker, gate, oracle, spec, artifacts };
}

const gateSpawns = f => existsSync(f.marker) ? readFileSync(f.marker, 'utf8').split('\n').filter(Boolean).map(Number) : [];
const buildSpawns = trace => trace.filter(e => e.source === 'adapter' && e.phase === 'spawned-before-pid-save');
// Probe only (signal 0), never delivery. PIDs come from the live host trace or the
// gate's own marker, never from the store/journal. PID reuse could cause a false "alive".
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function assertGroupsGone(pids, ms = ORPHAN_MS) {
  const deadline = Date.now() + ms;
  for (const pid of pids) {
    while (groupAlive(pid)) {
      assert.ok(Date.now() < deadline, `orphan process group ${pid} outlived its ${ms} ms bound`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

async function killAtBoundary(t, boundary, request = { scenario: 'pass', delayMs: 0, timeoutMs: 1000 }) {
  const f = prepare(t, request);
  const store = await openStore(join(f.directory, 'loop.sqlite'));
  try { store.create(f.spec, f.artifacts, { simulation: true }); } finally { store.close(); }
  const host = spawn(process.execPath, [hostScript, f.directory, boundary], { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { host.once('error', reject); host.once('exit', (code, signal) => resolve({ code, signal })); });
  // Teardown signals only the host handle this test spawned, never a saved PID.
  t.after(async () => { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); await exited; });
  const trace = []; let timer;
  const reached = new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    timer = setTimeout(() => reject(new Error(`Boundary ${boundary} was not reached: ${stderr}`)), REACH_MS);
    host.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
    host.stdout.on('data', bytes => {
      stdout += bytes;
      if (stdout.length > 64 * 1024) { reject(new Error('Unexpected host output volume')); return; }
      for (let at = stdout.indexOf('\n'); at >= 0; at = stdout.indexOf('\n')) {
        let event;
        try { event = JSON.parse(stdout.slice(0, at)); } catch (error) { reject(error); return; }
        stdout = stdout.slice(at + 1); trace.push(event);
        if (event.paused) resolve(event);
      }
    });
    host.once('exit', (code, signal) => reject(new Error(`Host exited before boundary: ${code}/${signal} ${stderr}`)));
  });
  let event;
  try { event = await reached; } finally { clearTimeout(timer); }
  assert.equal(event.boundary, boundary);
  host.kill('SIGKILL'); const exit = await exited; assert.equal(exit.signal, 'SIGKILL');
  return { ...f, event, trace, request };
}

// ADR 0002: the killed host's marker stays open; only an explicit operator close admits a new owner.
async function reopen(t, f) {
  const store = await openStore(join(f.directory, 'loop.sqlite'));
  const hostOwner = f.trace.find(e => e.source === 'owner')?.ownerId;
  await assert.rejects(acquireExecutionOwner({ store }), e => e.code === 'EXECUTION_OPEN');
  assert.deepEqual(store.executions().filter(e => e.open === 1).map(e => e.owner_id), [hostOwner]);
  assert.deepEqual(await closeOrphanedExecution({ store, ownerId: hostOwner, note: 'test: host SIGKILLed at boundary' }), { closed: true });
  const owner = await acquireExecutionOwner({ store, target: f.root });
  const archive = await openEvidenceArchive(join(f.directory, 'evidence.sqlite'));
  const phases = [];
  const adapter = await openFixtureAdapter({ filename: join(f.directory, 'fixture.sqlite'), runId, workspace: f.directory,
    onBoundary: event => { phases.push(event.phase); } });
  const gateConfigs = { test: { gate: f.gate, repoRoots: { product: f.root }, executables: { node: process.execPath }, envProfiles: { empty: {} }, oracleBundles: { oracle: f.oracle } } };
  const driver = createFixtureDriver({ store, owner, adapter, archive, runId, root: f.root, projectionDirectory: f.directory, request: f.request, gateConfigs });
  const events = store.events(runId, -1, 1000).map(e => e.digest);
  t.after(async () => { await driver.close(); await adapter.close(); owner.release(); archive.close(); store.close(); });
  return { store, archive, adapter, driver, phases, events, state: () => store.status(runId).state };
}

// Durable history is append-only and replays; no new process or gate was started.
function assertReplayAndNoRespawn(f, r, gatesAtKill) {
  assert.deepEqual(r.phases, [], 'recovery host must not reserve or spawn a fixture');
  assert.deepEqual(gateSpawns(f), gatesAtKill, 'recovery host must not re-run a gate');
  assert.deepEqual(r.store.events(runId, -1, 1000).map(e => e.digest).slice(0, r.events.length), r.events);
  assert.equal(r.store.verify(runId).ok, true);
}

async function assertUnknownRequiresRecovery(f, r) {
  await assert.rejects(r.driver.step(), e => e.code === 'EFFECT_UNKNOWN');
  assert.equal(r.state().status, 'RECOVERY_REQUIRED'); assert.equal(r.state().dispatches['d-1'].status, 'UNKNOWN');
  await assert.rejects(settleRecordedFixture({ store: r.store, adapter: r.adapter, runId, dispatchId: 'd-1', root: f.root }), e => e.code === 'EFFECT_UNKNOWN');
  await assert.rejects(r.driver.step(), e => e.code === 'EFFECT_UNKNOWN');
  assert.equal(r.state().dispatches['d-1'].receipt, null, 'unknown work never gains a receipt');
  assert.notEqual(r.state().tasks.build.status, 'CANDIDATE_READY');
}

const projectionFiles = f => readdirSync(f.directory).filter(name => name.startsWith(`${runId}.projection-`));

const boundaries = {
  async 'claim-before-start'(t, f) {
    assert.equal(buildSpawns(f.trace).length, 0);
    const r = await reopen(t, f);
    assert.equal(r.state().dispatches['d-1'].status, 'STARTED'); assert.equal(r.adapter.lookup('d-1'), null);
    await assertUnknownRequiresRecovery(f, r);
    assert.equal(r.adapter.lookup('d-1'), null, 'no journal row may appear');
    assertReplayAndNoRespawn(f, r, []);
  },
  async 'process-before-receipt'(t, f) {
    const spawned = buildSpawns(f.trace); assert.equal(spawned.length, 1);
    const r = await reopen(t, f), handle = r.adapter.lookup('d-1');
    const seen = r.adapter.inspect(handle);
    assert.equal(seen.pid, spawned[0].pid, 'PID was durably saved before the kill');
    assert.equal(seen.status, 'UNKNOWN'); assert.equal(seen.recoveryRequired, true);
    assert.equal(r.adapter.cancel(handle).cancelled, false, 'a saved PID is not cancellation authority');
    await assert.rejects(r.adapter.collectResult(handle), e => e.code === 'EFFECT_UNKNOWN');
    await assertUnknownRequiresRecovery(f, r);
    await assertGroupsGone([spawned[0].pid]);
    assert.equal(r.adapter.inspect(handle).status, 'UNKNOWN', 'an orphan that exits later cannot create a receipt');
    assertReplayAndNoRespawn(f, r, []);
  },
  async 'receipt-before-settle'(t, f) {
    assert.equal(buildSpawns(f.trace).length, 1);
    const r = await reopen(t, f), handle = r.adapter.lookup('d-1');
    assert.equal(r.adapter.inspect(handle).status, 'FINISHED');
    assert.equal((await r.adapter.collectResult(handle)).result, 'pass', 'durable completed record survives');
    assert.equal(r.state().dispatches['d-1'].receipt, null);
    await assert.rejects(r.driver.step(), e => e.code === 'EFFECT_UNKNOWN');
    assert.equal(r.state().status, 'RECOVERY_REQUIRED', 'driver never ingests automatically');
    const input = { store: r.store, adapter: r.adapter, runId, dispatchId: 'd-1', root: f.root };
    await settleRecordedFixture(input);
    assert.equal(r.state().dispatches['d-1'].receipt.result, 'pass');
    assert.equal((await settleRecordedFixture(input)).alreadySettled, true);
    assert.equal(r.state().status, 'RECOVERY_REQUIRED', 'explicit ingestion is not a success outcome');
    assert.equal(r.state().tasks.build.attempts, 1);
    assertReplayAndNoRespawn(f, r, []);
  },
  async 'gate-receipt-before-settle'(t, f) {
    const gates = gateSpawns(f); assert.equal(gates.length, 1); assert.equal(buildSpawns(f.trace).length, 1);
    await assertGroupsGone(gates);
    const r = await reopen(t, f);
    assert.equal(r.archive.intent(runId, 'd-2').status, 'RECORDED');
    assert.equal(r.archive.get(runId, 'd-2').record.evidence.result, 'pass', 'durable gate evidence survives');
    assert.equal(r.state().dispatches['d-2'].receipt, null);
    await assert.rejects(r.driver.step(), e => e.code === 'EFFECT_UNKNOWN');
    assert.equal(r.state().status, 'RECOVERY_REQUIRED');
    const input = { store: r.store, archive: r.archive, runId, dispatchId: 'd-2', repoRoots: { product: f.root } };
    settleRecordedGate(input);
    assert.equal(r.state().dispatches['d-2'].receipt.result, 'pass');
    assert.equal(settleRecordedGate(input).alreadySettled, true);
    assert.equal(r.state().status, 'RECOVERY_REQUIRED');
    assertReplayAndNoRespawn(f, r, gates);
  },
  async 'projection-before-ack'(t, f) {
    const gates = gateSpawns(f); assert.equal(gates.length, 2); assert.equal(buildSpawns(f.trace).length, 1);
    await assertGroupsGone(gates);
    const r = await reopen(t, f), projection = r.state().projection;
    assert.equal(projection.status, 'STARTED');
    const effect = r.store.effects(runId).find(e => e.id === projection.id);
    const expected = projectionContent(runId, { id: effect.id, kind: effect.kind, payload: effect.payload });
    const file = join(f.directory, `${runId}.${projection.id}.md`), before = readFileSync(file);
    assert.equal(before.toString('utf8'), expected, 'durable projection was published before the kill');
    assert.equal((await r.driver.step()).state.status, 'COMPLETED');
    assert.deepEqual(readFileSync(file), before, 'projection replay is byte-identical');
    assert.deepEqual(projectionFiles(f), [`${runId}.${projection.id}.md`]);
    assert.deepEqual(readdirSync(f.directory).filter(name => name.endsWith('.tmp')), []);
    const version = r.driver.status().stateVersion; await r.driver.step(); assert.equal(r.driver.status().stateVersion, version);
    assertReplayAndNoRespawn(f, r, gates);
  },
};

const requests = { 'process-before-receipt': { scenario: 'pass', delayMs: 1000, timeoutMs: 2000 } };
for (const [boundary, verify] of Object.entries(boundaries)) {
  for (let rep = 1; rep <= REPS; rep++) {
    test(`killed driver host at ${boundary} (${rep}/${REPS}) never respawns or reports false success`, sqlite, async t => {
      const f = await killAtBoundary(t, boundary, requests[boundary]);
      await verify(t, f);
      await assertGroupsGone(buildSpawns(f.trace).map(e => e.pid));
    });
  }
}

test('recovery after a killed host never signals the saved PID of a still-running orphan', sqlite, async t => {
  const f = await killAtBoundary(t, 'process-before-receipt', { scenario: 'hang', delayMs: 0, timeoutMs: 4000 });
  const [spawned] = buildSpawns(f.trace), r = await reopen(t, f), handle = r.adapter.lookup('d-1');
  assert.equal(r.adapter.inspect(handle).pid, spawned.pid);
  assert.equal(r.adapter.cancel(handle).cancelled, false);
  await assertUnknownRequiresRecovery(f, r);
  assert.equal(groupAlive(spawned.pid), true, 'recovery must leave the unowned orphan untouched');
  // The orphan is bounded only by its own five-second guard (fixture-worker.mjs).
  await assertGroupsGone([spawned.pid], 7000);
  assertReplayAndNoRespawn(f, r, []);
});

test('an edited projection after a killed host is preserved and blocks completion', sqlite, async t => {
  const f = await killAtBoundary(t, 'projection-before-ack');
  await assertGroupsGone(gateSpawns(f));
  const r = await reopen(t, f), file = join(f.directory, `${runId}.${r.state().projection.id}.md`);
  // Same length as the original: the conflict must come from content, not size.
  const original = readFileSync(file, 'utf8'), edited = original.replace('simulation result', 'simulation RESULT');
  assert.notEqual(edited, original); assert.equal(edited.length, original.length); writeFileSync(file, edited);
  await assert.rejects(r.driver.step(), e => e.code === 'PROJECTION_CONFLICT');
  assert.equal(r.state().status, 'RECOVERY_REQUIRED'); assert.notEqual(r.state().status, 'COMPLETED');
  assert.equal(readFileSync(file, 'utf8'), edited);
  assertReplayAndNoRespawn(f, r, gateSpawns(f));
});

// ADR 0002 T1/T5: real second processes. Helpers self-exit within 8 s; teardown signals only owned handles.
const ownerHost = fileURLToPath(new URL('./fixtures/execution-owner-host.mjs', import.meta.url));
const exclusive = { ...sqlite, timeout: 20000 };
function startOwnerHost(t, args) {
  const child = spawn(process.execPath, [ownerHost, ...args], { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const events = [], waiters = []; let buffer = '', stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  child.stdout.on('data', bytes => {
    buffer += bytes;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      events.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1);
      for (const w of [...waiters]) w();
    }
  });
  const next = (predicate, ms = REACH_MS) => new Promise((resolve, reject) => {
    const check = () => { const event = events.find(predicate); if (event) { done(); resolve(event); } };
    const timer = setTimeout(() => { done(); reject(new Error(`owner host did not report in ${ms} ms: ${stderr}`)); }, ms);
    const done = () => { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); };
    waiters.push(check); check();
  });
  return { child, exited, next, events };
}
const tryAcquire = file => JSON.parse(execFileSync(process.execPath, [ownerHost, 'try', file], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH ?? '' } }));

test('T1: a second process is refused at once while a live host owns the state directory, then the owner completes', exclusive, async t => {
  const f = prepare(t, { scenario: 'pass', delayMs: 0, timeoutMs: 1000 });
  const store = await openStore(join(f.directory, 'loop.sqlite'));
  try { store.create(f.spec, f.artifacts, { simulation: true }); } finally { store.close(); }
  const a = startOwnerHost(t, ['drive', f.directory]);
  const paused = await a.next(e => e.paused);
  const versionOf = async () => { const s = await openStore(join(f.directory, 'loop.sqlite')); try { return s.status(runId).stateVersion; } finally { s.close(); } };
  const version = await versionOf();
  const gatesBefore = gateSpawns(f), journalBefore = buildSpawns(a.events).length;
  const b = tryAcquire(join(f.directory, 'loop.sqlite'));
  assert.equal(b.acquire.code, 'EXECUTION_OWNER_ACTIVE'); assert.ok(b.acquire.ms < 1000, `refusal took ${b.acquire.ms} ms`);
  assert.equal(b.tick.code, 'EXECUTION_OPEN', 'an unfenced tick from the second process is refused');
  assert.equal(await versionOf(), version, 'second process changed no state');
  assert.deepEqual(gateSpawns(f), gatesBefore); assert.equal(journalBefore, 1);
  a.child.stdin.end('go\n');
  const done = await a.next(e => e.done);
  assert.equal(done.status, 'COMPLETED'); assert.deepEqual(done.released, { markerClosed: true });
  assert.equal((await a.exited).code, 0);
  assert.equal(buildSpawns(a.events).length, 1, 'exactly one build spawn, by the owner'); assert.equal(gateSpawns(f).length, 2);
  const after = await openStore(join(f.directory, 'loop.sqlite'));
  try {
    assert.deepEqual(after.executions().map(e => [e.owner_id, e.open, e.close_kind]), [[paused.ownerId, 0, 'graceful']]);
    assert.equal(after.verify(runId).ok, true);
  } finally { after.close(); }
});

test('T5: a SIGKILLed host with a surviving child blocks every new execution until an operator close', exclusive, async t => {
  const f = await killAtBoundary(t, 'process-before-receipt', { scenario: 'hang', delayMs: 0, timeoutMs: 4000 });
  const [spawned] = buildSpawns(f.trace), hostOwner = f.trace.find(e => e.source === 'owner').ownerId;
  const store = await openStore(join(f.directory, 'loop.sqlite'));
  t.after(() => store.close());
  // The kernel lock is free (X7), so the refusal comes from the durable marker.
  await assert.rejects(acquireExecutionOwner({ store }), e => e.code === 'EXECUTION_OPEN');
  assert.equal(tryAcquire(join(f.directory, 'loop.sqlite')).acquire.code, 'EXECUTION_OPEN', 'a separate process is refused too');
  assert.equal(groupAlive(spawned.pid), true, 'the orphan is alive and untouched');
  const other = demoBundle('run2'); store.create(other.spec, other.artifacts, { simulation: true });
  assert.throws(() => store.apply('tick', { requestId: 'r1', idempotencyKey: 'r1', runId: 'run2', expectedStateVersion: 0,
    payload: { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null } }), e => e.code === 'EXECUTION_OPEN');
  assert.equal(store.status('run2').stateVersion, 0);
  await assertGroupsGone([spawned.pid], 7000);
  await assert.rejects(acquireExecutionOwner({ store }), e => e.code === 'EXECUTION_OPEN', 'orphan exit does not reopen the directory');
  assert.deepEqual(store.executions().filter(e => e.open === 1).map(e => e.owner_id), [hostOwner]);
  const r = await reopen(t, f);
  await assertUnknownRequiresRecovery(f, r);
  assert.deepEqual(r.store.executions().map(e => [e.owner_id, e.open, e.close_kind]).slice(0, 1), [[hostOwner, 0, 'operator']]);
  assertReplayAndNoRespawn(f, r, []);
});
