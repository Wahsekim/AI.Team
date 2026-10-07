import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { bytesDigest, digest, specDigest } from '../src/loop/contracts.mjs';
import { command, demoBundle } from '../src/loop/demo.mjs';
import { openStore } from '../src/loop/store.mjs';
import { openEvidenceArchive } from '../src/loop/evidence.mjs';
import { snapshotRepository } from '../src/loop/snapshots.mjs';
import { gateDigest } from '../src/loop/gates.mjs';
import { openFixtureAdapter } from '../src/loop/adapters/fixture-process.mjs';
import { createFixtureDriver, MAX_STOP_POLL_MS, STOP_POLL_MS } from '../src/loop/fixture-driver.mjs';
import { acquireExecutionOwner } from '../src/loop/execution-owner.mjs';

// R04b: the active driver observes durable stop records (ADR 0004). Assertions use durable state and
// trace order, not wall-clock. Lifetime bounds: hosts self-exit at 20 s, fixture workers at 5 s, gates at 3 s.
const major = Number(process.versions.node.split('.')[0]);
const sqlite = { skip: major < 24 ? 'Stop observation tests need the Node 24+ control store (node:sqlite)' : false, timeout: 30000 };
const cli = fileURLToPath(new URL('../scripts/team-run.mjs', import.meta.url));
const hostScript = fileURLToPath(new URL('./fixtures/stop-observe-host.mjs', import.meta.url));
const env = { PATH: process.env.PATH ?? '' };
const POLL_MS = 20, WAIT_MS = 8000, HOST_MS = 20000;
const request = (scenario = 'pass', delayMs = 0, timeoutMs = 1000) => ({ scenario, delayMs, timeoutMs });

// State directories live under the OS temp dir, outside any Git repository (ADR 0003).
function prepare(t, { gateSource = 'process.stdout.write("gate ok")', gateTimeoutMs = 1000, req = request() } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-stop-observe-'))), root = join(directory, 'product');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(root); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/check.cjs'), gateSource);
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const oracle = [{ path: 'src/check.cjs', digest: bytesDigest(readFileSync(join(root, 'src/check.cjs'))) }];
  const gate = { id: 'test', repoId: 'product', executableRef: { id: 'node', digest: bytesDigest(readFileSync(process.execPath)) },
    argv: ['check.cjs'], cwd: { repoId: 'product', relativePath: 'src' }, envProfileId: 'empty', timeoutMs: gateTimeoutMs,
    successExitCodes: [0], oracleBundleRef: { id: 'oracle', digest: digest(oracle) }, networkPolicyId: 'local-attended-inherit' };
  gate.specDigest = gateDigest(gate);
  const { spec, artifacts } = demoBundle('run', { schemaVersion: 2 });
  artifacts.snapshot = snapshotRepository({ root }); artifacts.gate = gate;
  artifacts.manifest.gates[0].artifactRef.digest = digest(gate);
  spec.manifestRef.digest = digest(artifacts.manifest); spec.initialSnapshotRef.digest = digest(artifacts.snapshot); spec.approvedSpecDigest = specDigest(spec);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ root, gate, oracle, request: req, pollMs: POLL_MS }));
  const gateConfigs = { test: { gate, repoRoots: { product: root }, executables: { node: process.execPath }, envProfiles: { empty: {} }, oracleBundles: { oracle } } };
  return { directory, root, spec, artifacts, gateConfigs };
}

// The CLI is a separate process: the stop record is written by another writer, lock-free.
const cliRun = (directory, ...args) => {
  const result = spawnSync(process.execPath, [cli, ...args.slice(0, 1), directory, 'run', ...args.slice(1)], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env });
  return { status: result.status, stdout: result.stdout, json: result.stdout.startsWith('{') ? JSON.parse(result.stdout) : null };
};
const cliStop = (directory, kind) => { const r = cliRun(directory, 'stop', `--${kind}`); assert.equal(r.status, 0, r.stdout); return r.json.value; };
async function waitFor(predicate, label, ms = WAIT_MS) {
  const deadline = Date.now() + ms;
  while (!predicate()) { assert.ok(Date.now() < deadline, `${label} not reached within ${ms} ms`); await delay(10); }
}
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const actions = store => store.events('run', -1, 1000).map(e => e.action);
const observations = store => store.events('run', -1, 1000).filter(e => e.action === 'stop-observed').map(e => e.payload.seq);

// In-process driver; `hooks` wrap the store's apply and the adapter like the driver-crash host does.
async function inProcess(t, options = {}) {
  const f = prepare(t, options), hooks = { beforeApply: null, boundary: null, readFails: null, holdCollect: null, hideStop: false, beforeRead: null };
  const store = await openStore(join(f.directory, 'loop.sqlite'));
  store.create(f.spec, f.artifacts, { simulation: true });
  const owner = await acquireExecutionOwner({ store, target: f.root });
  const archive = await openEvidenceArchive(join(f.directory, 'evidence.sqlite'));
  const spawned = [], cancels = [];
  const inner = await openFixtureAdapter({ filename: join(f.directory, 'fixture.sqlite'), runId: 'run', workspace: f.directory,
    onBoundary: event => { if (event.phase === 'spawned-before-pid-save') spawned.push(event.pid); hooks.boundary?.(event); } });
  const adapter = { ...inner,
    cancel(handle) { const result = inner.cancel(handle); cancels.push({ cancelled: result.cancelled, status: result.status }); return result; },
    async collectResult(handle) { const result = await inner.collectResult(handle); if (hooks.holdCollect) await waitFor(hooks.holdCollect, 'held collect condition'); return result; } };
  const hooked = { ...store,
    readStopRequest(id) { if (hooks.readFails) throw hooks.readFails; hooks.beforeRead?.(); return hooks.hideStop ? null : store.readStopRequest(id); },
    apply(action, prepared, at, fence) { hooks.beforeApply?.(action, prepared.payload); return store.apply(action, prepared, at, fence); } };
  const drivers = [];
  const newDriver = () => { const d = createFixtureDriver({ store: hooked, owner, adapter, archive, runId: 'run', root: f.root, projectionDirectory: f.directory,
    request: options.req ?? request(), gateConfigs: f.gateConfigs, pollMs: POLL_MS }); drivers.push(d); return d; };
  const driver = newDriver();
  t.after(async () => { for (const d of drivers) await d.close(); await adapter.close(); owner.release(); archive.close(); store.close(); });
  // Fires `act` once, on the first call whose arguments match.
  const once = (matches, act) => { let done = false; return (...args) => { if (!done && matches(...args)) { done = true; act(...args); } }; };
  return { ...f, store, owner, archive, adapter, driver, newDriver, hooks, spawned, cancels, once, state: () => store.status('run').state };
}

// Host process for O1/O2: emits a JSON trace; this test is the second process that records the stop.
async function hostRun(t, f, trigger) {
  const store = await openStore(join(f.directory, 'loop.sqlite'));
  try { store.create(f.spec, f.artifacts, { simulation: true }); } finally { store.close(); }
  const host = spawn(process.execPath, [hostScript, f.directory], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { host.once('error', reject); host.once('exit', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); await exited; });
  const trace = []; let stdout = '', stderr = '';
  host.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  host.stdout.on('data', bytes => {
    stdout += bytes;
    for (let at = stdout.indexOf('\n'); at >= 0; at = stdout.indexOf('\n')) { trace.push(JSON.parse(stdout.slice(0, at))); stdout = stdout.slice(at + 1); }
  });
  await waitFor(() => trigger(trace) || host.exitCode !== null, 'host effect start', WAIT_MS);
  assert.equal(host.exitCode, null, `host exited before the effect started: ${stderr}`);
  const stop = cliStop(f.directory, 'hard');
  let timer;
  const exit = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('host did not finish')), HOST_MS); })]).finally(() => clearTimeout(timer));
  assert.equal(exit.code, 0, stderr);
  return { trace, stop, reopen: async () => { const s = await openStore(join(f.directory, 'loop.sqlite')); t.after(() => s.close()); return s; } };
}

function assertObservedThenCancelled(trace, { ownedCancel }) {
  const seen = trace.findIndex(e => e.source === 'poll' && e.seq === 1);
  const marked = trace.findIndex(e => e.source === 'store' && e.action === 'stop-observed' && e.payload.seq === 1);
  assert.ok(seen >= 0 && marked > seen, 'the first poll that reads the record observes it');
  assert.equal(trace.slice(seen + 1, marked).filter(e => e.source === 'poll').length, 0, 'observed within the poll that read it');
  // A hard stop aborts before it records the observation; fixtures cancel through the adapter's owned handle.
  if (ownedCancel) assert.ok(trace.slice(seen, marked).some(e => e.source === 'cancel' && e.cancelled === true), 'cancel issued on observation');
  assert.equal(trace.slice(seen).some(e => e.source === 'store' && e.action === 'claim' && /^d-/.test(e.payload.effectId)), false, 'no dispatch claim after the stop');
  assert.equal(trace.slice(seen).some(e => e.source === 'adapter' && e.phase === 'reservation-committed'), false, 'no spawn after the stop');
  return trace[marked].at - trace[seen].at;
}

test('O1: a hard stop from another process during a build is observed by the polling driver and cancels the owned worker', sqlite, async t => {
  const f = prepare(t, { req: request('hang', 0, 4000) });
  const r = await hostRun(t, f, trace => trace.some(e => e.source === 'adapter' && e.phase === 'spawned-before-pid-save'));
  assert.equal(r.stop.recorded, true); assert.equal(r.stop.stopRequest.seq, 1);
  const latency = assertObservedThenCancelled(r.trace, { ownedCancel: true });
  t.diagnostic(`poll-read to observed-marker: ${latency} ms; poll interval ${POLL_MS} ms`);
  const cancels = r.trace.filter(e => e.source === 'cancel');
  assert.deepEqual(cancels.map(e => e.cancelled), [true], 'cancellation issued exactly once through the owned handle');
  const store = await r.reopen(), state = store.status('run').state;
  assert.deepEqual(Object.keys(state.dispatches), ['d-1'], 'no later dispatch');
  assert.deepEqual(state.stopObserved.seq, 1); assert.equal(state.stopObserved.kind, 'hard');
  assert.notEqual(state.tasks.build.status, 'CANDIDATE_READY'); assert.equal(state.candidate, f.spec.initialSnapshotRef.digest);
  const show = cliRun(f.directory, 'show'), status = cliRun(f.directory, 'status');
  assert.match(show.stdout, /^stop hard · #1 · by cli$/m); assert.match(show.stdout, /stop observed by the driver · #1/);
  if (state.status === 'RECOVERY_REQUIRED') {
    // Unconfirmed cleanup (classification) never becomes accepted work.
    assert.match(show.stdout, /cancellation unconfirmed · recovery required/); assert.equal(status.json.value.stop.cancellation, 'unconfirmed');
  } else {
    assert.equal(state.dispatches['d-1'].receipt.result, 'cancelled'); assert.equal(state.status, 'STOPPED');
    assert.match(show.stdout, /cancellation confirmed/); assert.equal(status.json.value.stop.cancellation, 'confirmed');
  }
  assert.equal(status.json.value.stop.observed, true); assert.equal(store.verify('run').ok, true);
  const pid = r.trace.find(e => e.source === 'adapter' && e.phase === 'spawned-before-pid-save').pid;
  await waitFor(() => !groupAlive(pid), `worker group ${pid} exit`);
});

test('O2: a hard stop from another process during a real gate is observed and cancels the gate process', sqlite, async t => {
  const marker = join(tmpdir(), `ai-stop-observe-gate-${process.pid}-${Date.now()}.pid`);
  t.after(() => rmSync(marker, { force: true }));
  const f = prepare(t, { gateTimeoutMs: 5000, gateSource: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 3000);` });
  const r = await hostRun(t, f, () => existsSync(marker));
  assertObservedThenCancelled(r.trace, { ownedCancel: false });
  const store = await r.reopen(), state = store.status('run').state;
  assert.deepEqual(Object.keys(state.dispatches), ['d-1', 'd-2'], 'no later dispatch');
  assert.equal(state.stopObserved.kind, 'hard'); assert.notEqual(state.tasks.build.status, 'SUCCEEDED');
  const archive = await openEvidenceArchive(join(f.directory, 'evidence.sqlite'));
  try {
    const record = archive.get('run', 'd-2').record;
    assert.ok(['cancelled', 'cleanup_unknown', 'cancel_error', 'orphaned_process_group'].includes(record.transcript.reason), record.transcript.reason);
    assert.notEqual(record.evidence.result, 'pass');
    if (state.status !== 'RECOVERY_REQUIRED') { assert.equal(record.transcript.reason, 'cancelled'); assert.equal(state.status, 'STOPPED'); }
  } finally { archive.close(); }
  assert.match(cliRun(f.directory, 'show').stdout, /stop observed by the driver · #1/);
  assert.equal(store.verify('run').ok, true);
  const pid = Number(readFileSync(marker, 'utf8'));
  await waitFor(() => !groupAlive(pid), `gate group ${pid} exit`);
});

test('O3: a graceful stop during a build lets the step finish, starts no new work and closes out', sqlite, async t => {
  const p = await inProcess(t, { req: request('pass', 300) });
  p.hooks.boundary = p.once(event => event.phase === 'spawned-before-pid-save', () => cliStop(p.directory, 'graceful'));
  // Hold the step until the poll (not a later step) records the observation.
  p.hooks.holdCollect = () => p.state().stopObserved?.seq === 1;
  await p.driver.step();
  let state = p.state();
  assert.deepEqual(state.stopObserved.seq, 1); assert.equal(state.stopObserved.kind, 'graceful');
  assert.equal(state.dispatches['d-1'].receipt.result, 'pass', 'the running step finished');
  assert.notEqual(state.tasks.build.status, 'CANDIDATE_READY'); assert.deepEqual(p.cancels, []);
  assert.match(cliRun(p.directory, 'show').stdout, /stop observed by the driver · #1/);
  assert.equal((await p.driver.step()).state.status, 'STOPPED');
  state = p.state();
  assert.deepEqual(Object.keys(state.dispatches), ['d-1']); assert.equal(p.spawned.length, 1);
  assert.equal(state.projection.status, 'ACKNOWLEDGED'); assert.equal(p.store.verify('run').ok, true);
  assert.deepEqual(observations(p.store), [1]);
});

test('O4: a repeated stop is not re-observed; graceful-to-hard escalation mid-step cancels exactly once', sqlite, async t => {
  const p = await inProcess(t, { req: request('hang', 0, 4000) });
  p.hooks.boundary = p.once(event => event.phase === 'spawned-before-pid-save', () => cliStop(p.directory, 'graceful'));
  const active = p.driver.step();
  await waitFor(() => p.state().stopObserved?.seq === 1, 'graceful observation');
  assert.deepEqual(p.cancels, [], 'graceful never cancels');
  const version = p.store.status('run').stateVersion;
  assert.equal(cliStop(p.directory, 'graceful').recorded, false);
  assert.equal(p.store.status('run').stateVersion, version, 'a repeat changes nothing');
  const hard = cliStop(p.directory, 'hard');
  assert.equal(hard.recorded, true); assert.equal(hard.stopRequest.seq, 2);
  await active;
  const state = p.state();
  assert.deepEqual(observations(p.store), [1, 2]);
  assert.deepEqual(p.cancels.map(c => c.cancelled), [true]);
  assert.equal(state.stopRequest.seq, 2); assert.equal(state.stopObserved.seq, 2); assert.equal(state.stopObserved.kind, 'hard');
  assert.equal(state.dispatches['d-1'].receipt.result, 'cancelled');
  assert.equal(p.driver.stop({ kind: 'hard', requestedBy: 'owner' }).state.stopRequest.seq, 2);
  assert.equal(p.cancels.length, 1, 'no double cancel');
  assert.equal((await p.driver.step()).state.status, 'STOPPED'); assert.deepEqual(Object.keys(p.state().dispatches), ['d-1']);
});

test('O5: a stop before spawn (before the step, or between intent and claim) never spawns and closes out', sqlite, async t => {
  const early = await inProcess(t);
  cliStop(early.directory, 'hard');
  assert.equal((await early.driver.step()).state.status, 'STOPPED');
  assert.deepEqual(early.state().dispatches, {}); assert.equal(early.adapter.lookup('d-1'), null);
  assert.equal(early.state().stopObserved.seq, 1);

  const late = await inProcess(t);
  late.hooks.beforeApply = late.once((action, payload) => action === 'claim' && payload.effectId === 'd-1', () => cliStop(late.directory, 'hard'));
  const status = await late.driver.step();
  assert.equal(status.state.status, 'QUIESCING', 'the refused claim ends the step cleanly');
  assert.equal(late.adapter.lookup('d-1'), null); assert.deepEqual(late.spawned, []);
  assert.deepEqual(late.state().dispatches['d-1'].receipt, { result: 'cancelled', tokens: 0, costMicroUsd: 0 });
  assert.equal(late.state().stopObserved.seq, 1); assert.equal(actions(late.store).includes('interrupted'), false);
  assert.equal((await late.driver.step()).state.status, 'STOPPED'); assert.equal(late.store.verify('run').ok, true);
});

test('O6: a result durable before the cancel is issued settles as accounting only; it never becomes accepted work', sqlite, async t => {
  const p = await inProcess(t);
  p.hooks.boundary = p.once(event => event.phase === 'result-stored', () => cliStop(p.directory, 'hard'));
  p.hooks.holdCollect = () => p.state().stopObserved?.seq === 1;
  await p.driver.step();
  const state = p.state();
  assert.deepEqual(p.cancels, [{ cancelled: false, status: 'FINISHED' }], 'cancel after the durable receipt is a no-op');
  assert.equal(state.dispatches['d-1'].receipt.result, 'pass');
  assert.notEqual(state.tasks.build.status, 'CANDIDATE_READY'); assert.equal(state.candidate, p.spec.initialSnapshotRef.digest);
  assert.equal(state.reason, 'user_stop');
  assert.equal((await p.driver.step()).state.status, 'STOPPED');
  assert.match(cliRun(p.directory, 'show').stdout, /cancellation confirmed/);
});

test('O7: an observer read failure stops new work and is reported in status/show', sqlite, async t => {
  const failure = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
  const p = await inProcess(t, { req: request('pass', 200) });
  p.hooks.boundary = event => { if (event.phase === 'spawned-before-pid-save') p.hooks.readFails = failure; };
  p.hooks.holdCollect = () => !!p.state().stopObserverFailed;
  await assert.rejects(p.driver.step(), e => e.code === 'STOP_OBSERVER_FAILED' && e.cause === failure);
  const failedAt = actions(p.store).length;
  assert.equal(p.state().dispatches['d-1'].receipt.result, 'pass', 'the running step finished');
  assert.deepEqual(p.state().stopObserverFailed.cause, 'ERR_SQLITE_ERROR');
  assert.equal(actions(p.store).includes('interrupted'), false);
  await assert.rejects(p.driver.step(), e => e.code === 'STOP_OBSERVER_FAILED');
  p.hooks.readFails = null;
  await assert.rejects(p.driver.step(), e => e.code === 'STOP_OBSERVER_FAILED', 'monitoring is never silently re-enabled or skipped');
  assert.equal(actions(p.store).length, failedAt, 'no tick, claim or dispatch after the failure');
  assert.deepEqual(Object.keys(p.state().dispatches), ['d-1']); assert.equal(p.spawned.length, 1);
  const status = cliRun(p.directory, 'status'), show = cliRun(p.directory, 'show');
  assert.deepEqual(status.json.value.stop.observerFailed.cause, 'ERR_SQLITE_ERROR');
  assert.match(show.stdout, /STOP_OBSERVER_FAILED · ERR_SQLITE_ERROR · driver stopped new work/);
  // F1(c): a hard stop recorded after the failure is shown as recorded and pending, never observed or confirmed.
  cliStop(p.directory, 'hard');
  const after = cliRun(p.directory, 'status'), afterShow = cliRun(p.directory, 'show');
  assert.equal(after.json.value.stop.observed, false); assert.equal(after.json.value.stop.cancellation, 'pending');
  assert.match(afterShow.stdout, /^stop recorded · not yet observed by a driver  cancellation pending$/m);
  // F4: a later healthy driver observes the stop and supersedes the failure banner.
  await p.driver.close();
  const healthy = p.newDriver();
  assert.equal((await healthy.step()).state.status, 'STOPPED');
  assert.equal(p.state().stopObserverFailed.cause, 'ERR_SQLITE_ERROR'); assert.ok(p.state().stopObserverFailed.recoveredAt >= p.state().stopObserverFailed.at);
  const recovered = cliRun(p.directory, 'status'), recoveredShow = cliRun(p.directory, 'show');
  assert.equal(recovered.json.value.stop.observerFailed, null); assert.equal(recovered.json.value.stop.observed, true);
  assert.doesNotMatch(recoveredShow.stdout, /STOP_OBSERVER_FAILED/); assert.equal(p.store.verify('run').ok, true);

  const start = await inProcess(t);
  start.hooks.readFails = failure;
  await assert.rejects(start.driver.step(), e => e.code === 'STOP_OBSERVER_FAILED');
  assert.deepEqual(actions(start.store), ['created', 'stop-observer-failed']); assert.equal(start.adapter.lookup('d-1'), null);
});

test('O8: STALE_STATE caused by a stop mid-step is re-read and re-prepared, never a blind interrupted', sqlite, async t => {
  const p = await inProcess(t);
  p.hooks.beforeApply = p.once((action, payload) => action === 'settle' && payload.dispatchId === 'd-1', () => cliStop(p.directory, 'graceful'));
  await p.driver.step();
  const state = p.state();
  assert.equal(state.status, 'QUIESCING'); assert.equal(actions(p.store).includes('interrupted'), false);
  assert.equal(state.dispatches['d-1'].receipt.result, 'pass'); assert.equal(state.stopObserved.seq, 1);
  assert.deepEqual(actions(p.store).slice(-3), ['stop', 'stop-observed', 'settle']);
  assert.equal((await p.driver.step()).state.status, 'STOPPED'); assert.equal(p.store.verify('run').ok, true);

  // Control: a STALE_STATE from any other writer keeps the fail-closed path.
  const other = await inProcess(t);
  other.hooks.beforeApply = other.once((action, payload) => action === 'settle' && payload.dispatchId === 'd-1',
    () => other.store.apply('tick', command(other.store, 'run', { reservation: { agentCalls: 0, tokens: 0, costMicroUsd: 0 }, quota: null }, 'external-tick'), undefined, other.owner.ownerId));
  await assert.rejects(other.driver.step(), e => e.code === 'STALE_STATE');
  assert.equal(other.state().status, 'RECOVERY_REQUIRED');
});

// Drives build, task gate and final gate, then hooks the closing projection's claim/ACK.
async function atProjection(t, hooks) {
  const p = await inProcess(t);
  for (let n = 0; n < 3; n++) await p.driver.step();
  assert.equal(p.state().status, 'FINALIZING'); assert.equal(p.state().projection, null);
  p.hooks.beforeApply = (action, payload) => { const fn = hooks[action]; if (fn && /^projection-/.test(payload.effectId)) { delete hooks[action]; cliStop(p.directory, fn); } };
  const outbox = () => p.store.effects('run').find(e => e.kind === 'projection')?.status;
  const files = () => readdirSync(p.directory).filter(name => name.startsWith('run.projection-'));
  return { ...p, outbox, files };
}

test('O9: graceful stop keeps a closing projection; hard stop and escalation drop it into recovery and mark the row', sqlite, async t => {
  for (const hook of ['claim', 'projected']) {
    const p = await atProjection(t, { [hook]: 'graceful' });
    assert.equal((await p.driver.step()).state.status, 'COMPLETED', `graceful before ${hook}`);
    const state = p.state();
    assert.equal(state.stopRequest.kind, 'graceful'); assert.equal(state.reason, 'goal_satisfied');
    assert.equal(state.projection.keptByStop, 1); assert.equal(state.projection.status, 'ACKNOWLEDGED'); assert.equal(p.outbox(), 'ACKNOWLEDGED');
    assert.equal(state.stopObserved.seq, 1); assert.equal(actions(p.store).includes('interrupted'), false);
    assert.match(cliRun(p.directory, 'show').stdout, /closing projection kept/); assert.equal(p.store.verify('run').ok, true);
  }
  for (const [hook, published] of [['claim', 0], ['projected', 1]]) {
    const p = await atProjection(t, { [hook]: 'hard' });
    // F5: a refused claim (STOP_REQUESTED) ends the step cleanly; a refused ACK after publication is not swallowed.
    if (hook === 'claim') assert.equal((await p.driver.step()).state.status, 'RECOVERY_REQUIRED', 'hard before claim');
    else await assert.rejects(p.driver.step(), e => e.code === 'INVALID_TRANSITION' && !e.preStart, 'hard before projected');
    assert.equal(p.state().status, 'RECOVERY_REQUIRED');
    const state = p.state();
    assert.equal(state.projection, null); assert.equal(p.outbox(), 'DROPPED'); assert.equal(p.files().length, published);
    assert.equal(state.stopObserved.kind, 'hard'); assert.equal(actions(p.store).includes('interrupted'), false);
    assert.match(cliRun(p.directory, 'show').stdout, /cancellation unconfirmed · recovery required/);
    await assert.rejects(p.driver.step(), e => e.code === 'EFFECT_UNKNOWN'); assert.equal(p.store.verify('run').ok, true);
  }
  const p = await atProjection(t, { claim: 'graceful', projected: 'hard' });
  await assert.rejects(p.driver.step(), e => e.code === 'INVALID_TRANSITION' && !e.preStart, 'escalation of a kept projection applies the hard rule');
  assert.equal(p.state().status, 'RECOVERY_REQUIRED');
  const state = p.state();
  assert.equal(state.stopRequest.seq, 2); assert.equal(state.projection, null); assert.equal(p.outbox(), 'DROPPED');
  assert.deepEqual(observations(p.store), [1, 2]); assert.equal(p.store.verify('run').ok, true);
});

test('O10: observation is owner-only, replayable and bounded by configuration', sqlite, async t => {
  const p = await inProcess(t);
  cliStop(p.directory, 'graceful');
  assert.throws(() => p.store.apply('stop-observed', command(p.store, 'run', { seq: 1 })), e => e.code === 'INVALID_SPEC');
  assert.throws(() => p.store.apply('stop-observer-failed', command(p.store, 'run', { cause: 'X' })), e => e.code === 'INVALID_SPEC');
  assert.equal(p.driver.stop({ kind: 'graceful', requestedBy: 'owner' }).state.stopObserved.seq, 1);
  assert.throws(() => p.store.apply('stop-observed', command(p.store, 'run', { seq: 1 }), undefined, p.owner.ownerId), e => e.code === 'INVALID_TRANSITION');
  assert.equal(p.store.verify('run').ok, true);
  assert.ok(STOP_POLL_MS <= 2000 && MAX_STOP_POLL_MS === 2000);
  for (const pollMs of [0, 2001, 1.5]) assert.throws(() => createFixtureDriver({ store: p.store, owner: p.owner, adapter: p.adapter, archive: p.archive,
    runId: 'run', root: p.root, projectionDirectory: p.directory, gateConfigs: p.gateConfigs, pollMs }), e => e.code === 'INVALID_SPEC');
  assert.equal((await p.driver.step()).state.status, 'STOPPED');
  const terminal = cliRun(p.directory, 'stop', '--hard');
  assert.equal(terminal.status, 2); assert.equal(terminal.json.code, 'RUN_TERMINAL');
});

test('O11: status/show never report an unobserved or still-running hard stop as confirmed', sqlite, async t => {
  const p = await inProcess(t, { req: request('hang', 0, 4000) });
  let released = false;
  p.hooks.hideStop = true; // the driver's poll keeps reading, but sees no record yet
  p.hooks.boundary = p.once(event => event.phase === 'spawned-before-pid-save', () => cliStop(p.directory, 'hard'));
  p.hooks.holdCollect = () => released;
  const active = p.driver.step();
  await waitFor(() => !!p.state().stopRequest, 'stop record');
  // (a) recorded while the build runs, not yet observed.
  let status = cliRun(p.directory, 'status'), show = cliRun(p.directory, 'show');
  assert.equal(status.json.value.stop.recorded, true); assert.equal(status.json.value.stop.observed, false);
  assert.equal(status.json.value.stop.cancellation, 'pending');
  assert.match(show.stdout, /^stop recorded · not yet observed by a driver  cancellation pending$/m);
  assert.deepEqual(p.cancels, []); assert.equal(p.state().stopObserved, undefined);
  // (b) observed and cancelled, but the cancelled result is not settled yet: still pending.
  p.hooks.hideStop = false;
  await waitFor(() => p.state().stopObserved?.seq === 1 && p.cancels.length === 1, 'hard observation');
  assert.equal(p.state().dispatches['d-1'].receipt, null);
  status = cliRun(p.directory, 'status'); show = cliRun(p.directory, 'show');
  assert.equal(status.json.value.stop.observed, true); assert.equal(status.json.value.stop.cancellation, 'pending');
  assert.match(show.stdout, /^stop observed by the driver · #1  cancellation pending$/m);
  released = true; await active;
  assert.equal(p.state().dispatches['d-1'].receipt.result, 'cancelled');
  assert.equal(cliRun(p.directory, 'status').json.value.stop.cancellation, 'confirmed');
});

test('O12: a stop committed between claim and spawn refuses the spawn and settles the claim as cancelled', sqlite, async t => {
  const p = await inProcess(t);
  // Fires on the host's re-read right before adapter.start: the dispatch is claimed, nothing is spawned yet.
  p.hooks.beforeRead = p.once(() => p.state().dispatches['d-1']?.status === 'STARTED' && p.spawned.length === 0, () => cliStop(p.directory, 'hard'));
  const status = await p.driver.step();
  assert.equal(status.state.status, 'QUIESCING'); assert.deepEqual(p.spawned, []); assert.equal(p.adapter.lookup('d-1'), null);
  assert.deepEqual(p.state().dispatches['d-1'].receipt, { dispatchId: 'd-1', result: 'cancelled', candidate: p.spec.initialSnapshotRef.digest, tokens: 0, costMicroUsd: 0 });
  assert.equal(actions(p.store).includes('interrupted'), false);
  assert.equal((await p.driver.step()).state.status, 'STOPPED'); assert.equal(p.store.verify('run').ok, true);

  const marker = join(tmpdir(), `ai-stop-observe-f2-${process.pid}-${Date.now()}.pid`);
  t.after(() => rmSync(marker, { force: true }));
  const g = await inProcess(t, { gateSource: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` });
  await g.driver.step();
  g.hooks.beforeRead = g.once(() => g.state().dispatches['d-2']?.status === 'STARTED' && g.archive.intent('run', 'd-2').status === 'PENDING', () => cliStop(g.directory, 'hard'));
  assert.equal((await g.driver.step()).state.status, 'QUIESCING');
  assert.equal(existsSync(marker), false, 'the gate never ran'); assert.equal(g.archive.intent('run', 'd-2').status, 'CANCELLED');
  assert.equal(g.state().dispatches['d-2'].receipt.result, 'cancelled');
  assert.equal((await g.driver.step()).state.status, 'STOPPED'); assert.equal(g.store.verify('run').ok, true);
});
