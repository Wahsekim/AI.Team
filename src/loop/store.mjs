import { chmodSync } from 'node:fs';
import { canonical, digest, LoopError, requireThat, validateCommand } from './contracts.mjs';
import { validateBundle } from './artifacts.mjs';
import { initialState, reduce } from './reducer.mjs';

const FENCED = new Set(['tick', 'claim']);
const unresolved = state => state.status === 'RECOVERY_REQUIRED' || state.projection?.status === 'STARTED'
  || Object.values(state.dispatches).some(d => !d.receipt && ['STARTED', 'UNKNOWN'].includes(d.status));
// ADR 0002: created lazily by acquireExecutionOwner only; append-only history, at most one open row.
const EXECUTIONS = `CREATE TABLE IF NOT EXISTS executions(seq INTEGER PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE,
    open INTEGER NOT NULL CHECK(open IN (0,1)), state_path TEXT NOT NULL, state_dev TEXT NOT NULL, state_ino TEXT NOT NULL,
    lock_ino TEXT NOT NULL, pid INTEGER, hostname TEXT, opened_at INTEGER NOT NULL, closed_at INTEGER,
    close_kind TEXT CHECK(close_kind IN ('graceful','operator')), close_note TEXT,
    CHECK((open=1 AND closed_at IS NULL AND close_kind IS NULL AND close_note IS NULL)
      OR (open=0 AND closed_at IS NOT NULL AND close_kind IS NOT NULL
        AND (close_kind='graceful' OR length(trim(coalesce(close_note,'')))>0))));
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_execution ON executions(open) WHERE open=1;
  CREATE TRIGGER IF NOT EXISTS executions_update_only_closes BEFORE UPDATE ON executions
    WHEN OLD.open=0 OR NEW.open<>0 OR NEW.seq IS NOT OLD.seq OR NEW.owner_id IS NOT OLD.owner_id OR NEW.state_path IS NOT OLD.state_path
      OR NEW.state_dev IS NOT OLD.state_dev OR NEW.state_ino IS NOT OLD.state_ino OR NEW.lock_ino IS NOT OLD.lock_ino
      OR NEW.pid IS NOT OLD.pid OR NEW.hostname IS NOT OLD.hostname OR NEW.opened_at IS NOT OLD.opened_at
    BEGIN SELECT RAISE(ABORT, 'execution rows only close once'); END;
  CREATE TRIGGER IF NOT EXISTS executions_append_only BEFORE DELETE ON executions
    BEGIN SELECT RAISE(ABORT, 'execution history is append-only'); END;`;

export async function openStore(filename) {
  requireThat(Number(process.versions.node.split('.')[0]) >= 24, 'CAPABILITY_MISSING', 'Goal supervisor requires Node 24+; legacy engine still supports Node 22');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS metadata(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, spec TEXT NOT NULL, artifacts TEXT NOT NULL,
      state TEXT NOT NULL, version INTEGER NOT NULL, simulation INTEGER NOT NULL CHECK(simulation=1));
    CREATE TABLE IF NOT EXISTS events(run_id TEXT REFERENCES runs(id), seq INTEGER NOT NULL,
      event TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(run_id,seq));
    CREATE TABLE IF NOT EXISTS requests(run_id TEXT REFERENCES runs(id), key TEXT NOT NULL,
      digest TEXT NOT NULL, reply TEXT NOT NULL, PRIMARY KEY(run_id,key));
    CREATE TABLE IF NOT EXISTS outbox(run_id TEXT REFERENCES runs(id), id TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(run_id,id));`);
  const versions = db.prepare('SELECT version FROM metadata').all();
  if (!versions.length) db.prepare('INSERT OR IGNORE INTO metadata VALUES (1)').run();
  else if (versions.length !== 1 || versions[0].version !== 1) { db.close(); throw new LoopError('CAPABILITY_MISSING', 'Unsupported store schema'); }

  const hasExecutions = () => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executions'").get();
  const openMarker = () => hasExecutions() ? db.prepare('SELECT * FROM executions WHERE open=1').get() ?? null : null;
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const row = runId => {
    const value = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
    requireThat(value, 'UNKNOWN_REFERENCE', `Unknown run ${runId}`); return value;
  };
  const append = (runId, seq, action, payload, state, now) => {
    const previous = db.prepare('SELECT digest FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(runId);
    const event = { runId, seq, action, payload, stateDigest: digest(state), at: now, previousDigest: previous?.digest ?? null };
    db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(runId, seq, canonical(event), digest(event));
  };
  return {
    filename,
    close() { db.close(); },
    create(spec, artifacts, { simulation = false, now = Date.now() } = {}) {
      requireThat(simulation === true, 'CAPABILITY_MISSING', 'Only explicit simulation runs are enabled; no live Claude adapter');
      validateBundle(spec, artifacts); const state = initialState(spec, now);
      return transaction(() => {
        requireThat(!db.prepare('SELECT id FROM runs WHERE id=?').get(spec.runId), 'IDEMPOTENCY_CONFLICT', 'Run already exists; use a new runId');
        db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,1)').run(spec.runId, canonical(spec), canonical(artifacts), canonical(state), 0);
        append(spec.runId, 0, 'created', { spec, artifacts, simulation: true }, state, now);
        return { runId: spec.runId, stateVersion: 0, simulation: true, state };
      });
    },
    status(runId) { const r = row(runId); return { runId, stateVersion: r.version, simulation: true, spec: JSON.parse(r.spec), state: JSON.parse(r.state) }; },
    bundle(runId) { const r = row(runId); return { spec: JSON.parse(r.spec), artifacts: JSON.parse(r.artifacts) }; },
    apply(action, command, now = Date.now(), fence = undefined) {
      validateCommand(command);
      requireThat(fence === undefined || typeof fence === 'string' && fence.length > 0, 'INVALID_SPEC', 'Fence must be an owner id');
      // Request identity and expected version are part of the idempotency contract.
      const inputDigest = digest({ action, command });
      return transaction(() => {
        const marker = openMarker();
        if (fence !== undefined) requireThat(marker?.owner_id === fence, 'OWNER_LOST', 'Execution owner no longer holds the open execution marker');
        else requireThat(!marker || !FENCED.has(action), 'EXECUTION_OPEN', 'An execution is open in this state directory; use its owner or an operator close');
        const r = row(command.runId);
        const old = db.prepare('SELECT digest,reply FROM requests WHERE run_id=? AND key=?').get(command.runId, command.idempotencyKey);
        if (old) { requireThat(old.digest === inputDigest, 'IDEMPOTENCY_CONFLICT', 'Same key with different command'); return JSON.parse(old.reply); }
        requireThat(r.version === command.expectedStateVersion, 'STALE_STATE', `Expected ${r.version}`);
        const result = reduce(JSON.parse(r.spec), JSON.parse(r.state), action, command.payload, now);
        const version = r.version + 1;
        db.prepare('UPDATE runs SET state=?,version=? WHERE id=?').run(canonical(result.state), version, command.runId);
        for (const e of result.effects) db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?)').run(command.runId, e.id, e.kind, canonical(e.payload), 'PENDING');
        for (const d of Object.values(result.state.dispatches)) db.prepare('UPDATE outbox SET status=? WHERE run_id=? AND id=?').run(d.status, command.runId, d.id);
        if (result.state.projection) db.prepare('UPDATE outbox SET status=? WHERE run_id=? AND id=?').run(result.state.projection.status, command.runId, result.state.projection.id);
        append(command.runId, version, action, command.payload, result.state, now);
        const reply = { ok: true, requestId: command.requestId, stateVersion: version, value: { status: result.state.status, scheduledEffectIds: result.effects.map(e => e.id) } };
        db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(command.runId, command.idempotencyKey, inputDigest, canonical(reply));
        return reply;
      });
    },
    executions() { return hasExecutions() ? db.prepare('SELECT * FROM executions ORDER BY seq').all().map(e => ({ ...e })) : []; },
    openExecution(e) {
      return transaction(() => {
        db.exec(EXECUTIONS);
        requireThat(!openMarker(), 'EXECUTION_OPEN', 'An execution is already open in this state directory; an operator close is required');
        db.prepare(`INSERT INTO executions(owner_id,open,state_path,state_dev,state_ino,lock_ino,pid,hostname,opened_at)
          VALUES (?,1,?,?,?,?,?,?,?)`).run(e.ownerId, e.statePath, e.stateDev, e.stateIno, e.lockIno, e.pid, e.hostname, e.now);
        return { ownerId: e.ownerId };
      });
    },
    closeExecution({ ownerId, kind, note = null, now }) {
      return transaction(() => {
        const marker = openMarker();
        if (kind === 'graceful') {
          requireThat(marker?.owner_id === ownerId, 'OWNER_LOST', 'Execution owner no longer holds the open execution marker');
          if (db.prepare('SELECT state FROM runs').all().some(r => unresolved(JSON.parse(r.state)))) return { closed: false };
        } else requireThat(kind === 'operator' && marker?.owner_id === ownerId, 'UNKNOWN_REFERENCE', 'No open execution with this owner_id');
        db.prepare('UPDATE executions SET open=0, closed_at=?, close_kind=?, close_note=? WHERE owner_id=? AND open=1').run(now, kind, note, ownerId);
        return { closed: true };
      });
    },
    effects(runId) { row(runId); return db.prepare('SELECT id,kind,payload,status FROM outbox WHERE run_id=? ORDER BY rowid').all(runId).map(e => ({ ...e, payload: JSON.parse(e.payload) })); },
    events(runId, after = -1, limit = 100) {
      row(runId); requireThat(Number.isSafeInteger(after) && after >= -1 && Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, 'INVALID_SPEC', 'Invalid event cursor/limit');
      return db.prepare('SELECT event,digest FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit).map(e => ({ ...JSON.parse(e.event), digest: e.digest }));
    },
    verify(runId) {
      const r = row(runId); const entries = db.prepare('SELECT event,digest FROM events WHERE run_id=? ORDER BY seq').all(runId);
      let previous = null, state = null;
      for (let seq = 0; seq < entries.length; seq++) {
        const e = JSON.parse(entries[seq].event);
        requireThat(e.seq === seq && e.previousDigest === previous && digest(e) === entries[seq].digest, 'RECOVERY_REQUIRED', 'Event chain mismatch');
        if (seq === 0) requireThat(digest(e.payload.spec) === digest(JSON.parse(r.spec))
          && digest(e.payload.artifacts) === digest(JSON.parse(r.artifacts)), 'RECOVERY_REQUIRED', 'Immutable run configuration mismatch');
        state = seq === 0 ? initialState(e.payload.spec, e.at) : reduce(JSON.parse(r.spec), state, e.action, e.payload, e.at).state;
        requireThat(digest(state) === e.stateDigest, 'RECOVERY_REQUIRED', 'Replay state mismatch'); previous = entries[seq].digest;
      }
      requireThat(entries.length === r.version + 1 && digest(state) === digest(JSON.parse(r.state)), 'RECOVERY_REQUIRED', 'Materialized state mismatch');
      return { ok: true, events: entries.length, stateVersion: r.version };
    },
  };
}
