import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesDigest, digest, specDigest } from '../src/loop/contracts.mjs';
import { command, demoBundle } from '../src/loop/demo.mjs';
import { openStore } from '../src/loop/store.mjs';
import { openEvidenceArchive } from '../src/loop/evidence.mjs';
import { snapshotRepository } from '../src/loop/snapshots.mjs';
import { gateDigest } from '../src/loop/gates.mjs';
import { executeStoredGate } from '../src/loop/host-gates.mjs';
import { openFixtureAdapter } from '../src/loop/adapters/fixture-process.mjs';
import { executeStoredFixture, settleRecordedFixture } from '../src/loop/host-fixtures.mjs';
import { publishProjection } from '../src/loop/projector.mjs';
import { createFixtureDriver } from '../src/loop/fixture-driver.mjs';
import { acquireExecutionOwner } from '../src/loop/execution-owner.mjs';

const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Fixture bridge requires Node 24+' : false };
const tick = { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null };
const request = (scenario = 'pass', delayMs = 0, timeoutMs = 1000) => ({ scenario, delayMs, timeoutMs });
async function fixture(t, source = 'process.stdout.write("real local gate")') {
  const directory = mkdtempSync(join(tmpdir(), 'ai-host-fixture-')), root = join(directory, 'product');
  mkdirSync(root); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/check.cjs'), source);
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
  const store = await openStore(join(directory, 'control.sqlite')), archive = await openEvidenceArchive(join(directory, 'evidence.sqlite'));
  const adapterConfig = { filename: join(directory, 'fixture.sqlite'), runId: 'run', workspace: directory };
  const adapter = await openFixtureAdapter(adapterConfig);
  const beforeClose = [];
  t.after(async () => { beforeClose.forEach(fn => fn()); await adapter.close(); archive.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.create(spec, artifacts, { simulation: true }); store.apply('tick', command(store, 'run', tick));
  const gateConfig = { gate, repoRoots: { product: root }, executables: { node: process.execPath }, envProfiles: { empty: {} }, oracleBundles: { oracle } };
  return { directory, root, store, archive, adapter, adapterConfig, gateConfig, beforeClose,
    input: { store, adapter, runId: 'run', dispatchId: 'd-1', root, request: request() } };
}

test('real fixture build, task/final gates and durable projection complete a simulation', sqlite, async t => {
  const f = await fixture(t); const candidate = f.store.status('run').state.candidate;
  await executeStoredFixture(f.input);
  assert.equal(f.store.status('run').state.candidate, candidate, 'fixture cannot invent a product change');
  assert.equal(f.store.status('run').state.tasks.build.status, 'CANDIDATE_READY');
  assert.equal((await settleRecordedFixture(f.input)).alreadySettled, true);
  for (const dispatchId of ['d-2', 'd-3']) {
    f.store.apply('tick', command(f.store, 'run', tick));
    await executeStoredGate({ store: f.store, archive: f.archive, runId: 'run', dispatchId, config: f.gateConfig });
    assert.equal(f.archive.get('run', dispatchId).record.evidence.result, 'pass');
  }
  f.store.apply('tick', command(f.store, 'run', tick));
  const effect = f.store.effects('run').find(e => e.kind === 'projection');
  f.store.apply('claim', command(f.store, 'run', { effectId: effect.id }));
  const receipt = publishProjection({ directory: f.directory, runId: 'run', effect: { id: effect.id, kind: effect.kind, payload: effect.payload } });
  f.store.apply('projected', command(f.store, 'run', { effectId: effect.id }));
  assert.match(readFileSync(join(f.directory, receipt.fileName), 'utf8'), /not evidence of a real product build/);
  assert.equal(f.store.status('run').state.status, 'COMPLETED'); assert.equal(f.store.verify('run').ok, true);
});

for (const scenario of ['fail', 'partial', 'crash']) {
  test(`${scenario} fixture cannot bypass acceptance; bounded retry uses a new dispatch`, sqlite, async t => {
    const f = await fixture(t); await executeStoredFixture({ ...f.input, request: request(scenario) });
    const state = f.store.status('run').state;
    assert.equal(state.tasks.build.status, 'READY'); assert.notEqual(state.dispatches['d-1'].receipt.result, 'pass');
    f.store.apply('tick', command(f.store, 'run', tick));
    await executeStoredFixture({ ...f.input, dispatchId: 'd-2' });
    assert.equal(f.store.status('run').state.tasks.build.attempts, 2);
    assert.equal(f.store.status('run').state.usage.agentCalls, 2); assert.equal(f.store.verify('run').ok, true);
  });
}

test('hard stop plus owned abort collects cancellation without reviving acceptance', sqlite, async t => {
  const f = await fixture(t), controller = new AbortController();
  const running = executeStoredFixture({ ...f.input, request: request('hang'), signal: controller.signal });
  assert.equal(f.adapter.inspect(f.adapter.lookup('d-1')).status, 'RUNNING');
  f.store.apply('stop', command(f.store, 'run', { mode: 'hard', reason: 'test operator' })); controller.abort();
  await running;
  const state = f.store.status('run').state;
  assert.equal(state.reason, 'user_stop'); assert.equal(state.dispatches['d-1'].receipt.result, 'cancelled');
  assert.notEqual(state.tasks.build.status, 'CANDIDATE_READY'); assert.equal(f.store.verify('run').ok, true);
});

test('pre-cancelled and expired claims never start a fixture', sqlite, async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(executeStoredFixture({ ...f.input, signal: controller.signal }), e => e.code === 'CANCELLED');
  assert.equal(f.adapter.lookup('d-1'), null);
  const result = await executeStoredFixture({ ...f.input, now: () => f.store.status('run').state.startedAt + 60001 });
  assert.equal(result.cancelledBeforeStart, true); assert.equal(f.adapter.lookup('d-1'), null);
});

test('unfinished reopened work is never respawned; only a durable result can reconcile', sqlite, async t => {
  const f = await fixture(t);
  f.store.apply('claim', command(f.store, 'run', { effectId: 'd-1' }));
  const handle = f.adapter.start('d-1', request('pass', 200));
  const other = await openFixtureAdapter(f.adapterConfig);
  try {
    await assert.rejects(executeStoredFixture({ ...f.input, adapter: other }), e => e.code === 'INVALID_TRANSITION');
    await assert.rejects(settleRecordedFixture({ ...f.input, adapter: other }), e => e.code === 'EFFECT_UNKNOWN');
    assert.equal(other.inspect(handle).status, 'UNKNOWN'); assert.equal(other.cancel(handle).cancelled, false);
    await f.adapter.collectResult(handle);
    await settleRecordedFixture({ ...f.input, adapter: other });
    assert.equal(f.store.status('run').state.tasks.build.status, 'CANDIDATE_READY');
    assert.equal(f.store.status('run').state.tasks.build.attempts, 1); assert.equal(f.store.verify('run').ok, true);
  } finally { await other.close(); }
});

test('candidate drift during fixture execution preserves result but requires recovery', sqlite, async t => {
  const f = await fixture(t);
  const running = executeStoredFixture({ ...f.input, request: request('pass', 100) });
  writeFileSync(join(f.root, 'src/changed.txt'), 'external change');
  assert.equal((await running).recoveryRequired, true);
  assert.equal(f.adapter.inspect(f.adapter.lookup('d-1')).status, 'FINISHED');
  assert.equal(f.store.status('run').state.status, 'RECOVERY_REQUIRED'); assert.equal(f.store.verify('run').ok, true);
});

test('wrong-run adapter and invalid request fail before claiming or spawning', sqlite, async t => {
  const f = await fixture(t), other = await openFixtureAdapter({ ...f.adapterConfig, runId: 'other' });
  try {
    await assert.rejects(executeStoredFixture({ ...f.input, adapter: other }), e => e.code === 'CAPABILITY_MISSING');
    await assert.rejects(executeStoredFixture({ ...f.input, request: request('shell') }), e => e.code === 'INVALID_SPEC');
    assert.equal(f.store.status('run').state.dispatches['d-1'].status, 'PENDING');
    assert.equal(f.adapter.lookup('d-1'), null); assert.equal(other.lookup('d-1'), null);
  } finally { await other.close(); }
});

test('claimed-without-journal and preexisting-journal gaps never cause a new spawn', sqlite, async t => {
  const f = await fixture(t);
  f.store.apply('claim', command(f.store, 'run', { effectId: 'd-1' }));
  await assert.rejects(executeStoredFixture(f.input), e => e.code === 'INVALID_TRANSITION');
  await assert.rejects(settleRecordedFixture(f.input), e => e.code === 'EFFECT_UNKNOWN');
  assert.equal(f.adapter.lookup('d-1'), null);
  const other = await fixture(t);
  const handle = other.adapter.start('d-1', request('pass')); await other.adapter.collectResult(handle);
  await assert.rejects(executeStoredFixture(other.input), e => e.code === 'EFFECT_UNKNOWN');
  assert.equal(other.store.status('run').state.dispatches['d-1'].status, 'PENDING');
});

// Drivers require an execution owner (ADR 0002); release runs before the fixture closes its store.
async function drivenFixture(t, source) {
  const f = await fixture(t, source), owner = await acquireExecutionOwner({ store: f.store, target: f.root });
  f.beforeClose.push(() => owner.release());
  return { ...f, owner, fenced: (action, payload) => f.store.apply(action, command(f.store, 'run', payload), undefined, owner.ownerId) };
}
const driverConfig = f => ({ store: f.store, owner: f.owner, adapter: f.adapter, archive: f.archive, runId: 'run', root: f.root,
  projectionDirectory: f.directory, gateConfigs: { test: f.gateConfig } });

test('driver completes one effect per step with real gates and idempotent terminal observation', sqlite, async t => {
  const f = await drivenFixture(t), mutableRequest = request(), config = driverConfig(f);
  const driver = createFixtureDriver({ ...config, request: mutableRequest });
  try {
    mutableRequest.scenario = 'fail'; config.gateConfigs.test.gate.argv[0] = 'unapproved.cjs';
    const statuses = [];
    for (let n = 0; n < 4; n++) statuses.push((await driver.step()).state.status);
    assert.equal(statuses.at(-1), 'COMPLETED');
    const state = driver.status().state;
    assert.equal(Object.keys(state.dispatches).length, 3); assert.equal(state.usage.agentCalls, 1);
    assert.equal(state.projection.status, 'ACKNOWLEDGED');
    const version = driver.status().stateVersion;
    await driver.step(); assert.equal(driver.status().stateVersion, version);
    assert.equal(f.store.verify('run').ok, true);
  } finally { await driver.close(); }
});

test('driver rejects overlapping steps/owners and hard stop cancels its running fixture', sqlite, async t => {
  const f = await drivenFixture(t), config = { ...driverConfig(f), request: request('hang') }, driver = createFixtureDriver(config);
  try {
    assert.throws(() => createFixtureDriver(config), e => e.code === 'INVALID_TRANSITION');
    const active = driver.step(); await Promise.resolve();
    assert.throws(() => driver.step(), e => e.code === 'INVALID_TRANSITION');
    assert.equal(f.adapter.inspect(f.adapter.lookup('d-1')).status, 'RUNNING');
    driver.stop({ mode: 'hard', reason: 'owner cancelled' }); await active;
    assert.equal(driver.status().state.dispatches['d-1'].receipt.result, 'cancelled');
    assert.equal((await driver.step()).state.status, 'STOPPED');
    assert.equal(f.store.verify('run').ok, true);
  } finally { await driver.close(); }
});

test('driver hard stop aborts its running real gate and records late evidence without acceptance', sqlite, async t => {
  const f = await drivenFixture(t, 'setTimeout(() => {}, 900)'), driver = createFixtureDriver(driverConfig(f));
  try {
    await driver.step(); const active = driver.step(); await Promise.resolve();
    assert.equal(f.archive.intent('run', 'd-2').status, 'STARTED');
    driver.stop({ mode: 'hard', reason: 'cancel gate' }); await active;
    assert.equal(f.archive.get('run', 'd-2').record.transcript.reason, 'cancelled');
    assert.notEqual(driver.status().state.tasks.build.status, 'SUCCEEDED');
    assert.equal((await driver.step()).state.status, 'STOPPED'); assert.equal(f.store.verify('run').ok, true);
  } finally { await driver.close(); }
});

test('driver graceful stop collects a successful fixture but cannot revive task acceptance', sqlite, async t => {
  const f = await drivenFixture(t), driver = createFixtureDriver({ ...driverConfig(f), request: request('pass', 100) });
  try {
    const active = driver.step(); await Promise.resolve(); driver.stop({ mode: 'graceful', reason: 'finish only current work' });
    await active;
    assert.equal(driver.status().state.dispatches['d-1'].receipt.result, 'pass');
    assert.notEqual(driver.status().state.tasks.build.status, 'CANDIDATE_READY');
    assert.equal((await driver.step()).state.status, 'STOPPED');
  } finally { await driver.close(); }
});

test('driver close cancels and drains owned work before releasing its guard', sqlite, async t => {
  const f = await drivenFixture(t), config = { ...driverConfig(f), request: request('hang') }, driver = createFixtureDriver(config);
  const active = driver.step(); await Promise.resolve();
  const closing = driver.close(); assert.equal(driver.close(), closing); await closing; await active;
  assert.equal(driver.status().state.dispatches['d-1'].receipt.result, 'cancelled');
  assert.throws(() => driver.step(), e => e.code === 'INVALID_TRANSITION');
  const replacement = createFixtureDriver(config);
  try { assert.equal((await replacement.step()).state.status, 'STOPPED'); } finally { await replacement.close(); }
});

test('driver never reruns a claim-before-journal gap', sqlite, async t => {
  const f = await drivenFixture(t); f.fenced('claim', { effectId: 'd-1' });
  const driver = createFixtureDriver(driverConfig(f));
  try {
    await assert.rejects(driver.step(), e => e.code === 'EFFECT_UNKNOWN');
    assert.equal(driver.status().state.status, 'RECOVERY_REQUIRED'); assert.equal(f.adapter.lookup('d-1'), null);
    await assert.rejects(driver.step(), e => e.code === 'EFFECT_UNKNOWN'); assert.equal(f.store.verify('run').ok, true);
  } finally { await driver.close(); }
});

test('driver replays a lost projection ACK but preserves a manually edited projection', sqlite, async t => {
  for (const edited of [false, true]) {
    const f = await drivenFixture(t), driver = createFixtureDriver(driverConfig(f));
    try {
      for (let n = 0; n < 3; n++) await driver.step();
      f.fenced('tick', tick);
      const effect = f.store.effects('run').find(e => e.kind === 'projection');
      f.fenced('claim', { effectId: effect.id });
      const receipt = publishProjection({ directory: f.directory, runId: 'run', effect: { id: effect.id, kind: effect.kind, payload: effect.payload } });
      if (edited) {
        writeFileSync(join(f.directory, receipt.fileName), 'owner edit');
        await assert.rejects(driver.step(), e => e.code === 'PROJECTION_CONFLICT');
        assert.equal(driver.status().state.status, 'RECOVERY_REQUIRED');
        assert.equal(readFileSync(join(f.directory, receipt.fileName), 'utf8'), 'owner edit');
      } else assert.equal((await driver.step()).state.status, 'COMPLETED');
      assert.equal(f.store.verify('run').ok, true);
    } finally { await driver.close(); }
  }
});

test('driver rejects product projections and expired admission starts no process', sqlite, async t => {
  const f = await drivenFixture(t), config = driverConfig(f);
  assert.throws(() => createFixtureDriver({ ...config, projectionDirectory: f.root }), e => e.code === 'SCOPE_DENIED');
  const driver = createFixtureDriver({ ...config, now: () => f.store.status('run').state.startedAt + 60001 });
  try {
    await driver.step(); assert.equal(f.adapter.lookup('d-1'), null);
    assert.equal((await driver.step()).state.status, 'STOPPED'); assert.equal(driver.status().state.reason, 'time_limit');
  } finally { await driver.close(); }
});

test('T12: driver requires an owner and refuses a state directory inside the product before binding', sqlite, async t => {
  const f = await drivenFixture(t), config = driverConfig(f);
  assert.throws(() => createFixtureDriver({ ...config, owner: undefined }), e => e.code === 'CAPABILITY_MISSING');
  const inner = join(f.root, '.state'); mkdirSync(inner);
  const nested = await openStore(join(inner, 'control.sqlite'));
  try {
    const { spec, artifacts } = f.store.bundle('run'); nested.create(spec, artifacts, { simulation: true });
    assert.throws(() => createFixtureDriver({ ...config, store: nested }), e => e.code === 'SCOPE_DENIED');
    assert.equal(existsSync(join(inner, 'execution-owner.sqlite')), false, 'no lock file was opened inside the product');
  } finally { nested.close(); rmSync(inner, { recursive: true }); }
  assert.equal(f.adapter.lookup('d-1'), null);
  const driver = createFixtureDriver(config);
  try { assert.equal((await driver.step()).state.dispatches['d-1'].receipt.result, 'pass'); } finally { await driver.close(); }
});
