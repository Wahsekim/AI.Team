import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, validateCheckReport } from '../src/router-worker/compile.mjs';
import { canonical, digest, bytesDigest } from '../src/loop/contracts.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { inputFixture, failedCheckReport } from './fixtures/router-worker/input.mjs';

const engine = fileURLToPath(new URL('../.claude/workflows/run-n-rounds.js', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/compile-router-worker.mjs', import.meta.url));
const rebindPolicy = input => { input.mandate.policyDigest = digest(input.policy); return input; };

test('F1: deterministic detached preview, bounded cross-layer task, existing engine fields', () => {
  const input = inputFixture(), before = canonical(input);
  const output = compile(input);
  assert.equal(canonical(input), before);
  assert.deepEqual(output, compile(JSON.parse(before)));
  assert.equal(output.manifest.launchable, false);
  assert.equal(output.manifest.stage, 'offline-preview');
  assert.deepEqual(Object.keys(output.enginePlanItem).sort(), ['ticket', 'title', 'agentType', 'verifierAgentType',
    'brief', 'verifierBrief', 'isCodeShipping', 'deliveryRequired', 'estimatedTokens', 'verifierEstimatedTokens'].sort());
  assert.equal(output.enginePlanItem.agentType, 'sample-worker-exec');
  assert.equal(output.enginePlanItem.verifierAgentType, 'sample-worker-check');
  assert.equal(output.enginePlanItem.title, 'Retry failed tag-list loading');
  assert.deepEqual(output.assignment.expectedPaths, ['src/tag-list/view.ts', 'src/api/tags.ts', 'tests/tag-list/retry.test.ts']);
  assert.deepEqual(output.assignment.skills, []);
  for (const duty of ['exec', 'check']) {
    const brief = output.renderedBriefs[duty];
    assert.match(brief, /No commits, pushes, deployment, delegation/);
    const data = JSON.parse(brief.trim().split('\n').at(-1));
    assert.deepEqual(data.ticket.acceptance, input.ticket.acceptance);
    assert.deepEqual(data.verificationCommands, ['npm run test:tag-list', 'npm run test:e2e:tag-list']);
    assert.deepEqual(data.stopConditions, input.mandate.stopConditions);
    assert.equal(output.manifest.briefDigests[duty], bytesDigest(brief));
  }
  const { digest: hash, ...body } = output.manifest;
  assert.equal(hash, digest(body));
  output.assignment.expectedPaths.push('other');
  assert.equal(canonical(input), before, 'caller state must not alias output');
});

test('canonical key order and all material inputs bind the preview', () => {
  const input = inputFixture(), initial = compile(input);
  assert.deepEqual(compile(Object.fromEntries(Object.entries(input).reverse())), initial);
  for (const mutate of [x => { x.ticket.title = 'Another title'; }, x => { x.proposal.selectionReason = 'Another reason'; },
    x => { x.baseline.commit = 'a'.repeat(40); }, x => { x.policy.runtimeRef.digest = digest('changed runtime'); rebindPolicy(x); }]) {
    const changed = inputFixture(); mutate(changed);
    assert.notEqual(compile(changed).manifest.digest, initial.manifest.digest);
  }
});

const failures = [
  ['unknown fields', x => { x.proposal.override = true; }, 'INVALID_INPUT'],
  ['unknown mode', x => { x.policy.mode = 'worker'; }, 'INVALID_INPUT'],
  ['same writer/check wrapper', x => { x.policy.profiles.check.wrapper = x.policy.profiles.exec.wrapper; }, 'DUTY_NOT_SEPARATED'],
  ['same guard wrapper', x => { x.policy.profiles.guard.wrapper = x.policy.profiles.exec.wrapper; }, 'DUTY_NOT_SEPARATED'],
  ['generic wrapper', x => { x.policy.profiles.exec.wrapper = 'general-purpose'; }, 'INVALID_INPUT'],
  ['missing verifier', x => { delete x.policy.profiles.check; }, 'INVALID_INPUT'],
  ['acceptance tampering', x => { x.ticket.acceptance.push('Weakened acceptance'); }, 'DIGEST_MISMATCH'],
  ['policy tampering', x => { x.policy.maxBriefChars--; }, 'DIGEST_MISMATCH'],
  ['missing authorization', x => { delete x.mandate.approvalRef; }, 'INVALID_INPUT'],
  ['wrong ticket', x => { x.mandate.ticketId = 'US-09'; }, 'INVALID_INPUT'],
  ['wrong repository', x => { x.mandate.repoId = 'other'; }, 'INVALID_INPUT'],
  ['F2 outside write scope', x => { x.proposal.expectedPaths.push('src/auth/session.ts'); }, 'SCOPE_NOT_AUTHORIZED'],
  ['prefix collision', x => { x.proposal.expectedPaths = ['src/tag-list-other/view.ts']; }, 'SCOPE_NOT_AUTHORIZED'],
  ['narrower task mandate', x => { x.mandate.allowedWritePaths = ['tests/tag-list/**']; }, 'SCOPE_NOT_AUTHORIZED'],
  ['tool escalation', x => { x.proposal.requestedTools.push('Agent'); }, 'TOOLS_NOT_AUTHORIZED'],
  ['narrower task tools', x => { x.mandate.allowedTools = ['Read']; }, 'TOOLS_NOT_AUTHORIZED'],
  ['unapproved method', x => { x.proposal.methodIds = ['diagnosing-bugs']; }, 'METHOD_NOT_ALLOWED'],
  ['unsupported catalog', x => { x.catalog.methods = [{ id: 'debug' }]; }, 'UNSUPPORTED_CAPABILITY'],
  ['retry unsupported', x => { x.proposal.attempt = 2; }, 'UNSUPPORTED_CAPABILITY'],
  ['resume unsupported', x => { x.proposal.sessionRef = 'old-session'; }, 'UNSUPPORTED_CAPABILITY'],
  ['duplicate assignment ID', x => { x.proposal.checkAssignmentId = x.proposal.assignmentId; }, 'INVALID_INPUT'],
  ['delivery unsupported', x => { x.ticket.deliveryRequired = true; }, 'UNSUPPORTED_CAPABILITY'],
  ['risk declaration', x => { x.ticket.riskFlags = ['auth']; }, 'SECURITY_CHECK_REQUIRED'],
  ['sensitive in-scope path', x => { x.policy.sensitivePaths.push('src/api/tags.ts'); rebindPolicy(x); }, 'SECURITY_CHECK_REQUIRED'],
  ['budget over policy', x => { x.mandate.budgetTokens++; }, 'BUDGET_EXCEEDED'],
  ['budget below total', x => { x.mandate.budgetTokens--; }, 'BUDGET_EXCEEDED'],
  ['altered estimate', x => { x.proposal.estimate.execTokens++; }, 'DIGEST_MISMATCH'],
  ['brief too large', x => { x.policy.maxBriefChars = 20; rebindPolicy(x); }, 'BRIEF_LIMIT_EXCEEDED'],
  ['engine character ceiling', x => { x.policy.maxBriefChars = 200001; }, 'INVALID_INPUT'],
  ['wrong budget unit', x => { x.policy.budgetUnit = 'USD'; }, 'INVALID_INPUT'],
  ['multiline command', x => { x.policy.verificationCommands = ['test\nother-command']; }, 'INVALID_INPUT'],
];
for (const [name, mutate, code] of failures) test(`rejects ${name} with no partial artifacts`, () => {
  const input = inputFixture(); mutate(input);
  const output = compile(input);
  assert.deepEqual(Object.keys(output), ['errors']);
  assert.equal(output.errors[0].code, code);
});

for (const unsafe of ['../secret', '/tmp/secret', 'src/../secret', 'src//file', 'src\\file', 'src/*', 'src/file\n', 'src/ file'])
  test(`rejects nonliteral path ${JSON.stringify(unsafe)}`, () => {
    const input = inputFixture(); input.proposal.expectedPaths = [unsafe];
    assert.equal(compile(input).errors[0].code, 'INVALID_INPUT');
  });

test('rejects malformed JSON values without crashing or producing partial artifacts', () => {
  const circular = {}; circular.self = circular;
  for (const input of [null, [], undefined, circular, { n: NaN }, { n: 1n }, { text: 'x'.repeat(1024 * 1024) }])
    assert.deepEqual(Object.keys(compile(input)), ['errors']);
});

test('preview plan remains compatible with the real legacy engine under a mock host', async () => {
  const input = inputFixture(), output = compile(input);
  const { result, calls } = await runWorkflow({ scriptPath: engine, args: {
    rounds: 1, date: '2026-11-08', nextLifecycleNumber: 1, executionMode: 'wrappers', budgetCeilingTokens: 24000,
    guardianAgentType: input.policy.profiles.guard.wrapper,
    allowedAgentTypes: ['sample-worker-exec', 'sample-worker-check', 'sample-worker-guard'], plan: [output.enginePlanItem],
  }, agentImpl: makeAgentImpl({}) });
  assert.equal(result.allPassed, true);
  assert.deepEqual(calls.map(c => c.opts.agentType), ['sample-worker-exec', 'sample-worker-check', 'sample-worker-guard']);
  assert.equal(output.manifest.launchable, false, 'mock acceptance cannot promote deployment status');
});

test('F3: valid FAIL remains unverified and cannot authorize delivery', () => {
  const result = validateCheckReport(failedCheckReport);
  assert.deepEqual(result.report, failedCheckReport);
  assert.equal(result.deliveryAuthorized, false);
  assert.equal(result.evidenceStatus, 'unverified');
  assert.deepEqual(Object.keys(validateCheckReport({ ...failedCheckReport, outcome: 'pass' })), ['errors']);
});

test('even a consistent PASS is only a claim until the host binds candidate and evidence', () => {
  const report = { ...failedCheckReport, outcome: 'pass', findings: [], uncertainties: [], unexecutedChecks: [],
    commandsRun: [{ ...failedCheckReport.commandsRun[0], exitCode: 0 }] };
  assert.equal(validateCheckReport(report).deliveryAuthorized, false);
  for (const mutate of [r => { r.commandsRun = []; }, r => { r.deliveryStatus = 'accepted'; },
    r => { r.commandsRun[0].evidenceRef = '../other-candidate/log'; }, r => { r.extra = 'authorize'; }]) {
    const changed = structuredClone(report); mutate(changed);
    assert.deepEqual(Object.keys(validateCheckReport(changed)), ['errors']);
  }
});

test('CLI reads one input, writes no files, and emits no partial stdout on errors', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'rw-preview-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'input.json'), input = JSON.stringify(inputFixture());
  writeFileSync(file, input);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
  const ok = run(file);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), compile(inputFixture()));
  assert.deepEqual(readdirSync(cwd), ['input.json']); assert.equal(readFileSync(file, 'utf8'), input);
  for (const bad of ['{"schemaVersion":1,"schemaVersion":2}', '{', JSON.stringify({ ...inputFixture(), catalog: null })]) {
    writeFileSync(file, bad);
    const result = run(file);
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(JSON.parse(result.stderr).errors);
  }
  assert.equal(run().status, 1);
  assert.equal(run(file, '--run').status, 1);
  assert.equal(run(cwd).status, 2);
});
