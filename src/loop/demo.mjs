import { digest, specDigest } from './contracts.mjs';

export function demoBundle(runId = 'demo') {
  const artifacts = {
    brief: 'SIMULATION ONLY: exercise a bounded fail/repair/pass loop. Do not edit product files.',
    snapshot: { simulation: true, candidate: 'initial' },
    gate: { simulation: true, name: 'deterministic-test' },
  };
  const reference = id => ({ id, digest: digest(artifacts[id]) });
  artifacts.manifest = { schemaVersion: 1,
    roles: [{ id: 'builder', scopeIds: ['product-code'], adapter: 'mock' }],
    scopes: [{ id: 'product-code', writePaths: [{ repoId: 'product', relativePath: 'src' }] }],
    gates: [{ id: 'test', artifactRef: reference('gate') }], approvalPolicy: 'local-attended', retentionPolicy: 'manual' };
  const spec = { schemaVersion: 1, runId, goalId: 'demo-goal', supersedesRunId: null,
    objective: 'SIMULATION: fail one verification, repair, pass task and final-candidate verification',
    mode: 'goal', manifestRef: reference('manifest'), graphVersion: '1', initialSnapshotRef: reference('snapshot'),
    criteria: [{ id: 'verified', description: 'Mock task and final gate pass', gateIds: ['test'], humanApprovalRequired: false }],
    tasks: [{ id: 'build', roleId: 'builder', briefRef: reference('brief'), dependsOn: [], acceptanceIds: ['verified'],
      requiredGateIds: ['test'], scopeId: 'product-code', mutatesProduct: true, maxAttempts: 2, maxGateRunsPerCandidate: 1, priority: 0 }],
    limits: { maxAgentCalls: 2, maxWallMs: 60000, maxTokens: null, maxCostMicroUsd: null,
      closeoutReserveTokens: 0, closeoutReserveMicroUsd: 0, quotaStopRemainingPercent: null, quotaSampleMaxAgeMs: 60000, unknownUsagePolicy: 'pause' },
    trustTier: 'local-attended' };
  spec.approvedSpecDigest = specDigest(spec);
  return { spec, artifacts };
}

export function command(store, runId, payload, key) {
  const version = store.status(runId).stateVersion;
  const requestId = key ?? `request-${version + 1}`;
  return { requestId, idempotencyKey: requestId, runId, expectedStateVersion: version, payload };
}

// Explicitly fake effects. This function never spawns a model or modifies product files.
export function driveDemo(store, runId, now = () => Date.now(), project = null) {
  for (let steps = 0; steps < 100; steps++) {
    const { state } = store.status(runId);
    if (['COMPLETED', 'STOPPED', 'FAILED'].includes(state.status)) return store.status(runId);
    if (state.status === 'RECOVERY_REQUIRED') throw new Error('Recovery required; do not automatically replay effects');
    const effect = store.effects(runId).find(e => (e.status === 'PENDING' || e.kind === 'projection' && e.status === 'STARTED')
      && (e.kind === 'dispatch' ? !state.dispatches[e.id].receipt : state.projection?.id === e.id));
    if (!effect) { store.apply('tick', command(store, runId, { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null }), now()); continue; }
    if (effect.status === 'PENDING') store.apply('claim', command(store, runId, { effectId: effect.id }), now());
    if (effect.kind === 'dispatch' && store.status(runId).state.dispatches[effect.id].status !== 'STARTED') continue;
    if (effect.kind === 'projection') {
      // CLI supplies an idempotent local projection. Pure-core tests can simulate it.
      if (project) {
        try { project({ id: effect.id, kind: effect.kind, payload: effect.payload }); }
        catch (error) {
          store.apply('interrupted', command(store, runId, {}), now()); throw error;
        }
      }
      store.apply('projected', command(store, runId, { effectId: effect.id }), now()); continue;
    }
    const d = effect.payload;
    const attempt = d.taskId ? store.status(runId).state.tasks[d.taskId].attempts : 0;
    store.apply('settle', command(store, runId, { dispatchId: d.id,
      result: d.stage === 'gate' && attempt === 1 ? 'fail' : 'pass',
      candidate: d.stage === 'build' ? digest({ simulation: true, attempt }) : d.candidate,
      tokens: 0, costMicroUsd: 0 }), now());
  }
  throw new Error('Demo step bound exceeded');
}
