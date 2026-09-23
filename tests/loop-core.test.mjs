import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, parseJSON, relativePath, specDigest, validateRunSpec } from '../src/loop/contracts.mjs';
import { validateBundle } from '../src/loop/artifacts.mjs';
import { initialState, reduce } from '../src/loop/reducer.mjs';
import { admission } from '../src/loop/scheduler.mjs';
import { openStore } from '../src/loop/store.mjs';
import { command, demoBundle, driveDemo } from '../src/loop/demo.mjs';

const bad = (fn, code) => assert.throws(fn, e => e.code === code);
function changed(edit) { const { spec } = demoBundle(); edit(spec); spec.approvedSpecDigest = specDigest(spec); return spec; }
const tick = { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null };

test('wire parser rejects duplicate/escaped duplicate keys, unknown fields and deep JSON', () => {
  assert.deepEqual(parseJSON('{"x":[true,null,2,"ok"]}'), { x: [true, null, 2, 'ok'] });
  for (const input of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '[1,]', '1e999', '['.repeat(102) + ']'.repeat(102)]) bad(() => parseJSON(input), 'INVALID_SPEC');
  bad(() => validateRunSpec(changed(s => { s.untrusted = true; })), 'INVALID_SPEC');
});
test('contract rejects empty criteria, missing gates, uncovered criteria, cycles, dangling dependencies', () => {
  for (const edit of [s => { s.criteria = []; }, s => { s.criteria[0].gateIds = []; }, s => { s.tasks[0].requiredGateIds = []; }]) bad(() => validateRunSpec(changed(edit)), 'INVALID_SPEC');
  bad(() => validateRunSpec(changed(s => { s.tasks[0].dependsOn = ['build']; })), 'GRAPH_CYCLE');
  bad(() => validateRunSpec(changed(s => { s.tasks[0].dependsOn = ['missing']; })), 'UNKNOWN_REFERENCE');
});
test('paths reject platform escapes but allow nested product memory directory', () => {
  for (const p of ['', '/etc/passwd', '../x', 'a/../x', 'a//x', 'C:/x', 'a\\b', 'a\0b', './x']) bad(() => relativePath(p), 'INVALID_SPEC');
  assert.equal(relativePath('src/memory/image.png'), 'src/memory/image.png');
});
test('artifact references bind the manifest and briefs, unknown refs fail closed', () => {
  const { spec, artifacts } = demoBundle(); validateBundle(spec, artifacts);
  artifacts.brief += ' changed'; bad(() => validateBundle(spec, artifacts), 'INVALID_SPEC');
  delete artifacts.manifest; bad(() => validateBundle(spec, artifacts), 'UNKNOWN_REFERENCE');
});
test('unsupported isolation and human approval cannot silently degrade', () => {
  bad(() => initialState(changed(s => { s.trustTier = 'isolated'; }), 0), 'CAPABILITY_MISSING');
  bad(() => initialState(changed(s => { s.criteria[0].humanApprovalRequired = true; }), 0), 'CAPABILITY_MISSING');
});
test('stop before dispatch cancels intent and cannot claim it', () => {
  const { spec } = demoBundle(); let s = reduce(spec, initialState(spec, 0), 'tick', tick, 1).state;
  s = reduce(spec, s, 'stop', { mode: 'hard', reason: 'test' }, 2).state;
  assert.equal(s.dispatches['d-1'].receipt.result, 'cancelled');
  bad(() => reduce(spec, s, 'claim', { effectId: 'd-1' }, 3), 'INVALID_TRANSITION');
  assert.equal(reduce(spec, s, 'tick', tick, 3).state.projection.outcome, 'STOPPED');
});
test('unknown effects require recovery, never auto retry', () => {
  const { spec } = demoBundle(); let s = reduce(spec, initialState(spec, 0), 'tick', tick, 1).state;
  s = reduce(spec, s, 'claim', { effectId: 'd-1' }, 2).state;
  s = reduce(spec, s, 'interrupted', {}, 3).state;
  assert.equal(s.dispatches['d-1'].status, 'UNKNOWN');
  bad(() => reduce(spec, s, 'tick', tick, 4), 'EFFECT_UNKNOWN');
  bad(() => reduce(spec, s, 'abandon', { confirmedProcessesExited: false }, 4), 'INVALID_TRANSITION');
  s = reduce(spec, s, 'abandon', { confirmedProcessesExited: true }, 4).state;
  assert.equal(s.tasks.build.attempts, 1); assert.equal(s.usage.tokens, null);
});
test('quota and unknown usage are not interpreted as zero', () => {
  const { spec } = demoBundle(); const state = initialState(spec, 0);
  const limits = { ...spec.limits, quotaStopRemainingPercent: 20 };
  assert.equal(admission(limits, state, tick.reservation, 1, null), 'usage_unknown');
  assert.equal(admission(limits, state, tick.reservation, 1, { remainingPercent: 20, at: 1 }), 'quota_threshold');
  assert.equal(admission({ ...spec.limits, maxTokens: 10 }, state, { agentCalls: 1, tokens: null, costMicroUsd: 0 }, 1), 'usage_unknown');
  assert.equal(admission({ ...spec.limits, maxTokens: 10, closeoutReserveTokens: 2 }, state, { agentCalls: 1, tokens: 9, costMicroUsd: 0 }, 1), 'tokens_limit');
});

const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Goal supervisor requires Node 24; pure core remains tested' : false };
test('REV-1-001: claim rechecks deadline, but closeout is allowed after it', () => {
  const spec = changed(s => { s.limits.maxWallMs = 10; });
  let s = reduce(spec, initialState(spec, 0), 'tick', tick, 1).state;
  const beforeDeadline = reduce(spec, s, 'claim', { effectId: 'd-1' }, 9).state;
  assert.equal(beforeDeadline.dispatches['d-1'].status, 'STARTED');
  s = reduce(spec, s, 'claim', { effectId: 'd-1' }, 10).state;
  assert.equal(s.reason, 'time_limit'); assert.equal(s.dispatches['d-1'].status, 'ACKNOWLEDGED');
  s = reduce(spec, s, 'tick', tick, 11).state;
  s = reduce(spec, s, 'claim', { effectId: s.projection.id }, 12).state;
  s = reduce(spec, s, 'projected', { effectId: s.projection.id }, 13).state;
  assert.equal(s.status, 'STOPPED');
});
test('REV-1-002: both stop modes preserve recovery for UNKNOWN work', () => {
  for (const mode of ['hard', 'graceful']) {
    const { spec } = demoBundle(); let s = reduce(spec, initialState(spec, 0), 'tick', tick, 1).state;
    s = reduce(spec, s, 'claim', { effectId: 'd-1' }, 2).state;
    s = reduce(spec, s, 'interrupted', {}, 3).state;
    s = reduce(spec, s, 'stop', { mode, reason: 'operator' }, 4).state;
    assert.equal(s.status, 'RECOVERY_REQUIRED');
    s = reduce(spec, s, 'abandon', { confirmedProcessesExited: true }, 5).state;
    s = reduce(spec, s, 'tick', tick, 6).state;
    s = reduce(spec, s, 'claim', { effectId: s.projection.id }, 7).state;
    s = reduce(spec, s, 'projected', { effectId: s.projection.id }, 8).state;
    assert.equal(s.status, 'STOPPED'); assert.equal(s.usage.tokens, null); assert.equal(s.tasks.build.attempts, 1);
  }
});
test('REV-1-003: same-candidate gate ceiling survives rebuild; new candidates and higher caps work', () => {
  for (const [newCandidate, cap, allowed] of [[false, 1, false], [true, 1, true], [false, 2, true]]) {
    const spec = changed(s => { s.tasks[0].maxGateRunsPerCandidate = cap; });
    let s = initialState(spec, 0), time = 0;
    const apply = (a, p) => { s = reduce(spec, s, a, p, ++time).state; };
    for (const [stage, result, candidate] of [['build', 'pass', digest('a')], ['gate', 'fail', digest('a')], ['build', 'pass', digest(newCandidate ? 'b' : 'a')]]) {
      apply('tick', tick); const d = Object.values(s.dispatches).at(-1); assert.equal(d.stage, stage);
      apply('claim', { effectId: d.id }); apply('settle', { dispatchId: d.id, result, candidate, tokens: 0, costMicroUsd: 0 });
    }
    apply('tick', tick);
    assert.equal(Object.keys(s.dispatches).length, allowed ? 4 : 3);
    if (!allowed) assert.equal(s.reason, 'gate_runs_exhausted');
  }
});
test('transactional fail/repair/pass demo, final gate, immutable terminal state and replay', sqlite, async () => {
  const store = await openStore(':memory:');
  try {
    const { spec, artifacts } = demoBundle(); bad(() => store.create(spec, artifacts), 'CAPABILITY_MISSING');
    store.create(spec, artifacts, { simulation: true, now: 0 });
    const result = driveDemo(store, 'demo', () => 1);
    assert.equal(result.state.status, 'COMPLETED'); assert.equal(result.simulation, true);
    assert.equal(result.state.tasks.build.attempts, 2); assert.equal(result.state.usage.agentCalls, 2);
    assert.ok(Object.values(result.state.dispatches).some(d => d.stage === 'final-gate'));
    assert.equal(store.verify('demo').ok, true);
    bad(() => store.apply('tick', command(store, 'demo', tick), 2), 'RUN_TERMINAL');
    assert.equal(store.verify('demo').ok, true);
  } finally { store.close(); }
});
test('SQLite restart preserves intent; CAS rejects competing scheduler; idempotency conflict is atomic', sqlite, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-loop-')); let a, b;
  try {
    a = await openStore(join(dir, 'state.sqlite')); const { spec, artifacts } = demoBundle();
    a.create(spec, artifacts, { simulation: true, now: 0 }); const cmd = command(a, 'demo', tick);
    const result = a.apply('tick', cmd, 1); assert.deepEqual(a.apply('tick', cmd, 2), result);
    bad(() => a.apply('tick', { ...cmd, payload: { ...tick, quota: {} } }, 2), 'IDEMPOTENCY_CONFLICT');
    b = await openStore(join(dir, 'state.sqlite'));
    bad(() => b.apply('tick', { ...cmd, requestId: 'other', idempotencyKey: 'other' }, 2), 'STALE_STATE');
    a.close(); a = null;
    assert.equal(b.effects('demo').length, 1); assert.equal(b.effects('demo')[0].status, 'PENDING');
    assert.equal(b.verify('demo').ok, true);
  } finally { a?.close(); b?.close(); rmSync(dir, { recursive: true, force: true }); }
});
