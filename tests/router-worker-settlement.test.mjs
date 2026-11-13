// Rollout gate G-04: measured usage is settled to the ticket once per real call,
// and the 'budget' admission gate is derived from that ledger, not declared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createSettlementLedger, advanceSettlementLedger, inspectSettlementLedger, settleAgainstJournal, usageEventFromMeterRow } from '../src/router-worker/settlement.mjs';
import { loadRetryRules, createRetryJournal, advanceRetryJournal } from '../src/router-worker/retries.mjs';
import { digest } from '../src/loop/contracts.mjs';

const CLI = fileURLToPath(new URL('../scripts/settle-router-worker.mjs', import.meta.url));
const rules = loadRetryRules();
const reference = name => ({ id: name, digest: digest(name) });
const GATES = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const admission = () => ({ sourceRef: reference('host-gate-fixture'), gates: Object.fromEntries(GATES.map(gate => [gate, 'clear'])) });
const callRef = (duty, n = 1) => reference(`call-${duty}-${n}`);

// Retry journal after exec-1 (candidate) and check-1 (fail): two real calls.
function journalAfterFirstRound(extra = []) {
  let journal = createRetryJournal({ ticketId: 'US-08', rules }), seq = 0;
  const events = [
    { type: 'prepare', assignmentId: 'exec-1', duty: 'exec', planRef: reference('exec-plan-1'), candidateRef: reference('candidate-0'), continuationOf: null, resumeSessionRef: null, divergence: null, admission: admission() },
    { type: 'start', assignmentId: 'exec-1', sessionRef: reference('exec-session'), callRef: callRef('exec'), admission: admission() },
    { type: 'close', assignmentId: 'exec-1', outcome: 'candidate', progress: true, outcomeKey: 'observed-exec-1', candidateRef: reference('candidate-1'), receiptRef: reference('receipt-exec-1') },
    { type: 'prepare', assignmentId: 'check-1', duty: 'check', planRef: reference('check-plan-1'), candidateRef: reference('candidate-1'), continuationOf: null, resumeSessionRef: null, divergence: null, admission: admission() },
    { type: 'start', assignmentId: 'check-1', sessionRef: reference('check-session'), callRef: callRef('check'), admission: admission() },
    { type: 'close', assignmentId: 'check-1', outcome: 'fail', progress: true, outcomeKey: 'observed-check-1', candidateRef: reference('candidate-1'), receiptRef: reference('receipt-check-1') },
    ...extra];
  for (const event of events) journal = advanceRetryJournal({ journal, rules, expectedDigest: journal.digest, event: { eventId: `event-${++seq}`, ...event } }).journal;
  return journal;
}
const usage = (duty, tokens, overrides = {}) => ({ type: 'usage', callRef: callRef(duty), agentId: `agent-${duty}`, harnessTokens: tokens,
  uniqueMessages: 10, finished: true, sourceRef: reference(`meter-${duty}-${tokens}`), ...overrides });
function rig(authorizedTokens = 24000) {
  let ledger = createSettlementLedger({ ticketId: 'US-08', authorizedTokens }), seq = 0;
  const api = {
    get ledger() { return structuredClone(ledger); },
    send(event, eventId = `settle-${++seq}`) { const result = advanceSettlementLedger({ ledger, expectedDigest: ledger.digest, event: { eventId, ...event } }); ledger = result.ledger; api.last = result; return api; },
    state: () => inspectSettlementLedger({ ledger }),
    settle: (journal = journalAfterFirstRound(), options = {}) => settleAgainstJournal({ ledger, retryJournal: journal, rules, ...options }),
  };
  return api;
}
const throws = (fn, code) => assert.throws(fn, error => error.code === code, code);

test('each real call is settled once and attributed to its assignment, duty and attempt; the budget gate is derived', () => {
  const r = rig().send(usage('exec', 11000)).send(usage('check', 5000)), result = r.settle();
  assert.equal(result.budgetGate, 'clear'); assert.deepEqual(result.reasons, []);
  assert.equal(result.spentTokens, 16000); assert.equal(result.remainingTokens, 8000); assert.equal(result.overrunTokens, 0);
  assert.deepEqual(result.calls.map(c => [c.assignmentId, c.duty, c.attempt, c.tokens, c.status]),
    [['exec-1', 'exec', 1, 11000, 'settled'], ['check-1', 'check', 1, 5000, 'settled']]);
  assert.equal(result.launchable, false); assert.equal(result.unit, 'input+cache_creation');
  const { digest: recorded, ...body } = result;
  assert.equal(recorded, digest(body)); assert.deepEqual(r.settle(), result, 'deterministic');
  assert.equal(r.settle(undefined, { nextEstimateTokens: 8000 }).budgetGate, 'clear');
  const tight = r.settle(undefined, { nextEstimateTokens: 8001 });
  assert.equal(tight.budgetGate, 'blocked'); assert.deepEqual(tight.reasons, ['insufficient-remaining']);
});

test('duplicate close: a replayed event and a second read of the same call never count twice', () => {
  const r = rig().send(usage('exec', 11000), 'close-exec');
  r.send(usage('exec', 11000), 'close-exec');
  assert.equal(r.last.applied, false, 'identical event replay is a no-op');
  throws(() => r.send(usage('exec', 12000), 'close-exec'), 'IDEMPOTENCY_CONFLICT');
  r.send(usage('exec', 11000), 'close-exec-again');
  assert.equal(r.state().spentTokens, 11000, 'the same measurement under another event id adds nothing');
  throws(() => r.send(usage('check', 5000, { agentId: 'agent-exec' })), 'USAGE_REGRESSION', 'a second call on one transcript cannot read below what the first already used');
  throws(() => r.send(usage('exec', 11000, { agentId: 'agent-other' })), 'IDEMPOTENCY_CONFLICT');
  assert.equal(r.state().spentTokens, 11000, 'one meter row pays one call and one call has one meter row');
});

test('late usage adds only the delta of a cumulative read; a read that goes backwards is refused', () => {
  const r = rig().send(usage('exec', 11000));
  r.send(usage('exec', 12500, { uniqueMessages: 12 }));
  assert.equal(r.state().spentTokens, 12500);
  throws(() => r.send(usage('exec', 9000, { uniqueMessages: 12 })), 'USAGE_REGRESSION');
  throws(() => r.send(usage('exec', 13000, { uniqueMessages: 8 })), 'USAGE_REGRESSION');
  assert.equal(r.state().spentTokens, 12500);
});

test('restart: the ledger is rebuilt from its stored events and a stale writer is refused', () => {
  const r = rig().send(usage('exec', 11000)).send(usage('check', 5000)), stored = JSON.parse(JSON.stringify(r.ledger));
  assert.deepEqual(inspectSettlementLedger({ ledger: stored }), r.state());
  let rebuilt = createSettlementLedger({ ticketId: 'US-08', authorizedTokens: 24000 });
  for (const event of stored.events) rebuilt = advanceSettlementLedger({ ledger: rebuilt, expectedDigest: rebuilt.digest, event }).ledger;
  assert.equal(rebuilt.digest, stored.digest);
  const replayed = advanceSettlementLedger({ ledger: stored, expectedDigest: stored.digest, event: stored.events[0] });
  assert.equal(replayed.applied, false); assert.equal(replayed.ledger.digest, stored.digest);
  throws(() => advanceSettlementLedger({ ledger: stored, expectedDigest: rig().ledger.digest, event: { eventId: 'late-writer', ...usage('check', 6000) } }), 'STALE_SETTLEMENT_LEDGER');
  const altered = structuredClone(stored); altered.events[0].harnessTokens = 1;
  throws(() => inspectSettlementLedger({ ledger: altered }), 'SETTLEMENT_LEDGER_MISMATCH');
  const raised = structuredClone(stored); raised.authorizedTokens = 999999;
  throws(() => inspectSettlementLedger({ ledger: raised }), 'SETTLEMENT_LEDGER_MISMATCH');
});

test('overrun is recorded in full and blocks admission', () => {
  const r = rig().send(usage('exec', 20000)).send(usage('check', 7000)), result = r.settle();
  assert.equal(result.spentTokens, 27000); assert.equal(result.overrunTokens, 3000); assert.equal(result.remainingTokens, 0);
  assert.equal(result.budgetGate, 'blocked'); assert.deepEqual(result.reasons, ['authorization-exhausted']);
  assert.equal(rig().send(usage('exec', 24000)).settle().reasons.includes('authorization-exhausted'), true, 'spending exactly the authorization leaves nothing to admit');
});

test('unknown usage is retained, never read as zero: missing, unmeasured and unfinished calls make the gate unknown', () => {
  const missing = rig().send(usage('exec', 11000)).settle();
  assert.equal(missing.budgetGate, 'unknown'); assert.deepEqual(missing.reasons, ['unsettled-call']);
  assert.deepEqual(missing.calls.at(-1), { assignmentId: 'check-1', duty: 'check', attempt: 1, callRef: callRef('check'), tokens: null, status: 'unsettled' });
  const unmeasured = rig().send(usage('exec', 11000)).send({ type: 'unknown-usage', callRef: callRef('check'), reasonRef: reference('transcript-missing') });
  assert.equal(unmeasured.settle().budgetGate, 'unknown'); assert.deepEqual(unmeasured.settle().reasons, ['unknown-usage']);
  assert.equal(unmeasured.settle().spentTokens, 11000, 'the known lower bound');
  const partial = rig().send(usage('exec', 11000)).send(usage('check', 2000, { finished: false, uniqueMessages: 3 }));
  assert.deepEqual(partial.settle().reasons, ['partial-usage']); assert.equal(partial.settle().spentTokens, 13000);
  partial.send(usage('check', 5000, { finished: true, uniqueMessages: 9 }));
  assert.equal(partial.settle().budgetGate, 'clear'); assert.equal(partial.settle().spentTokens, 16000);
  unmeasured.send(usage('check', 5000));
  assert.equal(unmeasured.settle().budgetGate, 'clear', 'a finished measurement resolves an unknown call');
  throws(() => partial.send({ type: 'unknown-usage', callRef: callRef('check'), reasonRef: reference('x') }), 'USAGE_REGRESSION');
});

test('late usage after a stop is still settled; a call the journal does not know and a foreign ticket are not', () => {
  const stopped = journalAfterFirstRound([{ type: 'stop', reason: 'operator-stop', evidenceRef: reference('owner-said-stop') }]);
  const r = rig().send(usage('exec', 11000));
  assert.equal(r.settle(stopped).budgetGate, 'unknown');
  r.send(usage('check', 5000));
  const result = r.settle(stopped);
  assert.equal(result.spentTokens, 16000); assert.equal(result.budgetGate, 'clear'); assert.equal(result.ticketStopped, true, 'the budget gate is one gate; the stop stays with the retry journal');
  const foreign = rig().send(usage('exec', 11000)).send(usage('check', 5000)).send({ ...usage('exec', 700), callRef: reference('call-nobody-started'), agentId: 'agent-stray' }).settle();
  assert.equal(foreign.budgetGate, 'unknown'); assert.deepEqual(foreign.reasons, ['unattributed-usage']); assert.equal(foreign.spentTokens, 16700, 'stray usage still counts against the ticket');
  const other = createSettlementLedger({ ticketId: 'US-09', authorizedTokens: 24000 });
  throws(() => settleAgainstJournal({ ledger: other, retryJournal: journalAfterFirstRound(), rules }), 'TICKET_MISMATCH');
});

test('invalid ledgers and events are refused', () => {
  throws(() => createSettlementLedger({ ticketId: 'US-08', authorizedTokens: 0 }), 'INVALID_SETTLEMENT');
  for (const bad of [{ harnessTokens: -1 }, { harnessTokens: 1.5 }, { uniqueMessages: -1 }, { finished: 'yes' }, { extra: 1 }, { callRef: 'call-exec-1' }])
    throws(() => rig().send(usage('exec', 100, bad)), 'INVALID_SETTLEMENT');
  throws(() => rig().send({ type: 'refund', callRef: callRef('exec') }), 'INVALID_SETTLEMENT');
});

test('a measure-spawn row becomes a usage event in harness units; the CLI settles read-only', t => {
  const row = { agentId: 'a1b2c3', agentType: 'sample-worker-exec', finished: true, uniqueMessages: 14, harnessEq: 11000, total: 90000, input: 1000, cacheCreate: 10000, cacheRead: 78000, output: 1000 };
  const event = usageEventFromMeterRow({ row, callRef: callRef('exec'), eventId: 'meter-1' });
  assert.equal(event.harnessTokens, 11000, 'input + cache_creation, never the four-class total'); assert.equal(event.uniqueMessages, 14); assert.equal(event.finished, true);
  assert.equal(usageEventFromMeterRow({ row: { ...row, finished: null }, callRef: callRef('exec'), eventId: 'meter-2' }).finished, null);
  throws(() => usageEventFromMeterRow({ row: { ...row, harnessEq: undefined }, callRef: callRef('exec'), eventId: 'meter-3' }), 'INVALID_SETTLEMENT');
  const r = rig().send(event, 'meter-1').send(usage('check', 5000));
  const dir = mkdtempSync(join(tmpdir(), 'rw-settle-')), file = join(dir, 'request.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify({ ledger: r.ledger, retryJournal: journalAfterFirstRound() }));
  const ok = run(file);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).budgetGate, 'clear');
  writeFileSync(file, JSON.stringify({ ledger: r.ledger, retryJournal: journalAfterFirstRound(), nextEstimateTokens: 9000 }));
  const blocked = run(file);
  assert.equal(blocked.status, 2); assert.equal(JSON.parse(blocked.stdout).budgetGate, 'blocked');
  writeFileSync(file, '{broken');
  assert.equal(run(file).status, 2);
  assert.equal(run().status, 1);
});

// exec-2 is a continuation of exec-1 on the same session: both calls grow one transcript.
const repair = [
  { type: 'prepare', assignmentId: 'exec-2', duty: 'exec', planRef: reference('exec-plan-2'), candidateRef: reference('candidate-1'), continuationOf: 'exec-1', resumeSessionRef: reference('exec-session'),
    divergence: { previousPlanDigest: reference('exec-plan-1').digest, reason: 'Repair after the failed check', evidenceRef: reference('check-1-findings') }, admission: admission() },
  { type: 'start', assignmentId: 'exec-2', sessionRef: reference('exec-session'), callRef: callRef('exec', 2), admission: admission() },
];
const second = (tokens, overrides = {}) => usage('exec', tokens, { callRef: callRef('exec', 2), uniqueMessages: 18, ...overrides });

test('two calls on one transcript: the second call is charged the cumulative read minus what the first call used', () => {
  const r = rig(40000).send(usage('exec', 11000)).send(usage('check', 5000)).send(second(19000, { finished: false })), partial = r.settle(journalAfterFirstRound(repair));
  assert.deepEqual(partial.calls.map(c => [c.assignmentId, c.attempt, c.tokens, c.status]), [['exec-1', 1, 11000, 'settled'], ['check-1', 1, 5000, 'settled'], ['exec-2', 2, 8000, 'partial']]);
  assert.equal(partial.spentTokens, 24000); assert.deepEqual(partial.reasons, ['partial-usage']);
  const done = r.send(second(23000)).settle(journalAfterFirstRound(repair));
  assert.deepEqual(done.calls.map(c => c.tokens), [11000, 5000, 12000], 'a later read of the second call replaces its earlier read');
  assert.equal(done.spentTokens, 28000); assert.equal(done.budgetGate, 'clear');
  r.send(second(23000), 'same-read-again');
  assert.equal(r.state().spentTokens, 28000, 'the same cumulative read adds nothing');
});

test('one transcript cannot be split when the boundary is unknown or moves', () => {
  const open = rig(40000).send(usage('exec', 11000, { finished: false }));
  throws(() => open.send(second(19000)), 'IDEMPOTENCY_CONFLICT', 'the first call has no finished read, so no boundary exists');
  const r = rig(40000).send(usage('exec', 11000)).send(second(19000));
  throws(() => r.send(usage('exec', 12000)), 'USAGE_REGRESSION', 'a call that a later call on the same transcript follows is closed');
  throws(() => r.send(second(18000)), 'USAGE_REGRESSION');
  throws(() => rig(40000).send(usage('exec', 11000)).send(second(10999)), 'USAGE_REGRESSION', 'a cumulative read below the first call');
  throws(() => rig(40000).send(usage('exec', 11000)).send(second(19000, { uniqueMessages: 9 })), 'USAGE_REGRESSION');
});

test('calls of different duties on one transcript make the gate unknown: check and exec sessions must be separate', () => {
  const shared = rig(40000).send(usage('exec', 11000)).send(usage('check', 16000, { agentId: 'agent-exec' })).settle();
  assert.equal(shared.budgetGate, 'unknown'); assert.deepEqual(shared.reasons, ['meter-shared-across-duties']);
  assert.deepEqual(shared.calls.map(c => c.tokens), [11000, 5000]);
});
