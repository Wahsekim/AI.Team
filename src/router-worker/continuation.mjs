import { canonical, digest, bytesDigest, parseJSON } from '../loop/contracts.mjs';
import { compile } from './compile.mjs';
import { inspectRetryJournal, advanceRetryJournal } from './retries.mjs';

// Rollout gate G-03. A retry is a continuation of the same ticket and duty.
// Attempt number, previous assignment, session and candidate are read from the
// retry journal; the request only supplies the revised plan and why it differs.
const DUTIES = ['exec', 'check'];
const GATES = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const UNRESOLVED = ['real-session-resume', 'session-liveness', 'host-admission-at-prepare-and-start', 'candidate-observation',
  'meaningful-divergence-review', 'usage-and-lifecycle-settlement'];

class Refusal extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const need = (condition, code, reason) => { if (!condition) throw new Refusal(code, reason); };
const same = (a, b) => canonical(a) === canonical(b);
const isRef = value => value && typeof value === 'object' && Object.keys(value).sort().join() === 'digest,id'
  && typeof value.id === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.digest);

function render(firstBrief, facts, divergence) {
  return [
    `Continuation: attempt ${facts.attempt} of ticket ${facts.ticketId}, duty ${facts.duty}. This document is not dispatch authority.`,
    `It continues assignment ${facts.continuationOf} in its original session only. A new session, a lost session or an unknown earlier result means stop and return to PM.`,
    `Work from candidate ${facts.candidateRef.id}. If the checkout is not that candidate, stop.`,
    `What changed since the previous attempt (evidence ${divergence.evidenceRef.id}): ${divergence.reason}`,
    'Everything below is the frozen assignment and applies unchanged.',
    '',
    firstBrief,
  ].join('\n');
}

export function compileContinuation({ input, journal, rules, duty, divergence, methodBundle }) {
  try {
    need(DUTIES.includes(duty), 'INVALID_CONTINUATION', 'Only exec and check calls are ticket retries');
    need(divergence && typeof divergence === 'object' && Object.keys(divergence).sort().join() === 'evidenceRef,reason'
      && typeof divergence.reason === 'string' && divergence.reason.trim() && divergence.reason.length <= 1000
      && !/[\x00-\x1f\x7f]/.test(divergence.reason) && isRef(divergence.evidenceRef), 'INVALID_CONTINUATION',
    'divergence must carry exactly a single-line reason and an evidenceRef; the previous plan is read from the journal');
    const frozen = parseJSON(canonical(input)), preview = compile(frozen, { methodBundle });
    if (preview.errors) return { errors: preview.errors };
    const state = inspectRetryJournal({ journal, rules });
    need(state.ticketId === frozen.ticket.id, 'TICKET_MISMATCH', 'The journal belongs to another ticket');
    need(!state.stops.length, 'RETRY_STOPPED', `The ticket carries a sticky stop (${state.stops.join(', ')}); no automatic continuation`);
    need(!state.assignments.some(a => ['prepared', 'started', 'unknown'].includes(a.status)), 'RETRY_PENDING', 'Earlier work is still pending or unknown');
    const previous = state.assignments.filter(a => a.duty === duty && a.started).at(-1);
    need(previous, 'NOT_A_CONTINUATION', 'This duty never started on this ticket; compile a first attempt');
    // A started assignment always bound a session; a session the host lost arrives as a 'missing-session' stop.
    const sessionRef = state.sessions[duty];
    const held = duty === 'exec' ? previous.candidateRef : state.assignments.filter(a => a.duty === 'exec' && a.status === 'closed').at(-1)?.candidateRef;
    need(held && same(frozen.baseline.candidateRef, held), 'STALE_CANDIDATE', 'The request does not name the candidate the journal holds for this continuation');

    const assignmentId = duty === 'exec' ? frozen.proposal.assignmentId : frozen.proposal.checkAssignmentId;
    const facts = { ticketId: state.ticketId, duty, attempt: state.started[duty] + 1, assignmentId,
      continuationOf: previous.assignmentId, resumeSessionRef: sessionRef, candidateRef: held };
    const renderedBrief = render(preview.renderedBriefs[duty], facts, divergence);
    need(renderedBrief.length <= frozen.policy.maxBriefChars, 'BRIEF_LIMIT_EXCEEDED', 'Continuation brief exceeds policy; re-scope without truncating mandatory rules');
    const planRef = { id: assignmentId, digest: bytesDigest(renderedBrief) };
    const prepareEvent = { type: 'prepare', assignmentId, duty, planRef, candidateRef: held, continuationOf: previous.assignmentId,
      resumeSessionRef: sessionRef, divergence: { previousPlanDigest: previous.planRef.digest, ...divergence } };
    // The journal's own rules (cap, divergence, check-before-repair, used IDs) judge the event. The
    // all-clear admission is a placeholder for this discarded dry run; the host observes the real one.
    advanceRetryJournal({ journal, rules, expectedDigest: journal.digest, event: { eventId: 'continuation-dry-run', ...prepareEvent,
      admission: { sourceRef: { id: 'continuation-dry-run', digest: digest('continuation-dry-run') }, gates: Object.fromEntries(GATES.map(gate => [gate, 'clear'])) } } });

    const body = { schemaVersion: 1, stage: 'offline-continuation', launchable: false, ...facts, planRef,
      journalDigest: journal.digest, previewDigest: preview.manifest.digest, wrapper: frozen.policy.profiles[duty].wrapper,
      dispatch: 'main-session-resume-only', unresolved: UNRESOLVED };
    return { continuation: { ...body, digest: digest(body) }, renderedBrief, prepareEvent };
  } catch (error) {
    if (typeof error?.code === 'string' && error.code !== 'INVALID_SPEC') return { errors: [{ code: error.code, field: 'continuation', reason: error.message }] };
    return { errors: [{ code: 'INVALID_CONTINUATION', field: 'continuation', reason: 'Expected bounded, canonical JSON input, journal and rules' }] };
  }
}
