import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { canonical, digest, bytesDigest, parseJSON } from '../loop/contracts.mjs';
import { runWorkflow } from '../../scripts/lib/workflow-harness.mjs';
import { compile } from './compile.mjs';

// Rollout gate G-05. Builds the complete arguments of the existing count engine
// from compiled previews and the roster, so count, Q5 ceiling, failure policy
// and Guardian are frozen facts of the run and not values a caller may omit.
const DUTIES = ['exec', 'check', 'guard'];
const RUN_FIELDS = ['rounds', 'date', 'nextLifecycleNumber', 'runId', 'budgetCeilingTokens'];
const ENGINE = '.claude/workflows/run-n-rounds.js';
const ROSTER = 'agents/roster.md';
const WRAPPER = /^\.claude\/agents\/([A-Za-z0-9._-]+)\.md$/;
const UNRESOLVED = ['in-run-owner-stop-observation', 'guardian-runtime-prompt', 'runtime-isolation-and-lease-at-launch',
  'retry-continuation', 'real-usage-settlement', 'live-registry-and-session-freshness'];

class Refusal extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const need = (condition, code, reason) => { if (!condition) throw new Refusal(code, reason); };
const positive = value => Number.isSafeInteger(value) && value >= 1;
const sum = values => values.reduce((total, n) => total + n, 0);
const readRegular = (root, path) => {
  need(lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile(), 'INVALID_RUN', `${path} is missing from the team root`);
  return readFileSync(join(root, path));
};

function staffedWrappers(rosterText) {
  const rows = rosterText.split('\n').filter(line => line.startsWith('|')).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(cells => cells.length === 6 && cells[5] === 'active' && WRAPPER.test(cells[2]));
  return Object.fromEntries(rows.map(cells => [cells[0], WRAPPER.exec(cells[2])[1]]));
}

function validateRun(run, count) {
  need(run && typeof run === 'object' && !Array.isArray(run)
    && Object.keys(run).every(key => RUN_FIELDS.includes(key) || key === 'launchManifestDigest')
    && RUN_FIELDS.every(key => key in run), 'INVALID_RUN',
  `run must carry exactly ${RUN_FIELDS.join(', ')} and optionally launchManifestDigest`);
  need(positive(run.rounds) && positive(run.nextLifecycleNumber) && positive(run.budgetCeilingTokens)
    && typeof run.date === 'string' && typeof run.runId === 'string', 'INVALID_RUN', 'run fields have the wrong type');
  need(run.rounds === count, 'COUNT_MISMATCH', `the owner count ${run.rounds} must equal the ${count} frozen ticket(s); re-freeze a shorter or longer board`);
}

export async function freezeRun({ inputs, run, teamRoot }) {
  try {
    need(typeof teamRoot === 'string' && isAbsolute(teamRoot) && resolve(teamRoot) === teamRoot
      && lstatSync(teamRoot, { throwIfNoEntry: false })?.isDirectory() && realpathSync(teamRoot) === teamRoot, 'INVALID_RUN', 'A canonical team root is required');
    need(Array.isArray(inputs) && inputs.length >= 1 && inputs.length <= 300, 'INVALID_RUN', 'inputs must list 1 to 300 compiler inputs');
    const frozen = inputs.map(input => parseJSON(canonical(input))), previews = frozen.map(input => compile(input));
    const failed = previews.find(preview => preview.errors);
    if (failed) return { errors: failed.errors };
    validateRun(run, frozen.length);
    const tickets = frozen.map(input => input.ticket.id);
    need(new Set(tickets).size === tickets.length, 'DUPLICATE_TICKET', 'A ticket appears twice in one run');
    const policy = frozen[0].policy, policyDigest = digest(policy);
    need(frozen.every(input => digest(input.policy) === policyDigest), 'POLICY_MISMATCH', 'Every ticket of one run must carry the same policy');

    const roster = readRegular(teamRoot, ROSTER), staffed = staffedWrappers(roster.toString('utf8'));
    for (const duty of DUTIES) need(staffed[`worker-${duty}`] === policy.profiles[duty].wrapper, 'DUTY_NOT_STAFFED',
      `The roster has no active worker-${duty} row staffed by the policy wrapper`);

    const estimated = sum(frozen.map(input => input.proposal.estimate.execTokens + input.proposal.estimate.checkTokens));
    const authorized = sum(frozen.map(input => input.mandate.budgetTokens));
    // The engine stops dispatching once spend reaches 80% of the ceiling.
    need(5 * estimated < 4 * run.budgetCeilingTokens, 'BUDGET_BELOW_ESTIMATE',
      'The summed execution and check estimates reach the 80% line at which the engine stops; the run could not finish on estimate');
    need(run.budgetCeilingTokens <= authorized, 'BUDGET_EXCEEDED', 'The ceiling exceeds the summed ticket authorizations');

    const args = { rounds: run.rounds, date: run.date, nextLifecycleNumber: run.nextLifecycleNumber, runId: run.runId,
      executionMode: 'wrappers', failurePolicy: 'halt-on-failure', budgetCeilingTokens: run.budgetCeilingTokens,
      ...(run.launchManifestDigest === undefined ? {} : { launchManifestDigest: run.launchManifestDigest }),
      guardianAgentType: policy.profiles.guard.wrapper, allowedAgentTypes: Object.values(staffed).sort(),
      plan: previews.map(preview => preview.enginePlanItem) };
    const engine = readRegular(teamRoot, ENGINE);
    // The real validator judges the arguments; the aborting agent keeps the dry run at zero dispatch.
    const dry = await runWorkflow({ scriptPath: join(teamRoot, ENGINE), args: parseJSON(canonical(args)),
      agentImpl: () => { throw Error('freeze-abort: no dispatch while freezing') } });
    need(dry.result?.errorCode !== 'invalid-args', 'ENGINE_REJECTED',
      `The engine validator rejected the arguments: ${(dry.result?.validationErrors ?? []).join('; ').slice(0, 600)}`);

    const body = { schemaVersion: 1, stage: 'run-args-frozen-offline', launchable: false, argsDigest: digest(args),
      engineDigest: bytesDigest(engine), rosterDigest: bytesDigest(roster), policyDigest,
      items: frozen.map((input, i) => ({ ticket: tickets[i], inputDigest: digest(input), previewDigest: previews[i].manifest.digest })),
      budget: { ceiling: run.budgetCeilingTokens, stopLine: Math.floor(run.budgetCeilingTokens * 4 / 5), estimated, authorized }, unresolved: UNRESOLVED };
    return { args, record: { ...body, digest: digest(body) } };
  } catch (error) {
    if (error instanceof Refusal) return { errors: [{ code: error.code, field: 'run', reason: error.message }] };
    return { errors: [{ code: 'INVALID_RUN', field: 'run', reason: 'Expected bounded, canonical JSON inputs' }] };
  }
}

function blockersOf(result) {
  const specific = [
    result.guardian.status !== 'ok' ? 'guardian-unavailable' : result.guardian.verdict !== 'clean' ? 'guardian-not-clean' : null,
    result.budgetGateTripped ? 'budget-gate' : null,
    result.fixRetestQueue.length ? 'fix-retest-pending' : null,
    result.recoveryQueue.length ? 'recovery-pending' : null,
    result.runIncomplete ? 'run-incomplete' : null,
    result.haltRequiresAcknowledgement ? 'halt-requires-acknowledgement' : null,
  ].filter(Boolean);
  return specific.length || result.safeToContinue === true ? specific : ['not-safe-to-continue'];
}

// Every call of an engine return is matched to the frozen arguments. 'accounted'
// says the return is consistent with them; it says nothing about quality:
// read `blockers` for that.
export function accountRun({ args, record, result }) {
  const findings = [], check = (condition, code) => { if (!condition) findings.push(code); };
  try {
    const { digest: recorded, ...body } = record;
    check(recorded === digest(body) && record.argsDigest === digest(args), 'ARGS_NOT_THE_FROZEN_ARGS');
    check(result.runId === args.runId && result.rounds === args.rounds && result.executionMode === 'wrappers'
      && result.failurePolicy === 'halt-on-failure' && (result.launchManifestDigest ?? null) === (args.launchManifestDigest ?? null), 'RUN_IDENTITY_MISMATCH');
    const results = result.results;
    check(Array.isArray(results) && results.length <= args.plan.length && result.dispatchedCount === results.length, 'DISPATCH_COUNT_MISMATCH');
    check(results.every((r, i) => r.iter === i + 1 && r.ticket === args.plan[i]?.ticket && r.agentType === args.plan[i]?.agentType), 'CALL_NOT_IN_PLAN');
    check(typeof result.guardian?.status === 'string', 'GUARDIAN_RECORD_MISSING');
    const todo = result.mainSessionTodo;
    check(todo.lifecycleEntries.length === results.length + 2
      && todo.nextLifecycleNumberAfter === args.nextLifecycleNumber + results.length + 1, 'LIFECYCLE_COUNT_MISMATCH');
    if (findings.length) return { status: 'unaccounted', findings };
    return { status: 'accounted', findings,
      calls: { exec: results.length, check: results.filter(r => r.estimates.verifier !== null).length, guard: 1 },
      nextLifecycleNumberAfter: todo.nextLifecycleNumberAfter,
      blockers: blockersOf(result) };
  } catch { return { status: 'unaccounted', findings: [...findings, 'RETURN_UNREADABLE'] }; }
}
