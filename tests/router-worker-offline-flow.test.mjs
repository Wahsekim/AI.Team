import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { digest, bytesDigest } from '../src/loop/contracts.mjs';
import { gateDigest, gateInvocation, runLocalGate } from '../src/loop/gates.mjs';
import { validateGateRecord } from '../src/loop/evidence.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';
import { observeCandidate, candidateObservation, bindCandidate, bindCheckEvidence, checkDispatchId } from '../src/router-worker/candidate.mjs';
import { createRetryRegistry, openRetryRegistry } from '../src/router-worker/retry-registry.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';

const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 && 'Node 24+ required', timeout: 15000 };
const reference = id => ({ id, digest: digest(id) });
const executableDigest = bytesDigest(readFileSync(process.execPath));
async function fixture(t, passes) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'rw-offline-flow-'))), root = join(temp, 'product');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(join(root, 'checks'));
  writeFileSync(join(root, 'src/config.json'), JSON.stringify({ retry: false, title: 'baseline' }));
  const checker = 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync("../src/config.json","utf8"));console.log(JSON.stringify({retry:value.retry}));process.exit(value.retry===true?0:1);';
  writeFileSync(join(root, 'checks/retry.cjs'), checker);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const baseline = observeCandidate({ root }), observed = candidateObservation(baseline), input = inputFixture();
  input.ticket.title = 'Enable retry configuration'; input.ticket.goal = 'Set the local retry configuration to true';
  input.ticket.acceptance = ['The trusted checker observes retry=true']; input.ticket.acceptanceRef = { id: 'acceptance', digest: digest(input.ticket.acceptance) };
  input.baseline.commit = observed.snapshot.baseCommit; input.baseline.candidateRef = observed.reference;
  input.policy.allowedWritePaths = ['src/config.json']; input.mandate.allowedWritePaths = ['src/config.json']; input.proposal.expectedPaths = ['src/config.json'];
  input.policy.verificationCommands = ['node checks/retry.cjs'];
  const oracle = [{ path: 'checks/retry.cjs', digest: bytesDigest(checker) }];
  const gate = { id: 'retry-config', repoId: 'product', executableRef: { id: 'node', digest: executableDigest }, argv: ['retry.cjs'],
    cwd: { repoId: 'product', relativePath: 'checks' }, envProfileId: 'empty', timeoutMs: 2000, successExitCodes: [0],
    oracleBundleRef: { id: 'oracle', digest: digest(oracle) }, networkPolicyId: 'local-attended-inherit' };
  gate.specDigest = gateDigest(gate);
  const stackRecord = { id: 'fixture-stack', value: { verificationCommands: input.policy.verificationCommands,
    gateBindings: [{ command: input.policy.verificationCommands[0], gateRef: { id: gate.id, digest: gate.specDigest }, invocationDigest: digest(gateInvocation(gate, {})) }] } };
  input.policy.stackRef = { id: stackRecord.id, digest: digest(stackRecord.value) }; input.mandate.policyDigest = digest(input.policy);
  function author() {
    writeFileSync(join(root, 'src/config.json'), JSON.stringify({ retry: passes, title: 'candidate' }));
    const bound = bindCandidate({ input, baseline, candidate: observeCandidate({ root }) }); assert.equal(bound.errors, undefined);
    return bound;
  }
  async function check(bound) {
    const record = await runLocalGate({ gate, repoRoots: { product: root }, executables: { node: process.execPath },
      envProfiles: { empty: {} }, oracleBundles: { oracle }, expectedCandidate: bound.summary.candidateRef.digest,
      runId: 'offline-fixture', taskId: input.ticket.id, dispatchId: checkDispatchId(input.proposal.checkAssignmentId, gate.id) });
    const report = { schemaVersion: 1, assignmentId: input.proposal.checkAssignmentId, ticketId: input.ticket.id, duty: 'check',
      candidateRef: bound.summary.candidateRef.id, outcome: passes ? 'pass' : 'fail',
      commandsRun: [{ command: input.policy.verificationCommands[0], exitCode: record.evidence.exitCode, evidenceRef: 'fixture/check.log' }],
      unexecutedChecks: [], findings: passes ? [] : ['Retry is still disabled'], uncertainties: [], blockers: [], deliveryStatus: 'not-accepted' };
    return { record, report };
  }
  return { temp, root, input, baseline, stackRecord, author, check };
}

for (const passes of [false, true]) test(`offline first-attempt flow uses real local check ${passes ? 'success' : 'failure'}, persists and reopens without author self-acceptance`, sqlite, async t => {
  const f = await fixture(t, passes), rules = loadRetryRules();
  const anchor = createRetryRegistry({ root: join(f.temp, 'registry'), repoId: f.input.baseline.repoId, rules });
  const registry = openRetryRegistry({ anchor, rules }); await registry.register(f.input.ticket.id);
  const ticket = await registry.openTicket(f.input.ticket.id);
  const admission = { sourceRef: reference('fixture-admission-not-live'), gates: Object.fromEntries(
    ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'].map(key => [key, 'clear'])) };
  const append = event => ticket.append({ expectedDigest: ticket.read().journal.digest, event });
  let bound, result;
  for (const duty of ['exec', 'check']) {
    const assignmentId = duty === 'exec' ? f.input.proposal.assignmentId : f.input.proposal.checkAssignmentId;
    append({ eventId: `${duty}-prepare`, type: 'prepare', assignmentId, duty, planRef: reference(`${duty}-plan`),
      candidateRef: duty === 'exec' ? f.input.baseline.candidateRef : bound.summary.candidateRef,
      continuationOf: null, resumeSessionRef: null, divergence: null, admission });
    append({ eventId: `${duty}-start`, type: 'start', assignmentId, sessionRef: reference(`simulated-${duty}-session`), callRef: reference(`fixture-${duty}-call`), admission });
    assert.equal(ticket.read().state.assignments.at(-1).status, 'started');
    if (duty === 'exec') bound = f.author();
    else {
      result = await f.check(bound);
      const evidence = bindCheckEvidence(bound.binding, { report: result.report, stackRecord: f.stackRecord, runId: 'offline-fixture',
        records: [{ command: result.report.commandsRun[0].command, record: result.record }] });
      assert.equal(evidence.errors, undefined); assert.equal(result.record.evidence.result, passes ? 'pass' : 'fail');
      assert.equal(result.record.transcript.exitCode, passes ? 0 : 1);
      assert.equal(evidence.deliveryAuthorized, false); assert.equal(evidence.evidenceStatus, 'consistent-records-origin-unverified');
    }
    append({ eventId: `${duty}-close`, type: 'close', assignmentId,
      outcome: duty === 'exec' ? 'candidate' : result.report.outcome, progress: true, outcomeKey: `${duty}-result`, candidateRef: bound.summary.candidateRef,
      receiptRef: duty === 'exec' ? reference('fixture-author-diff') : validateGateRecord(result.record) });
  }
  const journal = ticket.read().journal; ticket.close();
  const reopened = await openRetryRegistry({ anchor, rules }).openTicket(f.input.ticket.id, { readOnly: true });
  assert.deepEqual(reopened.read().journal, journal); assert.deepEqual(reopened.read().state.started, { exec: 1, check: 1 });
  assert.equal(reopened.read().checkpoint.eventCount, 6); assert.equal(reopened.read().state.deliveryAuthorized, false); reopened.close();
});

test('check evidence rejects a fabricated PASS, wrong run, wrong recipe, missing records and post-check candidate drift', { timeout: 15000 }, async t => {
  const f = await fixture(t, false); f.bound = f.author(); Object.assign(f, await f.check(f.bound));
  const args = { report: f.report, stackRecord: f.stackRecord, runId: 'offline-fixture', records: [{ command: f.report.commandsRun[0].command, record: f.record }] };
  for (const mutate of [
    a => { a.report.outcome = 'pass'; a.report.findings = []; a.report.commandsRun[0].exitCode = 0; },
    a => { a.runId = 'foreign-run'; }, a => { a.records = []; },
    a => { a.stackRecord.value.gateBindings[0].invocationDigest = digest('foreign-invocation'); },
    a => { a.records[0].record.evidence.taskId = 'foreign-ticket'; },
  ]) { const changed = structuredClone(args); mutate(changed); assert.ok(bindCheckEvidence(f.bound.binding, changed).errors); }
  writeFileSync(join(f.root, 'src/config.json'), JSON.stringify({ retry: true }));
  assert.equal(bindCheckEvidence(f.bound.binding, args).errors[0].code, 'STALE_CANDIDATE');
});
