import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, bytesDigest, parseJSON, fields, id, ref, requireThat } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DUTIES = ['exec', 'check'];
const GATES = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const STOP_REASONS = [...GATES, 'missing-session', 'unknown-execution', 'operator-stop'];
const copy = value => parseJSON(canonical(value));
const expect = (condition, message, code = 'INVALID_RETRY_TRANSITION') => requireThat(condition, code, message);
const same = (a, b) => canonical(a) === canonical(b);
const reference = value => { ref(value); return value; };
const nonempty = value => expect(typeof value === 'string' && value.trim() && value.length <= 1000
  && !/[\x00-\x1f\x7f]/.test(value), 'Expected bounded single-line explanation');

export function loadRetryRules({ teamRoot = ROOT, instanceRoot } = {}) {
  const root = resolve(teamRoot);
  expect(realpathSync(root) === root, 'Canonical team root required');
  const instance = instanceOf(root, instanceRoot);
  const read = (path, base = root) => {
    let full = base;
    for (const component of path.split('/')) {
      full = join(full, component); expect(!lstatSync(full).isSymbolicLink(), 'Symlink in retry rule source');
    }
    const stat = lstatSync(full); expect(stat.isFile() && stat.size <= 1024 * 1024, 'Invalid retry rule source');
    return readFileSync(full);
  };
  const paths = [instance ? 'charter.md' : 'charter.template.md', 'agents/pm.md', 'decisions/0008-router-worker-topology.md'];
  const sources = Object.fromEntries(paths.map((path, i) => [path, read(path, i === 0 && instance ? instance : root)]));
  const charter = sources[paths[0]].toString('utf8'), pm = sources[paths[1]].toString('utf8'), adr = sources[paths[2]].toString('utf8');
  expect(/Same role may retry the same ticket at most twice unless the owner\s+approves\./.test(charter)
    && /If the last two closes made no progress or repeated the same\s+outcome/.test(charter)
    && /After the 3rd fix→verify round-trip/.test(pm)
    && /^Status: Accepted — topology equivalence and retry mapping only;/m.test(adr),
  'Rule source changed; review retry semantics before adopting it', 'RETRY_RULE_REVIEW_REQUIRED');
  return { schemaVersion: 1, maxRetries: 2, localEmptyCloseLimit: 2, maxFixVerifyRoundTrips: 3,
    sourceDigests: Object.fromEntries(paths.map(path => [path, bytesDigest(sources[path])])) };
}

function validateRules(rules) {
  fields(rules, ['schemaVersion', 'maxRetries', 'localEmptyCloseLimit', 'maxFixVerifyRoundTrips', 'sourceDigests'], 'Retry rules');
  expect(rules.schemaVersion === 1 && rules.maxRetries === 2 && rules.localEmptyCloseLimit === 2
    && rules.maxFixVerifyRoundTrips === 3, 'Unsupported retry rules', 'RETRY_RULE_REVIEW_REQUIRED');
  const charter = rules.sourceDigests && Object.hasOwn(rules.sourceDigests, 'charter.md') ? 'charter.md' : 'charter.template.md';
  fields(rules.sourceDigests, [charter, 'agents/pm.md', 'decisions/0008-router-worker-topology.md'], 'Rule sources');
  Object.values(rules.sourceDigests).forEach(value => expect(/^sha256:[a-f0-9]{64}$/.test(value), 'Invalid rule source digest'));
}

const envelope = body => ({ ...body, digest: digest(body) });
export function createRetryJournal({ ticketId, rules }) {
  id(ticketId); validateRules(rules);
  return envelope({ schemaVersion: 1, ticketId, rulesDigest: digest(rules), events: [] });
}

function initial(ticketId) {
  return { ticketId, assignments: [], started: { exec: 0, check: 0 }, sessions: { exec: null, check: null },
    stops: [], closes: [], fixVerifyRoundTrips: 0, pendingRepair: null };
}
const pending = state => state.assignments.some(a => ['prepared', 'started', 'unknown'].includes(a.status));
function admission(value) {
  fields(value, ['sourceRef', 'gates'], 'Host admission'); reference(value.sourceRef);
  fields(value.gates, GATES, 'Host gates');
  expect(Object.values(value.gates).every(status => ['clear', 'blocked', 'unknown'].includes(status)), 'Invalid host gate status');
}
function validateEvent(event) {
  id(event.eventId);
  const keys = {
    prepare: ['assignmentId', 'duty', 'planRef', 'candidateRef', 'continuationOf', 'resumeSessionRef', 'divergence', 'admission'],
    start: ['assignmentId', 'sessionRef', 'callRef', 'admission'],
    close: ['assignmentId', 'outcome', 'progress', 'outcomeKey', 'candidateRef', 'receiptRef'],
    cancel: ['assignmentId', 'neverStartedRef'], unknown: ['assignmentId', 'reasonRef'],
    stop: ['reason', 'evidenceRef'],
  };
  expect(Object.hasOwn(keys, event.type), 'Unknown retry event');
  fields(event, ['eventId', 'type', ...keys[event.type]], 'Retry event');
  if (event.type === 'stop') {
    expect(STOP_REASONS.includes(event.reason), 'Unknown stop reason'); reference(event.evidenceRef); return;
  }
  id(event.assignmentId);
  if (event.type === 'prepare') {
    expect(DUTIES.includes(event.duty), 'Only exec/check ticket retries are supported');
    reference(event.planRef); reference(event.candidateRef); admission(event.admission);
    if (event.continuationOf !== null) id(event.continuationOf);
    if (event.resumeSessionRef !== null) reference(event.resumeSessionRef);
    if (event.divergence !== null) {
      fields(event.divergence, ['previousPlanDigest', 'reason', 'evidenceRef'], 'Divergence');
      expect(/^sha256:[a-f0-9]{64}$/.test(event.divergence.previousPlanDigest), 'Invalid previous plan digest');
      nonempty(event.divergence.reason); reference(event.divergence.evidenceRef);
    }
  } else if (event.type === 'start') {
    reference(event.sessionRef); reference(event.callRef); admission(event.admission);
  } else if (event.type === 'close') {
    expect(['candidate', 'pass', 'fail', 'blocked'].includes(event.outcome), 'Invalid close outcome');
    expect(typeof event.progress === 'boolean', 'Explicit host-observed progress required'); id(event.outcomeKey);
    if (event.candidateRef !== null) reference(event.candidateRef);
    reference(event.receiptRef);
  } else reference(event[event.type === 'cancel' ? 'neverStartedRef' : 'reasonRef']);
}

function transition(before, event, rules) {
  const state = copy(before);
  const stop = reason => { state.stops = [...new Set([...state.stops, reason])]; };
  validateEvent(event);
  if (event.type === 'stop') { stop(event.reason); return state; }
  if (event.type === 'prepare') {
    expect(!state.stops.length, 'Ticket has a sticky stop; no automatic resume', 'RETRY_STOPPED');
    expect(!pending(state), 'Serial execution already has pending or unknown work', 'RETRY_PENDING');
    expect(!state.assignments.some(a => a.assignmentId === event.assignmentId), 'Assignment ID already used', 'IDEMPOTENCY_CONFLICT');
    const blocked = GATES.filter(gate => event.admission.gates[gate] !== 'clear');
    if (blocked.length) { blocked.forEach(stop); return state; }
    expect(state.started[event.duty] < rules.maxRetries + 1, 'Stable ticket/duty retry cap reached', 'RETRY_LIMIT');
    const previous = state.assignments.filter(a => a.duty === event.duty && a.started).at(-1);
    const lastCheck = state.assignments.filter(a => a.duty === 'check' && a.status === 'closed').at(-1);
    expect(lastCheck?.outcome !== 'pass', 'Passing check claim awaits settlement; further work needs a new reviewed transition', 'RETRY_STOPPED');
    if (previous) {
      expect(previous.status === 'closed' && event.continuationOf === previous.assignmentId
        && same(event.resumeSessionRef, state.sessions[event.duty]), 'Retry must continue the previous duty assignment and session', 'SESSION_CONTINUITY_REQUIRED');
      expect(event.divergence !== null && event.divergence.previousPlanDigest === previous.planRef.digest
        && event.planRef.digest !== previous.planRef.digest, 'Retry needs a revised plan and explicit divergence evidence', 'RETRY_DIVERGENCE_REQUIRED');
    } else expect(event.continuationOf === null && event.resumeSessionRef === null && event.divergence === null,
      'Initial call cannot claim continuation or divergence');
    if (event.duty === 'check') {
      const author = state.assignments.filter(a => a.duty === 'exec' && a.status === 'closed').at(-1);
      expect(author?.outcome === 'candidate' && same(author.candidateRef, event.candidateRef), 'Check must target the latest author candidate', 'CANDIDATE_MISMATCH');
    } else if (previous?.outcome === 'candidate') {
      expect(lastCheck?.outcome === 'fail' && same(lastCheck.candidateRef, previous.candidateRef),
        'A completed author candidate requires independent check failure before automatic repair', 'CHECK_REQUIRED');
    }
    state.assignments.push({ assignmentId: event.assignmentId, duty: event.duty, planRef: event.planRef,
      candidateRef: event.candidateRef, continuationOf: event.continuationOf, resumeSessionRef: event.resumeSessionRef,
      status: 'prepared', started: false, attempt: state.started[event.duty] + 1, sessionRef: null,
      callRef: null, outcome: null, receiptRef: null });
    return state;
  }
  const assignment = state.assignments.find(a => a.assignmentId === event.assignmentId);
  expect(assignment, 'Unknown assignment', 'UNKNOWN_REFERENCE');
  if (event.type === 'start') {
    expect(!state.stops.length, 'Stop arrived before start', 'RETRY_STOPPED');
    expect(assignment.status === 'prepared', 'Only a prepared assignment may start');
    const blocked = GATES.filter(gate => event.admission.gates[gate] !== 'clear');
    if (blocked.length) { blocked.forEach(stop); return state; }
    const own = state.sessions[assignment.duty], other = state.sessions[assignment.duty === 'exec' ? 'check' : 'exec'];
    expect(!own || same(own, event.sessionRef), 'Resumed call must retain the duty session', 'SESSION_CONTINUITY_REQUIRED');
    expect(!other || other.id !== event.sessionRef.id && other.digest !== event.sessionRef.digest,
      'Author and checker cannot share session identity', 'DUTY_NOT_SEPARATED');
    expect(!state.assignments.some(a => a.callRef && (a.callRef.id === event.callRef.id || a.callRef.digest === event.callRef.digest)),
      'Host call already belongs to another assignment', 'IDEMPOTENCY_CONFLICT');
    assignment.started = true; assignment.status = 'started'; assignment.sessionRef = event.sessionRef; assignment.callRef = event.callRef;
    state.sessions[assignment.duty] = event.sessionRef; state.started[assignment.duty]++;
  } else if (event.type === 'cancel') {
    expect(assignment.status === 'prepared', 'Only a proved never-started preparation can be cancelled');
    assignment.status = 'cancelled'; assignment.receiptRef = event.neverStartedRef;
  } else if (event.type === 'unknown') {
    expect(['prepared', 'started'].includes(assignment.status), 'Only pending execution can become unknown');
    if (!assignment.started) { assignment.started = true; state.started[assignment.duty]++; }
    assignment.status = 'unknown'; stop('unknown-execution');
  } else {
    expect(['started', 'unknown'].includes(assignment.status) && assignment.sessionRef !== null,
      'Close requires a bound started session; unresolved pre-start crashes need operator recovery');
    expect(assignment.duty === 'exec' ? event.outcome !== 'pass' : event.outcome !== 'candidate', 'Duty cannot self-accept');
    expect(assignment.duty === 'check' ? same(event.candidateRef, assignment.candidateRef)
      : event.outcome === 'candidate' ? event.candidateRef !== null : event.candidateRef === null, 'Invalid close candidate', 'CANDIDATE_MISMATCH');
    assignment.status = 'closed'; assignment.outcome = event.outcome; assignment.receiptRef = event.receiptRef;
    if (assignment.duty === 'exec' && event.outcome === 'candidate') {
      assignment.candidateRef = event.candidateRef;
      if (state.assignments.some(a => a.duty === 'check' && a.outcome === 'fail')) state.pendingRepair = event.candidateRef;
    }
    if (assignment.duty === 'check' && same(state.pendingRepair, event.candidateRef)) {
      state.fixVerifyRoundTrips++; state.pendingRepair = null;
      if (state.fixVerifyRoundTrips >= rules.maxFixVerifyRoundTrips && event.outcome !== 'pass') stop('round-trip');
    }
    state.closes.push({ assignmentId: assignment.assignmentId, progress: event.progress, outcomeKey: event.outcomeKey });
    const pair = state.closes.slice(-rules.localEmptyCloseLimit);
    if (pair.length === rules.localEmptyCloseLimit && (pair.every(close => !close.progress) || pair.every(close => close.outcomeKey === pair[0].outcomeKey)))
      stop('local-empty-loop');
  }
  return state;
}

function replay(journal, rules) {
  validateRules(rules);
  fields(journal, ['schemaVersion', 'ticketId', 'rulesDigest', 'events', 'digest'], 'Retry journal'); id(journal.ticketId);
  const { digest: expected, ...body } = journal;
  expect(journal.schemaVersion === 1 && expected === digest(body) && journal.rulesDigest === digest(rules), 'Journal or source rules changed', 'RETRY_JOURNAL_MISMATCH');
  expect(Array.isArray(journal.events) && journal.events.length <= 256, 'Journal event limit exceeded');
  let state = initial(journal.ticketId);
  const ids = new Set();
  for (const event of journal.events) {
    expect(!ids.has(event.eventId), 'Duplicate journal event ID', 'IDEMPOTENCY_CONFLICT'); ids.add(event.eventId);
    state = transition(state, event, rules);
  }
  return state;
}
function summary(state, journal) {
  return { ...state, stage: 'offline-retry-accounting', launchable: false, deliveryAuthorized: false,
    journalDigest: journal.digest, retryCounts: Object.fromEntries(DUTIES.map(duty => [duty, Math.max(0, state.started[duty] - 1)])),
    unresolved: ['host-event-authenticity', 'durable-journal', 'exclusive-target-owner', 'real-session-resume',
      'global-gate-observation', 'usage-and-lifecycle-settlement'] };
}
export function inspectRetryJournal({ journal, rules }) {
  return summary(replay(copy(journal), copy(rules)), journal);
}
export function advanceRetryJournal({ journal, rules, expectedDigest, event }) {
  const frozen = copy(journal), policy = copy(rules), next = copy(event);
  const state = replay(frozen, policy); validateEvent(next);
  expect(expectedDigest === frozen.digest, 'Caller holds a stale journal version', 'STALE_RETRY_JOURNAL');
  const previous = frozen.events.find(value => value.eventId === next.eventId);
  if (previous) {
    expect(same(previous, next), 'Event ID reused with different content', 'IDEMPOTENCY_CONFLICT');
    return { journal: frozen, state: summary(state, frozen), applied: false };
  }
  expect(frozen.events.length < 256, 'Journal event limit exceeded');
  const after = transition(state, next, policy);
  const updated = envelope({ schemaVersion: frozen.schemaVersion, ticketId: frozen.ticketId,
    rulesDigest: frozen.rulesDigest, events: [...frozen.events, next] });
  return { journal: updated, state: summary(after, updated), applied: true };
}
