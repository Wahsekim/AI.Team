import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { requireThat } from './contracts.mjs';
import { resolveRef } from './artifacts.mjs';
import { command } from './demo.mjs';
import { TERMINAL } from './reducer.mjs';
import { executeStoredFixture } from './host-fixtures.mjs';
import { executeStoredGate } from './host-gates.mjs';
import { validateFixtureRequest } from './adapters/fixture-process.mjs';
import { publishProjection } from './projector.mjs';
import { bindDriver, stateIdentity } from './execution-owner.mjs';

// Single trusted host, fixture builds only. One step runs at most one effect.
// `owner` (acquireExecutionOwner) is the cross-process authority; one driver per owner handle.
export function createFixtureDriver({ store, owner, adapter, archive, runId, root, projectionDirectory,
  request = { scenario: 'pass', delayMs: 0, timeoutMs: 1000 }, gateConfigs, quota = () => null, now = () => Date.now() }) {
  const capability = adapter.probeCapabilities();
  requireThat(store.status(runId).simulation === true && capability.adapter === 'fixture-process'
    && capability.simulation === true && capability.liveProvider === false && capability.runId === runId,
  'CAPABILITY_MISSING', 'Only a matching simulation fixture is supported');
  requireThat(typeof now === 'function' && typeof quota === 'function', 'INVALID_SPEC', 'Host time/quota callbacks required');
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
  const binding = bindDriver(owner, store), fenced = binding.store;
  let active = null, controller = null, closing = false, closePromise = null;
  const status = () => store.status(runId);
  const apply = (action, payload) => fenced.apply(action, command(store, runId, payload), now());

  const work = async signal => {
    owner.assertHeld();
    let state = status().state;
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

  const stop = ({ mode = 'hard', reason = 'Fixture driver operator stop' } = {}) => {
    requireThat(!closing, 'INVALID_TRANSITION', 'Driver is closing');
    if (!TERMINAL.has(status().state.status)) apply('stop', { mode, reason });
    // Persist the stop first. An abort alone must never allow a repair dispatch.
    if (mode === 'hard') controller?.abort();
    return status();
  };

  return Object.freeze({ status, stop,
    step() {
      requireThat(!closing && !active, 'INVALID_TRANSITION', 'Driver is closing or a step is already active');
      controller = new AbortController(); binding.setActive(true);
      // Queue work so active/owned cancellation exist before any effect starts.
      active = Promise.resolve().then(() => work(controller.signal)).catch(error => {
        const state = status().state;
        if (!TERMINAL.has(state.status) && state.status !== 'RECOVERY_REQUIRED'
          && (Object.values(state.dispatches).some(d => !d.receipt && d.status !== 'PENDING')
            || state.projection?.status === 'STARTED' || error.code === 'EFFECT_UNKNOWN')) apply('interrupted', {});
        throw error;
      }).finally(() => { active = null; controller = null; binding.setActive(false); });
      return active;
    },
    close() {
      if (closePromise) return closePromise;
      if (active) stop({ mode: 'hard', reason: 'Fixture driver closed during active step' });
      closing = true;
      // Caller owns adapter/archive/store lifetime; close them only after this.
      closePromise = (active ?? Promise.resolve()).finally(() => binding.unbind());
      return closePromise;
    },
  });
}
