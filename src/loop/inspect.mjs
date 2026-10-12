import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesDigest, digest, id } from './contracts.mjs';
import { validateGateRecord } from './evidence.mjs';
import { LOCK_FILE } from './execution-owner.mjs';
import { projectionContent } from './projector.mjs';
import { stopView } from './display.mjs';

// R05a: reports what the durable records say; it never writes, signals, probes a PID or opens the lock file.
const PID_NOTE = 'saved PID is informational: never cancellation authority, never signalled or probed';
const LOCK_NOTE = 'lock file is stat-only: any SQLite read takes a shared lock that can refuse a starting owner (R05a probe L2)';
const HOST_CHECKS = 'the host re-checks transcript reason and the on-disk product candidate before ingesting; not evaluated here';
const RECOVERY_REASONS = new Set(['cleanup_unknown', 'cancel_error', 'orphaned_process_group']);

const failure = error => `${error.code ?? 'ERROR'}${error.errcode ? ` (errcode ${error.errcode})` : ''}: ${error.message}`;

// Journals beside the store: absent, unreadable or the selected rows; opened read-only, never created.
export async function readJournal(path, queries, runId) {
  const none = Object.fromEntries(Object.keys(queries).map(k => [k, []]));
  try { lstatSync(path); } catch (error) { return error.code === 'ENOENT' ? { state: 'absent', ...none } : { state: 'unreadable', error: failure(error), ...none }; }
  const { DatabaseSync } = await import('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true }); db.exec('PRAGMA busy_timeout=3000');
    return { state: 'present', ...Object.fromEntries(Object.entries(queries).map(([k, sql]) => [k, db.prepare(sql).all(runId).map(r => ({ ...r }))])) };
  } catch (error) { return { state: 'unreadable', error: failure(error), ...none }; }
  finally { db?.close(); }
}

function fixtureReceipt(journal, row) {
  if (journal.state !== 'present') return { source: 'fixture-journal', present: null, durable: null, note: `journal ${journal.state}${journal.error ? `: ${journal.error}` : ''}` };
  if (!row) return { source: 'fixture-journal', present: false, durable: false };
  if (row.result === null) return { source: 'fixture-journal', present: false, durable: false, note: 'reserved row without a stored result' };
  try {
    const receipt = JSON.parse(row.result);
    if (digest(receipt) !== row.result_digest) return { source: 'fixture-journal', present: true, durable: false, integrity: 'digest mismatch' };
    return { source: 'fixture-journal', present: true, durable: true, integrity: 'ok', result: receipt.result,
      transcriptReason: receipt.transcript?.reason ?? null, hostRoutesToRecovery: RECOVERY_REASONS.has(receipt.transcript?.reason) };
  } catch (error) { return { source: 'fixture-journal', present: true, durable: false, integrity: failure(error) }; }
}

function gateReceipt(archive, intent, record) {
  if (archive.state !== 'present') return { source: 'evidence-archive', present: null, durable: null, note: `archive ${archive.state}${archive.error ? `: ${archive.error}` : ''}` };
  const journal = intent?.status ?? 'absent';
  if (!record) return { source: 'evidence-archive', present: false, durable: false, intent: journal };
  try {
    const reference = validateGateRecord(JSON.parse(record.body));
    const intact = reference.id === record.evidence_id && reference.digest === record.digest;
    return { source: 'evidence-archive', present: true, durable: intact && journal === 'RECORDED', intent: journal,
      integrity: intact ? 'ok' : 'digest mismatch', result: JSON.parse(record.body).evidence.result };
  } catch (error) { return { source: 'evidence-archive', present: true, durable: false, intent: journal, integrity: failure(error) }; }
}

// Reducer preconditions for `settle` only (reducer.mjs); the host bridge adds its own checks.
function settleView(state, d, receipt) {
  if (d.receipt) return { possible: 'settled' };
  if (!['STARTED', 'UNKNOWN'].includes(d.status)) return { possible: false, blockedBy: `dispatch ${d.status}: never claimed, nothing to ingest` };
  if (!receipt.durable) return { possible: false, blockedBy: receipt.present === null ? 'receipt presence unknown' : 'no durable receipt' };
  if (d.stage !== 'build' && state.candidate !== d.candidate) return { possible: false, blockedBy: 'stale candidate: the run candidate moved since this gate was scheduled' };
  return { possible: true, basis: 'reducer preconditions met', notEvaluated: HOST_CHECKS };
}

function publishedFile(directory, runId, effect) {
  const path = join(directory, `${runId}.${effect.id}.md`);
  let stat;
  try { stat = lstatSync(path); } catch (error) { return error.code === 'ENOENT' ? 'absent' : `unreadable: ${error.code}`; }
  if (!stat.isFile()) return 'not a regular file';
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return bytesDigest(readFileSync(fd)) === bytesDigest(projectionContent(runId, effect)) ? 'present, matches' : 'present, differs';
  } catch (error) { return `unreadable: ${error.code ?? error.message}`; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function projections(directory, runId, state, effects) {
  return effects.filter(e => e.kind === 'projection').map(e => {
    const current = state.projection?.id === e.id;
    const disposition = e.status === 'ACKNOWLEDGED' ? 'acknowledged' : e.status === 'DROPPED' ? 'dropped'
      : !current ? 'superseded (no longer the run projection; outbox not updated)' : state.projection.keptByStop ? 'kept by stop' : e.status.toLowerCase();
    return { id: e.id, outcome: e.payload.outcome, outboxStatus: e.status, current, disposition,
      publishedFile: publishedFile(directory, runId, { id: e.id, kind: e.kind, payload: e.payload }) };
  });
}

function marker(directory, executions) {
  const open = executions.find(e => e.open === 1) ?? null;
  let lock;
  try {
    const stat = lstatSync(join(directory, LOCK_FILE), { bigint: true });
    lock = { present: true, regularFile: stat.isFile(), ino: String(stat.ino), matchesMarkerLockIno: open ? open.lock_ino === String(stat.ino) : null };
  } catch (error) { lock = error.code === 'ENOENT' ? { present: false } : { present: null, error: error.code }; }
  return {
    table: executions.length || open ? 'present' : 'absent or empty', history: executions.length, open: !!open,
    ownerId: open?.owner_id ?? null,
    openedAt: open ? { value: open.opened_at, informational: true } : null,
    pid: open ? { value: open.pid, hostname: open.hostname, pidAuthority: false } : null,
    held: 'unknown: inspection never takes or probes the execution lock',
    lockFile: { ...lock, read: false, note: LOCK_NOTE },
    bindings: { storeBinding: 'not read', targetBinding: 'not read', note: LOCK_NOTE },
  };
}

// Usage is never reported as zero when any dispatch's spend is unknown (plan R11 KO).
function usage(state, unresolved) {
  const entry = key => {
    const value = state.usage[key];
    if (value === null) return { status: 'unknown', recorded: null };
    if (key !== 'agentCalls' && unresolved.length) return { status: 'partial', recorded: value, missing: unresolved.map(d => d.id), note: 'excludes the spend of unresolved dispatches' };
    return { status: 'known', recorded: value };
  };
  return { agentCalls: entry('agentCalls'), tokens: entry('tokens'), costMicroUsd: entry('costMicroUsd') };
}

function recoverySteps(state, dispatches, markerView) {
  const steps = [];
  for (const d of dispatches) if (d.settle.possible === true) steps.push({ action: 'ingest-receipt', dispatchId: d.id, source: d.receipt.source, availableIn: 'R05b', automatic: false });
  const claimed = dispatches.filter(d => !d.settled && d.settle.possible === false && ['STARTED', 'UNKNOWN'].includes(d.status));
  // A receipt that may exist must be read before abandon (run-wide) could discard it (R05a review F2).
  const unknown = claimed.filter(d => d.receipt.present === null), blocked = claimed.filter(d => d.receipt.present !== null);
  if (unknown.length) steps.push({ action: 'receipt-unknown', dispatchIds: unknown.map(d => d.id), availableIn: 'R05b', automatic: false,
    requires: 'read the receipt source before any abandon (a hot journal: recover-journal --all); a durable receipt may exist' });
  else if (state.status === 'RECOVERY_REQUIRED' || blocked.length) steps.push({ action: 'abandon', dispatchIds: blocked.map(d => d.id), availableIn: 'R05b', automatic: false,
    requires: 'operator attestation that the processes exited; the host does not verify it', runStatusRequired: 'RECOVERY_REQUIRED', runStatusNow: state.status,
    effect: 'usage becomes unknown; attempts are kept' });
  if (markerView.open) steps.push({ action: 'close-execution-marker', ownerId: markerView.ownerId, availableIn: 'R05b', automatic: false,
    requires: 'operator note; refused while the recorded owner still holds the lock' });
  return steps;
}

export async function inspectRun({ store, directory, runId }) {
  id(runId);
  const status = store.status(runId), { state } = status, effects = store.effects(runId);
  const fixture = await readJournal(join(directory, 'fixture.sqlite'), { rows: 'SELECT dispatch_id,pid,result,result_digest FROM fixture_dispatches WHERE run_id=?' }, runId);
  const archive = await readJournal(join(directory, 'evidence.sqlite'), {
    intents: 'SELECT dispatch_id,status FROM gate_intents WHERE run_id=?', records: 'SELECT * FROM gate_records WHERE run_id=?' }, runId);
  const dispatches = Object.values(state.dispatches).map(d => {
    const row = fixture.rows.find(r => r.dispatch_id === d.id);
    const receipt = d.stage === 'build' ? fixtureReceipt(fixture, row)
      : gateReceipt(archive, archive.intents.find(r => r.dispatch_id === d.id), archive.records.find(r => r.dispatch_id === d.id));
    return { id: d.id, taskId: d.taskId, stage: d.stage, gateId: d.gateId, candidate: d.candidate, status: d.status, settled: !!d.receipt,
      effect: d.receipt ? 'settled' : d.status === 'PENDING' ? 'not started' : 'unknown: no accepted receipt; inspection cannot tell running from exited',
      acceptedReceipt: d.receipt ? { result: d.receipt.result, tokens: d.receipt.tokens, costMicroUsd: d.receipt.costMicroUsd } : null,
      savedPid: row ? { value: row.pid, pidAuthority: false, note: PID_NOTE } : null,
      receipt, settle: settleView(state, d, receipt) };
  });
  const unresolved = dispatches.filter(d => !d.settled && ['STARTED', 'UNKNOWN'].includes(d.status));
  const markerView = marker(directory, store.executions());
  let eventChain;
  try { const { ok, ...verified } = store.verify(runId); eventChain = { verified: ok, ...verified }; }
  catch (error) { eventChain = { verified: false, error: failure(error) }; }
  const projectionViews = projections(directory, runId, state, effects);
  return {
    readOnly: true, runId, status: state.status, reason: state.reason, stateVersion: status.stateVersion, simulation: status.simulation, eventChain,
    unresolved: { dispatches: unresolved.map(d => d.id), projection: state.projection && state.projection.status !== 'ACKNOWLEDGED' ? state.projection.id : null,
      recoveryRequired: state.status === 'RECOVERY_REQUIRED', markerOpen: markerView.open },
    dispatches, projections: projectionViews, marker: markerView,
    stop: { record: state.stopRequest ?? null, observed: state.stopObserved ?? null, view: stopView(state) },
    usage: usage(state, unresolved),
    journals: { fixture: fixture.state, evidence: archive.state, ...(fixture.error ? { fixtureError: fixture.error } : {}), ...(archive.error ? { evidenceError: archive.error } : {}) },
    recoverySteps: recoverySteps(state, dispatches, markerView),
    operatorAudit: store.operatorAudit(),
    note: 'recoverySteps are suggestions only; inspection performs no action',
  };
}
