import { digest, fields, id, ref, requireThat, validateRunSpec } from './contracts.mjs';
import { admission, nextTask } from './scheduler.mjs';

export const TERMINAL = new Set(['COMPLETED', 'STOPPED', 'FAILED']);
const zero = () => ({ agentCalls: 0, tokens: 0, costMicroUsd: 0 });
export function initialState(spec, now) {
  validateRunSpec(spec);
  requireThat(Number.isSafeInteger(now) && now >= 0, 'INVALID_SPEC', 'Invalid host time');
  // This release deliberately refuses capabilities that have no real enforcement yet.
  requireThat(spec.mode === 'goal' && spec.trustTier === 'local-attended'
    && !spec.criteria.some(c => c.humanApprovalRequired), 'CAPABILITY_MISSING', 'Only goal/local-attended, automated criteria are supported');
  return { status: 'READY', reason: null, startedAt: now, lastAt: now, candidate: spec.initialSnapshotRef.digest,
    tasks: Object.fromEntries(spec.tasks.map(t => [t.id, { status: 'READY', attempts: 0, gates: {} }])),
    dispatches: {}, finalGates: {}, usage: zero(), projection: null, projectionCount: 0 };
}

function expect(condition, message, code = 'INVALID_TRANSITION') { requireThat(condition, code, message); }
function pending(s) { return Object.values(s.dispatches).filter(d => !d.receipt); }
function stop(s, reason) {
  s.reason = reason; s.status = pending(s).some(d => d.status === 'UNKNOWN') ? 'RECOVERY_REQUIRED' : 'QUIESCING';
  for (const d of pending(s)) {
    if (d.status === 'PENDING') { d.status = 'ACKNOWLEDGED'; d.receipt = { result: 'cancelled', tokens: 0, costMicroUsd: 0 }; }
  }
}
// ADR 0004: a stop record carries only a kind and an identifier label; no free text reaches any agent.
export const STOP_KINDS = Object.freeze(['graceful', 'hard']);
export function validateStopRequest(payload) {
  fields(payload, ['kind', 'requestedBy'], 'Stop'); expect(STOP_KINDS.includes(payload.kind), 'Invalid stop kind', 'INVALID_SPEC'); id(payload.requestedBy);
}
// Pre-R04a records were {mode, detail}; their kind is the mode.
export const stopKind = r => r && (r.kind ?? r.mode);
// Only graceful -> hard escalates; a repeat or a downgrade records nothing.
export const stopEscalates = (existing, kind) => !existing || stopKind(existing) === 'graceful' && kind === 'hard';
// Replay only (store.verify): the pre-R04a {mode, reason} transition, verbatim, so stored digests still match.
export function replayLegacyStop(before, payload, now) {
  const s = structuredClone(before);
  expect(Number.isSafeInteger(now) && now >= before.lastAt, 'Host clock moved backwards', 'CLOCK_REGRESSION'); s.lastAt = now;
  expect(!TERMINAL.has(s.status), 'Run is terminal', 'RUN_TERMINAL');
  fields(payload, ['mode', 'reason'], 'Stop'); expect(['graceful', 'hard'].includes(payload.mode), 'Invalid stop mode');
  expect(typeof payload.reason === 'string' && payload.reason.trim(), 'Stop reason required');
  stop(s, 'user_stop');
  s.stopRequest = { mode: payload.mode, detail: payload.reason };
  if (s.projection) { s.projection = null; s.status = 'RECOVERY_REQUIRED'; }
  return { state: s, effects: [] };
}
function reservation(value) {
  fields(value, ['agentCalls', 'tokens', 'costMicroUsd'], 'Reservation');
  for (const v of Object.values(value)) expect(v === null || Number.isSafeInteger(v) && v >= 0, 'Invalid reservation');
  expect(value.agentCalls === 0 || value.agentCalls === 1, 'Invalid agent call reservation');
}

// Input actions are HOST commands, not model reports. Never expose settle/claim to workers.
// No clock, filesystem, subprocess, random IDs or model calls inside this reducer.
export function reduce(spec, before, action, payload, now) {
  if (action === 'settle-evidence') {
    fields(payload, ['dispatchId', 'result', 'candidate', 'tokens', 'costMicroUsd', 'evidenceRef'], 'Evidence receipt');
    const { evidenceRef, ...receipt } = payload; ref(evidenceRef);
    const previousRef = before.dispatches[receipt.dispatchId]?.evidenceRef;
    expect(!previousRef || digest(previousRef) === digest(evidenceRef), 'Conflicting evidence reference', 'IDEMPOTENCY_CONFLICT');
    const result = reduce(spec, before, 'settle', receipt, now);
    // reduce(settle) may return its immutable input for an identical receipt.
    result.state = structuredClone(result.state);
    result.state.dispatches[receipt.dispatchId].evidenceRef = structuredClone(evidenceRef);
    return result;
  }
  const s = structuredClone(before); const effects = [];
  expect(Number.isSafeInteger(now) && now >= before.lastAt, 'Host clock moved backwards', 'CLOCK_REGRESSION'); s.lastAt = now;
  const emitDispatch = (taskId, stage, gateId, reserve) => {
    reservation(reserve);
    const reason = admission(spec.limits, s, reserve, now, payload.quota);
    if (reason) { stop(s, reason); return; }
    const number = Object.keys(s.dispatches).length + 1;
    const dispatchId = `d-${number}`;
    s.dispatches[dispatchId] = { id: dispatchId, taskId, stage, gateId, candidate: s.candidate,
      reservation: reserve, status: 'PENDING', receipt: null };
    s.usage.agentCalls += reserve.agentCalls;
    effects.push({ id: dispatchId, kind: 'dispatch', payload: s.dispatches[dispatchId] });
    if (taskId) {
      const t = s.tasks[taskId]; t.status = stage === 'build' ? 'BUILDING' : 'VERIFYING';
      if (stage === 'build') t.attempts++;
    }
    if (s.status !== 'FINALIZING') s.status = 'RUNNING';
  };
  const project = outcome => {
    s.status = 'FINALIZING';
    s.projection = { id: `projection-${++s.projectionCount}`, outcome, status: 'PENDING' };
    effects.push({ id: s.projection.id, kind: 'projection', payload: { outcome, reason: s.reason, candidate: s.candidate, usage: s.usage } });
  };

  // An authenticated late receipt may update accounting, never resurrect the outcome.
  if (action === 'settle') {
    fields(payload, ['dispatchId', 'result', 'candidate', 'tokens', 'costMicroUsd'], 'Receipt');
    expect(Object.hasOwn(s.dispatches, payload.dispatchId), 'Unknown dispatch', 'UNKNOWN_REFERENCE');
    const d = s.dispatches[payload.dispatchId];
    expect(['pass', 'fail', 'error', 'timeout', 'cancelled'].includes(payload.result), 'Invalid result');
    for (const k of ['tokens', 'costMicroUsd']) expect(payload[k] === null || Number.isSafeInteger(payload[k]) && payload[k] >= 0, 'Invalid usage');
    expect(/^sha256:[a-f0-9]{64}$/.test(payload.candidate), 'Invalid candidate');
    if (d.receipt) { expect(digest(d.receipt) === digest(payload), 'Conflicting receipt', 'IDEMPOTENCY_CONFLICT'); return { state: before, effects }; }
    expect(['STARTED', 'UNKNOWN'].includes(d.status), 'Receipt for undispatched work');
    if (d.stage !== 'build') expect(payload.candidate === d.candidate && s.candidate === d.candidate, 'Stale gate receipt', 'STALE_EVIDENCE');
    d.receipt = payload; d.status = 'ACKNOWLEDGED';
    for (const k of ['tokens', 'costMicroUsd']) s.usage[k] = s.usage[k] === null || payload[k] === null ? null : s.usage[k] + payload[k];
    if (TERMINAL.has(s.status)) return { state: s, effects };
    const limit = admission(spec.limits, s, zero(), now, null);
    // Quota is checked by tick with a fresh sample; a receipt is not a quota sample.
    if (limit && limit !== 'usage_unknown') stop(s, limit);
    for (const [k, cap] of [['tokens', 'maxTokens'], ['costMicroUsd', 'maxCostMicroUsd']]) {
      if (spec.limits[cap] !== null && s.usage[k] === null) stop(s, 'usage_unknown');
    }
    if (s.reason) return { state: s, effects };
    if (d.stage === 'final-gate') {
      if (payload.result === 'pass') s.finalGates[d.gateId] = payload.candidate;
      else { s.reason = 'final_gate_failed'; s.status = 'QUIESCING'; }
      return { state: s, effects };
    }
    const task = s.tasks[d.taskId]; const config = spec.tasks.find(t => t.id === d.taskId);
    if (payload.result !== 'pass') {
      task.gates = {}; task.status = task.attempts < config.maxAttempts ? 'READY' : 'FAILED';
      if (task.status === 'FAILED') stop(s, 'attempts_exhausted');
    } else if (d.stage === 'build') {
      s.candidate = payload.candidate; s.finalGates = {}; task.gates = {}; task.status = 'CANDIDATE_READY';
    } else {
      task.gates[d.gateId] = payload.candidate;
      task.status = config.requiredGateIds.every(g => task.gates[g] === s.candidate) ? 'SUCCEEDED' : 'CANDIDATE_READY';
    }
    return { state: s, effects };
  }

  expect(!TERMINAL.has(s.status), 'Run is terminal', 'RUN_TERMINAL');
  if (action === 'stop') {
    validateStopRequest(payload); const existing = s.stopRequest ?? null;
    expect(stopEscalates(existing, payload.kind), 'Stop already recorded at this or a stronger kind');
    s.stopRequest = { kind: payload.kind, seq: (existing?.seq ?? (existing ? 1 : 0)) + 1, requestedBy: payload.requestedBy, requestedAt: now };
    // Escalation only strengthens the record: the first stop already prevented dispatch (R04b cancels).
    if (!existing) {
      const recovering = s.status === 'RECOVERY_REQUIRED';
      stop(s, 'user_stop');
      if (s.projection) { s.projection = null; s.status = 'RECOVERY_REQUIRED'; }
      if (recovering) s.status = 'RECOVERY_REQUIRED';
    }
  } else if (action === 'claim') {
    fields(payload, Object.hasOwn(payload, 'quota') ? ['effectId', 'quota'] : ['effectId'], 'Claim');
    if (s.projection?.id === payload.effectId) {
      expect(s.projection.status === 'PENDING' && s.status === 'FINALIZING', 'Projection not claimable'); s.projection.status = 'STARTED';
    } else {
      expect(Object.hasOwn(s.dispatches, payload.effectId), 'Unknown effect', 'UNKNOWN_REFERENCE'); const d = s.dispatches[payload.effectId];
      expect(d.status === 'PENDING' && !s.reason && ['RUNNING', 'FINALIZING'].includes(s.status), 'Dispatch not claimable');
      // Reservations already exist: recheck freshness/deadline without charging twice.
      const reason = admission(spec.limits, s, zero(), now, payload.quota ?? null);
      if (reason) { stop(s, reason); return { state: s, effects }; }
      d.status = 'STARTED';
    }
  } else if (action === 'projected') {
    fields(payload, ['effectId'], 'Projection receipt');
    expect(s.status === 'FINALIZING' && s.projection?.id === payload.effectId && s.projection.status === 'STARTED', 'Unexpected projection receipt');
    s.projection.status = 'ACKNOWLEDGED'; s.status = s.projection.outcome;
  } else if (action === 'interrupted') {
    fields(payload, [], 'Interrupted');
    for (const d of pending(s)) if (d.status === 'STARTED') d.status = 'UNKNOWN';
    s.status = 'RECOVERY_REQUIRED';
  } else if (action === 'abandon') {
    fields(payload, ['confirmedProcessesExited'], 'Recovery');
    expect(s.status === 'RECOVERY_REQUIRED' && payload.confirmedProcessesExited === true, 'Recovery requires operator confirmation');
    for (const d of pending(s)) { d.status = 'ACKNOWLEDGED'; d.receipt = { result: 'cancelled', tokens: null, costMicroUsd: null }; }
    // Unknown spend is preserved as unknown. Recovery only closes, never retries or resets counters.
    s.usage.tokens = null; s.usage.costMicroUsd = null; s.projection = null; stop(s, 'recovery_abandoned');
  } else if (action === 'tick') {
    fields(payload, ['reservation', 'quota'], 'Tick'); reservation(payload.reservation);
    expect(s.status !== 'RECOVERY_REQUIRED', 'Operator recovery required', 'EFFECT_UNKNOWN');
    if (s.projection) return { state: s, effects };
    if (!s.reason) { const reason = admission(spec.limits, s, zero(), now, payload.quota); if (reason) stop(s, reason); }
    if (pending(s).length) return { state: s, effects };
    if (s.reason) { project(['attempts_exhausted', 'gate_runs_exhausted', 'final_gate_failed'].includes(s.reason) ? 'FAILED' : 'STOPPED'); return { state: s, effects }; }
    const t = nextTask(spec, s);
    if (t) {
      if (s.tasks[t.id].status === 'READY') {
        expect(s.tasks[t.id].attempts < t.maxAttempts, 'Attempts exhausted');
        expect(payload.reservation.agentCalls === 1, 'Build must reserve one call');
        emitDispatch(t.id, 'build', null, payload.reservation);
      } else {
        const gate = t.requiredGateIds.find(g => s.tasks[t.id].gates[g] !== s.candidate);
        if (gate) {
          const count = Object.values(s.dispatches).filter(d => d.taskId === t.id && d.gateId === gate && d.candidate === s.candidate).length;
          if (count >= t.maxGateRunsPerCandidate) stop(s, 'gate_runs_exhausted');
          else emitDispatch(t.id, 'gate', gate, zero());
        }
        else s.tasks[t.id].status = 'SUCCEEDED';
      }
    } else if (Object.values(s.tasks).every(t => t.status === 'SUCCEEDED')) {
      const gate = [...new Set(spec.criteria.flatMap(c => c.gateIds).concat(spec.tasks.flatMap(t => t.requiredGateIds)))].sort().find(g => s.finalGates[g] !== s.candidate);
      if (gate) { s.status = 'FINALIZING'; emitDispatch(null, 'final-gate', gate, zero()); }
      else { s.reason = 'goal_satisfied'; project('COMPLETED'); }
    } else throw new Error('Invariant violated: no runnable task in a validated DAG');
  } else throw new Error(`Unknown host action: ${action}`);
  return { state: s, effects };
}
