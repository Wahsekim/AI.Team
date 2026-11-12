// Rollout gate G-03: a retry is compiled as a continuation of the same ticket
// and duty. Attempt, previous assignment, session and candidate come from the
// retry journal, never from the request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileContinuation } from '../src/router-worker/continuation.mjs';
import { loadRetryRules, createRetryJournal, inspectRetryJournal, advanceRetryJournal } from '../src/router-worker/retries.mjs';
import { digest, bytesDigest } from '../src/loop/contracts.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';

const CLI = fileURLToPath(new URL('../scripts/continue-router-worker.mjs', import.meta.url));
const rules = loadRetryRules();
const reference = name => ({ id: name, digest: digest(name) });
const GATES = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const admission = () => ({ sourceRef: reference('host-gate-fixture'), gates: Object.fromEntries(GATES.map(gate => [gate, 'clear'])) });
const session = duty => reference(`${duty}-session`), candidate = n => reference(`candidate-${n}`);
const first = (duty, n = 1) => ({ type: 'prepare', assignmentId: `${duty}-${n}`, duty, planRef: reference(`${duty}-plan-${n}`),
  candidateRef: candidate(duty === 'exec' ? n - 1 : n), continuationOf: null, resumeSessionRef: null, divergence: null, admission: admission() });
const start = (duty, n) => ({ type: 'start', assignmentId: `${duty}-${n}`, sessionRef: session(duty), callRef: reference(`call-${duty}-${n}`), admission: admission() });
const close = (duty, n, outcome) => ({ type: 'close', assignmentId: `${duty}-${n}`, outcome, progress: true, outcomeKey: `observed-${duty}-${n}`,
  candidateRef: outcome === 'candidate' || duty === 'check' ? candidate(n) : null, receiptRef: reference(`receipt-${duty}-${n}`) });
function rig() {
  let journal = createRetryJournal({ ticketId: 'US-08', rules }), seq = 0;
  const api = {
    get journal() { return structuredClone(journal); },
    state: () => inspectRetryJournal({ journal, rules }),
    send(event) { journal = advanceRetryJournal({ journal, rules, expectedDigest: journal.digest, event: { eventId: `event-${++seq}`, ...event } }).journal; return api; },
    // Host side of a compiled continuation: add the event id and the observed admission.
    accept(prepareEvent) { return api.send({ ...prepareEvent, admission: admission() }); },
  };
  return api;
}
// exec-1 produced candidate-1 and check-1 judged it.
const afterFirstRound = (checkOutcome = 'fail') => rig().send(first('exec')).send(start('exec', 1)).send(close('exec', 1, 'candidate'))
  .send(first('check')).send(start('check', 1)).send(close('check', 1, checkOutcome));
function request(n = 2, onCandidate = n - 1) {
  const input = inputFixture();
  input.proposal.assignmentId = `exec-${n}`; input.proposal.checkAssignmentId = `check-${n}`;
  input.baseline.candidateRef = candidate(onCandidate);
  return input;
}
const divergence = { reason: 'Retry click handler now reissues the request; the failed check named it', evidenceRef: reference('check-1-findings') };
const go = (r, overrides = {}) => compileContinuation({ input: request(), journal: r.journal, rules, duty: 'exec', divergence, ...overrides });
const code = result => result.errors?.[0].code;

test('an exec repair continues the previous assignment on its original session, with everything derived from the journal', () => {
  const r = afterFirstRound(), result = go(r);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const { continuation, renderedBrief, prepareEvent } = result;
  assert.equal(continuation.attempt, 2); assert.equal(continuation.duty, 'exec'); assert.equal(continuation.ticketId, 'US-08');
  assert.equal(continuation.assignmentId, 'exec-2'); assert.equal(continuation.continuationOf, 'exec-1');
  assert.deepEqual(continuation.resumeSessionRef, session('exec'));
  assert.deepEqual(continuation.candidateRef, candidate(1), 'the repair builds on the candidate the check failed');
  assert.equal(continuation.journalDigest, r.journal.digest);
  assert.equal(continuation.launchable, false); assert.equal(continuation.stage, 'offline-continuation');
  assert.equal(continuation.dispatch, 'main-session-resume-only');
  assert.equal(result.enginePlanItem, undefined, 'the count engine cannot resume a session, so no engine plan item exists');
  assert.ok(continuation.unresolved.includes('real-session-resume'));
  const { digest: recorded, ...body } = continuation;
  assert.equal(recorded, digest(body));
  assert.equal(continuation.planRef.digest, bytesDigest(renderedBrief));
  assert.match(renderedBrief, /Continuation: attempt 2 of ticket US-08, duty exec/);
  assert.match(renderedBrief, /No commits, pushes, deployment, delegation/, 'the mandatory rules of the first brief are kept');
  assert.match(renderedBrief, /Retry click handler now reissues the request/);
  assert.deepEqual(prepareEvent, { type: 'prepare', assignmentId: 'exec-2', duty: 'exec', planRef: continuation.planRef, candidateRef: candidate(1),
    continuationOf: 'exec-1', resumeSessionRef: session('exec'),
    divergence: { previousPlanDigest: reference('exec-plan-1').digest, ...divergence } });
  assert.deepEqual(go(r), result, 'deterministic');
  r.accept(prepareEvent);
  assert.equal(r.state().assignments.at(-1).attempt, 2, 'the real journal accepts the compiled event once the host adds its admission');
});

test('a blocked check is retried on the check session against the latest author candidate', () => {
  const r = afterFirstRound('blocked'), result = go(r, { duty: 'check', divergence: { reason: 'Verification environment restored', evidenceRef: reference('env-fixed') } });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.continuation.attempt, 2); assert.equal(result.continuation.assignmentId, 'check-2');
  assert.equal(result.continuation.continuationOf, 'check-1'); assert.deepEqual(result.continuation.resumeSessionRef, session('check'));
  assert.match(result.renderedBrief, /Independently verify the host-bound candidate/);
  r.accept(result.prepareEvent);
});

test('the attempt is counted per ticket and duty: a changed wrapper, method or assignment name does not reset it', () => {
  const r = afterFirstRound();
  for (const n of [2, 3]) {
    const input = request(n); input.policy.profiles.exec.wrapper = `renamed-exec-${n}`; input.mandate.policyDigest = digest(input.policy);
    const result = compileContinuation({ input, journal: r.journal, rules, duty: 'exec', divergence });
    assert.equal(result.continuation?.attempt, n, JSON.stringify(result.errors));
    assert.deepEqual(result.continuation.resumeSessionRef, session('exec'), 'still the original session');
    r.accept(result.prepareEvent).send(start('exec', n)).send(close('exec', n, 'candidate'));
    r.send({ ...first('check', n), continuationOf: `check-${n - 1}`, resumeSessionRef: session('check'),
      divergence: { previousPlanDigest: reference(`check-plan-${n - 1}`).digest, reason: 'Recheck of the repaired candidate', evidenceRef: reference(`recheck-${n}`) } })
      .send(start('check', n)).send(close('check', n, 'fail'));
  }
  assert.equal(code(compileContinuation({ input: request(4), journal: r.journal, rules, duty: 'exec', divergence })), 'RETRY_LIMIT');
});

test('no continuation is compiled for stopped, unknown, pending or unproven work', () => {
  assert.equal(code(go(rig())), 'NOT_A_CONTINUATION', 'a duty that never started is compiled as a first attempt');
  assert.equal(code(go(afterFirstRound().send({ type: 'stop', reason: 'missing-session', evidenceRef: reference('session-lost') }))), 'RETRY_STOPPED');
  assert.equal(code(go(afterFirstRound().send({ type: 'stop', reason: 'operator-stop', evidenceRef: reference('owner-said-stop') }))), 'RETRY_STOPPED');
  const unknown = afterFirstRound(); unknown.accept(go(unknown).prepareEvent).send(start('exec', 2)).send({ type: 'unknown', assignmentId: 'exec-2', reasonRef: reference('host-crash') });
  assert.equal(code(go(unknown, { input: request(3, 1) })), 'RETRY_STOPPED', 'unknown execution is never retried automatically');
  const pending = afterFirstRound(); pending.accept(go(pending).prepareEvent);
  assert.equal(code(go(pending, { input: request(3, 1) })), 'RETRY_PENDING');
  assert.equal(code(go(afterFirstRound('pass'))), 'RETRY_STOPPED', 'a passing check awaits settlement');
  const unchecked = rig().send(first('exec')).send(start('exec', 1)).send(close('exec', 1, 'candidate'));
  assert.equal(code(go(unchecked)), 'CHECK_REQUIRED', 'an author candidate is not repaired before an independent check failed it');
});

test('a stale candidate, a foreign ticket, a reused assignment or an altered journal is refused', () => {
  const r = afterFirstRound();
  assert.equal(code(go(r, { input: request(2, 0) })), 'STALE_CANDIDATE', 'the request must name the candidate the journal holds');
  const foreign = request(); foreign.ticket.id = 'US-09'; foreign.mandate.ticketId = 'US-09';
  assert.equal(code(go(r, { input: foreign })), 'TICKET_MISMATCH');
  const reused = request(); reused.proposal.assignmentId = 'exec-1';
  assert.equal(code(go(r, { input: reused })), 'IDEMPOTENCY_CONFLICT');
  const altered = r.journal; altered.events.pop();
  assert.equal(code(go(r, { journal: altered })), 'RETRY_JOURNAL_MISMATCH');
  assert.equal(code(go(r, { duty: 'guard' })), 'INVALID_CONTINUATION');
  assert.equal(code(go(r, { divergence: { reason: '', evidenceRef: reference('x') } })), 'INVALID_CONTINUATION');
  assert.equal(code(go(r, { divergence: { ...divergence, previousPlanDigest: divergence.evidenceRef.digest } })), 'INVALID_CONTINUATION', 'the previous plan is read from the journal, not claimed');
  const broken = request(); broken.proposal.expectedPaths = ['../outside'];
  assert.equal(code(go(r, { input: broken })), 'INVALID_INPUT', 'compiler findings pass through');
});

test('CLI prints the continuation, exits 2 on refusal and 1 on usage', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-continue-')), file = join(dir, 'request.json'), r = afterFirstRound();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify({ input: request(), journal: r.journal, duty: 'exec', divergence }));
  const ok = run(file);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).continuation.attempt, 2);
  writeFileSync(file, JSON.stringify({ input: request(2, 0), journal: r.journal, duty: 'exec', divergence }));
  assert.equal(run(file).status, 2);
  assert.equal(run().status, 1);
});
