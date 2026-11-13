import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, cpSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/loop/contracts.mjs';
import { loadRetryRules, createRetryJournal, inspectRetryJournal, advanceRetryJournal } from '../src/router-worker/retries.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const rules = loadRetryRules();
const reference = name => ({ id: name, digest: digest(name) });
const gateNames = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const admission = overrides => ({ sourceRef: reference('host-gate-fixture'), gates: { ...Object.fromEntries(gateNames.map(k => [k, 'clear'])), ...overrides } });
const session = duty => reference(`${duty}-session`);
const candidate = n => reference(`candidate-${n}`);
function prepare(duty, n, overrides = {}) {
  return { type: 'prepare', assignmentId: `${duty}-${n}`, duty, planRef: reference(`${duty}-plan-${n}`),
    candidateRef: candidate(duty === 'exec' ? n - 1 : n), continuationOf: n > 1 ? `${duty}-${n - 1}` : null,
    resumeSessionRef: n > 1 ? session(duty) : null, divergence: n > 1
      ? { previousPlanDigest: reference(`${duty}-plan-${n - 1}`).digest, reason: 'Scoped repair based on the previous failure', evidenceRef: reference(`change-${duty}-${n}`) } : null,
    admission: admission(), ...overrides };
}
const start = (duty, n, overrides = {}) => ({ type: 'start', assignmentId: `${duty}-${n}`, sessionRef: session(duty),
  callRef: reference(`host-call-${duty}-${n}`), admission: admission(), ...overrides });
const close = (duty, n, outcome, overrides = {}) => ({ type: 'close', assignmentId: `${duty}-${n}`, outcome,
  progress: true, outcomeKey: `observed-${duty}-${n}`, candidateRef: outcome === 'candidate' || duty === 'check' ? candidate(n) : null,
  receiptRef: reference(`host-receipt-${duty}-${n}`), ...overrides });
function rig() {
  let journal = createRetryJournal({ ticketId: 'US-08', rules }), seq = 0;
  return {
    get journal() { return structuredClone(journal); },
    state() { return inspectRetryJournal({ journal, rules }); },
    send(input) {
      const event = { eventId: `event-${++seq}`, ...input };
      const result = advanceRetryJournal({ journal, rules, expectedDigest: journal.digest, event });
      journal = result.journal; return { ...result, event };
    },
  };
}
function run(r, duty, n, outcome, overrides = {}) { r.send(prepare(duty, n)); r.send(start(duty, n)); return r.send(close(duty, n, outcome, overrides)); }
const throws = (fn, code) => assert.throws(fn, error => error.code === code);

test('source-backed rules bind the approved cap without claiming live execution', () => {
  assert.equal(rules.maxRetries, 2); assert.equal(rules.localEmptyCloseLimit, 2); assert.equal(rules.maxFixVerifyRoundTrips, 3);
  const r = rig(), state = r.state();
  assert.deepEqual(state.started, { exec: 0, check: 0 }); assert.deepEqual(state.retryCounts, { exec: 0, check: 0 });
  assert.equal(state.launchable, false); assert.equal(state.deliveryAuthorized, false);
  assert.equal(Object.keys(rules.sourceDigests).length, 3);
});

test('each duty gets one initial call and at most two retries on its original session', () => {
  const r = rig();
  for (let n = 1; n <= 3; n++) { run(r, 'exec', n, 'candidate'); run(r, 'check', n, 'fail'); }
  const state = r.state();
  assert.deepEqual(state.started, { exec: 3, check: 3 }); assert.deepEqual(state.retryCounts, { exec: 2, check: 2 });
  assert.equal(state.fixVerifyRoundTrips, 2);
  assert.deepEqual(state.sessions, { exec: session('exec'), check: session('check') });
  throws(() => r.send(prepare('exec', 4)), 'RETRY_LIMIT');
  throws(() => r.send(prepare('check', 4)), 'RETRY_LIMIT');
  assert.equal(r.state().deliveryAuthorized, false);
});

test('changed plan/model/method references and new assignment names never reset the stable duty counter', () => {
  const r = rig();
  for (let n = 1; n <= 3; n++) run(r, 'exec', n, 'fail');
  throws(() => r.send(prepare('exec', 4, { assignmentId: 'fresh-model-and-method', planRef: reference('brand-new-plan') })), 'RETRY_LIMIT');
  throws(() => r.send({ ...prepare('exec', 4), resetRetries: true }), 'INVALID_SPEC');
});

test('idempotent prepare/start/close replay emits no second transition or increment', () => {
  const r = rig();
  for (const event of [prepare('exec', 1), start('exec', 1), close('exec', 1, 'candidate')]) {
    const first = r.send(event), before = r.journal, second = r.send(first.event);
    assert.equal(second.applied, false); assert.deepEqual(second.journal, before);
  }
  assert.deepEqual(r.state().started, { exec: 1, check: 0 }); assert.equal(r.state().closes.length, 1);
  const event = r.journal.events[0];
  throws(() => r.send({ ...event, planRef: reference('conflict') }), 'IDEMPOTENCY_CONFLICT');
});

test('prepared cancellation consumes no call, but used assignment identity cannot be recycled', () => {
  const r = rig(); r.send(prepare('exec', 1));
  r.send({ type: 'cancel', assignmentId: 'exec-1', neverStartedRef: reference('host-never-started') });
  assert.equal(r.state().started.exec, 0);
  throws(() => r.send(prepare('exec', 1)), 'IDEMPOTENCY_CONFLICT');
  r.send(prepare('exec', 1, { assignmentId: 'exec-replacement' }));
  r.send(start('exec', 1, { assignmentId: 'exec-replacement' }));
  assert.equal(r.state().started.exec, 1); assert.equal(r.state().assignments[1].attempt, 1);
  throws(() => r.send({ type: 'cancel', assignmentId: 'exec-replacement', neverStartedRef: reference('false-proof') }), 'INVALID_RETRY_TRANSITION');
});

test('only one serial call can be pending, including a prepared call', () => {
  const r = rig(); r.send(prepare('exec', 1));
  throws(() => r.send(prepare('check', 1)), 'RETRY_PENDING');
  r.send(start('exec', 1)); throws(() => r.send(prepare('exec', 2)), 'RETRY_PENDING');
});

test('initial author and check sessions cannot share either identity field', () => {
  for (const bad of [session('exec'), { ...session('check'), id: session('exec').id }, { ...session('check'), digest: session('exec').digest }]) {
    const r = rig(); run(r, 'exec', 1, 'candidate'); r.send(prepare('check', 1));
    throws(() => r.send(start('check', 1, { sessionRef: bad })), 'DUTY_NOT_SEPARATED');
    assert.equal(r.state().started.check, 0);
  }
});

test('retry requires previous assignment, original session and a changed plan with explicit divergence', () => {
  for (const overrides of [
    { continuationOf: null }, { continuationOf: 'foreign-assignment' }, { resumeSessionRef: session('foreign') },
    { divergence: null }, { planRef: reference('exec-plan-1') },
    { divergence: { previousPlanDigest: digest('wrong'), reason: 'changed', evidenceRef: reference('change') } },
  ]) {
    const r = rig(); run(r, 'exec', 1, 'fail');
    assert.throws(() => r.send(prepare('exec', 2, overrides)), error => ['SESSION_CONTINUITY_REQUIRED', 'RETRY_DIVERGENCE_REQUIRED'].includes(error.code));
  }
  const r = rig(); run(r, 'exec', 1, 'fail'); r.send(prepare('exec', 2));
  throws(() => r.send(start('exec', 2, { sessionRef: session('new') })), 'SESSION_CONTINUITY_REQUIRED');
});

test('one host call cannot be attributed to two assignments', () => {
  const r = rig(); run(r, 'exec', 1, 'candidate'); r.send(prepare('check', 1));
  throws(() => r.send(start('check', 1, { callRef: reference('host-call-exec-1') })), 'IDEMPOTENCY_CONFLICT');
});

for (const phase of ['prepared', 'started']) test(`unknown ${phase} execution is counted conservatively and blocks redispatch`, () => {
  const r = rig(); r.send(prepare('exec', 1)); if (phase === 'started') r.send(start('exec', 1));
  r.send({ type: 'unknown', assignmentId: 'exec-1', reasonRef: reference('connection-lost') });
  assert.equal(r.state().started.exec, 1); assert.deepEqual(r.state().stops, ['unknown-execution']);
  throws(() => r.send(prepare('exec', 2)), 'RETRY_STOPPED');
  throws(() => r.send({ type: 'cancel', assignmentId: 'exec-1', neverStartedRef: reference('unsafe-cancel') }), 'INVALID_RETRY_TRANSITION');
  if (phase === 'started') {
    r.send(close('exec', 1, 'candidate')); assert.equal(r.state().closes.length, 1);
    assert.deepEqual(r.state().stops, ['unknown-execution']);
  } else throws(() => r.send(close('exec', 1, 'candidate')), 'INVALID_RETRY_TRANSITION');
});

test('sticky stop blocks start while allowing cancellation of a known unstarted preparation', () => {
  const r = rig(); r.send(prepare('exec', 1)); r.send({ type: 'stop', reason: 'operator-stop', evidenceRef: reference('owner-stop') });
  throws(() => r.send(start('exec', 1)), 'RETRY_STOPPED');
  r.send({ type: 'cancel', assignmentId: 'exec-1', neverStartedRef: reference('host-cancel') });
  assert.equal(r.state().started.exec, 0); assert.deepEqual(r.state().stops, ['operator-stop']);
});

test('late close after security stop records the result without resurrecting dispatch or acceptance', () => {
  const r = rig(); r.send(prepare('exec', 1)); r.send(start('exec', 1));
  r.send({ type: 'stop', reason: 'security', evidenceRef: reference('security-event') });
  r.send(close('exec', 1, 'candidate'));
  throws(() => r.send(prepare('check', 1)), 'RETRY_STOPPED');
  assert.equal(r.state().closes.length, 1); assert.equal(r.state().deliveryAuthorized, false);
});

for (const phase of ['prepare', 'start']) test(`all host gates are required and any blocked/unknown gate stops ${phase}`, () => {
  for (const gate of gateNames) for (const status of ['blocked', 'unknown']) {
    const r = rig(); if (phase === 'start') r.send(prepare('exec', 1));
    r.send((phase === 'prepare' ? prepare : start)('exec', 1, { admission: admission({ [gate]: status }) }));
    assert.equal(r.state().started.exec, 0); assert.deepEqual(r.state().stops, [gate]);
    throws(() => r.send(prepare('exec', 2)), 'RETRY_STOPPED');
  }
  const r = rig(), event = prepare('exec', 1); delete event.admission.gates.budget;
  throws(() => r.send(event), 'INVALID_SPEC');
});

test('two locally empty closes or repeated normalized outcomes stop retries, even with quota remaining', () => {
  for (const overrides of [{ progress: false }, { outcomeKey: 'same-root-cause' }]) {
    const r = rig(); run(r, 'exec', 1, 'fail', overrides); run(r, 'exec', 2, 'fail', overrides);
    assert.equal(r.state().retryCounts.exec, 1); assert.deepEqual(r.state().stops, ['local-empty-loop']);
    throws(() => r.send(prepare('exec', 3)), 'RETRY_STOPPED');
  }
});

test('check candidate must come from the latest successful author close; author cannot self-accept', () => {
  const r = rig(); throws(() => r.send(prepare('check', 1)), 'CANDIDATE_MISMATCH');
  r.send(prepare('exec', 1)); r.send(start('exec', 1));
  throws(() => r.send(close('exec', 1, 'pass')), 'INVALID_RETRY_TRANSITION');
  r.send(close('exec', 1, 'candidate'));
  throws(() => r.send(prepare('check', 1, { candidateRef: candidate(0) })), 'CANDIDATE_MISMATCH');
  r.send(prepare('check', 1)); r.send(start('check', 1));
  throws(() => r.send(close('check', 1, 'pass', { candidateRef: candidate(2) })), 'CANDIDATE_MISMATCH');
  r.send(close('check', 1, 'pass'));
  assert.equal(r.state().deliveryAuthorized, false);
  throws(() => r.send(prepare('exec', 2)), 'RETRY_STOPPED');
});

test('a shipping author cannot skip independent check by calling its next assignment a repair', () => {
  const r = rig(); run(r, 'exec', 1, 'candidate');
  throws(() => r.send(prepare('exec', 2)), 'CHECK_REQUIRED');
  run(r, 'check', 1, 'blocked');
  throws(() => r.send(prepare('exec', 2)), 'CHECK_REQUIRED');
});

test('bounded deterministic command exploration preserves counters, independence and stop monotonicity', () => {
  let seed = 731;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let trace = 0; trace < 30; trace++) {
    const r = rig();
    for (let step = 0; step < 25; step++) {
      const before = r.state(), duty = random(2) ? 'exec' : 'check', n = random(4) + 1;
      const event = [prepare(duty, n), start(duty, n), close(duty, n, duty === 'exec' ? 'candidate' : 'fail'),
        { type: 'unknown', assignmentId: `${duty}-${n}`, reasonRef: reference('lost') },
        { type: 'stop', reason: 'budget', evidenceRef: reference('budget-stop') }][random(5)];
      try { r.send(event); } catch (error) { assert.ok(error.code); }
      const after = r.state();
      for (const d of ['exec', 'check']) {
        assert.ok(after.started[d] >= before.started[d] && after.started[d] <= 3);
        assert.equal(after.started[d], after.assignments.filter(a => a.duty === d && a.started).length);
      }
      assert.ok(before.stops.every(reason => after.stops.includes(reason)));
      assert.ok(after.assignments.filter(a => ['prepared', 'started', 'unknown'].includes(a.status)).length <= 1);
      if (after.sessions.exec && after.sessions.check) assert.notEqual(after.sessions.exec.id, after.sessions.check.id);
      assert.equal(after.launchable, false); assert.equal(after.deliveryAuthorized, false);
    }
  }
});

test('journal capacity is bounded and closed-world events cannot smuggle lifecycle or usage claims', () => {
  const r = rig();
  for (let n = 0; n < 256; n++) r.send({ type: 'stop', reason: 'operator-stop', evidenceRef: reference(`stop-${n}`) });
  assert.throws(() => r.send({ type: 'stop', reason: 'operator-stop', evidenceRef: reference('overflow') }), /limit exceeded/);
  assert.equal(r.journal.events.length, 256);
  const fresh = rig();
  throws(() => fresh.send({ ...close('exec', 1, 'candidate'), actualTokens: 1 }), 'INVALID_SPEC');
});

test('stale callers, modified journals, unknown fields and conflicting rule versions fail closed', () => {
  const r = rig(), original = r.journal; r.send(prepare('exec', 1));
  throws(() => advanceRetryJournal({ journal: r.journal, rules, expectedDigest: original.digest, event: { eventId: 'start', ...start('exec', 1) } }), 'STALE_RETRY_JOURNAL');
  const edited = r.journal; edited.events[0].assignmentId = 'changed';
  throws(() => inspectRetryJournal({ journal: edited, rules }), 'RETRY_JOURNAL_MISMATCH');
  const newRules = structuredClone(rules); newRules.sourceDigests['agents/pm.md'] = digest('new-rules');
  throws(() => inspectRetryJournal({ journal: r.journal, rules: newRules }), 'RETRY_JOURNAL_MISMATCH');
  throws(() => r.send({ ...start('exec', 1), reset: true }), 'INVALID_SPEC');
  throws(() => r.send({ type: 'resume', eventId: 'resume' }), 'INVALID_RETRY_TRANSITION');
});

test('returned data and failed transitions cannot mutate input journals; replay is deterministic', () => {
  const r = rig(); run(r, 'exec', 1, 'candidate'); const before = r.journal;
  const a = inspectRetryJournal({ journal: before, rules }), b = inspectRetryJournal({ journal: JSON.parse(JSON.stringify(before)), rules });
  assert.deepEqual(a, b); a.started.exec = 99; a.assignments[0].planRef.digest = digest('changed');
  assert.deepEqual(r.journal, before); assert.equal(r.state().started.exec, 1);
  throws(() => r.send(start('exec', 1)), 'INVALID_RETRY_TRANSITION'); assert.deepEqual(r.journal, before);
});

test('rule source edits and symlinks require review instead of silently changing caps', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-retry-rules-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of Object.keys(rules.sourceDigests)) cpSync(join(ROOT, path), join(root, path), { recursive: true });
  assert.deepEqual(loadRetryRules({ teamRoot: root }), rules);
  const path = join(root, 'charter.template.md'), text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace('at most twice', 'at most five times'));
  throws(() => loadRetryRules({ teamRoot: root }), 'RETRY_RULE_REVIEW_REQUIRED');
  rmSync(path); symlinkSync(join(ROOT, 'charter.template.md'), path);
  assert.throws(() => loadRetryRules({ teamRoot: root }), /Symlink/);
});

test('an author that returns work and reports blocked: the work may be checked once, then the ticket stops for a scope decision', () => {
  const r = rig();
  run(r, 'exec', 1, 'blocked', { candidateRef: candidate(1) });
  assert.equal(r.state().assignments.at(-1).outcome, 'blocked'); assert.deepEqual(r.state().stops, []);
  throws(() => r.send(prepare('exec', 2)), 'CHECK_REQUIRED');
  throws(() => r.send(prepare('check', 1, { candidateRef: candidate(0) })), 'CANDIDATE_MISMATCH');
  run(r, 'check', 1, 'fail');
  assert.deepEqual(r.state().stops, ['scope-decision'], 'the same brief cannot converge; no automatic repair');
  throws(() => r.send(prepare('exec', 2)), 'RETRY_STOPPED');
  const passed = rig(); run(passed, 'exec', 1, 'blocked', { candidateRef: candidate(1) }); run(passed, 'check', 1, 'pass');
  assert.deepEqual(passed.state().stops, ['scope-decision'], 'a passing check does not turn a blocked author into accepted work');
});

test('blocked without returned work is unchanged: nothing to check, a repair may follow', () => {
  const r = rig();
  run(r, 'exec', 1, 'blocked');
  throws(() => r.send(prepare('check', 1)), 'CANDIDATE_MISMATCH');
  r.send(prepare('exec', 2)); assert.deepEqual(r.state().stops, []);
  const checker = rig(); run(checker, 'exec', 1, 'candidate'); checker.send(prepare('check', 1)); checker.send(start('check', 1));
  throws(() => checker.send(close('check', 1, 'blocked', { candidateRef: candidate(2) })), 'CANDIDATE_MISMATCH');
});
