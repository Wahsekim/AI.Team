import { readFileSync } from 'node:fs';
import { bytesDigest, digest, requireThat } from './contracts.mjs';
import { resolveRef } from './artifacts.mjs';
import { command } from './demo.mjs';
import { gateInvocation, runLocalGate, validateGate } from './gates.mjs';
import { resolveContained, snapshotRepository } from './snapshots.mjs';

function binding(store, runId, dispatchId) {
  const { spec, artifacts } = store.bundle(runId), { state } = store.status(runId);
  const dispatch = state.dispatches[dispatchId];
  requireThat(dispatch && ['gate', 'final-gate'].includes(dispatch.stage), 'INVALID_TRANSITION', 'Not a gate dispatch');
  const manifest = resolveRef(spec.manifestRef, artifacts);
  const reference = manifest.gates.find(g => g.id === dispatch.gateId)?.artifactRef;
  requireThat(reference, 'UNKNOWN_REFERENCE', 'Gate is not bound in run manifest');
  const gate = resolveRef(reference, artifacts); validateGate(gate);
  requireThat(gate.id === dispatch.gateId, 'INVALID_SPEC', 'Gate identifier mismatch');
  return { dispatch, gate, state };
}

// Host-only bridge. A receipt reference is not an authority token: callers and
// both stores must stay out of the worker's write/API surface.
export function settleRecordedGate({ store, archive, runId, dispatchId, repoRoots, now = Date.now() }) {
  const { dispatch, gate, state } = binding(store, runId, dispatchId);
  const { reference, record } = archive.get(runId, dispatchId);
  const { evidence: e, scopeAttestation: scope } = record;
  requireThat(archive.intent(runId, dispatchId).status === 'RECORDED', 'EFFECT_UNKNOWN', 'Gate evidence was not journaled');
  requireThat(e.taskId === (dispatch.taskId ?? 'run-final') && e.gateRef.digest === gate.specDigest
    && e.candidateSnapshotRef.digest === dispatch.candidate, 'STALE_EVIDENCE', 'Receipt does not match scheduled gate');
  const payload = { dispatchId, result: e.result, candidate: dispatch.candidate, tokens: 0, costMicroUsd: 0, evidenceRef: reference };
  // A lost acknowledgement can be replayed without re-running or re-reading a
  // now changed product, but it must match the receipt already accepted.
  if (dispatch.evidenceRef) {
    requireThat(digest(dispatch.evidenceRef) === digest(reference), 'IDEMPOTENCY_CONFLICT', 'Different evidence already accepted');
    return { alreadySettled: true, evidenceRef: reference };
  }
  requireThat(['STARTED', 'UNKNOWN'].includes(dispatch.status), 'INVALID_TRANSITION', 'Gate was not claimed');
  let currentCandidate;
  try {
    const root = repoRoots[gate.repoId];
    currentCandidate = digest(snapshotRepository({ root, repoId: gate.repoId }));
    for (const entry of record.oracle) if (bytesDigest(readFileSync(resolveContained(root, entry.path))) !== entry.digest) currentCandidate = null;
  }
  catch { currentCandidate = null; }
  if (scope.recoveryRequired || !scope.unchanged || currentCandidate !== dispatch.candidate || state.candidate !== dispatch.candidate) {
    store.apply('interrupted', command(store, runId, {}), now);
    return { recoveryRequired: true, evidenceRef: reference };
  }
  return store.apply('settle-evidence', command(store, runId, payload), now);
}

// Runs one explicitly approved local gate, not an LLM. No automatic retry of a
// STARTED/UNKNOWN journal entry; recovery can consume RECORDED without spawning.
export async function executeStoredGate({ store, archive, runId, dispatchId, config, quota = null, now = () => Date.now() }) {
  const { dispatch, gate, state } = binding(store, runId, dispatchId);
  requireThat(!dispatch.receipt && !state.reason, 'INVALID_TRANSITION', 'Run is stopped or gate already settled');
  requireThat(gate.specDigest === config.gate.specDigest, 'STALE_EVIDENCE', 'Unapproved gate configuration');
  const { signal, ...plain } = config;
  const frozen = structuredClone(plain);
  const snapshot = snapshotRepository({ root: frozen.repoRoots[gate.repoId], repoId: gate.repoId });
  requireThat(digest(snapshot) === dispatch.candidate, 'STALE_EVIDENCE', 'Scheduled candidate changed');
  const intent = { runId, dispatchId, taskId: dispatch.taskId ?? 'run-final', candidateSnapshotRef: { id: snapshot.id, digest: digest(snapshot) },
    gateRef: { id: gate.id, digest: gate.specDigest }, invocationDigest: digest(gateInvocation(gate, frozen.envProfiles[gate.envProfileId], frozen.maxOutputBytes)) };
  const journal = archive.reserve(intent);
  requireThat(journal.status === 'PENDING', 'EFFECT_UNKNOWN', `Gate is ${journal.status}; inspect/reconcile instead of executing again`);
  if (dispatch.status === 'PENDING') store.apply('claim', command(store, runId, { effectId: dispatchId, quota }), now());
  // Also recheck admission when recovering the claim-before-journal-start gap.
  // A previously claimed effect is not an exemption from a new deadline/stop.
  store.apply('tick', command(store, runId, { reservation: { agentCalls: 0, tokens: 0, costMicroUsd: 0 }, quota }), now());
  const current = store.status(runId).state, claimed = current.dispatches[dispatchId];
  if (claimed.status !== 'STARTED' || current.reason) {
    archive.transition(runId, dispatchId, 'PENDING', 'CANCELLED');
    if (claimed.status === 'STARTED' && !claimed.receipt) store.apply('settle', command(store, runId,
      { dispatchId, result: 'cancelled', candidate: dispatch.candidate, tokens: 0, costMicroUsd: 0 }), now());
    return { cancelledBeforeStart: true };
  }
  archive.transition(runId, dispatchId, 'PENDING', 'STARTED');
  try {
    const record = await runLocalGate({ ...frozen, signal, gate, runId, dispatchId, taskId: intent.taskId, expectedCandidate: dispatch.candidate });
    archive.put(record);
  } catch (error) {
    if (archive.intent(runId, dispatchId).status === 'STARTED') archive.transition(runId, dispatchId, 'STARTED', 'UNKNOWN');
    store.apply('interrupted', command(store, runId, {}), now());
    throw error;
  }
  return settleRecordedGate({ store, archive, runId, dispatchId, repoRoots: frozen.repoRoots, now: now() });
}
