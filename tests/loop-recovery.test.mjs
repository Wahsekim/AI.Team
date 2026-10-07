import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesDigest, digest, specDigest } from '../src/loop/contracts.mjs';
import { command, demoBundle } from '../src/loop/demo.mjs';
import { openStore, openStoreReadOnly } from '../src/loop/store.mjs';
import { LOCK_FILE } from '../src/loop/execution-owner.mjs';
import { SNAPSHOT_SOURCE } from '../src/loop/hot-journal.mjs';
import { publishProjection } from '../src/loop/projector.mjs';
import { snapshotRepository } from '../src/loop/snapshots.mjs';
import { gateDigest } from '../src/loop/gates.mjs';

// R05b (ADR 0005). Child hosts self-exit within 10 s (driver-crash-host, hot-journal-writer) or 8 s (execution-owner-host,
// lock holder); fixture workers within 5 s. Teardown signals only handles this file spawned, never a saved PID.
const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Recovery tests require Node 24+ (node:sqlite)' : false, timeout: 40000 };
const cli = fileURLToPath(new URL('../scripts/team-run.mjs', import.meta.url));
const crashHost = fileURLToPath(new URL('./fixtures/driver-crash-host.mjs', import.meta.url));
const ownerHost = fileURLToPath(new URL('./fixtures/execution-owner-host.mjs', import.meta.url));
const spillWriter = fileURLToPath(new URL('./fixtures/hot-journal-writer.mjs', import.meta.url));
const env = { PATH: process.env.PATH ?? '' };
const PASS = { scenario: 'pass', delayMs: 0, timeoutMs: 1000 };
const LOCK_HOLDER = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE'); process.stdout.write('{"held":true}\\n');
setTimeout(() => process.exit(9), 8000); process.stdin.once('data', () => process.exit(0));`;

const run = (args, timeout = 15000) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout, killSignal: 'SIGKILL', env });
  let json = null; try { json = JSON.parse(result.stdout); } catch { /* show prints text */ }
  return { status: result.status, stdout: result.stdout, json };
};
const refused = (result, exit, code, label = '') => {
  assert.equal(result.status, exit, `${label} ${result.stdout}`); assert.equal(result.json?.code, code, `${label} ${result.stdout}`);
};
const ok = (result, label = '') => { assert.equal(result.status, 0, `${label} ${result.stdout}`); return result.json?.value; };
const scratch = t => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'ai-recovery-'))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// Durable facts a refused command must leave alone, and the history rows that may only grow (V9).
async function facts(directory) {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(directory, 'loop.sqlite'), { readOnly: true });
  try {
    const has = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return { sha: sha(join(directory, 'loop.sqlite')), versions: db.prepare('SELECT id, version FROM runs ORDER BY id').all().map(r => ({ ...r })),
      history: { events: db.prepare('SELECT count(*) AS n FROM events').get().n, audit: has('operator_audit') ? db.prepare('SELECT count(*) AS n FROM operator_audit').get().n : 0,
        executions: has('executions') ? db.prepare('SELECT count(*) AS n FROM executions').get().n : 0 } };
  } finally { db.close(); }
}
function grows(previous, next, label) {
  for (const key of Object.keys(previous)) assert.ok(next[key] >= previous[key], `${label}: ${key} history shrank (${previous[key]} -> ${next[key]})`);
  return next;
}
const state = directory => run(['status', directory, 'run']).json.value.state;
const eventDigests = directory => run(['events', directory, 'run']).json.value.map(e => e.digest);

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
  return { spec, artifacts, root };
}
async function createRun(directory, bundle) {
  const store = await openStore(join(directory, 'loop.sqlite'));
  try { store.create(bundle.spec, bundle.artifacts, { simulation: true }); } finally { store.close(); }
}

// A line-oriented child; teardown signals only this handle.
function startChild(t, args) {
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
  const next = (predicate, ms = 9000) => new Promise((resolve, reject) => {
    const check = () => { const event = events.find(predicate); if (event) { done(); resolve(event); } };
    const timer = setTimeout(() => { done(); reject(new Error(`child did not report in ${ms} ms: ${stderr}`)); }, ms);
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

async function killedHost(t, boundary, request = PASS) {
  const directory = scratch(t), bundle = prepare(directory, request);
  await createRun(directory, bundle);
  const host = startChild(t, [crashHost, directory, boundary]);
  await host.next(e => e.paused);
  host.child.kill('SIGKILL'); assert.equal((await host.exited).signal, 'SIGKILL');
  const pids = host.events.filter(e => e.source === 'adapter' && e.phase === 'spawned-before-pid-save').map(e => e.pid);
  await assertGroupsGone(pids);
  return { directory, root: bundle.root, ownerId: host.events.find(e => e.source === 'owner').ownerId };
}

// SIGKILL after a cache spill: the journal is synced and pages are overwritten, so it is hot (precondition asserted).
async function spillHot(t, file, extraSql = '') {
  const writer = startChild(t, [spillWriter, file, extraSql]);
  await writer.next(e => e.spilled);
  writer.child.kill('SIGKILL'); assert.equal((await writer.exited).signal, 'SIGKILL');
  assert.ok(statSync(`${file}-journal`).size > 0, 'journal left behind');
  const { DatabaseSync } = await import('node:sqlite');
  assert.throws(() => { const db = new DatabaseSync(file, { readOnly: true }); try { db.prepare('SELECT count(*) FROM sqlite_master').get(); } finally { db.close(); } },
    e => e.errcode === 776, 'the journal is hot');
}

async function holdLock(t, directory) {
  const holder = startChild(t, ['-e', LOCK_HOLDER, join(directory, LOCK_FILE)]);
  await holder.next(e => e.held);
  return async () => { holder.child.stdin.end('release\n'); assert.equal((await holder.exited).code, 0); };
}

test('V1: a durable receipt is ingested once, usage from the receipt; replay is identical; the run stays RECOVERY_REQUIRED until abandon', sqlite, async t => {
  const k = await killedHost(t, 'receipt-before-settle');
  assert.deepEqual(run(['inspect', k.directory, 'run']).json.value.recoverySteps.map(s => s.action), ['ingest-receipt', 'close-execution-marker']);
  let history = (await facts(k.directory)).history;
  const ingested = ok(run(['ingest-receipt', k.directory, 'run', 'd-1']), 'ingest');
  assert.equal(ingested.settled, true); assert.equal(ingested.result, 'pass'); assert.equal(ingested.interruptedFirst, true);
  assert.deepEqual(ingested.usage, { tokens: 0, costMicroUsd: 0, source: 'receipt' });
  assert.equal(ingested.status, 'RECOVERY_REQUIRED');
  let s = state(k.directory);
  assert.deepEqual(s.dispatches['d-1'].receipt, { dispatchId: 'd-1', result: 'pass', candidate: s.dispatches['d-1'].candidate, tokens: 0, costMicroUsd: 0 });
  assert.equal(s.status, 'RECOVERY_REQUIRED'); assert.equal(s.tasks.build.attempts, 1);
  const events = run(['events', k.directory, 'run']).json.value;
  assert.deepEqual(events.slice(-2).map(e => e.action), ['interrupted', 'settle']);
  history = grows(history, (await facts(k.directory)).history, 'ingest');
  const settled = await facts(k.directory), digests = eventDigests(k.directory);
  const again = ok(run(['ingest-receipt', k.directory, 'run', 'd-1']), 'repeat');
  assert.equal(again.alreadySettled, true);
  assert.deepEqual(await facts(k.directory), settled, 'a repeated ingest records nothing'); assert.deepEqual(eventDigests(k.directory), digests);
  assert.equal(ok(run(['audit', k.directory, 'run'])).ok, true);
  assert.deepEqual(run(['inspect', k.directory, 'run']).json.value.recoverySteps.map(s => s.action), ['abandon', 'close-execution-marker']);
  const abandoned = ok(run(['abandon', k.directory, 'run', '--note', 'V1 operator closes after ingest', '--confirm', 'run']), 'abandon');
  assert.equal(abandoned.interruptedFirst, false); assert.equal(abandoned.status, 'QUIESCING'); assert.equal(abandoned.reason, 'recovery_abandoned');
  s = state(k.directory);
  assert.equal(s.dispatches['d-1'].receipt.result, 'pass', 'the ingested receipt is kept'); assert.equal(s.tasks.build.attempts, 1);
  assert.equal(s.usage.tokens, null); assert.equal(s.usage.agentCalls, 1);
  history = grows(history, (await facts(k.directory)).history, 'abandon');
  const before = await facts(k.directory);
  const closed = ok(run(['close-execution-marker', k.directory, '--owner', k.ownerId, '--note', 'V1 host SIGKILLed']), 'close');
  assert.equal(closed.closed, true);
  const after = await facts(k.directory);
  assert.deepEqual(after.versions, before.versions, 'closing the marker leaves run state alone');
  grows(history, after.history, 'close');
});

test('V1b: a receipt without usage settles with usage unknown, never zero', sqlite, async t => {
  const k = await killedHost(t, 'receipt-before-settle', { scenario: 'crash', delayMs: 0, timeoutMs: 1000 });
  const ingested = ok(run(['ingest-receipt', k.directory, 'run', 'd-1']), 'ingest');
  assert.equal(ingested.result, 'error');
  assert.deepEqual(ingested.usage, { tokens: null, costMicroUsd: null, source: 'absent from receipt: unknown' });
  const s = state(k.directory);
  assert.equal(s.dispatches['d-1'].receipt.tokens, null); assert.equal(s.usage.tokens, null); assert.equal(s.usage.costMicroUsd, null);
  const usage = run(['inspect', k.directory, 'run']).json.value.usage;
  assert.deepEqual(usage.tokens, { status: 'unknown', recorded: null });
});

test('V2: no receipt is refused; abandon waits for a readable receipt source, then records an operator confirmation and keeps spend and attempts', sqlite, async t => {
  const k = await killedHost(t, 'process-before-receipt');
  const initial = await facts(k.directory);
  refused(run(['ingest-receipt', k.directory, 'run', 'd-1']), 2, 'RECEIPT_MISSING', 'reserved row without result');
  const journal = join(k.directory, 'fixture.sqlite'), saved = readFileSync(journal);
  for (const [label, damage] of [['absent', () => renameSync(journal, `${journal}.aside`)], ['garbage', () => writeFileSync(journal, Buffer.from('not a database '.repeat(64)))]]) {
    damage();
    refused(run(['abandon', k.directory, 'run', '--note', 'V2 attempt', '--confirm', 'run']), 2, 'RECEIPT_SOURCE_UNKNOWN', label);
    refused(run(['ingest-receipt', k.directory, 'run', 'd-1']), 2, 'RECEIPT_SOURCE_UNKNOWN', label);
    if (label === 'absent') renameSync(`${journal}.aside`, journal);
  }
  writeFileSync(journal, saved);
  refused(run(['abandon', k.directory, 'run', '--note', 'V2', '--confirm', 'other']), 2, 'INVALID_SPEC', 'wrong confirmation');
  refused(run(['abandon', k.directory, 'run', '--note', '   ', '--confirm', 'run']), 2, 'INVALID_SPEC', 'blank note');
  refused(run(['abandon', k.directory, 'run', '--confirm', 'run']), 2, 'INVALID_SPEC', 'missing note');
  assert.deepEqual(await facts(k.directory), initial, 'every refusal left the store unchanged');
  const note = 'V2 operator: worker group gone per ps; journal has no result';
  const out = run(['abandon', k.directory, 'run', '--note', note, '--confirm', 'run']), value = ok(out, 'abandon');
  assert.equal(value.confirmation, 'operator confirmation'); assert.equal(value.processExit, 'not verified by the host');
  assert.equal(value.interruptedFirst, true); assert.deepEqual(value.dispatches, ['d-1']);
  assert.equal(value.status, 'QUIESCING'); assert.equal(value.reason, 'recovery_abandoned');
  assert.deepEqual(value.usage, { agentCalls: 1, tokens: null, costMicroUsd: null }); assert.deepEqual(value.attempts, { build: 1 });
  let s = state(k.directory);
  assert.deepEqual(s.dispatches['d-1'].receipt, { result: 'cancelled', tokens: null, costMicroUsd: null });
  // V9: recorded as an operator confirmation; nothing claims a verified process exit.
  const event = run(['events', k.directory, 'run']).json.value.at(-1);
  assert.equal(event.action, 'abandon'); assert.deepEqual(Object.keys(event.payload).sort(), ['note', 'operatorConfirmation']);
  assert.deepEqual(s.abandonment, { by: 'operator', operatorConfirmation: 'run', note, at: s.abandonment.at });
  for (const text of [JSON.stringify(event), JSON.stringify(s), out.stdout]) assert.doesNotMatch(text, /confirmedProcess|processesExited|exit(ed)?[ _]?(confirmed|verified)"?\s*[:=]\s*true|verified (process )?exit/i);
  let history = grows(initial.history, (await facts(k.directory)).history, 'abandon');
  const abandoned = await facts(k.directory);
  refused(run(['abandon', k.directory, 'run', '--note', 'again', '--confirm', 'run']), 2, 'INVALID_TRANSITION', 'second abandon');
  refused(run(['ingest-receipt', k.directory, 'run', 'd-1']), 2, 'RECEIPT_MISSING', 'no receipt appears later');
  assert.deepEqual(await facts(k.directory), abandoned);
  ok(run(['close-execution-marker', k.directory, '--owner', k.ownerId, '--note', 'V2 host SIGKILLed']), 'close');
  // The same unknown job is never re-enabled: no claim, and the next tick only closes out.
  const store = await openStore(join(k.directory, 'loop.sqlite'));
  try {
    assert.throws(() => store.apply('claim', command(store, 'run', { effectId: 'd-1' })), e => e.code === 'INVALID_TRANSITION');
    store.apply('tick', command(store, 'run', { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null }));
    s = store.status('run').state;
    assert.deepEqual(Object.keys(s.dispatches), ['d-1']); assert.equal(s.tasks.build.attempts, 1); assert.equal(s.usage.agentCalls, 1);
    assert.equal(s.usage.tokens, null); assert.equal(s.projection.outcome, 'STOPPED');
  } finally { store.close(); }
  history = grows(history, (await facts(k.directory)).history, 'close');
});

test('V3: a receipt that does not match its digest or the current candidate is refused and the store is unchanged', sqlite, async t => {
  const k = await killedHost(t, 'receipt-before-settle');
  const initial = await facts(k.directory), journal = join(k.directory, 'fixture.sqlite');
  const { DatabaseSync } = await import('node:sqlite'), raw = new DatabaseSync(journal);
  const original = raw.prepare("SELECT result FROM fixture_dispatches WHERE dispatch_id='d-1'").get().result;
  try { raw.prepare("UPDATE fixture_dispatches SET result=? WHERE dispatch_id='d-1'").run(original.replaceAll('"result":"pass"', '"result":"fail"')); } finally { raw.close(); }
  refused(run(['ingest-receipt', k.directory, 'run', 'd-1']), 2, 'RECEIPT_MISMATCH', 'edited receipt');
  assert.equal(run(['inspect', k.directory, 'run']).json.value.dispatches[0].receipt.integrity, 'digest mismatch');
  const restore = new DatabaseSync(journal);
  try { restore.prepare("UPDATE fixture_dispatches SET result=? WHERE dispatch_id='d-1'").run(original); } finally { restore.close(); }
  const file = join(k.root, 'src/check.cjs'), bytes = readFileSync(file);
  writeFileSync(file, `${bytes}\n// changed after the build was scheduled`);
  refused(run(['ingest-receipt', k.directory, 'run', 'd-1']), 2, 'STALE_RECEIPT', 'stale product');
  assert.deepEqual(await facts(k.directory), initial, 'refusals changed nothing');
  writeFileSync(file, bytes);
  assert.equal(ok(run(['ingest-receipt', k.directory, 'run', 'd-1']), 'restored').settled, true);
});

test('V4: after a kill with an edited projection, recovery commands accept nothing and the edit is preserved', sqlite, async t => {
  const k = await killedHost(t, 'projection-before-ack');
  const s = state(k.directory), file = join(k.directory, `run.${s.projection.id}.md`);
  const original = readFileSync(file, 'utf8'), edited = original.replace('simulation result', 'simulation RESULT');
  assert.notEqual(edited, original); writeFileSync(file, edited);
  const initial = await facts(k.directory);
  for (const id of Object.keys(s.dispatches)) assert.equal(ok(run(['ingest-receipt', k.directory, 'run', id]), id).alreadySettled, true, id);
  refused(run(['abandon', k.directory, 'run', '--note', 'V4', '--confirm', 'run']), 2, 'INVALID_TRANSITION', 'nothing unresolved');
  assert.deepEqual(await facts(k.directory), initial);
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.equal(run(['inspect', k.directory, 'run']).json.value.projections[0].publishedFile, 'present, differs');
  const effect = run(['inspect', k.directory, 'run']).json.value.projections[0], reader = await openStoreReadOnly(join(k.directory, 'loop.sqlite'));
  const outbox = reader.effects('run').find(e => e.id === effect.id); reader.close();
  assert.throws(() => publishProjection({ directory: k.directory, runId: 'run', effect: { id: outbox.id, kind: outbox.kind, payload: outbox.payload } }), e => e.code === 'PROJECTION_CONFLICT');
  assert.equal(readFileSync(file, 'utf8'), edited);
});

test('V5: gate evidence missing or unreadable refuses ingest; abandon waits until the archive is readable', sqlite, async t => {
  const k = await killedHost(t, 'gate-receipt-before-settle');
  const initial = await facts(k.directory), archive = join(k.directory, 'evidence.sqlite');
  renameSync(archive, `${archive}.aside`);
  const v = run(['inspect', k.directory, 'run']).json.value;
  assert.equal(v.dispatches.find(d => d.id === 'd-2').receipt.present, null); assert.equal(v.recoverySteps[0].action, 'receipt-unknown');
  refused(run(['ingest-receipt', k.directory, 'run', 'd-2']), 2, 'RECEIPT_SOURCE_UNKNOWN', 'archive absent');
  refused(run(['abandon', k.directory, 'run', '--note', 'V5', '--confirm', 'run']), 2, 'RECEIPT_SOURCE_UNKNOWN', 'archive absent');
  renameSync(`${archive}.aside`, archive);
  // Simulated loss of the archived record (test setup only; no command deletes rows).
  const { DatabaseSync } = await import('node:sqlite'), raw = new DatabaseSync(archive);
  try { raw.prepare("DELETE FROM gate_records WHERE dispatch_id='d-2'").run(); } finally { raw.close(); }
  refused(run(['ingest-receipt', k.directory, 'run', 'd-2']), 2, 'RECEIPT_MISSING', 'record absent');
  assert.deepEqual(await facts(k.directory), initial);
  const value = ok(run(['abandon', k.directory, 'run', '--note', 'V5 evidence lost', '--confirm', 'run']), 'abandon');
  assert.deepEqual(value.dispatches, ['d-2']); assert.deepEqual(value.durableReceiptsNotIngested, []);
});

test('V5b: durable gate evidence is ingested through the archive, once', sqlite, async t => {
  const k = await killedHost(t, 'gate-receipt-before-settle');
  const value = ok(run(['ingest-receipt', k.directory, 'run', 'd-2']), 'ingest');
  assert.equal(value.result, 'pass'); assert.equal(value.usage.source, 'host-local gate: no provider usage');
  const s = state(k.directory);
  assert.equal(s.dispatches['d-2'].receipt.result, 'pass'); assert.match(s.dispatches['d-2'].evidenceRef.id, /^evidence-/);
  assert.equal(s.status, 'RECOVERY_REQUIRED');
  const settled = await facts(k.directory);
  assert.equal(ok(run(['ingest-receipt', k.directory, 'run', 'd-2'])).alreadySettled, true);
  assert.deepEqual(await facts(k.directory), settled);
});

test('V6: close-execution-marker needs the exact owner, a note and a free lock; it closes as operator and leaves run state alone', sqlite, async t => {
  const k = await killedHost(t, 'claim-before-start');
  const initial = await facts(k.directory);
  refused(run(['close-execution-marker', k.directory, '--owner', 'not-the-owner', '--note', 'V6']), 2, 'UNKNOWN_REFERENCE', 'wrong owner');
  refused(run(['close-execution-marker', k.directory, '--owner', k.ownerId, '--note', ' ']), 2, 'INVALID_SPEC', 'blank note');
  refused(run(['close-execution-marker', k.directory, '--owner', k.ownerId]), 2, 'INVALID_SPEC', 'missing note');
  const release = await holdLock(t, k.directory);
  refused(run(['close-execution-marker', k.directory, '--owner', k.ownerId, '--note', 'V6']), 4, 'EXECUTION_OWNER_ACTIVE', 'lock held');
  refused(run(['ingest-receipt', k.directory, 'run', 'd-1']), 4, 'EXECUTION_OWNER_ACTIVE', 'lock held');
  refused(run(['abandon', k.directory, 'run', '--note', 'V6', '--confirm', 'run']), 4, 'EXECUTION_OWNER_ACTIVE', 'lock held');
  await release();
  assert.deepEqual(await facts(k.directory), initial);
  const value = ok(run(['close-execution-marker', k.directory, '--owner', k.ownerId, '--note', 'V6 host SIGKILLed']), 'close');
  assert.equal(value.closed, true); assert.equal(value.runStateChanged, false);
  const after = await facts(k.directory), reader = await openStoreReadOnly(join(k.directory, 'loop.sqlite'));
  try {
    assert.deepEqual(reader.executions().map(e => [e.owner_id, e.open, e.close_kind, e.close_note]), [[k.ownerId, 0, 'operator', 'V6 host SIGKILLed']]);
    assert.deepEqual(reader.operatorAudit().map(a => [a.action, a.note, a.detail.ownerId, a.detail.pidAuthority]), [['close-execution-marker', 'V6 host SIGKILLed', k.ownerId, false]]);
  } finally { reader.close(); }
  assert.deepEqual(after.versions, initial.versions);
  refused(run(['close-execution-marker', k.directory, '--owner', k.ownerId, '--note', 'again']), 2, 'UNKNOWN_REFERENCE', 'already closed');
});

test('V7: a live driver mid-step excludes every recovery command; after stop --hard and its close they proceed', { ...sqlite, timeout: 45000 }, async t => {
  const directory = scratch(t), bundle = prepare(directory, { scenario: 'pass', delayMs: 300, timeoutMs: 2000 });
  await createRun(directory, bundle);
  const host = startChild(t, [ownerHost, 'drive', directory]);
  await host.next(e => e.source === 'adapter' && e.phase === 'spawned-before-pid-save');
  const ownerId = run(['inspect', directory, 'run']).json.value.marker.ownerId;
  refused(run(['ingest-receipt', directory, 'run', 'd-1']), 4, 'EXECUTION_OWNER_ACTIVE', 'ingest mid-step');
  refused(run(['abandon', directory, 'run', '--note', 'V7', '--confirm', 'run']), 4, 'EXECUTION_OWNER_ACTIVE', 'abandon mid-step');
  refused(run(['close-execution-marker', directory, '--owner', ownerId, '--note', 'V7']), 4, 'EXECUTION_OWNER_ACTIVE', 'close mid-step');
  refused(run(['recover-journal', directory, '--note', 'V7']), 4, 'EXECUTION_OWNER_ACTIVE', 'recover mid-step');
  await host.next(e => e.paused);
  assert.equal(ok(run(['stop', directory, 'run', '--hard'])).recorded, true);
  host.child.stdin.end('go\n');
  const done = await host.next(e => e.done);
  assert.equal(done.status, 'STOPPED'); assert.deepEqual(done.released, { markerClosed: true });
  assert.equal((await host.exited).code, 0);
  assert.equal(ok(run(['ingest-receipt', directory, 'run', 'd-1'])).alreadySettled, true);
  refused(run(['abandon', directory, 'run', '--note', 'V7', '--confirm', 'run']), 2, 'RUN_TERMINAL', 'after close');
  const actions = run(['events', directory, 'run']).json.value.map(e => e.action);
  assert.ok(!actions.includes('abandon') && !actions.includes('interrupted'), actions.join(','));
});

test('V8: a hot journal is read through a labelled snapshot; recover-journal rolls it back under the lock and audits it', sqlite, async t => {
  const directory = scratch(t), file = join(directory, 'loop.sqlite'), store = await openStore(file);
  try { const { spec, artifacts } = demoBundle('run'); store.create(spec, artifacts, { simulation: true }); store.apply('tick', command(store, 'run', { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null })); }
  finally { store.close(); }
  await spillHot(t, file, 'UPDATE runs SET version=version+100');
  await assert.rejects(openStoreReadOnly(file), e => e.code === 'STORE_UNREADABLE' && e.errcode === 776);
  const originals = () => [file, `${file}-journal`].map(f => ({ sha: sha(f), mtime: statSync(f).mtimeMs, ino: statSync(f).ino }));
  const before = originals(), snapshots = () => readdirSync(tmpdir()).filter(n => n.startsWith('ai-loop-snapshot-')).sort(), leftovers = snapshots();
  for (const action of ['status', 'events', 'audit', 'inspect']) {
    const result = run([action, directory, 'run']); ok(result, action);
    assert.equal(result.json.source, SNAPSHOT_SOURCE, action);
  }
  assert.equal(run(['status', directory, 'run']).json.value.stateVersion, 1, 'committed state, not the uncommitted transaction');
  const show = run(['show', directory, 'run']); assert.equal(show.status, 0); assert.equal(show.stdout.split('\n')[0], SNAPSHOT_SOURCE);
  assert.deepEqual(originals(), before, 'snapshot reads left the store and its journal byte-identical');
  assert.deepEqual(snapshots(), leftovers, 'every snapshot copy was removed');
  refused(run(['abandon', directory, 'run', '--note', 'V8', '--confirm', 'run']), 2, 'HOT_JOURNAL', 'abandon');
  refused(run(['ingest-receipt', directory, 'run', 'd-1']), 2, 'HOT_JOURNAL', 'ingest');
  refused(run(['close-execution-marker', directory, '--owner', 'x', '--note', 'V8']), 2, 'HOT_JOURNAL', 'close');
  const release = await holdLock(t, directory);
  refused(run(['recover-journal', directory, '--note', 'V8']), 4, 'EXECUTION_OWNER_ACTIVE', 'lock held');
  await release();
  refused(run(['recover-journal', directory]), 2, 'INVALID_SPEC', 'missing note');
  assert.deepEqual(originals(), before, 'refusals left the files byte-identical');
  const recovered = ok(run(['recover-journal', directory, '--note', 'V8 writer SIGKILLed after a spill']), 'recover');
  assert.equal(recovered.files.length, 1);
  const [entry] = recovered.files;
  assert.equal(entry.file, 'loop.sqlite'); assert.equal(entry.rolledBack, true);
  assert.ok(entry.before.journalBytes > 0); assert.equal(entry.after.journalBytes, null);
  assert.deepEqual(recovered.chains.map(c => [c.runId, c.ok, c.stateVersion]), [['run', true, 1]]);
  const reader = await openStoreReadOnly(file);
  try {
    assert.equal(reader.status('run').stateVersion, 1); assert.equal(reader.source, undefined);
    assert.deepEqual(reader.operatorAudit().map(a => [a.action, a.note, a.detail.files[0].rolledBack]), [['recover-journal', 'V8 writer SIGKILLed after a spill', true]]);
  } finally { reader.close(); }
  assert.equal(existsSync(`${file}-journal`), false);
  assert.equal(run(['status', directory, 'run']).json.source, undefined);
  // V9: the audit is append-only at the engine level.
  const { DatabaseSync } = await import('node:sqlite'), raw = new DatabaseSync(file);
  try {
    assert.throws(() => raw.exec('DELETE FROM operator_audit'), /append-only/);
    assert.throws(() => raw.exec("UPDATE operator_audit SET note='x'"), /append-only/);
  } finally { raw.close(); }
});

test('V8b: abandon is refused while the fixture journal is hot and allowed after recover-journal --all', sqlite, async t => {
  const k = await killedHost(t, 'process-before-receipt');
  await spillHot(t, join(k.directory, 'fixture.sqlite'));
  const v = run(['inspect', k.directory, 'run']).json.value;
  assert.equal(v.journals.fixture, 'unreadable'); assert.match(v.journals.fixtureError, /errcode 776/);
  assert.equal(v.recoverySteps[0].action, 'receipt-unknown'); assert.match(v.recoverySteps[0].requires, /recover-journal --all/);
  let history = (await facts(k.directory)).history;
  refused(run(['abandon', k.directory, 'run', '--note', 'V8b', '--confirm', 'run']), 2, 'RECEIPT_SOURCE_UNKNOWN', 'hot fixture journal');
  const storeOnly = ok(run(['recover-journal', k.directory, '--note', 'V8b store only']), 'recover store');
  assert.deepEqual(storeOnly.files.map(f => [f.file, f.state, f.rolledBack]), [['loop.sqlite', 'readable', false]]);
  refused(run(['abandon', k.directory, 'run', '--note', 'V8b', '--confirm', 'run']), 2, 'RECEIPT_SOURCE_UNKNOWN', 'still hot');
  const all = ok(run(['recover-journal', k.directory, '--note', 'V8b all journals', '--all']), 'recover all');
  assert.deepEqual(all.files.map(f => [f.file, f.state, f.rolledBack]), [['loop.sqlite', 'readable', false], ['fixture.sqlite', 'hot', true], ['evidence.sqlite', 'readable', false]]);
  history = grows(history, (await facts(k.directory)).history, 'recover');
  assert.equal(history.audit, 2);
  assert.equal(ok(run(['abandon', k.directory, 'run', '--note', 'V8b after recovery', '--confirm', 'run']), 'abandon').abandoned, true);
  grows(history, (await facts(k.directory)).history, 'abandon');
});

test('V9: recovery modules contain no row deletion, PID signal or process spawn', sqlite, () => {
  for (const name of ['recovery.mjs', 'hot-journal.mjs']) {
    const source = readFileSync(fileURLToPath(new URL(`../src/loop/${name}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\bDELETE\s+FROM\b|\bDROP\s+TABLE\b|\bprocess\.kill\b|child_process|unlinkSync/i, name);
  }
});
