import { digest, requirePreStart, requireThat } from './contracts.mjs';
import { command } from './demo.mjs';
import { resolveRef } from './artifacts.mjs';
import { snapshotRepository } from './snapshots.mjs';
import { validateFixtureRequest } from './adapters/fixture-process.mjs';

function binding({ store, adapter, runId, dispatchId }) {
  const status = store.status(runId), capability = adapter.probeCapabilities();
  requireThat(status.simulation === true && capability.simulation === true && capability.liveProvider === false
    && capability.adapter === 'fixture-process' && capability.runId === runId, 'CAPABILITY_MISSING', 'Matching simulation fixture required');
  const { spec, artifacts } = store.bundle(runId), dispatch = status.state.dispatches[dispatchId];
  requireThat(dispatch?.stage === 'build', 'INVALID_TRANSITION', 'Not a build dispatch');
  const snapshot = resolveRef(spec.initialSnapshotRef, artifacts);
  requireThat(snapshot.schemaVersion === 1 && snapshot.repoId === 'product'
    && dispatch.candidate === spec.initialSnapshotRef.digest, 'CAPABILITY_MISSING', 'Fixture builds require an unchanged real product snapshot');
  return { dispatch, state: status.state };
}

const matches = (root, candidate) => {
  try { return digest(snapshotRepository({ root })) === candidate; } catch { return false; }
};

// Explicit host reconciliation, not an automatic retry. Never starts a process.
// Control APIs and fixture journals must remain outside worker write authority.
export async function settleRecordedFixture({ store, adapter, runId, dispatchId, root, now = () => Date.now() }) {
  const { dispatch } = binding({ store, adapter, runId, dispatchId });
  const handle = adapter.lookup(dispatchId);
  requireThat(handle && adapter.inspect(handle).status === 'FINISHED', 'EFFECT_UNKNOWN', 'No durable completed fixture result');
  const record = await adapter.collectResult(handle);
  const payload = { dispatchId, result: record.result, candidate: dispatch.candidate, tokens: 0, costMicroUsd: 0 };
  if (dispatch.receipt) {
    requireThat(digest(dispatch.receipt) === digest(payload), 'IDEMPOTENCY_CONFLICT', 'Fixture receipt differs from accepted result');
    return { alreadySettled: true, simulation: true };
  }
  requireThat(['STARTED', 'UNKNOWN'].includes(dispatch.status), 'INVALID_TRANSITION', 'Fixture was not claimed');
  const current = store.status(runId).state;
  if (['cleanup_unknown', 'cancel_error', 'orphaned_process_group'].includes(record.transcript.reason)
    || current.candidate !== dispatch.candidate || !matches(root, dispatch.candidate)) {
    store.apply('interrupted', command(store, runId, {}), now());
    return { recoveryRequired: true, simulation: true };
  }
  // A fake worker cannot create a new candidate or supply gate acceptance.
  // Late results can account/close dispatches but cannot revive a stopped run.
  return store.apply('settle', command(store, runId, payload), now());
}

// One trusted host, one claimed simulation build. Real provider rollout remains
// disabled. Cancellation requires this caller's AbortSignal/owned adapter handle.
export async function executeStoredFixture({ store, adapter, runId, dispatchId, root, request, signal, quota = null, now = () => Date.now() }) {
  request = structuredClone(request); validateFixtureRequest(request);
  const input = { store, adapter, runId, dispatchId, root, now };
  const { dispatch, state } = binding(input);
  requireThat(!signal?.aborted, 'CANCELLED', 'Fixture cancelled before dispatch');
  requirePreStart(!state.reason && dispatch.status === 'PENDING', 'Only a pending fixture can execute; reconcile existing claims explicitly');
  requireThat(!adapter.lookup(dispatchId), 'EFFECT_UNKNOWN', 'Fixture journal already contains this dispatch; do not execute again');
  requireThat(matches(root, dispatch.candidate), 'STALE_EVIDENCE', 'Scheduled candidate changed');
  store.apply('claim', command(store, runId, { effectId: dispatchId, quota }), now());
  const claimed = store.status(runId).state;
  if (claimed.dispatches[dispatchId].status !== 'STARTED') return { cancelledBeforeStart: true };
  // A stop committed after the claim refuses the spawn (re-read now: R04b F2); the claim settles cancelled.
  if (claimed.reason || store.readStopRequest(runId)) {
    store.apply('settle', command(store, runId, { dispatchId, result: 'cancelled', candidate: dispatch.candidate, tokens: 0, costMicroUsd: 0 }), now());
    return { cancelledBeforeStart: true };
  }
  let handle;
  const abort = () => { if (handle) adapter.cancel(handle); };
  try {
    handle = adapter.start(dispatchId, request);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    await adapter.collectResult(handle);
    return await settleRecordedFixture(input);
  } catch (error) {
    store.apply('interrupted', command(store, runId, {}), now());
    throw error;
  } finally { signal?.removeEventListener('abort', abort); }
}
