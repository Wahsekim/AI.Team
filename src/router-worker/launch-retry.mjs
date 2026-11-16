import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { compileContinuation } from './continuation.mjs';
import { advanceRetryJournal, inspectRetryJournal } from './retries.mjs';
import { acquireLease, releaseLease } from './lease.mjs';
import { observeIsolation } from './isolation.mjs';
import { readBoundary } from './write-boundary.mjs';
import { LAUNCH_FILE, CLOSE_FILE } from './launch.mjs';
import { SETTLE_FILE } from './launch-settle.mjs';
import { settleAgainstJournal } from './settlement.mjs';

// Launch host, retry: after a failed check the exec call may be continued in its original
// session. This prepares that continuation; the PM session of the copy sends it.
const GATES = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const RETRY_FILE = /^rw-retry-(\d+)\.json$/;
const UNRESOLVED = ['resume-of-workflow-started-agent', 'retry-close-and-settlement', 'check-continuation', 'in-run-admission', 'unobserved-admission-gates'];
// The gates this command observes itself. The others are recorded clear without an observation; the record says so.
const OBSERVED = ['budget', 'runtime-isolation'];
const refuse = reason => ({ errors: [{ code: 'LAUNCH_REFUSED', field: 'retry', reason }] });
const intact = (teamRoot, file, stage) => {
  try {
    const record = JSON.parse(readFileSync(join(teamRoot, file), 'utf8')), { digest: recorded, ...body } = record;
    return recorded === digest(body) && record.stage === stage ? record : null;
  } catch { return null; }
};

export function prepareRetry({ teamRoot, request, rules, methodBundle }) {
  if (typeof teamRoot !== 'string' || !request || typeof request !== 'object') return refuse('The team root and a retry request are required');
  const launch = intact(teamRoot, LAUNCH_FILE, 'launch-prepared'), close = intact(teamRoot, CLOSE_FILE, 'launch-closed'), settlement = intact(teamRoot, SETTLE_FILE, 'launch-settled');
  if (!launch || !close || !settlement || close.launchDigest !== launch.digest || settlement.closeDigest !== close.digest)
    return refuse('A retry needs a launch of this copy that was closed and settled');
  const retries = readdirSync(teamRoot).filter(name => RETRY_FILE.test(name));
  // Closing a retry is not built yet, so a copy carries at most one prepared retry.
  if (retries.length) return refuse('This copy already carries a prepared retry');
  const kept = settlement.ticketRecords?.find(entry => entry.ticketId === request.input?.ticket?.id);
  if (!kept) return refuse('The request names no ticket this launch dispatched');

  // Budget admission comes from what the ticket already spent, never from the request: the kept ledger, the kept
  // journal and the estimate of the call to come. A stop the settlement observed is not cleared by asking again.
  const budgetRefusal = reason => ({ errors: [{ code: 'RETRY_BUDGET_REFUSED', field: 'budget', reason }] });
  if (request.input.mandate?.budgetTokens !== kept.ledger?.authorizedTokens)
    return budgetRefusal(`A retry spends against the authorization the ticket was settled with (${kept.ledger?.authorizedTokens}); a revised authorization needs its own owner decision and is not accepted here`);
  const nextEstimateTokens = request.input.proposal?.estimate?.reworkTokens;
  if (!Number.isSafeInteger(nextEstimateTokens) || nextEstimateTokens < 1) return budgetRefusal('The request carries no rework estimate for the retry');
  let budget;
  try { budget = settleAgainstJournal({ ledger: kept.ledger, retryJournal: kept.journal, rules, nextEstimateTokens }); }
  catch (error) { return budgetRefusal(`The kept ledger and journal of the ticket cannot be settled: ${error?.code ?? 'unreadable'}`); }
  if (budget.budgetGate !== 'clear') return budgetRefusal(`The budget gate of the ticket is ${budget.budgetGate}: ${budget.reasons.join(', ')}`);

  const compiled = compileContinuation({ input: request.input, journal: kept.journal, rules, duty: 'exec', divergence: request.divergence, ...(methodBundle ? { methodBundle } : {}) });
  if (compiled.errors) return compiled;
  // The boundary was armed for the run; a retry may not write where the run could not.
  const armed = readBoundary(teamRoot)?.wrappers?.[compiled.continuation.wrapper]?.writePaths ?? [];
  if (!request.input.mandate.allowedWritePaths.every(path => armed.includes(path))) return refuse('The revised mandate names write paths outside the armed write boundary of this run');

  const acquired = acquireLease({ teamRoot, productRoot: launch.productRoot });
  if (acquired.errors) return acquired;
  const lease = acquired.lease.digest;
  let prepared = false;
  try {
    const isolation = observeIsolation({ teamRoot, productRoot: launch.productRoot, lease, retryOf: close.digest });
    if (isolation.errors) return isolation;
    if (isolation.status !== 'clear')
      return refuse(`The runtime-isolation gate is ${isolation.status}: ${isolation.findings.filter(f => f.severity !== 'accepted').map(f => f.code).join(', ')}`);
    const admission = { sourceRef: { id: 'rw-isolation', digest: isolation.digest }, gates: Object.fromEntries(GATES.map(gate => [gate, 'clear'])) };
    const journal = advanceRetryJournal({ journal: kept.journal, rules, expectedDigest: kept.journal.digest, event: { eventId: `retry-1-prepare`, ...compiled.prepareEvent, admission } }).journal;
    const { continuation } = compiled, session = inspectRetryJournal({ journal: kept.journal, rules }).sessions.exec;
    const body = { schemaVersion: 1, stage: 'retry-prepared', runId: launch.runId, ticket: continuation.ticketId, duty: 'exec', attempt: continuation.attempt,
      assignmentId: continuation.assignmentId, continuationOf: continuation.continuationOf, wrapper: continuation.wrapper,
      resumeAgentId: session.id.replace(/^agent-/, ''), lease, isolationDigest: isolation.digest, closeDigest: close.digest, settlementDigest: settlement.digest,
      budget: { unit: budget.unit, authorizedTokens: budget.authorizedTokens, spentTokens: budget.spentTokens, remainingTokens: budget.remainingTokens, nextEstimateTokens, gate: budget.budgetGate },
      admissionObserved: OBSERVED, continuationDigest: continuation.digest, renderedBrief: compiled.renderedBrief, journal, unresolved: UNRESOLVED };
    const record = { ...body, digest: digest(body) };
    try { writeFileSync(join(teamRoot, 'rw-retry-1.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { return refuse(`The retry record could not be written: ${error.code ?? 'unknown error'}`); }
    prepared = true;
    return record;
  } finally { if (!prepared) releaseLease({ productRoot: launch.productRoot, lease }); }
}
