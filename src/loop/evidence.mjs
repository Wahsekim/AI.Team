import { chmodSync, lstatSync } from 'node:fs';
import { canonical, digest, fields, id, ref, relativePath, requireThat } from './contracts.mjs';
import { validateGate } from './gates.mjs';

// Integrity validation, not authentication. Only a trusted host may write this
// archive; hashes do not establish who executed a process or enforce a sandbox.
export function validateGateRecord(record) {
  fields(record, ['evidence', 'transcript', 'scopeAttestation', 'snapshot', 'gate', 'invocation', 'oracle'], 'Gate record');
  requireThat(Buffer.byteLength(canonical(record)) <= 16 * 1024 * 1024, 'LIMIT_REACHED', 'Gate record exceeds 16 MiB');
  const { evidence: e, transcript: t, scopeAttestation: s, snapshot, gate, invocation: i, oracle } = record;
  validateGate(gate);
  fields(e, ['schemaVersion', 'id', 'runId', 'taskId', 'dispatchId', 'candidateSnapshotRef', 'gateRef', 'producerIdentity',
    'result', 'exitCode', 'startedAt', 'finishedAt', 'transcriptRef', 'scopeAttestationRef', 'invocationRef'], 'Evidence');
  requireThat(e.schemaVersion === 2 && e.producerIdentity === 'host-local-gate', 'INVALID_SPEC', 'Unsupported evidence producer/version');
  [e.id, e.runId, e.taskId, e.dispatchId].forEach(id);
  const bound = (reference, name, value) => {
    ref(reference); requireThat(reference.id === name && reference.digest === digest(value), 'STALE_EVIDENCE', `Mismatched ${name}`);
  };
  bound(e.candidateSnapshotRef, snapshot.id, snapshot);
  ref(e.gateRef); requireThat(e.gateRef.id === gate.id && e.gateRef.digest === gate.specDigest, 'STALE_EVIDENCE', 'Mismatched gate');
  bound(e.transcriptRef, 'transcript', t); bound(e.scopeAttestationRef, 'scope-attestation', s); bound(e.invocationRef, 'invocation', i);
  fields(snapshot, ['schemaVersion', 'id', 'repoId', 'baseCommit', 'treeDigest', 'inventory'], 'Snapshot');
  requireThat(snapshot.schemaVersion === 1 && snapshot.repoId === gate.repoId
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.baseCommit) && Array.isArray(snapshot.inventory), 'INVALID_SPEC', 'Invalid snapshot');
  const paths = new Set();
  for (const entry of snapshot.inventory) {
    fields(entry, entry.kind === 'deleted' ? ['path', 'kind'] : ['path', 'kind', 'executable', 'bytes', 'digest'], 'Inventory entry');
    relativePath(entry.path); requireThat(!paths.has(entry.path), 'INVALID_SPEC', 'Duplicate inventory path'); paths.add(entry.path);
    requireThat(['file', 'deleted'].includes(entry.kind), 'INVALID_SPEC', 'Invalid inventory kind');
    if (entry.kind === 'file') requireThat(typeof entry.executable === 'boolean' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
      && /^sha256:[a-f0-9]{64}$/.test(entry.digest), 'INVALID_SPEC', 'Invalid inventory file');
  }
  requireThat(snapshot.treeDigest === digest({ baseCommit: snapshot.baseCommit, inventory: snapshot.inventory })
    && snapshot.id === `snapshot-${snapshot.treeDigest.slice(7, 39)}`, 'STALE_EVIDENCE', 'Snapshot inventory digest mismatch');
  fields(i, ['schemaVersion', 'executableRef', 'argv', 'cwd', 'envProfileId', 'environmentDigest', 'oracleBundleRef', 'networkPolicyId', 'maxOutputBytes'], 'Invocation');
  requireThat(i.schemaVersion === 1 && /^sha256:[a-f0-9]{64}$/.test(i.environmentDigest)
    && Number.isSafeInteger(i.maxOutputBytes) && i.maxOutputBytes > 0 && i.maxOutputBytes <= 16 * 1024 * 1024, 'INVALID_SPEC', 'Invalid invocation');
  for (const key of ['executableRef', 'argv', 'cwd', 'envProfileId', 'oracleBundleRef', 'networkPolicyId']) {
    requireThat(digest(i[key]) === digest(gate[key]), 'STALE_EVIDENCE', `Invocation ${key} mismatch`);
  }
  requireThat(Array.isArray(oracle) && oracle.length > 0 && digest(oracle) === gate.oracleBundleRef.digest, 'STALE_EVIDENCE', 'Oracle bundle mismatch');
  for (const entry of oracle) {
    fields(entry, ['path', 'digest'], 'Oracle entry'); relativePath(entry.path);
    requireThat(/^sha256:[a-f0-9]{64}$/.test(entry.digest), 'INVALID_SPEC', 'Invalid oracle digest');
  }
  fields(t, ['exitCode', 'signal', 'error', 'reason', 'stdout', 'stderr', 'startedAt', 'finishedAt'], 'Transcript');
  requireThat(t.exitCode === null || Number.isInteger(t.exitCode) && t.exitCode >= 0 && t.exitCode <= 255, 'INVALID_SPEC', 'Invalid exit code');
  for (const key of ['signal', 'error', 'reason']) requireThat(t[key] === null || typeof t[key] === 'string', 'INVALID_SPEC', `Invalid ${key}`);
  requireThat(typeof t.stdout === 'string' && typeof t.stderr === 'string', 'INVALID_SPEC', 'Invalid output');
  // UTF-8 replacement characters may expand a bounded byte buffer by up to 3x.
  requireThat(Buffer.byteLength(t.stdout) + Buffer.byteLength(t.stderr) <= i.maxOutputBytes * 3, 'LIMIT_REACHED', 'Transcript exceeds output cap');
  requireThat([t.startedAt, t.finishedAt].every(v => typeof v === 'string' && Number.isFinite(Date.parse(v)))
    && Date.parse(t.finishedAt) >= Date.parse(t.startedAt), 'INVALID_SPEC', 'Invalid execution timestamps');
  requireThat(e.exitCode === t.exitCode && e.startedAt === t.startedAt && e.finishedAt === t.finishedAt, 'STALE_EVIDENCE', 'Transcript metadata mismatch');
  fields(s, ['unchanged', 'postSnapshotError', 'before', 'networkPolicy', 'trustTier', 'recoveryRequired'], 'Scope attestation');
  requireThat(typeof s.unchanged === 'boolean' && (s.postSnapshotError === null || typeof s.postSnapshotError === 'string')
    && s.before === snapshot.treeDigest && s.networkPolicy === gate.networkPolicyId && s.trustTier === 'local-attended'
    && s.recoveryRequired === ['cleanup_unknown', 'cancel_error', 'orphaned_process_group'].includes(t.reason), 'INVALID_SPEC', 'Invalid scope attestation');
  const expected = !s.unchanged || t.error ? 'error' : t.reason === 'timeout' ? 'timeout'
    : t.reason || t.signal ? 'error' : gate.successExitCodes.includes(t.exitCode) ? 'pass' : 'fail';
  requireThat(e.result === expected && e.id === `evidence-${digest({ runId: e.runId, dispatchId: e.dispatchId, transcript: t }).slice(7, 39)}`,
    'STALE_EVIDENCE', 'Evidence outcome/identity mismatch');
  return { id: e.id, digest: digest(record) };
}

export function validateGateIntent(intent) {
  fields(intent, ['runId', 'dispatchId', 'taskId', 'candidateSnapshotRef', 'gateRef', 'invocationDigest'], 'Gate intent');
  [intent.runId, intent.dispatchId, intent.taskId].forEach(id);
  ref(intent.candidateSnapshotRef); ref(intent.gateRef);
  requireThat(/^sha256:[a-f0-9]{64}$/.test(intent.invocationDigest), 'INVALID_SPEC', 'Invalid invocation digest');
  return digest(intent);
}

// Separate versioned archive: opening it never migrates or changes the existing
// simulation control store. Transactions persist the complete record atomically.
export async function openEvidenceArchive(filename) {
  requireThat(Number(process.versions.node.split('.')[0]) >= 24, 'CAPABILITY_MISSING', 'Evidence archive requires Node 24+');
  if (filename !== ':memory:') {
    try { requireThat(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink(), 'SCOPE_DENIED', 'Archive must be a regular file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filename);
  try {
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS evidence_metadata(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS gate_records(run_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,dispatch_id));
      CREATE TABLE IF NOT EXISTS gate_intents(run_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
        digest TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','STARTED','UNKNOWN','RECORDED','CANCELLED')),
        PRIMARY KEY(run_id,dispatch_id));`);
    const versions = db.prepare('SELECT version FROM evidence_metadata').all();
    if (!versions.length) db.prepare('INSERT OR IGNORE INTO evidence_metadata VALUES (1)').run();
    else requireThat(versions.length === 1 && versions[0].version === 1, 'CAPABILITY_MISSING', 'Unsupported evidence archive version');
  } catch (error) { db.close(); throw error; }
  const decode = row => {
    requireThat(row, 'UNKNOWN_REFERENCE', 'Evidence not found');
    const record = JSON.parse(row.body); const reference = validateGateRecord(record);
    requireThat(reference.id === row.evidence_id && reference.digest === row.digest && record.evidence.runId === row.run_id
      && record.evidence.dispatchId === row.dispatch_id, 'STALE_EVIDENCE', 'Archive integrity mismatch');
    return { reference, record };
  };
  const intentRow = (runId, dispatchId) => {
    id(runId); id(dispatchId);
    const row = db.prepare('SELECT * FROM gate_intents WHERE run_id=? AND dispatch_id=?').get(runId, dispatchId);
    requireThat(row, 'UNKNOWN_REFERENCE', 'Gate intent not found');
    const intent = JSON.parse(row.body);
    requireThat(validateGateIntent(intent) === row.digest && intent.runId === runId && intent.dispatchId === dispatchId,
      'STALE_EVIDENCE', 'Gate intent integrity mismatch');
    return { intent, status: row.status };
  };
  return {
    close() { db.close(); },
    reserve(intent) {
      const hash = validateGateIntent(intent), body = canonical(intent);
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare('SELECT digest FROM gate_intents WHERE run_id=? AND dispatch_id=?').get(intent.runId, intent.dispatchId);
        if (previous) requireThat(previous.digest === hash, 'IDEMPOTENCY_CONFLICT', 'Conflicting gate intent');
        else {
          requireThat(!db.prepare('SELECT 1 FROM gate_records WHERE run_id=? AND dispatch_id=?').get(intent.runId, intent.dispatchId),
            'IDEMPOTENCY_CONFLICT', 'Cannot attach intent to an existing unjournaled record');
          db.prepare('INSERT INTO gate_intents VALUES (?,?,?,?,?)').run(intent.runId, intent.dispatchId, hash, body, 'PENDING');
        }
        const value = intentRow(intent.runId, intent.dispatchId); db.exec('COMMIT'); return value;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    intent: intentRow,
    transition(runId, dispatchId, from, to) {
      requireThat([['PENDING', 'STARTED'], ['PENDING', 'CANCELLED'], ['STARTED', 'UNKNOWN']].some(([a, b]) => a === from && b === to),
        'INVALID_TRANSITION', 'Invalid gate execution transition');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = intentRow(runId, dispatchId);
        requireThat(current.status === from, 'EFFECT_UNKNOWN', `Gate intent is ${current.status}; never restart an uncertain effect`);
        db.prepare('UPDATE gate_intents SET status=? WHERE run_id=? AND dispatch_id=?').run(to, runId, dispatchId);
        db.exec('COMMIT'); return { ...current, status: to };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    put(record) {
      const reference = validateGateRecord(record), body = canonical(record), e = record.evidence;
      db.exec('BEGIN IMMEDIATE');
      try {
        const journaled = db.prepare('SELECT 1 FROM gate_intents WHERE run_id=? AND dispatch_id=?').get(e.runId, e.dispatchId);
        if (journaled) {
          const { intent, status } = intentRow(e.runId, e.dispatchId);
          requireThat(['STARTED', 'UNKNOWN', 'RECORDED'].includes(status), 'INVALID_TRANSITION', 'Gate was never started');
          requireThat(intent.taskId === e.taskId && digest(intent.candidateSnapshotRef) === digest(e.candidateSnapshotRef)
            && digest(intent.gateRef) === digest(e.gateRef) && intent.invocationDigest === e.invocationRef.digest,
            'STALE_EVIDENCE', 'Evidence differs from gate intent');
        }
        const existing = db.prepare('SELECT * FROM gate_records WHERE run_id=? AND dispatch_id=?').get(e.runId, e.dispatchId);
        if (existing) requireThat(decode(existing).reference.digest === reference.digest, 'IDEMPOTENCY_CONFLICT', 'Dispatch already has different evidence');
        else db.prepare('INSERT INTO gate_records VALUES (?,?,?,?,?)').run(e.runId, e.dispatchId, reference.id, reference.digest, body);
        if (journaled) db.prepare('UPDATE gate_intents SET status=? WHERE run_id=? AND dispatch_id=?').run('RECORDED', e.runId, e.dispatchId);
        db.exec('COMMIT'); return reference;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    get(runId, dispatchId, expectedRef = null) {
      id(runId); id(dispatchId);
      const value = decode(db.prepare('SELECT * FROM gate_records WHERE run_id=? AND dispatch_id=?').get(runId, dispatchId));
      if (expectedRef) { ref(expectedRef); requireThat(digest(expectedRef) === digest(value.reference), 'STALE_EVIDENCE', 'Evidence reference mismatch'); }
      return value;
    },
  };
}
