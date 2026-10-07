import { lstatSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LoopError, requireThat } from './contracts.mjs';

// ADR 0002. No other module may open LOCK_FILE: a plain open+close in this process drops the lock.
export const LOCK_FILE = 'execution-owner.sqlite';
const LOCK_SQL = 'PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE';
// Written and read only under the kernel lock; locking_mode=EXCLUSIVE keeps the lock across this COMMIT.
const BINDING_SQL = `CREATE TABLE IF NOT EXISTS store_binding(id INTEGER PRIMARY KEY CHECK(id=1),
  store_name TEXT NOT NULL, store_dev TEXT NOT NULL, store_ino TEXT NOT NULL)`;
const SQLITE_BUSY = 5, PROBE_TIMEOUT_MS = 2000;
const UNFENCED = new Set(['stop', 'interrupted']);
const PROBE_SOURCE = `const { DatabaseSync } = require('node:sqlite');
let errcode = null;
try { new DatabaseSync(process.argv[1]).exec(${JSON.stringify(LOCK_SQL)}); } catch (error) { errcode = error.errcode ?? null; }
process.stdout.write(JSON.stringify({ errcode }));`;
const internals = new WeakMap();

const missing = message => new LoopError('CAPABILITY_MISSING', message);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function requireCapability() {
  requireThat(Number(process.versions.node.split('.')[0]) >= 24, 'CAPABILITY_MISSING', 'Execution owner requires Node 24+');
  requireThat(['darwin', 'linux'].includes(process.platform), 'CAPABILITY_MISSING', `Execution owner is unsupported on ${process.platform}`);
}

export function stateIdentity(store) {
  const filename = store?.filename;
  requireThat(typeof filename === 'string' && filename !== '' && filename !== ':memory:' && !filename.startsWith('file:'),
    'CAPABILITY_MISSING', 'Execution owner requires a file-backed control store');
  const path = realpathSync.native(dirname(resolve(filename))), storeStat = statSync(resolve(filename), { bigint: true });
  return { path, stat: statSync(path, { bigint: true }),
    store: { name: basename(realpathSync.native(resolve(filename))), dev: String(storeStat.dev), ino: String(storeStat.ino) } };
}

// One state directory, one control store: the first owner binds it durably; any other store file is refused.
function bindStore(db, store) {
  db.exec(BINDING_SQL);
  const bound = db.prepare('SELECT store_name, store_dev, store_ino FROM store_binding WHERE id=1').get();
  if (!bound) db.prepare('INSERT INTO store_binding VALUES (1,?,?,?)').run(store.name, store.dev, store.ino);
  else if (bound.store_name !== store.name || bound.store_dev !== store.dev || bound.store_ino !== store.ino)
    throw new LoopError('STORE_MISMATCH', `State directory is bound to control store ${bound.store_name} (dev ${bound.store_dev}, ino ${bound.store_ino})`);
  db.exec('COMMIT; BEGIN EXCLUSIVE');
}

function checkLockFile(lockPath, directory, { mustExist }) {
  let stat;
  try { stat = lstatSync(lockPath, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' && !mustExist) return null; throw missing(`Lock file unavailable: ${error.code}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.dev !== directory.dev)
    throw missing('Lock file must be a regular, single-link, non-symlink file on the state directory device');
  return stat;
}

// Cross-process check: another process must be refused (errcode 5) while this one holds the lock.
export function probeExclusive(lockPath) {
  const child = spawnSync(process.execPath, ['--no-warnings', '-e', PROBE_SOURCE, lockPath], {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
  let errcode = null;
  try { errcode = JSON.parse(child.stdout).errcode; } catch { errcode = null; }
  return { exclusive: child.status === 0 && errcode === SQLITE_BUSY, errcode, status: child.status, signal: child.signal };
}

async function lockKernel({ path: stateDirectory, stat: directoryStat, store }) {
  requireCapability();
  const { DatabaseSync } = await import('node:sqlite');
  const lockPath = join(stateDirectory, LOCK_FILE);
  checkLockFile(lockPath, directoryStat, { mustExist: false });
  let db;
  try { db = new DatabaseSync(lockPath); db.exec(LOCK_SQL); }
  catch (error) {
    try { db?.close(); } catch { /* the failed connection holds nothing */ }
    if (error.errcode === SQLITE_BUSY) throw new LoopError('EXECUTION_OWNER_ACTIVE', 'Another execution owner holds this state directory');
    throw missing(`Execution lock unavailable (errcode ${error.errcode ?? error.code ?? 'unknown'})`);
  }
  const unlock = () => { try { db.exec('ROLLBACK'); } catch { /* close drops the lock */ } db.close(); };
  try {
    try { bindStore(db, store); }
    catch (error) { if (error.code === 'STORE_MISMATCH') throw error; throw missing(`Store binding unavailable (errcode ${error.errcode ?? error.code ?? 'unknown'})`); }
    const lockStat = checkLockFile(lockPath, directoryStat, { mustExist: true });
    const probe = probeExclusive(lockPath);
    if (!probe.exclusive) throw missing(`Execution lock is not exclusive across processes (probe errcode ${probe.errcode}, status ${probe.status})`);
    return { lockPath, lockStat, unlock };
  } catch (error) { unlock(); throw error; }
}

export async function acquireExecutionOwner({ store, now = Date.now }) {
  requireCapability();
  const state = stateIdentity(store);
  const lock = await lockKernel(state);
  const ownerId = randomUUID();
  try {
    store.openExecution({ ownerId, statePath: state.path, stateDev: String(state.stat.dev), stateIno: String(state.stat.ino),
      lockIno: String(lock.lockStat.ino), pid: process.pid, hostname: hostname(), now: now() });
  } catch (error) { lock.unlock(); throw error; }
  const self = { released: false, bound: false, active: false, result: null };
  const held = () => {
    if (self.released) return false;
    try {
      return sameFile(lstatSync(lock.lockPath, { bigint: true }), lock.lockStat) && sameFile(statSync(state.path, { bigint: true }), state.stat);
    } catch { return false; }
  };
  const handle = Object.freeze({
    ownerId, stateDirectory: state.path, lockPath: lock.lockPath,
    assertHeld() { requireThat(held(), 'OWNER_LOST', 'Execution ownership lost; no further dispatch'); },
    release() {
      if (self.released) return self.result;
      let markerClosed = false;
      try {
        // A lost lock or an active step leaves the marker open for an operator.
        if (held() && !self.active) markerClosed = store.closeExecution({ ownerId, kind: 'graceful', now: now() }).closed;
      } catch (error) { if (error.code !== 'OWNER_LOST') throw error; } finally { self.released = true; lock.unlock(); }
      self.result = { markerClosed };
      return self.result;
    },
  });
  internals.set(handle, { self, state, store });
  return handle;
}

// Library-only operator transition (c). Taking the kernel lock proves the recorded owner no longer holds it,
// but only for the same lock file and directory: after a replacement (P6) the close is refused.
export async function closeOrphanedExecution({ store, ownerId, note, now = Date.now }) {
  requireCapability();
  requireThat(typeof ownerId === 'string' && ownerId.length > 0, 'INVALID_SPEC', 'Exact open owner_id required');
  requireThat(typeof note === 'string' && note.trim().length > 0, 'INVALID_SPEC', 'Non-empty operator note required');
  const state = stateIdentity(store);
  const lock = await lockKernel(state);
  try {
    const row = store.executions().find(e => e.open === 1 && e.owner_id === ownerId);
    requireThat(!row || row.lock_ino === String(lock.lockStat.ino) && row.state_dev === String(state.stat.dev) && row.state_ino === String(state.stat.ino),
      'EXECUTION_OWNER_ACTIVE', 'Lock file or state directory changed since this execution opened; its owner may still be alive');
    return store.closeExecution({ ownerId, kind: 'operator', note, now: now() });
  }
  finally { lock.unlock(); }
}

// Driver-only: one driver per handle; returns the fenced store the driver must use exclusively.
export function bindDriver(owner, store) {
  const entry = internals.get(owner);
  requireThat(entry, 'CAPABILITY_MISSING', 'A live execution owner handle is required');
  const { self, state } = entry;
  owner.assertHeld();
  requireThat(!self.bound, 'INVALID_TRANSITION', 'This execution owner already has a fixture driver');
  const identity = stateIdentity(store);
  requireThat(identity.path === state.path && sameFile(identity.stat, state.stat) && identity.store.dev === state.store.dev
    && identity.store.ino === state.store.ino, 'INVALID_SPEC', 'Store is not the owned control store');
  self.bound = true;
  const fenced = Object.freeze({ ...store, apply(action, command, at) {
    if (UNFENCED.has(action)) return store.apply(action, command, at);
    owner.assertHeld();
    return store.apply(action, command, at, owner.ownerId);
  } });
  return { store: fenced, setActive(value) { self.active = value; }, unbind() { self.bound = false; self.active = false; } };
}
