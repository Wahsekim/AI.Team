import { digest, requireThat } from '../loop/contracts.mjs';

// Run-level view of usage in input+cache_creation: the per-ticket settlements of
// one frozen run plus the Guardian call, which belongs to the run and to no ticket.
const UNIT = 'input+cache_creation';
const UNRESOLVED = ['meter-read-authenticity', 'guardian-call-to-transcript-binding', 'governance-usage', 'main-session-usage'];
const expect = (condition, message) => requireThat(condition, 'INVALID_RUN_SETTLEMENT', message);
const selfDigested = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { digest: recorded, ...body } = value;
  return recorded === digest(body);
};
const count = value => Number.isSafeInteger(value) && value >= 0;

export function settleRun({ record, tickets, guardian }) {
  expect(selfDigested(record) && record.stage === 'run-args-frozen-offline' && record.tickets?.unit === UNIT && record.guardian?.unit === UNIT
    && Array.isArray(record.items), 'A frozen run record with its own digest is required');
  expect(Array.isArray(tickets) && tickets.every(entry => selfDigested(entry) && entry.stage === 'offline-settlement' && entry.unit === UNIT),
    'Each ticket entry must be an unaltered ticket settlement');
  const planned = record.items.map(item => item.ticket), settled = tickets.map(entry => entry.ticketId);
  expect(new Set(settled).size === settled.length && settled.every(id => planned.includes(id)), 'Ticket settlements must be distinct tickets of this run');
  expect(guardian === null || (guardian && typeof guardian.agentId === 'string' && count(guardian.harnessEq) && [true, false, null].includes(guardian.finished)),
    'guardian must be a measure-spawn subagent row or null');

  const estimate = record.guardian.estimated, guardianTokens = guardian?.harnessEq ?? null;
  const blocked = [...tickets.filter(entry => entry.budgetGate === 'blocked').map(entry => `ticket-gate-blocked:${entry.ticketId}`),
    guardian?.finished === true && guardianTokens > estimate ? 'guardian-over-estimate' : null].filter(Boolean);
  const unknown = [...planned.filter(id => !settled.includes(id)).map(id => `ticket-unsettled:${id}`),
    ...tickets.filter(entry => entry.budgetGate === 'unknown').map(entry => `ticket-gate-unknown:${entry.ticketId}`),
    guardian === null ? 'guardian-usage-missing' : guardian.finished !== true ? 'guardian-usage-partial' : null].filter(Boolean);
  const ticketTokens = tickets.reduce((total, entry) => total + entry.spentTokens, 0);
  const body = { schemaVersion: 1, stage: 'offline-run-settlement', launchable: false, unit: UNIT, recordDigest: record.digest,
    authorizedTokens: record.tickets.authorized, guardianEstimateTokens: estimate, ticketTokens, guardianTokens, totalTokens: ticketTokens + (guardianTokens ?? 0),
    runGate: blocked.length ? 'blocked' : unknown.length ? 'unknown' : 'clear', reasons: [...blocked, ...unknown],
    tickets: tickets.map(entry => ({ ticketId: entry.ticketId, spentTokens: entry.spentTokens, budgetGate: entry.budgetGate, settlementDigest: entry.digest })),
    unresolved: UNRESOLVED };
  return { ...body, digest: digest(body) };
}
