// Run-level settlement: the per-ticket settlements of one frozen run plus the
// Guardian call, which belongs to the run and to no ticket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { settleRun } from '../src/router-worker/run-settlement.mjs';
import { freezeRun } from '../src/router-worker/run-args.mjs';
import { createSettlementLedger, advanceSettlementLedger, settleAgainstJournal } from '../src/router-worker/settlement.mjs';
import { loadRetryRules, createRetryJournal, advanceRetryJournal } from '../src/router-worker/retries.mjs';
import { digest } from '../src/loop/contracts.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';

const ENGINE = fileURLToPath(new URL('../.claude/workflows/run-n-rounds.js', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/settle-run-router-worker.mjs', import.meta.url));
const rules = loadRetryRules(), reference = name => ({ id: name, digest: digest(name) });
const GATES = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const admission = () => ({ sourceRef: reference('host-gate-fixture'), gates: Object.fromEntries(GATES.map(gate => [gate, 'clear'])) });

async function frozenRecord(t, run = {}) {
  const team = realpathSync(mkdtempSync(join(tmpdir(), 'rw-run-settle-')));
  t.after(() => rmSync(team, { recursive: true, force: true }));
  mkdirSync(join(team, 'agents')); mkdirSync(join(team, '.claude/workflows'), { recursive: true });
  writeFileSync(join(team, 'agents/roster.md'), ['| Role id | Role file | Wrapper file | Model | Reasoning | Status |', '|---|---|---|---|---|---|',
    ...['exec', 'check', 'guard'].map(d => `| worker-${d} | agents/worker-${d}.md | .claude/agents/sample-worker-${d}.md | m | high | active |`)].join('\n') + '\n');
  copyFileSync(ENGINE, join(team, '.claude/workflows/run-n-rounds.js'));
  const second = inputFixture();
  second.ticket.id = 'US-09'; second.mandate.ticketId = 'US-09'; second.proposal.assignmentId = 'US-09.exec.1'; second.proposal.checkAssignmentId = 'US-09.check.1';
  const frozen = await freezeRun({ inputs: [inputFixture(), second], teamRoot: team, run: { rounds: 2, date: '2026-11-13', nextLifecycleNumber: 2, runId: 'rw-run-002',
    budgetCeilingTokens: 46800, estimatedOutputTokens: 36000, guardianEstimateTokens: 20000, ...run } });
  assert.equal(frozen.errors, undefined, JSON.stringify(frozen.errors));
  return { record: frozen.record, team };
}
// One ticket after exec-1 and check-1, both measured and finished unless overridden.
function ticket(id, { exec = 11000, check = 5000, checkFinished = true } = {}) {
  let journal = createRetryJournal({ ticketId: id, rules }), ledger = createSettlementLedger({ ticketId: id, authorizedTokens: 24000 }), seq = 0;
  const call = duty => reference(`${id}-call-${duty}`);
  for (const event of [
    { type: 'prepare', assignmentId: 'exec-1', duty: 'exec', planRef: reference('exec-plan'), candidateRef: reference('candidate-0'), continuationOf: null, resumeSessionRef: null, divergence: null, admission: admission() },
    { type: 'start', assignmentId: 'exec-1', sessionRef: reference('exec-session'), callRef: call('exec'), admission: admission() },
    { type: 'close', assignmentId: 'exec-1', outcome: 'candidate', progress: true, outcomeKey: 'exec-1', candidateRef: reference('candidate-1'), receiptRef: reference('receipt-exec') },
    { type: 'prepare', assignmentId: 'check-1', duty: 'check', planRef: reference('check-plan'), candidateRef: reference('candidate-1'), continuationOf: null, resumeSessionRef: null, divergence: null, admission: admission() },
    { type: 'start', assignmentId: 'check-1', sessionRef: reference('check-session'), callRef: call('check'), admission: admission() },
    { type: 'close', assignmentId: 'check-1', outcome: 'pass', progress: true, outcomeKey: 'check-1', candidateRef: reference('candidate-1'), receiptRef: reference('receipt-check') },
  ]) journal = advanceRetryJournal({ journal, rules, expectedDigest: journal.digest, event: { eventId: `event-${++seq}`, ...event } }).journal;
  for (const [duty, tokens, finished] of [['exec', exec, true], ['check', check, checkFinished]])
    ledger = advanceSettlementLedger({ ledger, expectedDigest: ledger.digest, event: { eventId: `usage-${duty}`, type: 'usage', callRef: call(duty), agentId: `agent-${duty}`,
      harnessTokens: tokens, uniqueMessages: 9, finished, sourceRef: reference(`meter-${id}-${duty}`) } }).ledger;
  return settleAgainstJournal({ ledger, retryJournal: journal, rules });
}
const guardRow = (overrides = {}) => ({ agentId: 'g1', agentType: 'sample-worker-guard', finished: true, uniqueMessages: 3, harnessEq: 17000, ...overrides });
const account = (exec = 2) => ({ status: 'accounted', findings: [], calls: { exec, check: exec, guard: 1 }, nextLifecycleNumberAfter: 5, blockers: [] });
const code = fn => { try { fn(); } catch (error) { return error.code; } return null; };

test('a frozen run records the Guardian estimate in the ledger unit; it is not an engine argument', async t => {
  const { record, team } = await frozenRecord(t);
  assert.deepEqual(record.guardian, { unit: 'input+cache_creation', estimated: 20000 });
  const missing = await freezeRun({ inputs: [inputFixture()], teamRoot: team, run: { rounds: 1, date: '2026-11-13', nextLifecycleNumber: 2, runId: 'r', budgetCeilingTokens: 23400, estimatedOutputTokens: 18000 } });
  assert.equal(missing.errors?.[0].code, 'INVALID_RUN', 'the Guardian estimate is required');
});

test('ticket usage and the Guardian call add up to the run total; all settled and within estimate is clear', async t => {
  const { record } = await frozenRecord(t), result = settleRun({ record, account: account(), tickets: [ticket('US-08'), ticket('US-09', { exec: 12000 })], guardian: guardRow() });
  assert.equal(result.runGate, 'clear'); assert.deepEqual(result.reasons, []);
  assert.deepEqual([result.ticketTokens, result.guardianTokens, result.totalTokens], [33000, 17000, 50000]);
  assert.equal(result.authorizedTokens, 48000); assert.equal(result.guardianEstimateTokens, 20000); assert.equal(result.unit, 'input+cache_creation');
  assert.deepEqual(result.tickets.map(entry => [entry.ticketId, entry.spentTokens, entry.budgetGate]), [['US-08', 16000, 'clear'], ['US-09', 17000, 'clear']]);
  assert.equal(result.launchable, false); assert.equal(result.recordDigest, record.digest);
  const { digest: recorded, ...body } = result;
  assert.equal(recorded, digest(body));
});

test('the run gate is unknown or blocked for the reason that applies, and names it', async t => {
  const { record } = await frozenRecord(t), both = () => [ticket('US-08'), ticket('US-09')];
  const reasons = input => { const r = settleRun({ record, account: account(), tickets: both(), guardian: guardRow(), ...input }); return [r.runGate, r.reasons]; };
  assert.deepEqual(reasons({ guardian: null }), ['unknown', ['guardian-usage-missing']]);
  assert.deepEqual(reasons({ guardian: guardRow({ finished: null }) }), ['unknown', ['guardian-usage-partial']]);
  assert.deepEqual(reasons({ guardian: guardRow({ harnessEq: 20001 }) }), ['blocked', ['guardian-over-estimate']]);
  assert.deepEqual(reasons({ tickets: [ticket('US-08'), ticket('US-09', { checkFinished: null })] }), ['unknown', ['ticket-gate-unknown:US-09']]);
  assert.deepEqual(reasons({ tickets: [ticket('US-08', { exec: 30000 }), ticket('US-09')] }), ['blocked', ['ticket-gate-blocked:US-08']]);
  assert.deepEqual(reasons({ tickets: [ticket('US-08')] }), ['unknown', ['ticket-unsettled:US-09']], 'a ticket of the run without a settlement');
});

test('altered or foreign inputs are refused', async t => {
  const { record } = await frozenRecord(t), tickets = [ticket('US-08'), ticket('US-09')];
  assert.equal(code(() => settleRun({ account: account(), record: { ...record, guardian: { ...record.guardian, estimated: 90000 } }, tickets, guardian: guardRow() })), 'INVALID_RUN_SETTLEMENT');
  assert.equal(code(() => settleRun({ record, account: account(), tickets: [{ ...tickets[0], spentTokens: 1 }, tickets[1]], guardian: guardRow() })), 'INVALID_RUN_SETTLEMENT');
  assert.equal(code(() => settleRun({ record, account: account(), tickets: [...tickets, ticket('US-10')], guardian: guardRow() })), 'INVALID_RUN_SETTLEMENT', 'a ticket that is not in the run');
  assert.equal(code(() => settleRun({ record, account: account(), tickets: [tickets[0], tickets[0]], guardian: guardRow() })), 'INVALID_RUN_SETTLEMENT');
  assert.equal(code(() => settleRun({ record, tickets, guardian: { agentId: 'g1' } })), 'INVALID_RUN_SETTLEMENT');
});

test('CLI is read-only: exit 0 clear, 2 otherwise or invalid, 1 usage', async t => {
  const { record, team } = await frozenRecord(t), file = join(team, 'request.json'), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify({ record, account: account(), tickets: [ticket('US-08'), ticket('US-09')], guardian: guardRow() }));
  const ok = run(file);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).totalTokens, 49000);
  writeFileSync(file, JSON.stringify({ record, account: account(), tickets: [ticket('US-08'), ticket('US-09')], guardian: null }));
  assert.equal(run(file).status, 2);
  writeFileSync(file, '{broken'); assert.equal(run(file).status, 2);
  assert.equal(run().status, 1);
});

test('a run that halted early settles only the tickets it dispatched', async t => {
  const { record } = await frozenRecord(t), halted = settleRun({ record, account: account(1), tickets: [ticket('US-08')], guardian: guardRow() });
  assert.equal(halted.runGate, 'clear', JSON.stringify(halted.reasons));
  assert.deepEqual(halted.undispatchedTickets, ['US-09']); assert.equal(halted.totalTokens, 33000);
  assert.deepEqual(settleRun({ record, account: account(1), tickets: [], guardian: guardRow() }).reasons, ['ticket-unsettled:US-08']);
  assert.equal(code(() => settleRun({ record, account: account(1), tickets: [ticket('US-08'), ticket('US-09')], guardian: guardRow() })), 'INVALID_RUN_SETTLEMENT', 'usage for a ticket the run never dispatched');
  assert.equal(code(() => settleRun({ record, account: { ...account(), status: 'unaccounted' }, tickets: [], guardian: guardRow() })), 'INVALID_RUN_SETTLEMENT', 'an unaccounted return cannot be settled');
  assert.equal(code(() => settleRun({ record, account: account(3), tickets: [], guardian: guardRow() })), 'INVALID_RUN_SETTLEMENT');
  assert.equal(code(() => settleRun({ record, tickets: [], guardian: guardRow() })), 'INVALID_RUN_SETTLEMENT', 'the call accounting is required');
});
