import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bytesDigest, digest, id, LoopError, requireThat } from './contracts.mjs';
import { resolveRef } from './artifacts.mjs';
import { command } from './demo.mjs';
import { validateGateIntent, validateGateRecord } from './evidence.mjs';
import { closeOrphanedExecution, withExclusiveLock } from './execution-owner.mjs';
import { journalState, rollbackInPlace, SQLITE_READONLY_ROLLBACK } from './hot-journal.mjs';
import { inspectRun, readJournal } from './inspect.mjs';
import { TERMINAL } from './reducer.mjs';
import { resolveContained, snapshotRepository } from './snapshots.mjs';
import { openStore, openStoreReadOnly } from './store.mjs';

// R05b (ADR 0005): explicit operator recovery. Never spawns, resumes, signals a saved PID or deletes a row.
const RECOVERY_REASONS = new Set(['cleanup_unknown', 'cancel_error', 'orphaned_process_group']);
const JOURNALS = ['fixture.sqlite', 'evidence.sqlite'];
const storeFile = directory => join(resolve(directory), 'loop.sqlite');
const parse = text => { try { return JSON.parse(text); } catch { return null; } };

function requireNote(note) {
  requireThat(typeof note === 'string' && note.trim().length > 0 && note.length <= 500 && !/[\x00-\x1F\x7F]/.test(note),
    'INVALID_SPEC', 'Operator note: 1-500 characters without control characters required (--note)');
}

// A writable open would roll a hot journal back silently; write commands refuse and leave that to recover-journal.
async function requireNoHotJournal(filename) {
  let store;
  try { store = await openStoreReadOnly(filename); }
  catch (error) {
    if (error.errcode !== SQLITE_READONLY_ROLLBACK) throw error;
    throw new LoopError('HOT_JOURNAL', 'Control store has a hot rollback journal; run recover-journal first (inspect reads a snapshot)');
  } finally { store?.close(); }
}

// Rule 4: the kernel lock excludes a live driver for the whole command; no marker row, no binding written.
async function withRecoveryStore(directory, fn) {
  const filename = storeFile(directory);
  await requireNoHotJournal(filename);
  return withExclusiveLock({ store: { filename } }, async lock => {
    await requireNoHotJournal(filename);
    const store = await openStore(filename, { create: false });
    try { return await fn(store, lock); } finally { store.close(); }
  });
}

function boundProduct(lock) {
  const bound = lock.targetBinding;
  requireThat(bound, 'CAPABILITY_MISSING', 'No bound product clone in this state directory; the on-disk candidate cannot be re-checked');
  const root = join(lock.statePath, bound.target_path);
  let stat = null;
  try { stat = statSync(root, { bigint: true }); } catch { /* reported below */ }
  requireThat(stat && String(stat.dev) === bound.target_dev && String(stat.ino) === bound.target_ino, 'TARGET_MISMATCH', 'Bound product clone is missing or was replaced');
  return root;
}
const currentCandidate = (root, repoId, oracle = []) => {
  try {
    const value = digest(snapshotRepository({ root, repoId }));
    return oracle.every(e => bytesDigest(readFileSync(resolveContained(root, e.path))) === e.digest) ? value : null;
  } catch { return null; }
};
const sourceUnknown = (name, journal) => new LoopError('RECEIPT_SOURCE_UNKNOWN',
  `${name} ${journal.state}${journal.error ? `: ${journal.error}` : ''}; make it readable (a hot journal: recover-journal --all) first`);

async function buildReceipt({ directory, runId, d, spec, artifacts }) {
  const journal = await readJournal(join(directory, 'fixture.sqlite'), { rows: 'SELECT * FROM fixture_dispatches WHERE run_id=?' }, runId);
  if (journal.state !== 'present') throw sourceUnknown('Fixture journal', journal);
  const row = journal.rows.find(r => r.dispatch_id === d.id);
  requireThat(row && row.result !== null, 'RECEIPT_MISSING', `No durable receipt for ${d.id} in the fixture journal`);
  const receipt = parse(row.result), request = parse(row.request);
  requireThat(receipt && request && digest(receipt) === row.result_digest && digest(request) === row.request_digest,
    'RECEIPT_MISMATCH', 'Fixture receipt digest does not match its journal row');
  const snapshot = resolveRef(spec.initialSnapshotRef, artifacts);
  requireThat(snapshot.schemaVersion === 1 && snapshot.repoId === 'product' && d.candidate === spec.initialSnapshotRef.digest,
    'RECEIPT_MISMATCH', 'Fixture builds require the unchanged product snapshot the dispatch recorded');
  // Usage comes only from the receipt; a receipt without structured output leaves it unknown (plan R11 KO).
  const usage = receipt.structured;
  return { action: 'settle', usageSource: usage ? 'receipt' : 'absent from receipt: unknown',
    payload: { dispatchId: d.id, result: receipt.result, candidate: d.candidate, tokens: usage?.tokens ?? null, costMicroUsd: usage?.costMicroUsd ?? null },
    current(state, lock) {
      requireThat(!RECOVERY_REASONS.has(receipt.transcript?.reason), 'EFFECT_UNKNOWN', `Receipt reports ${receipt.transcript?.reason}: process cleanup unverified; not ingestible`);
      requireThat(state.candidate === d.candidate && currentCandidate(boundProduct(lock), 'product') === d.candidate,
        'STALE_RECEIPT', 'Run or on-disk product candidate moved since this build was scheduled');
    } };
}

async function gateReceipt({ directory, runId, d, spec, artifacts }) {
  const archive = await readJournal(join(directory, 'evidence.sqlite'), {
    intents: 'SELECT * FROM gate_intents WHERE run_id=?', records: 'SELECT * FROM gate_records WHERE run_id=?' }, runId);
  if (archive.state !== 'present') throw sourceUnknown('Evidence archive', archive);
  const record = archive.records.find(r => r.dispatch_id === d.id), intent = archive.intents.find(r => r.dispatch_id === d.id);
  requireThat(record, 'RECEIPT_MISSING', `No archived gate evidence for ${d.id}`);
  let body, reference;
  try {
    body = JSON.parse(record.body); reference = validateGateRecord(body);
    requireThat(intent?.status === 'RECORDED' && validateGateIntent(JSON.parse(intent.body)) === intent.digest, 'RECEIPT_MISMATCH', 'not journaled as RECORDED');
  } catch (error) { throw new LoopError('RECEIPT_MISMATCH', `Archived gate evidence is not a durable receipt: ${error.message}`); }
  const e = body.evidence, manifest = resolveRef(spec.manifestRef, artifacts);
  const gateRef = manifest.gates.find(g => g.id === d.gateId)?.artifactRef, gate = gateRef ? resolveRef(gateRef, artifacts) : null;
  requireThat(gate && reference.id === record.evidence_id && reference.digest === record.digest && e.runId === runId && e.dispatchId === d.id
    && e.taskId === (d.taskId ?? 'run-final') && e.gateRef.digest === gate.specDigest && e.candidateSnapshotRef.digest === d.candidate,
  'RECEIPT_MISMATCH', 'Archived evidence does not match the scheduled gate dispatch');
  // A host-local gate has no provider usage: its reservation is zero and its producer is host-local-gate (ADR 0005).
  return { action: 'settle-evidence', usageSource: 'host-local gate: no provider usage',
    payload: { dispatchId: d.id, result: e.result, candidate: d.candidate, tokens: 0, costMicroUsd: 0, evidenceRef: reference },
    current(state, lock) {
      requireThat(!body.scopeAttestation.recoveryRequired && body.scopeAttestation.unchanged, 'EFFECT_UNKNOWN', 'Gate evidence reports a scope change or unverified cleanup; not ingestible');
      requireThat(gate.repoId === 'product' && state.candidate === d.candidate && currentCandidate(boundProduct(lock), gate.repoId, body.oracle) === d.candidate,
        'STALE_RECEIPT', 'Run or on-disk product candidate moved since this gate was scheduled');
    } };
}

// Holding the lock proves no live owner: a STARTED dispatch is unknown work, recorded as `interrupted` first (R02 path).
function markInterrupted(store, runId, now) {
  const { state } = store.status(runId);
  if (TERMINAL.has(state.status) || state.status === 'RECOVERY_REQUIRED') return false;
  store.apply('interrupted', command(store, runId, {}), now()); return true;
}

export async function ingestReceipt({ directory, runId, dispatchId, now = Date.now }) {
  id(runId); id(dispatchId);
  return withRecoveryStore(directory, async (store, lock) => {
    store.verify(runId);
    const { state } = store.status(runId), { spec, artifacts } = store.bundle(runId), d = state.dispatches[dispatchId];
    requireThat(d, 'UNKNOWN_REFERENCE', `Unknown dispatch ${dispatchId}`);
    requireThat(d.status !== 'PENDING', 'INVALID_TRANSITION', `Dispatch ${dispatchId} was never claimed; nothing to ingest`);
    const receipt = await (d.stage === 'build' ? buildReceipt : gateReceipt)({ directory: resolve(directory), runId, d, spec, artifacts });
    const { evidenceRef, ...accepted } = receipt.payload;
    if (d.receipt) {
      requireThat(digest(d.receipt) === digest(accepted) && (!evidenceRef || digest(d.evidenceRef ?? null) === digest(evidenceRef)),
        'RECEIPT_MISMATCH', 'Durable receipt differs from the receipt already accepted');
      return { alreadySettled: true, dispatchId, status: state.status, stateVersion: store.status(runId).stateVersion };
    }
    requireThat(['STARTED', 'UNKNOWN'].includes(d.status), 'INVALID_TRANSITION', `Dispatch ${dispatchId} is ${d.status}`);
    receipt.current(state, lock);
    const interruptedFirst = markInterrupted(store, runId, now);
    const reply = store.apply(receipt.action, command(store, runId, receipt.payload), now()), after = store.status(runId).state;
    return { settled: true, dispatchId, result: accepted.result, interruptedFirst, status: after.status, stateVersion: reply.stateVersion,
      usage: { tokens: accepted.tokens, costMicroUsd: accepted.costMicroUsd, source: receipt.usageSource },
      next: 'ingestion is not a success outcome; the run closes through abandon (ADR 0001 decision 6)' };
  });
}

export async function abandonRun({ directory, runId, note, confirm, now = Date.now }) {
  id(runId); requireNote(note);
  requireThat(confirm === runId, 'INVALID_SPEC', 'Confirmation must repeat the run id (--confirm <runId>)');
  return withRecoveryStore(directory, async store => {
    store.verify(runId);
    const view = await inspectRun({ store, directory: resolve(directory), runId });
    requireThat(!TERMINAL.has(view.status), 'RUN_TERMINAL', 'Run is terminal');
    const claimed = view.dispatches.filter(d => !d.settled && ['STARTED', 'UNKNOWN'].includes(d.status));
    // R05a review F2: a durable receipt may exist in a source that cannot be read.
    const unknown = claimed.filter(d => d.receipt.present === null).map(d => d.id);
    requireThat(!unknown.length, 'RECEIPT_SOURCE_UNKNOWN', `Receipt source unknown for ${unknown.join(', ')}; make it readable (recover-journal --all) or ingest first`);
    requireThat(view.status === 'RECOVERY_REQUIRED' || claimed.length, 'INVALID_TRANSITION', `Run is ${view.status} with no unresolved dispatch; nothing to abandon`);
    const interruptedFirst = markInterrupted(store, runId, now);
    const reply = store.apply('abandon', command(store, runId, { operatorConfirmation: confirm, note }), now()), after = store.status(runId).state;
    return { abandoned: true, confirmation: 'operator confirmation', processExit: 'not verified by the host', interruptedFirst,
      dispatches: claimed.map(d => d.id), durableReceiptsNotIngested: claimed.filter(d => d.receipt.durable).map(d => d.id),
      status: after.status, reason: after.reason, usage: after.usage, stateVersion: reply.stateVersion,
      attempts: Object.fromEntries(Object.entries(after.tasks).map(([k, t]) => [k, t.attempts])) };
  });
}

// ADR 0002 §3(c) through the CLI; closeOrphanedExecution takes the kernel lock itself and leaves run state alone.
export async function closeExecutionMarker({ directory, ownerId, note, now = Date.now }) {
  requireNote(note);
  requireThat(typeof ownerId === 'string' && ownerId.length > 0 && ownerId.length <= 64, 'INVALID_SPEC', 'Exact open owner id required (--owner)');
  const filename = storeFile(directory);
  await requireNoHotJournal(filename);
  const store = await openStore(filename, { create: false });
  try {
    const open = store.executions().find(e => e.open === 1 && e.owner_id === ownerId) ?? null;
    const result = await closeOrphanedExecution({ store, ownerId, note, now });
    const audit = store.appendOperatorAudit({ action: 'close-execution-marker', note, now: now(),
      detail: { ownerId, pid: open?.pid ?? null, pidAuthority: false, openedAt: open?.opened_at ?? null } });
    return { ...result, ownerId, closeKind: 'operator', auditSeq: audit.seq, runStateChanged: false, processExit: 'not verified by the host' };
  } finally { store.close(); }
}

export async function recoverJournals({ directory, all = false, note, now = Date.now }) {
  requireNote(note);
  const root = resolve(directory), filename = storeFile(directory);
  requireThat((await journalState(filename)).state !== 'absent', 'STORE_MISSING', `No control store at ${filename}`);
  return withExclusiveLock({ store: { filename } }, async () => {
    const files = [];
    for (const name of ['loop.sqlite', ...(all ? JOURNALS : [])]) files.push(await rollbackInPlace(join(root, name)));
    const store = await openStore(filename, { create: false });
    try {
      const chains = store.runIds().map(runId => {
        try { return { runId, ...store.verify(runId) }; } catch (error) { return { runId, ok: false, code: error.code ?? 'ERROR' }; }
      });
      const at = now(), audit = store.appendOperatorAudit({ action: 'recover-journal', detail: { files, chains }, note, now: at });
      return { files, chains, at, auditSeq: audit.seq, effect: 'rollback discards only an uncommitted transaction; committed history is unchanged' };
    } finally { store.close(); }
  });
}
