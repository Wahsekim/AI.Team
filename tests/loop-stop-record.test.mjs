import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, demoBundle, driveDemo } from '../src/loop/demo.mjs';
import { initialState, reduce } from '../src/loop/reducer.mjs';
import { openStore } from '../src/loop/store.mjs';
import { acquireExecutionOwner, LOCK_FILE } from '../src/loop/execution-owner.mjs';

// ADR 0004 (R04a): durable stop record, store side only. R04b adds driver observation.
const major = Number(process.versions.node.split('.')[0]);
const sqlite = { skip: major < 24 ? 'Stop record tests need the Node 24+ control store (node:sqlite)' : false, timeout: 15000 };
const host = fileURLToPath(new URL('./fixtures/execution-owner-host.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/team-run.mjs', import.meta.url));
const env = { PATH: process.env.PATH ?? '' };
const tick = { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null };
const code = expected => error => error.code === expected;

// State directories live under the OS temp dir, outside any Git repository (ADR 0003).
async function stateDir(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-stop-record-'))), file = join(directory, 'loop.sqlite');
  const cleanup = [];
  t.after(() => { cleanup.reverse().forEach(fn => fn()); rmSync(directory, { recursive: true, force: true }); });
  const open = async () => { const store = await openStore(file); cleanup.push(() => store.close()); return store; };
  const store = await open();
  const { spec, artifacts } = demoBundle('run'); store.create(spec, artifacts, { simulation: true });
  return { directory, file, lock: join(directory, LOCK_FILE), store, open, cleanup };
}
const run = (args, options = {}) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env, ...options });
  return { status: result.status, ms: Date.now() - started, stdout: result.stdout, json: result.stdout.startsWith('{') ? JSON.parse(result.stdout) : null };
};
const apply = (store, action, payload, fence) => store.apply(action, command(store, 'run', payload), undefined, fence);
async function schema(file) {
  const { DatabaseSync } = await import('node:sqlite'), raw = new DatabaseSync(file, { readOnly: true });
  try { return raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all().map(r => ({ ...r })); } finally { raw.close(); }
}

test('S1: a graceful stop is recorded once, shown by status/show, and replays identically after reopen', sqlite, async t => {
  const s = await stateDir(t);
  const first = s.store.requestStop('run', { kind: 'graceful', requestedBy: 'cli' }, Date.now());
  assert.equal(first.recorded, true); assert.equal(first.stateVersion, 1); assert.equal(first.status, 'QUIESCING');
  assert.deepEqual(Object.keys(first.stopRequest).sort(), ['kind', 'requestedAt', 'requestedBy', 'seq']);
  assert.equal(first.stopRequest.kind, 'graceful'); assert.equal(first.stopRequest.seq, 1);
  const repeat = s.store.requestStop('run', { kind: 'graceful', requestedBy: 'someone-else' });
  assert.deepEqual(repeat, { recorded: false, stateVersion: 1, status: 'QUIESCING', stopRequest: first.stopRequest });
  const cliRepeat = run(['stop', s.directory, 'run']);
  assert.equal(cliRepeat.status, 0, cliRepeat.stdout); assert.equal(cliRepeat.json.value.recorded, false);
  assert.deepEqual(cliRepeat.json.value.stopRequest, first.stopRequest);
  const status = run(['status', s.directory, 'run']);
  assert.equal(status.status, 0); assert.deepEqual(status.json.value.state.stopRequest, first.stopRequest);
  assert.equal(status.json.value.stateVersion, 1, 'repeats never add a transition');
  const show = run(['show', s.directory, 'run']);
  assert.equal(show.status, 0); assert.match(show.stdout, /^stop graceful · #1 · by cli$/m);
  const events = s.store.events('run'); assert.equal(events.length, 2);
  s.cleanup.pop()(); s.cleanup.length = 0;
  const reopened = await s.open();
  assert.deepEqual(reopened.events('run'), events); assert.deepEqual(reopened.verify('run'), { ok: true, events: 2, stateVersion: 1 });
  assert.deepEqual(reopened.readStopRequest('run'), first.stopRequest);
});

test('S2: graceful escalates to hard once; hard is never downgraded; repeats are idempotent', sqlite, async t => {
  const s = await stateDir(t);
  s.store.requestStop('run', { kind: 'graceful', requestedBy: 'cli' });
  const hard = run(['stop', s.directory, 'run', '--hard']);
  assert.equal(hard.status, 0, hard.stdout);
  assert.equal(hard.json.value.recorded, true); assert.equal(hard.json.value.stateVersion, 2);
  assert.equal(hard.json.value.stopRequest.kind, 'hard'); assert.equal(hard.json.value.stopRequest.seq, 2);
  for (const kind of ['graceful', 'hard']) {
    const again = s.store.requestStop('run', { kind, requestedBy: 'cli' });
    assert.equal(again.recorded, false, kind); assert.deepEqual(again.stopRequest, hard.json.value.stopRequest); assert.equal(again.stateVersion, 2);
  }
  const graceful = run(['stop', s.directory, 'run', '--graceful']);
  assert.equal(graceful.status, 0); assert.equal(graceful.json.value.stopRequest.kind, 'hard', 'a downgrade records nothing');
  assert.deepEqual(s.store.events('run').map(e => [e.action, e.payload.kind ?? null]), [['created', null], ['stop', 'graceful'], ['stop', 'hard']]);
  assert.equal(s.store.verify('run').ok, true);
  const { spec } = demoBundle('run'), state = s.store.status('run').state;
  assert.throws(() => reduce(spec, state, 'stop', { kind: 'graceful', requestedBy: 'replay' }, state.lastAt), code('INVALID_TRANSITION'), 'the reducer refuses a non-escalating stop event');
});

test('S2b: escalation during closeout strengthens the record without dropping the pending projection', sqlite, async t => {
  const s = await stateDir(t);
  s.store.requestStop('run', { kind: 'graceful', requestedBy: 'cli' });
  apply(s.store, 'tick', tick);
  const projection = s.store.status('run').state.projection;
  assert.equal(projection.status, 'PENDING'); assert.equal(projection.outcome, 'STOPPED');
  assert.equal(s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli' }).status, 'FINALIZING');
  apply(s.store, 'claim', { effectId: projection.id }); apply(s.store, 'projected', { effectId: projection.id });
  const state = s.store.status('run').state;
  assert.equal(state.status, 'STOPPED'); assert.equal(state.stopRequest.kind, 'hard'); assert.equal(state.stopRequest.seq, 2);
});

test('S3: a stop before spawn makes every later dispatch claim refuse STOP_REQUESTED, fenced or not', sqlite, async t => {
  const s = await stateDir(t);
  apply(s.store, 'tick', tick);
  assert.equal(s.store.status('run').state.dispatches['d-1'].status, 'PENDING', 'intent exists, nothing spawned');
  s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli' });
  assert.deepEqual(s.store.status('run').state.dispatches['d-1'].receipt, { result: 'cancelled', tokens: 0, costMicroUsd: 0 });
  assert.throws(() => apply(s.store, 'claim', { effectId: 'd-1' }), code('STOP_REQUESTED'), 'unfenced');
  assert.equal(s.store.executions().length, 0, 'no executions marker involved');
  const owner = await acquireExecutionOwner({ store: s.store }); t.after(() => owner.release());
  assert.throws(() => apply(s.store, 'claim', { effectId: 'd-1' }, owner.ownerId), code('STOP_REQUESTED'), 'fenced with the valid owner');
  assert.throws(() => apply(s.store, 'claim', { effectId: 'd-2' }, owner.ownerId), code('STOP_REQUESTED'), 'any dispatch id');
  apply(s.store, 'tick', tick, owner.ownerId);
  const projection = s.store.status('run').state.projection;
  assert.deepEqual(s.store.effects('run').map(e => [e.id, e.kind]), [['d-1', 'dispatch'], [projection.id, 'projection']], 'closeout only, no new dispatch');
  apply(s.store, 'claim', { effectId: projection.id }, owner.ownerId); apply(s.store, 'projected', { effectId: projection.id });
  const state = s.store.status('run').state;
  assert.equal(state.status, 'STOPPED'); assert.equal(state.reason, 'user_stop'); assert.equal(state.usage.agentCalls, 1);
  assert.equal(Object.values(state.dispatches).some(d => d.status === 'STARTED'), false);
});

test('S3b: a stop before any tick leaves a run that can only close out', sqlite, async t => {
  const s = await stateDir(t);
  s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli' });
  assert.throws(() => apply(s.store, 'claim', { effectId: 'd-1' }), code('STOP_REQUESTED'));
  apply(s.store, 'tick', tick);
  assert.deepEqual(s.store.effects('run').map(e => e.kind), ['projection']);
  assert.deepEqual(s.store.status('run').state.dispatches, {});
});

test('S3c: a stop never clears an existing recovery requirement', sqlite, async t => {
  const s = await stateDir(t);
  apply(s.store, 'tick', tick); apply(s.store, 'interrupted', {});
  assert.equal(s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli' }).status, 'RECOVERY_REQUIRED');
  assert.throws(() => apply(s.store, 'tick', tick), code('EFFECT_UNKNOWN'));
});

// A real holder process, bounded at 8 s (tests/fixtures/execution-owner-host.mjs).
async function holder(t, file) {
  const child = spawn(process.execPath, [host, 'hold', file], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (c, sig) => resolve({ code: c, signal: sig })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  let out = '';
  const line = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder did not report')), 8000);
    const onData = bytes => { out += bytes; const at = out.indexOf('\n'); if (at < 0) return;
      const event = JSON.parse(out.slice(0, at)); out = out.slice(at + 1); clearTimeout(timer); child.stdout.off('data', onData); resolve(event); };
    child.stdout.on('data', onData);
  });
  assert.equal((await line()).held, true);
  return { async release() { const next = line(); child.stdin.end('release\n'); const event = await next; assert.equal((await exited).code, 0); return event; } };
}

test('S4: a hard stop from a second process succeeds lock-free while another process holds the execution', sqlite, async t => {
  const s = await stateDir(t), idle = await stateDir(t), held = await holder(t, s.file);
  const before = { bytes: readFileSync(s.lock), mtime: statSync(s.lock).mtimeMs };
  const stop = run(['stop', s.directory, 'run', '--hard']);
  assert.equal(stop.status, 0, stop.stdout); assert.ok(stop.ms < 2000, `stop took ${stop.ms} ms`);
  assert.equal(stop.json.value.recorded, true); assert.equal(stop.json.value.stopRequest.kind, 'hard');
  assert.deepEqual(readFileSync(s.lock), before.bytes); assert.equal(statSync(s.lock).mtimeMs, before.mtime);
  assert.equal(s.store.executions().filter(e => e.open === 1).length, 1, 'the holder keeps its marker');
  assert.deepEqual((await held.release()).released, { markerClosed: true }, 'a stopped run with no unresolved work releases cleanly');
  const idleSchema = await schema(idle.file);
  const idleStop = run(['stop', idle.directory, 'run', '--hard']);
  assert.equal(idleStop.status, 0, idleStop.stdout);
  assert.equal(existsSync(idle.lock), false, 'the lock file is never created');
  assert.deepEqual(await schema(idle.file), idleSchema, 'no executions table or any other schema change');
});

test('S5: readStopRequest is a read-only poll', sqlite, async t => {
  const s = await stateDir(t);
  const bytes = readFileSync(s.file), tables = await schema(s.file);
  assert.equal(s.store.readStopRequest('run'), null);
  assert.deepEqual(readFileSync(s.file), bytes); assert.deepEqual(await schema(s.file), tables);
  assert.equal(s.store.status('run').stateVersion, 0);
  const { stopRequest, stateVersion } = s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli' });
  const after = readFileSync(s.file);
  for (let i = 0; i < 3; i++) assert.deepEqual(s.store.readStopRequest('run'), stopRequest);
  assert.deepEqual(readFileSync(s.file), after); assert.deepEqual(await schema(s.file), tables, 'no stop table, before or after');
  assert.equal(s.store.status('run').stateVersion, stateVersion);
  assert.throws(() => s.store.readStopRequest('missing'), code('UNKNOWN_REFERENCE'));
});

test('S6: a stop landing between a read and an apply invalidates the stale command and is never lost', sqlite, async t => {
  const s = await stateDir(t);
  apply(s.store, 'tick', tick);
  const v = s.store.status('run').stateVersion, staleClaim = command(s.store, 'run', { effectId: 'd-1' }), staleTick = command(s.store, 'run', tick);
  const stop = s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli' });
  assert.equal(stop.stateVersion, v + 1);
  assert.throws(() => s.store.apply('claim', staleClaim), code('STALE_STATE'));
  assert.throws(() => s.store.apply('tick', staleTick), code('STALE_STATE'));
  assert.throws(() => apply(s.store, 'claim', { effectId: 'd-1' }), code('STOP_REQUESTED'), 'a re-read claim is still refused');
  assert.deepEqual(s.store.readStopRequest('run'), stop.stopRequest);
  const state = s.store.status('run').state;
  assert.equal(state.dispatches['d-1'].status, 'ACKNOWLEDGED'); assert.equal(state.dispatches['d-1'].receipt.result, 'cancelled');
  assert.equal(state.status, 'QUIESCING'); assert.notEqual(state.status, 'COMPLETED');
});

test('S6b: a settle prepared before the stop is stale, and its re-read settle keeps the stop clean', sqlite, async t => {
  const s = await stateDir(t);
  apply(s.store, 'tick', tick); apply(s.store, 'claim', { effectId: 'd-1' });
  const staleSettle = command(s.store, 'run', { dispatchId: 'd-1', result: 'cancelled', candidate: s.store.status('run').state.candidate, tokens: 0, costMicroUsd: 0 });
  const stop = s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli' });
  assert.equal(stop.status, 'QUIESCING', 'running work is not cancelled by the record itself');
  assert.throws(() => s.store.apply('settle', staleSettle), code('STALE_STATE'));
  assert.equal(s.store.apply('settle', { ...staleSettle, expectedStateVersion: stop.stateVersion }).ok, true);
  apply(s.store, 'tick', tick);
  const state = s.store.status('run').state;
  assert.equal(state.status, 'FINALIZING'); assert.equal(state.projection.outcome, 'STOPPED');
  assert.deepEqual(state.stopRequest, stop.stopRequest); assert.equal(s.store.verify('run').ok, true);
});

test('S7: the stop record has no free text and the transition depends only on its fields', () => {
  const { spec } = demoBundle('run'); const s = reduce(spec, initialState(spec, 0), 'tick', tick, 1).state;
  for (const payload of [{ kind: 'hard', requestedBy: 'cli', reason: 'please stop' }, { kind: 'hard', requestedBy: 'please stop now' },
    { kind: 'soft', requestedBy: 'cli' }, { mode: 'hard', reason: 'legacy' }]) {
    assert.throws(() => reduce(spec, s, 'stop', payload, 2), code('INVALID_SPEC'), JSON.stringify(payload));
  }
  const strip = state => { const { lastAt, stopRequest: { requestedBy, requestedAt, ...record }, ...rest } = state; return { ...rest, record }; };
  const a = reduce(spec, s, 'stop', { kind: 'hard', requestedBy: 'cli' }, 2).state, b = reduce(spec, s, 'stop', { kind: 'hard', requestedBy: 'fixture-driver' }, 9).state;
  assert.deepEqual(strip(a), strip(b));
  assert.deepEqual(a.stopRequest, { kind: 'hard', seq: 1, requestedBy: 'cli', requestedAt: 2 });
  const graceful = reduce(spec, s, 'stop', { kind: 'graceful', requestedBy: 'cli' }, 2).state;
  assert.deepEqual({ ...graceful, stopRequest: null }, { ...a, stopRequest: null }, 'at R04a the kind changes only the record');
});

test('S7b: the stop record cannot be written as a versioned command', sqlite, async t => {
  const s = await stateDir(t);
  assert.throws(() => apply(s.store, 'stop', { kind: 'hard', requestedBy: 'cli' }), code('INVALID_SPEC'));
  assert.throws(() => s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli', reason: 'text' }), code('INVALID_SPEC'));
  assert.equal(s.store.status('run').stateVersion, 0);
});

test('S8: stop on a terminal run stays RUN_TERMINAL; flags are stop-only', sqlite, async t => {
  const s = await stateDir(t);
  assert.equal(driveDemo(s.store, 'run').state.status, 'COMPLETED');
  const before = s.store.status('run').stateVersion;
  for (const flag of [[], ['--hard'], ['--graceful']]) {
    const result = run(['stop', s.directory, 'run', ...flag]);
    assert.equal(result.status, 2, result.stdout); assert.equal(result.json.code, 'RUN_TERMINAL');
  }
  assert.throws(() => s.store.requestStop('run', { kind: 'hard', requestedBy: 'cli' }), code('RUN_TERMINAL'));
  assert.equal(s.store.status('run').stateVersion, before);
  for (const args of [['stop', s.directory, 'run', '--soft'], ['stop', s.directory, 'run', '--hard', '--graceful'], ['status', s.directory, 'run', '--hard']]) {
    const result = run(args); assert.equal(result.status, 2); assert.equal(result.json.code, 'INVALID_SPEC', args.join(' '));
  }
});
