import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { LoopError, requireThat } from './contracts.mjs';
import { resolveRef } from './artifacts.mjs';
import { command } from './demo.mjs';
import { stopKind, stopSeq, TERMINAL } from './reducer.mjs';
import { executeStoredFixture } from './host-fixtures.mjs';
import { executeStoredGate } from './host-gates.mjs';
import { validateFixtureRequest } from './adapters/fixture-process.mjs';
import { publishProjection } from './projector.mjs';
import { assertOwnedTarget, bindDriver, stateIdentity } from './execution-owner.mjs';

// R04b: stop records are polled between steps and every `pollMs` while a step runs (target: observed within 2 s).
export const STOP_POLL_MS = 250, MAX_STOP_POLL_MS = 2000;
const unresolved = state => state.projection?.status === 'STARTED'
  || Object.values(state.dispatches).some(d => !d.receipt && ['STARTED', 'UNKNOWN'].includes(d.status));

// Single trusted host, fixture builds only. One step runs at most one effect.
// `owner` (acquireExecutionOwner) is the cross-process authority; one driver per owner handle.
export function createFixtureDriver({ store, owner, adapter, archive, runId, root, projectionDirectory,
  request = { scenario: 'pass', delayMs: 0, timeoutMs: 1000 }, gateConfigs, quota = () => null, now = () => Date.now(), pollMs = STOP_POLL_MS }) {
  const capability = adapter.probeCapabilities();
  requireThat(store.status(runId).simulation === true && capability.adapter === 'fixture-process'
    && capability.simulation === true && capability.liveProvider === false && capability.runId === runId,
  'CAPABILITY_MISSING', 'Only a matching simulation fixture is supported');
  requireThat(typeof now === 'function' && typeof quota === 'function', 'INVALID_SPEC', 'Host time/quota callbacks required');
  requireThat(Number.isSafeInteger(pollMs) && pollMs >= 1 && pollMs <= MAX_STOP_POLL_MS, 'INVALID_SPEC', `Stop poll interval must be 1..${MAX_STOP_POLL_MS} ms`);
  request = structuredClone(request); validateFixtureRequest(request);
  gateConfigs = structuredClone(gateConfigs);
  root = realpathSync.native(root); projectionDirectory = realpathSync.native(projectionDirectory);
  const outside = target => { const rel = relative(root, target); return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`); };
  requireThat(outside(projectionDirectory), 'SCOPE_DENIED', 'Projection directory must be outside product');
  // A product snapshot opens files in-process; opening the lock file would drop the kernel lock (ADR 0002 P3).
  requireThat(outside(stateIdentity(store).path), 'SCOPE_DENIED', 'State directory must be outside product');
  const { spec, artifacts } = store.bundle(runId), manifest = resolveRef(spec.manifestRef, artifacts);
  for (const binding of manifest.gates) {
    const gate = resolveRef(binding.artifactRef, artifacts), config = gateConfigs?.[binding.id];
    requireThat(config?.gate?.specDigest === gate.specDigest && gate.repoId === 'product'
      && realpathSync.native(config.repoRoots.product) === root, 'INVALID_SPEC', 'Missing or mismatched trusted product gate configuration');
  }
  assertOwnedTarget(owner, root);
  const binding = bindDriver(owner, store);
  let active = null, controller = null, closing = false, closePromise = null, failure = null;
  let observedSeq = stopSeq(store.status(runId).state.stopObserved);
  const status = () => store.status(runId);
  // ADR 0004 decision 6: STALE_STATE caused only by stop records is re-read, observed and re-prepared
  // (at most one re-preparation per stop transition); any other STALE_STATE keeps the fail-closed path.
  const stopOnly = version => { const later = store.events(runId, version, 3); return later.length > 0 && later.length < 3 && later.every(e => e.action === 'stop'); };
  const fenced = Object.freeze({ ...binding.store, apply(action, prepared, at) {
    for (let attempt = 0; ; attempt++) {
      try { return binding.store.apply(action, prepared, at); }
      catch (error) {
        if (error.code !== 'STALE_STATE' || attempt >= 2 || !stopOnly(prepared.expectedStateVersion)) throw error;
        observe(); prepared = command(store, runId, prepared.payload); at = now();
      }
    }
  } });
  const apply = (action, payload) => fenced.apply(action, command(store, runId, payload), now());
  // A failed observer stops new work and is reported, never silently disabled. The running step may finish.
  const fail = error => {
    failure = new LoopError('STOP_OBSERVER_FAILED', `Stop observer failed (${error.code ?? 'INTERNAL_ERROR'}); no new work is started`);
    failure.cause = error;
    try { if (!TERMINAL.has(status().state.status)) apply('stop-observer-failed', { cause: /^[A-Z][A-Z_]{0,63}$/.test(error.code ?? '') ? error.code : 'INTERNAL_ERROR' }); }
    catch (recordError) { failure.recordError = recordError; }
  };
  // Read-only, lock-free poll. A hard stop cancels the owned effect first, then records the observation.
  const observe = () => {
    if (failure) return;
    try {
      const record = store.readStopRequest(runId), seq = stopSeq(record);
      if (seq <= observedSeq) return;
      observedSeq = seq;
      if (stopKind(record) === 'hard') controller?.abort();
      if (TERMINAL.has(status().state.status)) return;
      // A nested re-preparation may already have recorded this or a later record.
      try { apply('stop-observed', { seq }); } catch (error) { if ((status().state.stopObserved?.seq ?? 0) < seq) throw error; }
    } catch (error) { fail(error); }
  };

  const work = async signal => {
    owner.assertHeld();
    observe(); if (failure) throw failure;
    let state = status().state;
    // A healthy observer supersedes an earlier driver's durable failure banner (R04b F4).
    if (state.stopObserverFailed && !state.stopObserverFailed.recoveredAt && !TERMINAL.has(state.status)) { apply('stop-observer-recovered', {}); state = status().state; }
    if (TERMINAL.has(state.status)) return status();
    requireThat(state.status !== 'RECOVERY_REQUIRED', 'EFFECT_UNKNOWN', 'Explicit operator recovery required');
    const unresolved = Object.values(state.dispatches).filter(d => !d.receipt);
    if (unresolved.some(d => d.status !== 'PENDING')) {
      apply('interrupted', {});
      requireThat(false, 'EFFECT_UNKNOWN', 'Existing claimed work must be reconciled, never automatically re-executed');
    }
    if (!unresolved.length && !state.projection) {
      apply('tick', { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: quota() });
      state = status().state;
    }
    const dispatch = Object.values(state.dispatches).find(d => !d.receipt);
    if (dispatch) {
      if (dispatch.stage === 'build') await executeStoredFixture({ store: fenced, adapter, runId, dispatchId: dispatch.id,
        root, request, signal, quota: quota(), now });
      else await executeStoredGate({ store: fenced, archive, runId, dispatchId: dispatch.id,
        config: { ...gateConfigs[dispatch.gateId], signal }, quota: quota(), now });
    } else if (state.projection) {
      const effect = store.effects(runId).find(e => e.id === state.projection.id);
      requireThat(effect?.kind === 'projection', 'UNKNOWN_REFERENCE', 'Missing projection effect');
      if (state.projection.status === 'PENDING') apply('claim', { effectId: effect.id });
      // Durable no-replace publication is safe to repeat after a lost ACK.
      publishProjection({ directory: projectionDirectory, runId, effect: { id: effect.id, kind: effect.kind, payload: effect.payload } });
      apply('projected', { effectId: effect.id });
    }
    return status();
  };

  const stop = ({ kind = 'hard', requestedBy = 'fixture-driver' } = {}) => {
    requireThat(!closing, 'INVALID_TRANSITION', 'Driver is closing');
    if (!TERMINAL.has(status().state.status)) store.requestStop(runId, { kind, requestedBy }, now());
    // Persist the stop first. An abort alone must never allow a repair dispatch.
    if (kind === 'hard') controller?.abort();
    observe();
    return status();
  };

  return Object.freeze({ status, stop,
    step() {
      requireThat(!closing && !active, 'INVALID_TRANSITION', 'Driver is closing or a step is already active');
      controller = new AbortController(); binding.setActive(true);
      const startSeq = observedSeq, poll = setInterval(observe, pollMs);
      // Queue work so active/owned cancellation exist before any effect starts.
      active = Promise.resolve().then(async () => {
        const value = await work(controller.signal);
        if (failure) throw failure;
        return value;
      }).catch(error => {
        const state = status().state;
        // A stop landing during this step refused its dispatch before any effect started: a clean stop.
        if ((error.code === 'STOP_REQUESTED' || error.preStart === true) && stopSeq(state.stopRequest) > startSeq && !unresolved(state)) {
          observe(); if (failure) throw failure;
          return status();
        }
        if (!TERMINAL.has(state.status) && state.status !== 'RECOVERY_REQUIRED'
          && (Object.values(state.dispatches).some(d => !d.receipt && d.status !== 'PENDING')
            || state.projection?.status === 'STARTED' || error.code === 'EFFECT_UNKNOWN')) apply('interrupted', {});
        throw error;
      }).finally(() => { clearInterval(poll); active = null; controller = null; binding.setActive(false); });
      return active;
    },
    close() {
      if (closePromise) return closePromise;
      if (active) stop({ kind: 'hard', requestedBy: 'fixture-driver.close' });
      closing = true;
      // Caller owns adapter/archive/store lifetime; close them only after this.
      closePromise = (active ?? Promise.resolve()).finally(() => binding.unbind());
      return closePromise;
    },
  });
}
