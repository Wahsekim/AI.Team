import { canonical, digest, parseJSON, requireThat } from '../loop/contracts.mjs';
import { inspectRetryJournal } from './retries.mjs';

// Rollout gate G-04. A per-ticket ledger of measured usage: one entry per real
// call, cumulative meter reads applied as deltas, unknown usage kept as unknown.
// The 'budget' admission gate is derived from it.
const UNIT = 'input+cache_creation';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, DIGEST = /^sha256:[a-f0-9]{64}$/;
const EVENT_KEYS = {
  usage: ['callRef', 'agentId', 'harnessTokens', 'uniqueMessages', 'finished', 'sourceRef'],
  'unknown-usage': ['callRef', 'reasonRef'],
};
const UNRESOLVED = ['meter-read-authenticity', 'call-to-transcript-binding', 'durable-ledger', 'guardian-and-governance-usage',
  'lifecycle-token-lines', 'cross-ticket-run-budget'];

const expect = (condition, message, code = 'INVALID_SETTLEMENT') => requireThat(condition, code, message);
const copy = value => parseJSON(canonical(value), 4 * 1024 * 1024);
const same = (a, b) => canonical(a) === canonical(b);
const count = value => Number.isSafeInteger(value) && value >= 0;
const isId = value => typeof value === 'string' && ID.test(value);
const isRef = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === 'digest,id'
  && isId(value.id) && DIGEST.test(value.digest);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const envelope = body => ({ ...body, digest: digest(body) });

export function createSettlementLedger({ ticketId, authorizedTokens }) {
  expect(isId(ticketId) && Number.isSafeInteger(authorizedTokens) && authorizedTokens >= 1, 'A ticket id and a positive authorization are required');
  return envelope({ schemaVersion: 1, ticketId, authorizedTokens, unit: UNIT, events: [] });
}

function validateEvent(event) {
  expect(event && Object.hasOwn(EVENT_KEYS, event.type) && exact(event, ['eventId', 'type', ...EVENT_KEYS[event.type]])
    && isId(event.eventId) && isRef(event.callRef), 'Unknown or malformed settlement event');
  if (event.type === 'unknown-usage') return expect(isRef(event.reasonRef), 'An unknown-usage event needs a reason reference');
  expect(isId(event.agentId) && count(event.harnessTokens) && count(event.uniqueMessages)
    && [true, false, null].includes(event.finished) && isRef(event.sourceRef), 'Malformed usage reading');
}

function transition(calls, event) {
  const next = calls.map(call => ({ ...call })), index = next.findIndex(call => same(call.callRef, event.callRef)), call = next[index];
  if (event.type === 'unknown-usage') {
    expect(!call || call.status === 'unknown', 'A measured call cannot become unknown again', 'USAGE_REGRESSION');
    if (!call) next.push({ callRef: event.callRef, agentId: null, tokens: null, uniqueMessages: null, status: 'unknown' });
    return next;
  }
  expect(!next.some(other => other.agentId === event.agentId && !same(other.callRef, event.callRef)),
    'This meter row already pays another call', 'IDEMPOTENCY_CONFLICT');
  expect(!call?.agentId || call.agentId === event.agentId, 'This call is already bound to another meter row', 'IDEMPOTENCY_CONFLICT');
  // Meter reads are cumulative for one transcript: a later read replaces the earlier one.
  expect(!call?.agentId || event.harnessTokens >= call.tokens && event.uniqueMessages >= call.uniqueMessages,
    'A later read of one call cannot report fewer tokens or messages', 'USAGE_REGRESSION');
  const settled = { callRef: event.callRef, agentId: event.agentId, tokens: event.harnessTokens, uniqueMessages: event.uniqueMessages,
    status: event.finished === true || call?.status === 'settled' ? 'settled' : 'partial' };
  if (call) next[index] = settled; else next.push(settled);
  return next;
}

function replay(ledger) {
  expect(exact(ledger, ['schemaVersion', 'ticketId', 'authorizedTokens', 'unit', 'events', 'digest']) && Array.isArray(ledger.events)
    && ledger.events.length <= 1024, 'Malformed settlement ledger');
  const { digest: recorded, ...body } = ledger;
  expect(ledger.schemaVersion === 1 && ledger.unit === UNIT && recorded === digest(body), 'Ledger content does not match its digest', 'SETTLEMENT_LEDGER_MISMATCH');
  const ids = new Set(); let calls = [];
  for (const event of ledger.events) {
    validateEvent(event);
    expect(!ids.has(event.eventId), 'Duplicate settlement event ID', 'IDEMPOTENCY_CONFLICT'); ids.add(event.eventId);
    calls = transition(calls, event);
  }
  return calls;
}
const summary = (ledger, calls) => ({ ticketId: ledger.ticketId, authorizedTokens: ledger.authorizedTokens, unit: UNIT, calls,
  spentTokens: calls.reduce((total, call) => total + (call.tokens ?? 0), 0), ledgerDigest: ledger.digest });

export function inspectSettlementLedger({ ledger }) {
  const frozen = copy(ledger);
  return summary(frozen, replay(frozen));
}

export function advanceSettlementLedger({ ledger, expectedDigest, event }) {
  const frozen = copy(ledger), next = copy(event), calls = replay(frozen);
  validateEvent(next);
  expect(expectedDigest === frozen.digest, 'Caller holds a stale ledger version', 'STALE_SETTLEMENT_LEDGER');
  const previous = frozen.events.find(value => value.eventId === next.eventId);
  if (previous) {
    expect(same(previous, next), 'Event ID reused with different content', 'IDEMPOTENCY_CONFLICT');
    return { ledger: frozen, state: summary(frozen, calls), applied: false };
  }
  expect(frozen.events.length < 1024, 'Settlement event limit exceeded');
  const after = transition(calls, next), { digest: _, ...body } = frozen;
  const updated = envelope({ ...body, events: [...frozen.events, next] });
  return { ledger: updated, state: summary(updated, after), applied: true };
}

// One row of `measure-spawn.mjs --json` (.subagents[]) for the call it belongs to.
export function usageEventFromMeterRow({ row, callRef, eventId }) {
  expect(row && isId(row.agentId) && count(row.harnessEq) && count(row.uniqueMessages) && [true, false, null].includes(row.finished),
    'Not a measure-spawn subagent row');
  const reading = { agentId: row.agentId, harnessTokens: row.harnessEq, uniqueMessages: row.uniqueMessages, finished: row.finished };
  const event = { eventId, type: 'usage', callRef, ...reading, sourceRef: { id: 'measure-spawn', digest: digest(reading) } };
  validateEvent(event);
  return event;
}

export function settleAgainstJournal({ ledger, retryJournal, rules, nextEstimateTokens }) {
  const state = inspectSettlementLedger({ ledger }), journal = inspectRetryJournal({ journal: retryJournal, rules });
  expect(state.ticketId === journal.ticketId, 'Ledger and retry journal belong to different tickets', 'TICKET_MISMATCH');
  expect(nextEstimateTokens === undefined || count(nextEstimateTokens), 'nextEstimateTokens must be a non-negative integer');
  const started = journal.assignments.filter(assignment => assignment.callRef);
  const calls = started.map(assignment => {
    const entry = state.calls.find(call => same(call.callRef, assignment.callRef));
    return { assignmentId: assignment.assignmentId, duty: assignment.duty, attempt: assignment.attempt, callRef: assignment.callRef,
      tokens: entry?.tokens ?? null, status: entry?.status ?? 'unsettled' };
  });
  const unattributedCalls = state.calls.filter(call => !started.some(assignment => same(assignment.callRef, call.callRef))).length;
  const remainingTokens = Math.max(0, state.authorizedTokens - state.spentTokens);
  const blocked = [state.spentTokens >= state.authorizedTokens ? 'authorization-exhausted' : null,
    remainingTokens > 0 && nextEstimateTokens > remainingTokens ? 'insufficient-remaining' : null].filter(Boolean);
  const unknown = [['unknown', 'unknown-usage'], ['partial', 'partial-usage'], ['unsettled', 'unsettled-call']]
    .filter(([status]) => calls.some(call => call.status === status) || state.calls.some(call => call.status === status)).map(([, reason]) => reason);
  if (unattributedCalls) unknown.push('unattributed-usage');
  const body = { schemaVersion: 1, stage: 'offline-settlement', launchable: false, ticketId: state.ticketId, unit: UNIT,
    authorizedTokens: state.authorizedTokens, spentTokens: state.spentTokens, remainingTokens,
    overrunTokens: Math.max(0, state.spentTokens - state.authorizedTokens),
    budgetGate: blocked.length ? 'blocked' : unknown.length ? 'unknown' : 'clear', reasons: [...blocked, ...unknown],
    calls, unattributedCalls, ticketStopped: journal.stops.length > 0,
    ledgerDigest: state.ledgerDigest, journalDigest: retryJournal.digest, unresolved: UNRESOLVED };
  return { ...body, digest: digest(body) };
}
