import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonical, digest, fields, id, parseJSON, requireThat } from '../contracts.mjs';
import { startBoundedProcess } from '../process-runner.mjs';

const worker = fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url));
function validateRequest(request) {
  fields(request, ['scenario', 'delayMs', 'timeoutMs'], 'Fixture request');
  requireThat(['pass', 'fail', 'partial', 'crash', 'hang'].includes(request.scenario)
    && Number.isSafeInteger(request.delayMs) && request.delayMs >= 0 && request.delayMs <= 1000
    && Number.isSafeInteger(request.timeoutMs) && request.timeoutMs >= 1 && request.timeoutMs <= 4000, 'INVALID_SPEC', 'Invalid fixture request');
}

// Capability-development fixture only. Not accepted as a live provider by the
// production manifest; it cannot execute arbitrary programs or edit a product.
export async function openFixtureAdapter({ filename, runId, workspace }) {
  id(runId); const cwd = realpathSync(workspace);
  requireThat(Number(process.versions.node.split('.')[0]) >= 24, 'CAPABILITY_MISSING', 'Fixture journal requires Node 24+');
  if (filename !== ':memory:') try {
    const stat = lstatSync(filename); requireThat(stat.isFile() && !stat.isSymbolicLink(), 'SCOPE_DENIED', 'Invalid fixture journal file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(filename);
  try {
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS fixture_dispatches(run_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
        request TEXT NOT NULL, request_digest TEXT NOT NULL, pid INTEGER, result TEXT, result_digest TEXT,
        PRIMARY KEY(run_id,dispatch_id));`);
  } catch (error) { db.close(); throw error; }
  const owned = new Map(); let closing = false;
  const row = handle => {
    fields(handle, ['runId', 'dispatchId', 'requestDigest'], 'Fixture handle'); id(handle.dispatchId);
    requireThat(handle.runId === runId, 'SCOPE_DENIED', 'Handle belongs to another run');
    const value = db.prepare('SELECT * FROM fixture_dispatches WHERE run_id=? AND dispatch_id=?').get(runId, handle.dispatchId);
    requireThat(value, 'UNKNOWN_REFERENCE', 'Unknown fixture dispatch');
    const request = JSON.parse(value.request); validateRequest(request);
    requireThat(digest(request) === value.request_digest && value.request_digest === handle.requestDigest, 'IDEMPOTENCY_CONFLICT', 'Fixture request mismatch');
    if (value.result !== null) requireThat(digest(JSON.parse(value.result)) === value.result_digest, 'STALE_EVIDENCE', 'Fixture result mismatch');
    return value;
  };
  const inspect = handle => {
    const value = row(handle), active = owned.get(handle.dispatchId);
    return { simulation: true, pid: value.pid,
      status: value.result !== null ? 'FINISHED' : active ? 'RUNNING' : 'UNKNOWN',
      recoveryRequired: value.result === null && !active };
  };
  return {
    probeCapabilities() { return { adapter: 'fixture-process', simulation: true, structuredOutput: 'supported', cancellation: 'owned-handles-only', resume: 'unsupported', liveProvider: false }; },
    start(dispatchId, request) {
      requireThat(!closing, 'INVALID_TRANSITION', 'Adapter is closing'); id(dispatchId); validateRequest(request);
      const requestDigest = digest(request), handle = { runId, dispatchId, requestDigest };
      db.exec('BEGIN IMMEDIATE');
      let existing;
      try {
        existing = db.prepare('SELECT 1 FROM fixture_dispatches WHERE run_id=? AND dispatch_id=?').get(runId, dispatchId);
        if (existing) row(handle);
        else db.prepare('INSERT INTO fixture_dispatches VALUES (?,?,?,?,NULL,NULL,NULL)').run(runId, dispatchId, canonical(request), requestDigest);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      // Durable reservation BEFORE spawn. Even a PID-less row after host death
      // is UNKNOWN; never guess that spawn did not happen or create a second one.
      if (existing) return handle;
      const process = startBoundedProcess({ executable: globalThis.process.execPath, argv: [worker, request.scenario, String(request.delayMs)],
        cwd, env: {}, timeoutMs: request.timeoutMs, maxOutputBytes: 4096 });
      const entry = { process, completion: null }; owned.set(dispatchId, entry);
      const save = transcript => {
        let structured = null, result = transcript.reason === 'cancelled' ? 'cancelled' : transcript.reason === 'timeout' ? 'timeout' : 'error';
        if (transcript.exitCode === 0 && !transcript.error && !transcript.reason && !transcript.signal) try {
          structured = parseJSON(transcript.stdout, 4096);
          fields(structured, ['simulation', 'result', 'tokens', 'costMicroUsd'], 'Fixture output');
          requireThat(structured.simulation === true && ['pass', 'fail'].includes(structured.result)
            && structured.tokens === 0 && structured.costMicroUsd === 0, 'INVALID_SPEC', 'Invalid fixture output');
          result = structured.result;
        } catch { structured = null; }
        const receipt = { simulation: true, result, structured, transcript };
        db.prepare('UPDATE fixture_dispatches SET result=?,result_digest=? WHERE run_id=? AND dispatch_id=? AND result IS NULL')
          .run(canonical(receipt), digest(receipt), runId, dispatchId);
        return receipt;
      };
      entry.completion = process.completion.then(save);
      // Attach a rejection observer immediately; collectResult still propagates
      // persistence failures, which leave the durable row UNKNOWN after reopen.
      entry.completion.catch(() => {});
      try { db.prepare('UPDATE fixture_dispatches SET pid=? WHERE run_id=? AND dispatch_id=?').run(process.pid, runId, dispatchId); }
      catch (error) { process.cancel(); throw error; }
      return handle;
    },
    inspect,
    cancel(handle) {
      const state = inspect(handle);
      if (state.status === 'FINISHED') return { cancelled: false, ...state };
      const entry = owned.get(handle.dispatchId);
      if (!entry) return { cancelled: false, ...state }; // Never signal a persisted PID.
      return { cancelled: entry.process.cancel(), ...state };
    },
    async collectResult(handle) {
      row(handle); const entry = owned.get(handle.dispatchId);
      if (entry) await entry.completion;
      const value = row(handle);
      requireThat(value.result !== null, 'EFFECT_UNKNOWN', 'Unowned process/result is unknown; manual reconciliation required');
      return JSON.parse(value.result);
    },
    async close() {
      if (closing) return; closing = true;
      for (const entry of owned.values()) entry.process.cancel();
      const results = await Promise.allSettled([...owned.values()].map(e => e.completion));
      db.close();
      const failure = results.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
    },
  };
}
