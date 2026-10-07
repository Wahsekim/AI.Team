import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, demoBundle } from '../src/loop/demo.mjs';
import { openStore } from '../src/loop/store.mjs';
import { acquireExecutionOwner, bindDriver, closeOrphanedExecution, LOCK_FILE, probeExclusive } from '../src/loop/execution-owner.mjs';

const major = Number(process.versions.node.split('.')[0]);
const sqlite = { skip: major < 24 ? 'Execution owner requires Node 24+ (node:sqlite)' : false, timeout: 15000 };
const host = fileURLToPath(new URL('./fixtures/execution-owner-host.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/team-run.mjs', import.meta.url));
const env = { PATH: process.env.PATH ?? '' };
const tick = { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null };
const code = expected => error => error.code === expected;

async function stateDir(t, { run = true } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-exec-owner-'))), file = join(directory, 'loop.sqlite');
  const cleanup = [];
  t.after(() => { cleanup.reverse().forEach(fn => fn()); rmSync(directory, { recursive: true, force: true }); });
  const open = async (path = file) => { const store = await openStore(path); cleanup.push(() => store.close()); return store; };
  const own = async store => { const owner = await acquireExecutionOwner({ store }); cleanup.push(() => owner.release()); return owner; };
  const store = await open();
  if (run) { const { spec, artifacts } = demoBundle('run'); store.create(spec, artifacts, { simulation: true }); }
  return { directory, file, lock: join(directory, LOCK_FILE), store, open, own };
}
const fenced = (store, owner, action, payload) => store.apply(action, command(store, 'run', payload), undefined, owner.ownerId);
const attempt = (file, args = [], options = {}) => JSON.parse(execFileSync(process.execPath, [host, 'try', file, ...args],
  { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env, ...options }));

// A real holder process, bounded at 8 s; teardown signals only this handle.
async function holder(t, file) {
  const child = spawn(process.execPath, [host, 'hold', file], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (c, s) => resolve({ code: c, signal: s })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  let out = '';
  const line = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder did not report')), 8000);
    const onData = bytes => { out += bytes; const at = out.indexOf('\n'); if (at < 0) return;
      const event = JSON.parse(out.slice(0, at)); out = out.slice(at + 1); clearTimeout(timer); child.stdout.off('data', onData); resolve(event); };
    child.stdout.on('data', onData);
  });
  const held = await line();
  return { held, async kill() { child.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL'); }, async release() { const next = line(); child.stdin.end('release\n'); const event = await next; assert.equal((await exited).code, 0); return event; } };
}

test('T2: two store instances in one process cannot both own the directory', sqlite, async t => {
  const s = await stateDir(t), other = await s.open();
  const owner = await s.own(s.store);
  await assert.rejects(acquireExecutionOwner({ store: other }), code('EXECUTION_OWNER_ACTIVE'));
  owner.assertHeld();
  assert.equal(bindDriver(owner, other).store.apply('tick', command(other, 'run', tick)).ok, true, 'one handle may fence any store object of its directory');
  assert.throws(() => bindDriver(owner, s.store), code('INVALID_TRANSITION'), 'one driver per owner handle');
  assert.throws(() => bindDriver({ ownerId: owner.ownerId, assertHeld() {} }, s.store), code('CAPABILITY_MISSING'), 'a forged handle is not an owner');
});

test('T3: graceful release closes the marker and admits the next owner despite leftover lock files', sqlite, async t => {
  const s = await stateDir(t);
  const first = await acquireExecutionOwner({ store: s.store });
  assert.deepEqual(first.release(), { markerClosed: true }); assert.deepEqual(first.release(), { markerClosed: true });
  assert.ok(existsSync(s.lock), 'the lock file is left in place');
  writeFileSync(`${s.lock}-journal`, ''); // as a killed holder leaves it (lockprobe P5)
  const second = await s.own(s.store);
  assert.deepEqual(s.store.executions().map(e => [e.owner_id, e.open, e.close_kind]),
    [[first.ownerId, 0, 'graceful'], [second.ownerId, 1, null]]);
  assert.throws(() => first.assertHeld(), code('OWNER_LOST'));
});

test('T4: release with unresolved work leaves the marker open', sqlite, async t => {
  for (const interrupted of [false, true]) {
    const s = await stateDir(t), owner = await acquireExecutionOwner({ store: s.store });
    fenced(s.store, owner, 'tick', tick); fenced(s.store, owner, 'claim', { effectId: 'd-1' });
    if (interrupted) s.store.apply('interrupted', command(s.store, 'run', {}));
    assert.equal(s.store.status('run').state.status === 'RECOVERY_REQUIRED', interrupted);
    assert.deepEqual(owner.release(), { markerClosed: false });
    await assert.rejects(acquireExecutionOwner({ store: s.store }), code('EXECUTION_OPEN'));
    assert.equal(attempt(s.file).acquire.code, 'EXECUTION_OPEN');
    assert.deepEqual(s.store.executions().map(e => e.open), [1]);
  }
});

test('T6: stale-looking metadata never authorizes takeover; operator close has strict preconditions', sqlite, async t => {
  const s = await stateDir(t);
  (await acquireExecutionOwner({ store: s.store })).release(); // creates the lock file and the store binding
  const dir = statSync(s.directory, { bigint: true });
  s.store.openExecution({ ownerId: 'ghost', statePath: s.directory, stateDev: String(dir.dev), stateIno: String(dir.ino),
    lockIno: String(statSync(s.lock, { bigint: true }).ino), pid: 2 ** 22 + 7, hostname: 'elsewhere.invalid', now: 0 });
  await assert.rejects(acquireExecutionOwner({ store: s.store }), code('EXECUTION_OPEN'));
  await assert.rejects(closeOrphanedExecution({ store: s.store, ownerId: 'wrong', note: 'x' }), code('UNKNOWN_REFERENCE'));
  await assert.rejects(closeOrphanedExecution({ store: s.store, ownerId: 'ghost', note: '  ' }), code('INVALID_SPEC'));
  const busy = await stateDir(t), held = await holder(t, busy.file);
  await assert.rejects(closeOrphanedExecution({ store: busy.store, ownerId: held.held.ownerId, note: 'operator' }), code('EXECUTION_OWNER_ACTIVE'));
  assert.deepEqual(busy.store.executions().map(e => e.open), [1]);
  assert.deepEqual((await held.release()).released, { markerClosed: true });
  assert.deepEqual(await closeOrphanedExecution({ store: s.store, ownerId: 'ghost', note: 'operator verified host gone' }), { closed: true });
  const { DatabaseSync } = await import('node:sqlite'), raw = new DatabaseSync(s.file);
  try {
    assert.throws(() => raw.exec("UPDATE executions SET close_note='rewritten' WHERE owner_id='ghost'"), /only close once/);
    assert.throws(() => raw.exec("UPDATE executions SET open=1, closed_at=NULL, close_kind=NULL, close_note=NULL WHERE owner_id='ghost'"), /only close once/);
    assert.throws(() => raw.exec('DELETE FROM executions'), /append-only/);
    raw.exec("INSERT INTO executions(owner_id,open,state_path,state_dev,state_ino,lock_ino,opened_at) VALUES ('a',1,'p','0','0','0',0)");
    assert.throws(() => raw.exec("INSERT INTO executions(owner_id,open,state_path,state_dev,state_ino,lock_ino,opened_at) VALUES ('b',1,'p','0','0','0',0)"), /UNIQUE/);
    assert.throws(() => raw.exec("UPDATE executions SET open=0 WHERE owner_id='a'"), /CHECK/);
    assert.throws(() => raw.exec("UPDATE executions SET open=0, closed_at=1, close_kind='operator' WHERE owner_id='a'"), /CHECK/);
  } finally { raw.close(); }
});

const caseAlias = directory => join(dirname(directory), basename(directory).toUpperCase());
function caseSensitiveVolume() {
  if (major < 24) return false;
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ai-case-')));
  try { return !existsSync(caseAlias(d)); } finally { rmSync(d, { recursive: true }); }
}

test('T7: symlink and relative aliases meet one lock; the marker records the native path', sqlite, async t => {
  const s = await stateDir(t), parent = dirname(s.directory), name = basename(s.directory);
  const link = join(parent, `${name}-link`); symlinkSync(s.directory, link); t.after(() => unlinkSync(link));
  const owner = await s.own(await s.open(join(link, 'loop.sqlite')));
  assert.equal(owner.stateDirectory, realpathSync.native(s.directory));
  assert.deepEqual(s.store.executions().map(e => e.state_path), [realpathSync.native(s.directory)]);
  assert.equal(attempt(s.file).acquire.code, 'EXECUTION_OWNER_ACTIVE');
  assert.equal(attempt(join(link, 'loop.sqlite')).acquire.code, 'EXECUTION_OWNER_ACTIVE');
  assert.equal(attempt(join(name, 'loop.sqlite'), [], { cwd: parent }).acquire.code, 'EXECUTION_OWNER_ACTIVE');
});

test('T7: a macOS case alias meets the same lock and records the native path', { ...sqlite,
  skip: sqlite.skip || (caseSensitiveVolume() ? 'Volume is case-sensitive (probe: upper-case alias of a new directory does not exist)' : false) }, async t => {
  const s = await stateDir(t), upper = caseAlias(s.directory);
  assert.equal(statSync(upper).ino, statSync(s.directory).ino);
  const owner = await s.own(await s.open(join(upper, 'loop.sqlite')));
  assert.equal(owner.stateDirectory, realpathSync.native(s.directory)); assert.notEqual(owner.stateDirectory, upper);
  assert.deepEqual(s.store.executions().map(e => e.state_path), [realpathSync.native(s.directory)]);
  assert.equal(attempt(s.file).acquire.code, 'EXECUTION_OWNER_ACTIVE');
  assert.equal(attempt(join(upper, 'loop.sqlite')).acquire.code, 'EXECUTION_OWNER_ACTIVE');
});

test('T8: lock file replaced while held: the second host meets the marker, the first loses ownership', sqlite, async t => {
  const s = await stateDir(t), owner = await acquireExecutionOwner({ store: s.store }), driver = bindDriver(owner, s.store);
  unlinkSync(s.lock);
  assert.equal(attempt(s.file).acquire.code, 'EXECUTION_OPEN');
  assert.throws(() => owner.assertHeld(), code('OWNER_LOST'));
  assert.throws(() => driver.store.apply('tick', command(s.store, 'run', tick)), code('OWNER_LOST'));
  assert.equal(s.store.status('run').stateVersion, 0, 'no dispatch after the loss');
  assert.deepEqual(owner.release(), { markerClosed: false });
  assert.deepEqual(s.store.executions().map(e => e.open), [1]);
});

test('T8/F2: operator close is refused after a lock-file replacement; the live owner stays open', sqlite, async t => {
  const s = await stateDir(t), owner = await acquireExecutionOwner({ store: s.store });
  unlinkSync(s.lock);
  await assert.rejects(closeOrphanedExecution({ store: s.store, ownerId: owner.ownerId, note: 'operator' }), code('EXECUTION_OWNER_ACTIVE'));
  assert.deepEqual(s.store.executions().map(e => [e.owner_id, e.open]), [[owner.ownerId, 1]]);
  assert.equal(attempt(s.file).acquire.code, 'EXECUTION_OPEN', 'the operator lock was released and nothing reopened the directory');
  assert.deepEqual(owner.release(), { markerClosed: false });
});

test('F1: a crashed owner of store A blocks execution through any other store in the directory', sqlite, async t => {
  const s = await stateDir(t), held = await holder(t, s.file);
  await held.kill();
  const other = await s.open(join(s.directory, 'other.sqlite'));
  const { spec, artifacts } = demoBundle('run'); other.create(spec, artifacts, { simulation: true });
  await assert.rejects(acquireExecutionOwner({ store: other }), code('STORE_MISMATCH'));
  assert.deepEqual(other.executions(), [], 'no marker row in the other store');
  assert.equal(other.status('run').stateVersion, 0, 'no dispatch');
  assert.equal(attempt(join(s.directory, 'other.sqlite')).acquire.code, 'STORE_MISMATCH', 'a separate process is refused too');
  assert.deepEqual(s.store.executions().map(e => [e.owner_id, e.open]), [[held.held.ownerId, 1]]);
  await assert.rejects(acquireExecutionOwner({ store: s.store }), code('EXECUTION_OPEN'));
});

test('F1: the canonical store re-acquires after a graceful close; a replaced store file is refused', sqlite, async t => {
  const s = await stateDir(t);
  assert.deepEqual((await acquireExecutionOwner({ store: s.store })).release(), { markerClosed: true });
  const again = await acquireExecutionOwner({ store: await s.open(join(s.directory, '.', 'loop.sqlite')) });
  assert.deepEqual(again.release(), { markerClosed: true });
  const bytes = readFileSync(s.file); unlinkSync(s.file); writeFileSync(s.file, bytes); // same bytes, new inode
  const replaced = await s.open();
  await assert.rejects(acquireExecutionOwner({ store: replaced }), code('STORE_MISMATCH'));
  assert.deepEqual(replaced.executions().map(e => e.open), [0, 0], 'no new marker row');
});

test('F3: a cross-process probe that does not report BUSY fails closed and releases the lock', sqlite, async t => {
  const s = await stateDir(t);
  assert.equal(attempt(s.file, ['noprobe']).acquire.code, 'CAPABILITY_MISSING');
  assert.deepEqual(s.store.executions(), [], 'no marker row');
  const owner = await s.own(s.store);
  owner.assertHeld();
});

test('T9: store fencing refuses foreign and unfenced dispatch but keeps stop unfenced', sqlite, async t => {
  const s = await stateDir(t);
  assert.throws(() => s.store.apply('tick', command(s.store, 'run', tick), undefined, 'nobody'), code('OWNER_LOST'), 'fence without an open marker');
  assert.equal(s.store.executions().length, 0, 'a fenced refusal does not create the marker table');
  const owner = await s.own(s.store);
  assert.throws(() => s.store.apply('tick', command(s.store, 'run', tick), undefined, 'foreign'), code('OWNER_LOST'));
  assert.throws(() => s.store.apply('tick', command(s.store, 'run', tick)), code('EXECUTION_OPEN'));
  fenced(s.store, owner, 'tick', tick);
  assert.throws(() => s.store.apply('claim', command(s.store, 'run', { effectId: 'd-1' })), code('EXECUTION_OPEN'));
  assert.equal(s.store.apply('stop', command(s.store, 'run', { mode: 'graceful', reason: 'R04 stop' })).ok, true);
});

test('T10: inspection and stop never touch the lock or create the marker table', sqlite, async t => {
  const idle = await stateDir(t), s = await stateDir(t), held = await holder(t, s.file);
  const before = { bytes: readFileSync(s.lock), mtime: statSync(s.lock).mtimeMs };
  for (const action of ['status', 'events', 'audit', 'show', 'stop']) {
    const started = Date.now(), result = spawnSync(process.execPath, [cli, action, s.directory, 'run'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env });
    assert.equal(result.status, 0, `${action}: ${result.stdout}`); assert.ok(Date.now() - started < 2000, `${action} took too long`);
  }
  assert.deepEqual(readFileSync(s.lock), before.bytes); assert.equal(statSync(s.lock).mtimeMs, before.mtime);
  await held.release();
  const status = spawnSync(process.execPath, [cli, 'status', idle.directory, 'run'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env });
  assert.equal(status.status, 0); assert.equal(existsSync(idle.lock), false);
  const { DatabaseSync } = await import('node:sqlite'), raw = new DatabaseSync(idle.file, { readOnly: true });
  try { assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name='executions'").get().n, 0); } finally { raw.close(); }
});

test('T11: unsupported lock surfaces fail closed and leave files untouched', sqlite, async t => {
  const s = await stateDir(t), target = join(s.directory, 'elsewhere.sqlite');
  writeFileSync(target, ''); symlinkSync(target, s.lock);
  await assert.rejects(acquireExecutionOwner({ store: s.store }), code('CAPABILITY_MISSING'));
  assert.ok(lstatSync(s.lock).isSymbolicLink()); assert.equal(readFileSync(target).length, 0);
  unlinkSync(s.lock); linkSync(target, s.lock);
  await assert.rejects(acquireExecutionOwner({ store: s.store }), code('CAPABILITY_MISSING'), 'hard-linked lock file');
  unlinkSync(s.lock);
  const garbage = Buffer.from('not a database '.repeat(16)); writeFileSync(s.lock, garbage);
  await assert.rejects(acquireExecutionOwner({ store: s.store }), code('CAPABILITY_MISSING'));
  assert.deepEqual(readFileSync(s.lock), garbage);
  const memory = await openStore(':memory:'); t.after(() => memory.close());
  await assert.rejects(acquireExecutionOwner({ store: memory }), code('CAPABILITY_MISSING'));
  const fresh = await stateDir(t);
  assert.equal(attempt(fresh.file, ['win32']).acquire.code, 'CAPABILITY_MISSING');
  assert.equal(existsSync(fresh.lock), false, 'win32 refusal happens before any lock file');
  writeFileSync(fresh.lock, '');
  assert.equal(probeExclusive(fresh.lock).exclusive, false, 'an unlocked file is reported as not exclusive');
  assert.equal(s.store.executions().length + fresh.store.executions().length, 0, 'no marker was opened');
});

test('T11: fixture CLI on Node 22 exits 7', { skip: major >= 24 ? 'Runs only on Node < 24 (expects CAPABILITY_MISSING exit 7)' : false, timeout: 15000 }, t => {
  const parent = mkdtempSync(join(tmpdir(), 'ai-exec-node22-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, 'fixture', join(parent, 'new'), 'run'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env });
  assert.equal(result.status, 7); assert.equal(JSON.parse(result.stdout).code, 'CAPABILITY_MISSING');
});

test('CLI demo acquires the owner and maps execution exclusion to exit 4', sqlite, async t => {
  const s = await stateDir(t, { run: false }), held = await holder(t, s.file);
  const call = runId => spawnSync(process.execPath, [cli, 'demo', s.directory, runId], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env });
  const refused = call('blocked');
  assert.equal(refused.status, 4); assert.equal(JSON.parse(refused.stdout).code, 'EXECUTION_OWNER_ACTIVE');
  await held.release();
  const ok = call('demo-1');
  assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).value.state.status, 'COMPLETED');
  assert.deepEqual(s.store.executions().map(e => [e.open, e.close_kind]), [[0, 'graceful'], [0, 'graceful']]);
  s.store.openExecution({ ownerId: 'stuck', statePath: s.directory, stateDev: '0', stateIno: '0', lockIno: '0', pid: null, hostname: null, now: 0 });
  const open = call('demo-2');
  assert.equal(open.status, 4); assert.equal(JSON.parse(open.stdout).code, 'EXECUTION_OPEN');
});
