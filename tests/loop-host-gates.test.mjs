import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesDigest, digest, specDigest } from '../src/loop/contracts.mjs';
import { command, demoBundle } from '../src/loop/demo.mjs';
import { openStore } from '../src/loop/store.mjs';
import { openEvidenceArchive } from '../src/loop/evidence.mjs';
import { snapshotRepository } from '../src/loop/snapshots.mjs';
import { gateDigest, gateInvocation, runLocalGate } from '../src/loop/gates.mjs';
import { executeStoredGate, settleRecordedGate } from '../src/loop/host-gates.mjs';
import { survivingDescendantSource } from './fixtures/surviving-descendant.mjs';

const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Host integration requires Node 24+' : false };
const executableDigest = bytesDigest(readFileSync(process.execPath));
const tick = { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null };
async function fixture(t, source = 'process.stdout.write("host checked")') {
  const dir = mkdtempSync(join(tmpdir(), 'ai-host-gate-')), root = join(dir, 'product');
  mkdirSync(root); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/check.cjs'), source);
  writeFileSync(join(root, '.gitignore'), '*.ignored\n'); writeFileSync(join(root, 'oracle.ignored'), 'approved');
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const oracle = ['src/check.cjs', 'oracle.ignored'].map(path => ({ path, digest: bytesDigest(readFileSync(join(root, path))) }));
  const gate = { id: 'test', repoId: 'product', executableRef: { id: 'node', digest: executableDigest }, argv: ['check.cjs'],
    cwd: { repoId: 'product', relativePath: 'src' }, envProfileId: 'empty', timeoutMs: 1000, successExitCodes: [0],
    oracleBundleRef: { id: 'oracle', digest: digest(oracle) }, networkPolicyId: 'local-attended-inherit' };
  gate.specDigest = gateDigest(gate);
  const snapshot = snapshotRepository({ root });
  const { spec, artifacts } = demoBundle('run');
  artifacts.snapshot = snapshot; artifacts.gate = gate;
  artifacts.manifest.gates[0].artifactRef.digest = digest(gate);
  spec.manifestRef.digest = digest(artifacts.manifest); spec.initialSnapshotRef.digest = digest(snapshot);
  spec.approvedSpecDigest = specDigest(spec);
  const store = await openStore(join(dir, 'control.sqlite')), archive = await openEvidenceArchive(join(dir, 'evidence.sqlite'));
  t.after(() => { store.close(); archive.close(); rmSync(dir, { recursive: true, force: true }); });
  store.create(spec, artifacts, { simulation: true });
  store.apply('tick', command(store, 'run', tick)); store.apply('claim', command(store, 'run', { effectId: 'd-1' }));
  store.apply('settle', command(store, 'run', { dispatchId: 'd-1', result: 'pass', candidate: digest(snapshot), tokens: 0, costMicroUsd: 0 }));
  store.apply('tick', command(store, 'run', tick));
  const config = { gate, repoRoots: { product: root }, executables: { node: process.execPath }, envProfiles: { empty: {} },
    oracleBundles: { oracle }, expectedCandidate: digest(snapshot), runId: 'run', taskId: 'build', dispatchId: 'd-2' };
  const intent = { runId: 'run', dispatchId: 'd-2', taskId: 'build', candidateSnapshotRef: { id: snapshot.id, digest: digest(snapshot) },
    gateRef: { id: gate.id, digest: gate.specDigest }, invocationDigest: digest(gateInvocation(gate, {})) };
  return { store, archive, dir, root, config, intent, input: { store, archive, runId: 'run', dispatchId: 'd-2', config } };
}

test('real task and final gates persist evidence and replay without live agents', sqlite, async t => {
  const f = await fixture(t); await executeStoredGate(f.input);
  assert.equal(f.archive.intent('run', 'd-2').status, 'RECORDED');
  assert.equal(f.store.status('run').state.tasks.build.status, 'SUCCEEDED');
  assert.equal(f.store.status('run').state.dispatches['d-2'].evidenceRef.digest, f.archive.get('run', 'd-2').reference.digest);
  const repeated = settleRecordedGate({ ...f.input, repoRoots: f.config.repoRoots }); assert.equal(repeated.alreadySettled, true);
  f.store.apply('tick', command(f.store, 'run', tick));
  await executeStoredGate({ ...f.input, dispatchId: 'd-3' });
  assert.equal(f.archive.get('run', 'd-3').record.evidence.taskId, 'run-final');
  f.store.apply('tick', command(f.store, 'run', tick));
  const effectId = f.store.status('run').state.projection.id;
  f.store.apply('claim', command(f.store, 'run', { effectId })); f.store.apply('projected', command(f.store, 'run', { effectId }));
  assert.equal(f.store.status('run').state.status, 'COMPLETED'); assert.equal(f.store.verify('run').ok, true);
});

test('recorded-before-settle survives reopening and never reexecutes', sqlite, async t => {
  const f = await fixture(t);
  f.archive.reserve(f.intent); f.store.apply('claim', command(f.store, 'run', { effectId: 'd-2' }));
  f.archive.transition('run', 'd-2', 'PENDING', 'STARTED'); f.archive.put(await runLocalGate(f.config));
  const second = await openEvidenceArchive(join(f.dir, 'evidence.sqlite'));
  try {
    await assert.rejects(executeStoredGate({ ...f.input, archive: second }), e => e.code === 'EFFECT_UNKNOWN');
    settleRecordedGate({ ...f.input, archive: second, repoRoots: f.config.repoRoots });
    assert.equal(f.store.status('run').state.tasks.build.status, 'SUCCEEDED');
    assert.equal(f.store.verify('run').ok, true);
  } finally { second.close(); }
});

test('STARTED and UNKNOWN intents cannot be automatically executed twice', sqlite, async t => {
  const f = await fixture(t); f.archive.reserve(f.intent);
  f.store.apply('claim', command(f.store, 'run', { effectId: 'd-2' }));
  const second = await openEvidenceArchive(join(f.dir, 'evidence.sqlite'));
  try {
    f.archive.transition('run', 'd-2', 'PENDING', 'STARTED');
    assert.throws(() => second.transition('run', 'd-2', 'PENDING', 'STARTED'), e => e.code === 'EFFECT_UNKNOWN');
    await assert.rejects(executeStoredGate(f.input), e => e.code === 'EFFECT_UNKNOWN');
    f.archive.transition('run', 'd-2', 'STARTED', 'UNKNOWN');
    await assert.rejects(executeStoredGate(f.input), e => e.code === 'EFFECT_UNKNOWN');
    assert.equal(f.store.status('run').state.tasks.build.attempts, 1);
  } finally { second.close(); }
});

test('gate mutation requires recovery instead of scheduling repair on an unverified tree', sqlite, async t => {
  const f = await fixture(t, 'require("node:fs").writeFileSync("changed.txt","unexpected");');
  const result = await executeStoredGate(f.input);
  assert.equal(result.recoveryRequired, true);
  assert.equal(f.archive.get('run', 'd-2').record.evidence.result, 'error');
  assert.equal(f.store.status('run').state.status, 'RECOVERY_REQUIRED');
  assert.equal(f.store.status('run').state.dispatches['d-2'].status, 'UNKNOWN');
});

test('ignored oracle changed after recording cannot yield accepted stale evidence', sqlite, async t => {
  const f = await fixture(t); f.archive.reserve(f.intent); f.store.apply('claim', command(f.store, 'run', { effectId: 'd-2' }));
  f.archive.transition('run', 'd-2', 'PENDING', 'STARTED'); f.archive.put(await runLocalGate(f.config));
  writeFileSync(join(f.root, 'oracle.ignored'), 'changed after gate');
  const result = settleRecordedGate({ ...f.input, repoRoots: f.config.repoRoots });
  assert.equal(result.recoveryRequired, true); assert.equal(f.store.status('run').state.status, 'RECOVERY_REQUIRED');
});

test('nonzero gate receipt is archived but does not satisfy task acceptance', sqlite, async t => {
  const f = await fixture(t, 'process.exit(7)'); await executeStoredGate(f.input);
  assert.equal(f.archive.get('run', 'd-2').record.evidence.result, 'fail');
  assert.equal(f.store.status('run').state.tasks.build.status, 'READY');
  assert.equal(f.store.verify('run').ok, true);
});

test('deadline at claim cancels intent before execution', sqlite, async t => {
  const f = await fixture(t);
  const result = await executeStoredGate({ ...f.input, now: () => f.store.status('run').state.startedAt + 60001 });
  assert.equal(result.cancelledBeforeStart, true); assert.equal(f.archive.intent('run', 'd-2').status, 'CANCELLED');
  assert.throws(() => f.archive.get('run', 'd-2'), e => e.code === 'UNKNOWN_REFERENCE');
});

test('late result after stop is recorded without reviving acceptance', sqlite, async t => {
  const f = await fixture(t, 'setTimeout(() => {}, 100)');
  const promise = executeStoredGate(f.input);
  f.store.apply('stop', command(f.store, 'run', { mode: 'hard', reason: 'operator' }));
  await promise;
  const state = f.store.status('run').state;
  assert.equal(state.reason, 'user_stop'); assert.notEqual(state.tasks.build.status, 'SUCCEEDED');
  assert.equal(state.dispatches['d-2'].status, 'ACKNOWLEDGED'); assert.equal(f.store.verify('run').ok, true);
});

test('recovered claim-before-start gap rechecks deadline instead of running', sqlite, async t => {
  const f = await fixture(t); f.archive.reserve(f.intent);
  f.store.apply('claim', command(f.store, 'run', { effectId: 'd-2' }));
  const result = await executeStoredGate({ ...f.input, now: () => f.store.status('run').state.startedAt + 60001 });
  assert.equal(result.cancelledBeforeStart, true);
  assert.equal(f.archive.intent('run', 'd-2').status, 'CANCELLED');
  assert.equal(f.store.status('run').state.dispatches['d-2'].receipt.result, 'cancelled');
  assert.equal(f.store.verify('run').ok, true);
});

test('timeout with surviving descendants enters recovery instead of scheduling repair', sqlite, async t => {
  const f = await fixture(t, survivingDescendantSource());
  const result = await executeStoredGate(f.input);
  const record = f.archive.get('run', 'd-2').record;
  assert.equal(record.transcript.reason, 'orphaned_process_group');
  assert.equal(record.scopeAttestation.recoveryRequired, true);
  assert.equal(result.recoveryRequired, true);
  const state = f.store.status('run').state;
  assert.equal(state.status, 'RECOVERY_REQUIRED');
  assert.notEqual(state.tasks.build.status, 'READY');
  assert.equal(state.dispatches['d-2'].status, 'UNKNOWN');
  assert.equal(f.store.verify('run').ok, true);
});
