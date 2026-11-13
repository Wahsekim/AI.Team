// Rollout gate G-05: the complete run arguments of the count engine are frozen
// from compiled previews and the roster, and the engine's own stops (Q5 budget
// gate, Guardian, worker stop, idempotent reconciliation) hold for those arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { freezeRun, accountRun } from '../src/router-worker/run-args.mjs';
import { compile } from '../src/router-worker/compile.mjs';
import { digest } from '../src/loop/contracts.mjs';
import { runWorkflow, makeAgentImpl, makeBudget } from '../scripts/lib/workflow-harness.mjs';
import { loadMethods, methodCatalog } from '../src/router-worker/methods.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';

const ENGINE = fileURLToPath(new URL('../.claude/workflows/run-n-rounds.js', import.meta.url));
const RECONCILE = fileURLToPath(new URL('../scripts/reconcile-run.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/freeze-run-router-worker.mjs', import.meta.url));
const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const rosterText = (rows = {}) => ['| Role id | Role file | Wrapper file | Model | Reasoning | Status |', '|---|---|---|---|---|---|',
  '| pm | agents/pm.md | main session | inherits | owner | active |',
  ...['exec', 'check', 'guard'].map(d => rows[d] ?? `| worker-${d} | agents/worker-${d}.md | .claude/agents/sample-worker-${d}.md | m | high | active |`),
  '| auditor | agents/auditor.md | .claude/agents/sample-auditor.md | m | high | active |',
  '| coach | agents/coach.md | — (pending governance staffing) | owner-selected | owner-selected | dormant |'].join('\n') + '\n';

function fixture(t, rows) {
  const team = realpathSync(mkdtempSync(join(tmpdir(), 'rw-run-args-')));
  t.after(() => rmSync(team, { recursive: true, force: true }));
  write(team, 'agents/roster.md', rosterText(rows));
  mkdirSync(join(team, '.claude/workflows'), { recursive: true });
  copyFileSync(ENGINE, join(team, '.claude/workflows/run-n-rounds.js'));
  return team;
}
function second() {
  const input = inputFixture();
  input.ticket.id = 'US-09'; input.ticket.title = 'Empty tag-list state'; input.mandate.ticketId = 'US-09';
  input.proposal.assignmentId = 'US-09.exec.1'; input.proposal.checkAssignmentId = 'US-09.check.1';
  return input;
}
const RUN = { rounds: 2, date: '2026-11-12', nextLifecycleNumber: 2, runId: 'rw-run-001', budgetCeilingTokens: 46800, estimatedOutputTokens: 36000 };
const freeze = (team, overrides = {}, inputs = [inputFixture(), second()]) => freezeRun({ inputs, run: { ...RUN, ...overrides }, teamRoot: team });
const engine = (team, args, extra = {}) => runWorkflow({ scriptPath: join(team, '.claude/workflows/run-n-rounds.js'), args, agentImpl: makeAgentImpl({}), ...extra });
const types = calls => calls.map(call => call.opts.agentType);

test('freezes the complete engine arguments from previews and the roster; the real engine accepts them', async t => {
  const team = fixture(t), frozen = await freeze(team);
  assert.equal(frozen.errors, undefined, JSON.stringify(frozen.errors));
  const { args, record } = frozen;
  assert.deepEqual(Object.keys(args).sort(), ['allowedAgentTypes', 'budgetCeilingTokens', 'date', 'executionMode', 'failurePolicy',
    'guardianAgentType', 'nextLifecycleNumber', 'plan', 'rounds', 'runId']);
  assert.equal(args.executionMode, 'wrappers'); assert.equal(args.failurePolicy, 'halt-on-failure');
  assert.equal(args.guardianAgentType, 'sample-worker-guard', 'the Guardian comes from the frozen policy, not from the caller');
  assert.deepEqual(args.allowedAgentTypes, ['sample-auditor', 'sample-worker-check', 'sample-worker-exec', 'sample-worker-guard'], 'active roster wrappers only');
  assert.deepEqual(args.plan, [compile(inputFixture()).enginePlanItem, compile(second()).enginePlanItem]);
  assert.equal(record.launchable, false); assert.equal(record.stage, 'run-args-frozen-offline');
  assert.equal(record.argsDigest, digest(args));
  assert.deepEqual(record.items.map(item => item.ticket), ['US-08', 'US-09']);
  assert.deepEqual(record.budget, { unit: 'output', ceiling: 46800, stopLine: 37440, estimatedOutput: 36000 }, 'the engine gate is metered in output tokens');
  assert.deepEqual(record.tickets, { unit: 'input+cache_creation', estimated: 36000, authorized: 48000 }, 'ticket estimates and authorizations stay in the ledger unit and are not compared with the ceiling');
  assert.ok(record.unresolved.includes('in-run-owner-stop-observation'), 'the engine cannot observe an owner stop mid-run');
  const { digest: recorded, ...body } = record;
  assert.equal(recorded, digest(body));
  assert.deepEqual(await freeze(team), frozen, 'deterministic');
  const { result, calls } = await engine(team, args);
  assert.equal(result.allPassed, true);
  assert.deepEqual(types(calls), ['sample-worker-exec', 'sample-worker-check', 'sample-worker-exec', 'sample-worker-check', 'sample-worker-guard']);
  const account = accountRun({ args, record, result });
  assert.equal(account.status, 'accounted', JSON.stringify(account.findings));
  assert.deepEqual(account.calls, { exec: 2, check: 2, guard: 1 });
  assert.equal(account.nextLifecycleNumberAfter, 5); assert.deepEqual(account.blockers, []);
});

test('an incomplete or inconsistent run is refused before any argument is produced', async t => {
  const team = fixture(t), code = async promise => (await promise).errors?.[0].code;
  assert.equal(await code(freeze(team, { rounds: 3 })), 'COUNT_MISMATCH', 'N must equal the number of frozen tickets');
  assert.equal(await code(freeze(team, {}, [inputFixture(), inputFixture()])), 'DUPLICATE_TICKET');
  const other = second(); other.policy.maxBriefChars = 9000; other.mandate.policyDigest = digest(other.policy);
  assert.equal(await code(freeze(team, {}, [inputFixture(), other])), 'POLICY_MISMATCH', 'one run has one policy and one Guardian');
  assert.equal(await code(freeze(team, { budgetCeilingTokens: 45000 })), 'BUDGET_BELOW_ESTIMATE', 'the engine stops at 80% of the ceiling, so the estimates must stay below that line');
  assert.equal((await freeze(team, { budgetCeilingTokens: 45001 })).errors, undefined);
  assert.equal((await freeze(team, { budgetCeilingTokens: 108000 })).errors, undefined, 'a ceiling above the ticket authorizations is not refused: they are in another unit');
  assert.equal(await code(freeze(team, { budgetCeilingTokens: 108001 })), 'BUDGET_CEILING_TOO_LOOSE', 'a ceiling above three times the output estimate gives no runaway protection');
  assert.equal(await code(freeze(team, { estimatedOutputTokens: 0 })), 'INVALID_RUN');
  { const { estimatedOutputTokens, ...without } = RUN; assert.equal((await freezeRun({ inputs: [inputFixture(), second()], run: without, teamRoot: team })).errors?.[0].code, 'INVALID_RUN', 'the output estimate is required'); }
  assert.equal(await code(freeze(team, { date: '2026-02-30' })), 'ENGINE_REJECTED', 'the real engine validator judges the frozen arguments');
  assert.equal(await code(freeze(team, { failurePolicy: 'continue' })), 'INVALID_RUN', 'only the fields of the owner directive are accepted');
  const broken = inputFixture(); broken.proposal.attempt = 2;
  assert.equal(await code(freeze(team, { rounds: 1, budgetCeilingTokens: 20000 }, [broken])), 'UNSUPPORTED_CAPABILITY', 'a compile error passes through');
  const dormant = fixture(t, { guard: '| worker-guard | agents/worker-guard.md | .claude/agents/sample-worker-guard.md | m | high | dormant |' });
  assert.equal(await code(freeze(dormant)), 'DUTY_NOT_STAFFED', 'a dormant Guardian is a missing Guardian');
  const renamed = fixture(t, { check: '| worker-check | agents/worker-check.md | .claude/agents/other-check.md | m | high | active |' });
  assert.equal(await code(freeze(renamed)), 'DUTY_NOT_STAFFED', 'the policy wrapper must be the one the roster staffs for the duty');
  const noEngine = fixture(t); rmSync(join(noEngine, '.claude/workflows/run-n-rounds.js'));
  assert.equal(await code(freeze(noEngine)), 'INVALID_RUN');
});

test('a run that spends exactly its estimates finishes under the smallest accepted ceiling', async t => {
  const team = fixture(t), { args, record } = await freeze(team, { budgetCeilingTokens: 45001 }), budget = makeBudget({ total: 100_000_000 }), impl = makeAgentImpl({});
  const spend = (p, o, i) => { budget.bump({ 'sample-worker-exec': 12000, 'sample-worker-check': 6000 }[o.agentType] ?? 0); return impl(p, o, i); };
  const { result, calls } = await engine(team, args, { budgetImpl: budget, agentImpl: spend });
  assert.equal(calls.length, 5); assert.equal(result.budgetGateTripped, false); assert.equal(result.safeToContinue, true);
  assert.deepEqual(accountRun({ args, record, result }).blockers, []);
  assert.equal(record.budget.stopLine, 36000, 'the record states the 80% line the engine stops at');
});

test('Q5 budget stop before the verifier: no check call, no later ticket, Guardian still audits, continuation blocked', async t => {
  const team = fixture(t), { args, record } = await freeze(team), budget = makeBudget({ total: 100_000_000 }), impl = makeAgentImpl({});
  const { result, calls } = await engine(team, args, { budgetImpl: budget, agentImpl: (p, o, i) => { budget.bump(40_000); return impl(p, o, i); } });
  assert.deepEqual(types(calls), ['sample-worker-exec', 'sample-worker-guard']);
  assert.match(result.haltReason, /token-burnout/); assert.equal(result.allPassed, false);
  const account = accountRun({ args, record, result });
  assert.equal(account.status, 'accounted', JSON.stringify(account.findings));
  assert.deepEqual(account.calls, { exec: 1, check: 0, guard: 1 });
  assert.ok(account.blockers.includes('budget-gate') && account.blockers.includes('run-incomplete'), JSON.stringify(account.blockers));
});

test('a missing Guardian fails closed: work that passed is still not continuable', async t => {
  const team = fixture(t), { args, record } = await freeze(team);
  const { result } = await engine(team, args, { agentImpl: makeAgentImpl({ guardian: () => { throw new Error('guardian unavailable'); } }) });
  assert.equal(result.allPassed, false); assert.equal(result.nextInvocationBlocked, true);
  const account = accountRun({ args, record, result });
  assert.equal(account.status, 'accounted'); assert.deepEqual(account.calls, { exec: 2, check: 2, guard: 1 });
  assert.deepEqual(account.blockers, ['guardian-unavailable']);
});

test('a worker stop halts the run: the next ticket is never dispatched', async t => {
  const team = fixture(t), { args, record } = await freeze(team);
  const stop = () => ({ outcome: 'owner stop observed', progress: false, filesTouched: [], decisionsCount: 0, selfReportTokens: 10, blocked: false, terminalStop: true, notes: '' });
  const { result, calls } = await engine(team, args, { agentImpl: makeAgentImpl({ worker: stop }) });
  assert.equal(types(calls).filter(type => type === 'sample-worker-exec').length, 1);
  const account = accountRun({ args, record, result });
  assert.equal(account.status, 'accounted', JSON.stringify(account.findings)); assert.equal(account.calls.exec, 1);
  assert.ok(account.blockers.includes('run-incomplete'));
});

test('a return that does not match the frozen arguments is unaccounted', async t => {
  const team = fixture(t), { args, record } = await freeze(team), { result } = await engine(team, args);
  const mutations = [r => { r.runId = 'other-run'; }, r => { r.results.push(structuredClone(r.results[0])); },
    r => { r.results[1].ticket = 'US-99'; }, r => { r.results[0].agentType = 'sample-auditor'; },
    r => { r.mainSessionTodo.nextLifecycleNumberAfter += 1; }, r => { r.mainSessionTodo.lifecycleEntries.pop(); },
    r => { r.dispatchedCount = 1; }, r => { delete r.guardian; }];
  for (const mutate of mutations) {
    const changed = structuredClone(result); mutate(changed);
    assert.equal(accountRun({ args, record, result: changed }).status, 'unaccounted', mutate.toString());
  }
  const edited = structuredClone(args); edited.budgetCeilingTokens = 48000;
  assert.equal(accountRun({ args: edited, record, result }).status, 'unaccounted', 'arguments changed after the freeze');
  assert.equal(accountRun({ args, record, result: null }).status, 'unaccounted');
});

test('duplicate delivery of one return reconciles once: lifecycle entries and the counter are not doubled', async t => {
  const team = fixture(t), { args, record } = await freeze(team), { result } = await engine(team, args);
  write(team, 'agents/lifecycle.md', '# Lifecycle\n\n## [001] bootstrap — deployed\n\nNext NNN to assign: 002\n'); mkdirSync(join(team, 'messages'));
  write(team, 'result.json', JSON.stringify(result));
  const apply = () => spawnSync(process.execPath, [RECONCILE, join(team, 'result.json'), team], { encoding: 'utf8' });
  const first = apply(); assert.equal(first.status, 0, first.stdout + first.stderr);
  const once = readFileSync(join(team, 'agents/lifecycle.md'), 'utf8');
  const again = apply(); assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readFileSync(join(team, 'agents/lifecycle.md'), 'utf8'), once);
  assert.equal(once.split('\n').filter(line => /^## \[\d+\]/.test(line)).length, 1 + accountRun({ args, record, result }).calls.exec + 1, 'bootstrap, one entry per ticket, one Guardian entry');
  assert.match(once, /Next NNN to assign: 005/);
});

test('CLI writes nothing, prints arguments and record, exits 2 on refusal and 1 on usage', t => {
  const team = fixture(t), file = join(team, 'run.json');
  writeFileSync(file, JSON.stringify({ run: RUN, inputs: [inputFixture(), second()] }));
  const run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  const ok = run(file, '--team-root', team);
  assert.equal(ok.status, 0, ok.stderr);
  const printed = JSON.parse(ok.stdout);
  assert.equal(printed.record.launchable, false); assert.equal(printed.record.argsDigest, digest(printed.args));
  writeFileSync(file, JSON.stringify({ run: { ...RUN, rounds: 3 }, inputs: [inputFixture(), second()] }));
  assert.equal(run(file, '--team-root', team).status, 2);
  assert.equal(run(file).status, 1);
});

// Schema-v2 input selecting the pinned check method.
function methodInput(bundle) {
  const input = inputFixture();
  input.schemaVersion = 2; input.catalog = methodCatalog(bundle);
  input.policy = { ...input.policy, schemaVersion: 2, maxBriefChars: 20000, methodAllowlist: { exec: [], check: ['pstack-blast-radius'], guard: [] } };
  input.proposal = { ...input.proposal, checkMethodIds: ['pstack-blast-radius'], checkSelectionReason: 'Review downstream effects' };
  input.mandate.policyDigest = digest(input.policy);
  return input;
}
const ONE = { ...RUN, rounds: 1, budgetCeilingTokens: 23400, estimatedOutputTokens: 18000 };

test('an input selecting an approved method freezes with the loader-verified bundle; only the check brief carries the method', async t => {
  const team = fixture(t), bundle = loadMethods(), input = methodInput(bundle);
  const frozen = await freezeRun({ inputs: [input], run: ONE, teamRoot: team, methodBundle: bundle });
  assert.equal(frozen.errors, undefined, JSON.stringify(frozen.errors));
  const preview = compile(input, { methodBundle: bundle });
  assert.deepEqual(frozen.args.plan, [preview.enginePlanItem]);
  assert.equal(frozen.record.items[0].previewDigest, preview.manifest.digest);
  const withMethod = Object.entries(frozen.args.plan[0]).filter(([, value]) => typeof value === 'string' && value.includes('pstack-blast-radius')).map(([key]) => key);
  assert.equal(withMethod.length, 1, `fields naming the method: ${withMethod}`);
  assert.match(withMethod[0], /verif|check/i);
});

test('a method selection without a verified bundle, or with a serialized stand-in, emits no arguments', async t => {
  const team = fixture(t), bundle = loadMethods(), input = methodInput(bundle);
  for (const methodBundle of [undefined, {}, { catalog: methodCatalog(bundle) }]) {
    const refused = await freezeRun({ inputs: [input], run: ONE, teamRoot: team, methodBundle });
    assert.equal(refused.errors?.[0].code, 'METHOD_BUNDLE_REQUIRED', JSON.stringify(refused));
    assert.equal(refused.args, undefined);
  }
});

test('CLI loads the pinned bundle of its own kit for a method-bearing input', t => {
  const team = fixture(t), file = join(team, 'run.json');
  writeFileSync(file, JSON.stringify({ run: ONE, inputs: [methodInput(loadMethods())] }));
  const out = spawnSync(process.execPath, [CLI, file, '--team-root', team], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(JSON.stringify(JSON.parse(out.stdout).args.plan[0]), /pstack-blast-radius/);
});
