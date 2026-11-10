import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonical, digest, parseJSON, requireThat, fields, ref, id } from '../loop/contracts.mjs';
import { snapshotRepository, changedPaths } from '../loop/snapshots.mjs';
import { validateGateRecord } from '../loop/evidence.mjs';
import { compile, validateCheckReport } from './compile.mjs';

const observations = new WeakMap();
const bindings = new WeakMap();
const clone = value => parseJSON(canonical(value), 16 * 1024 * 1024);
const within = (path, grants) => grants.some(grant => grant.endsWith('/**') ? path.startsWith(grant.slice(0, -2)) : path === grant);
const fail = error => ({ errors: [{ code: error.code ?? 'INVALID_CANDIDATE', field: 'candidate', reason: error.message }] });

function identity(root) {
  requireThat(typeof root === 'string' && isAbsolute(root) && resolve(root) === root && realpathSync(root) === root,
    'INVALID_CANDIDATE', 'A canonical absolute repository root is required');
  const stat = statSync(root, { bigint: true });
  requireThat(stat.isDirectory(), 'INVALID_CANDIDATE', 'Candidate root must be a directory');
  return { root, dev: String(stat.dev), ino: String(stat.ino) };
}

function observe(root) {
  // These piped inspection commands invoke neither a pager nor an editor. Keep discovery/config overrides denied.
  requireThat(!Object.keys(process.env).some(key => key.startsWith('GIT_') && !['GIT_PAGER', 'GIT_EDITOR'].includes(key)),
    'UNSUPPORTED_ENVIRONMENT', 'Unset ambient GIT_* variables except GIT_PAGER and GIT_EDITOR before candidate observation');
  const target = identity(root);
  const snapshot = snapshotRepository({ root, repoId: 'product' });
  requireThat(canonical(target) === canonical(identity(root))
    && digest(snapshot) === digest(snapshotRepository({ root, repoId: 'product' })),
  'STALE_CANDIDATE', 'Candidate changed while being observed');
  return { target, snapshot, reference: { id: snapshot.id, digest: digest(snapshot) } };
}

export function observeCandidate({ root }) {
  const record = observe(root), token = Object.freeze({ kind: 'local-candidate-observation' });
  observations.set(token, record);
  return token;
}

export function candidateObservation(token) {
  requireThat(observations.has(token), 'UNVERIFIED_CANDIDATE', 'Only a local observation token is accepted');
  return clone(observations.get(token));
}

export function bindCandidate({ input, baseline, candidate, methodBundle }) {
  try {
    const frozen = clone(input), preview = compile(frozen, { methodBundle });
    if (preview.errors) return preview;
    requireThat(observations.has(baseline) && observations.has(candidate), 'UNVERIFIED_CANDIDATE', 'Serialized or worker-reported snapshots are not observation tokens');
    const before = observations.get(baseline), after = observations.get(candidate);
    requireThat(canonical(before.target) === canonical(after.target), 'CANDIDATE_TARGET_MISMATCH', 'Baseline and candidate belong to different local targets');
    requireThat(frozen.baseline.commit === before.snapshot.baseCommit
      && canonical(frozen.baseline.candidateRef) === canonical(before.reference), 'BASELINE_MISMATCH', 'Input baseline is not the observed baseline');
    requireThat(after.snapshot.baseCommit === before.snapshot.baseCommit, 'CANDIDATE_HEAD_CHANGED', 'HEAD changed after baseline observation; PM must review the new baseline');
    const paths = changedPaths(before.snapshot, after.snapshot);
    requireThat(paths.length > 0, 'NO_CANDIDATE_PROGRESS', 'No observable candidate change');
    requireThat(paths.every(path => within(path, frozen.policy.allowedWritePaths) && within(path, frozen.mandate.allowedWritePaths)),
      'SCOPE_NOT_AUTHORIZED', 'Actual candidate changes exceed mandate or policy paths');
    requireThat(!paths.some(path => within(path, frozen.policy.sensitivePaths)),
      'SECURITY_CHECK_REQUIRED', 'Actual candidate changes require an unsupported security check');
    const current = observe(after.target.root);
    requireThat(canonical(current.target) === canonical(after.target) && canonical(current.reference) === canonical(after.reference),
      'STALE_CANDIDATE', 'Candidate changed before binding');
    const body = { schemaVersion: 1, stage: 'candidate-bound-offline', launchable: false, deliveryAuthorized: false,
      inputDigest: digest(frozen), previewDigest: digest(preview), assignmentId: frozen.proposal.assignmentId,
      checkAssignmentId: frozen.proposal.checkAssignmentId, target: after.target,
      baselineRef: before.reference, candidateRef: after.reference, changedPaths: paths,
      unplannedPaths: paths.filter(path => !frozen.proposal.expectedPaths.includes(path)),
      evidenceStatus: 'not-executed', snapshotPolicy: 'tracked-and-nonignored-untracked-working-tree',
      unresolved: ['owner-and-runtime-authority', 'exclusive-target-ownership', 'ignored-files-and-git-metadata-boundary',
        'independent-check-execution', 'session-binding', 'usage-and-ledger-settlement'] };
    const summary = { ...body, digest: digest(body) }, token = Object.freeze({ kind: 'local-candidate-binding' });
    bindings.set(token, { observation: after, summary: clone(summary), input: frozen });
    return { binding: token, summary: clone(summary) };
  } catch (error) { return fail(error); }
}

export function assertCandidateCurrent(token) {
  try {
    requireThat(bindings.has(token), 'UNVERIFIED_CANDIDATE', 'Only a process-local binding token is accepted');
    const { observation, summary } = bindings.get(token), current = observe(observation.target.root);
    requireThat(canonical(current.target) === canonical(observation.target) && canonical(current.reference) === canonical(observation.reference),
      'STALE_CANDIDATE', 'Candidate changed after binding; prior check evidence cannot be reused');
    return { stage: 'candidate-current-offline', launchable: false, deliveryAuthorized: false,
      bindingDigest: summary.digest, candidateRef: clone(observation.reference), evidenceStatus: 'not-executed' };
  } catch (error) { return fail(error); }
}

export function bindCheckReport(token, input) {
  try {
    requireThat(bindings.has(token), 'UNVERIFIED_CANDIDATE', 'Only a process-local binding token is accepted');
    const checked = validateCheckReport(input);
    if (checked.errors) return checked;
    const { report } = checked, bound = bindings.get(token), spec = bound.input;
    requireThat(report.assignmentId === spec.proposal.checkAssignmentId && report.ticketId === spec.ticket.id
      && report.candidateRef === bound.observation.reference.id,
    'REPORT_BINDING_MISMATCH', 'Check report does not identify the bound ticket, check assignment and candidate');
    const commands = report.commandsRun.map(command => command.command), required = spec.policy.verificationCommands;
    requireThat(new Set(commands).size === commands.length && commands.every(command => required.includes(command))
      && report.unexecutedChecks.every(command => required.includes(command) && !commands.includes(command))
      && required.every(command => commands.includes(command) || report.unexecutedChecks.includes(command)),
    'REPORT_COMMAND_MISMATCH', 'Report must account for every required command exactly once as run or unexecuted');
    requireThat(report.commandsRun.every(command => command.exitCode >= 0 && command.exitCode <= 255),
      'INVALID_CHECK_EXIT', 'Exit codes must be in the host process range 0..255');
    const current = assertCandidateCurrent(token);
    if (current.errors) return current;
    return { stage: 'report-bound-offline', launchable: false, deliveryAuthorized: false,
      bindingDigest: bound.summary.digest, reportDigest: digest(report), candidateRef: clone(bound.observation.reference),
      claimedOutcome: report.outcome, evidenceStatus: 'unverified',
      unresolved: ['host-command-transcripts', 'independent-session-identity', 'functional-acceptance', 'usage-and-ledger-settlement'] };
  } catch (error) { return fail(error); }
}

export function checkDispatchId(assignmentId, gateId) {
  id(assignmentId); id(gateId);
  return `rw-check-${digest({ assignmentId, gateId }).slice(7, 39)}`;
}

export function bindCheckEvidence(token, { report, stackRecord, runId, records }) {
  try {
    report = clone(report);
    const boundReport = bindCheckReport(token, report);
    if (boundReport.errors) return boundReport;
    const stack = clone(stackRecord), inputs = clone(records), spec = bindings.get(token).input;
    id(runId); fields(stack, ['id', 'value'], 'Stack record');
    fields(stack.value, ['verificationCommands', 'gateBindings'], 'Host check recipe');
    requireThat(stack.id === spec.policy.stackRef.id && digest(stack.value) === spec.policy.stackRef.digest
      && canonical(stack.value.verificationCommands) === canonical(spec.policy.verificationCommands),
    'STACK_RECIPE_MISMATCH', 'Check recipe differs from the input-bound stack record');
    const gates = stack.value.gateBindings;
    requireThat(Array.isArray(gates) && gates.length === spec.policy.verificationCommands.length, 'STACK_RECIPE_MISMATCH', 'Every required command needs a gate binding');
    const commands = new Set(), gateIds = new Set();
    for (const gate of gates) {
      fields(gate, ['command', 'gateRef', 'invocationDigest'], 'Command gate binding'); ref(gate.gateRef);
      requireThat(spec.policy.verificationCommands.includes(gate.command) && !commands.has(gate.command)
        && !gateIds.has(gate.gateRef.id) && /^sha256:[a-f0-9]{64}$/.test(gate.invocationDigest),
      'STACK_RECIPE_MISMATCH', 'Duplicate or invalid command/gate binding');
      commands.add(gate.command); gateIds.add(gate.gateRef.id);
    }
    requireThat(Array.isArray(inputs) && inputs.length === report.commandsRun.length, 'CHECK_EVIDENCE_MISMATCH', 'Every executed command requires exactly one record');
    const seen = new Set(), receipts = [];
    for (const entry of inputs) {
      fields(entry, ['command', 'record'], 'Check evidence entry');
      const configured = gates.find(gate => gate.command === entry.command), reported = report.commandsRun.find(command => command.command === entry.command);
      requireThat(configured && reported && !seen.has(entry.command), 'CHECK_EVIDENCE_MISMATCH', 'Unknown, missing or duplicate executed command');
      seen.add(entry.command);
      const receipt = validateGateRecord(entry.record), evidence = entry.record.evidence;
      requireThat(evidence.runId === runId && evidence.taskId === spec.ticket.id
        && evidence.dispatchId === checkDispatchId(spec.proposal.checkAssignmentId, configured.gateRef.id)
        && canonical(evidence.candidateSnapshotRef) === canonical(boundReport.candidateRef)
        && canonical(evidence.gateRef) === canonical(configured.gateRef)
        && digest(entry.record.invocation) === configured.invocationDigest
        && evidence.exitCode === reported.exitCode, 'CHECK_EVIDENCE_MISMATCH', 'Record differs from the frozen command, invocation, assignment or candidate');
      requireThat(entry.record.scopeAttestation.unchanged && !entry.record.scopeAttestation.recoveryRequired,
        'CHECK_SCOPE_UNSAFE', 'Check changed its candidate or has unresolved process cleanup');
      requireThat(report.outcome !== 'pass' || evidence.result === 'pass', 'CHECK_EVIDENCE_MISMATCH', 'Passing report contradicts a host gate result');
      receipts.push({ command: entry.command, reference: receipt, result: evidence.result });
    }
    const current = assertCandidateCurrent(token);
    if (current.errors) return current;
    return { ...boundReport, stage: 'check-records-bound-offline', stackRecipeDigest: digest(stack.value), receipts,
      evidenceStatus: 'consistent-records-origin-unverified', launchable: false, deliveryAuthorized: false,
      unresolved: ['trusted-host-record-origin', 'independent-session-identity', 'owner-perspective-acceptance', 'usage-and-ledger-settlement'] };
  } catch (error) { return fail(error); }
}
