// Launch host, first half: one command chains the gates that precede a run and
// leaves a single-use launch record; any refusal leaves the product unleased.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { prepareLaunch, closeLaunch, LAUNCH_FILE, CLOSE_FILE } from '../src/router-worker/launch.mjs';
import { settleLaunch, SETTLE_FILE } from '../src/router-worker/launch-settle.mjs';
import { prepareRetry } from '../src/router-worker/launch-retry.mjs';
import { loadRetryRules, inspectRetryJournal } from '../src/router-worker/retries.mjs';
import { candidateOf } from '../src/router-worker/closed-candidate.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { freezeRun } from '../src/router-worker/run-args.mjs';
import { observeIsolation } from '../src/router-worker/isolation.mjs';
import { acquireLease, readLease, releaseLease } from '../src/router-worker/lease.mjs';
import { digest } from '../src/loop/contracts.mjs';
import { loadMethods, methodCatalog } from '../src/router-worker/methods.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';

const ENGINE = fileURLToPath(new URL('../.claude/workflows/run-n-rounds.js', import.meta.url));
const HOOK = fileURLToPath(new URL('../scripts/hooks/rw-write-boundary.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/launch-router-worker.mjs', import.meta.url));
const ARM = fileURLToPath(new URL('../scripts/arm-boundary-router-worker.mjs', import.meta.url));
const DUTIES = ['exec', 'check', 'guard'];
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const wrapper = duty => `---\nname: "sample-worker-${duty}"\ndescription: "fixture"\nmodel: "m"\neffort: "high"\nmaxTurns: 10\n`
  + `tools: ${duty === 'exec' ? 'Read, Grep, Glob, Write, Edit' : 'Read, Grep, Glob'}\ndisallowedTools: ${duty === 'exec' ? 'Agent, Task' : 'Agent, Task, Write, Edit, NotebookEdit'}\npermissionMode: "default"\n---\n\nActive wrapper.\n`;
const roster = ['| Role id | Role file | Wrapper file | Model | Reasoning | Status |', '|---|---|---|---|---|---|',
  ...DUTIES.map(d => `| worker-${d} | agents/worker-${d}.md | .claude/agents/sample-worker-${d}.md | m | high | active |`)].join('\n') + '\n';
const RUN = { rounds: 1, date: '2026-11-13', nextLifecycleNumber: 1, runId: 'rw-launch-001', budgetCeilingTokens: 23400, estimatedOutputTokens: 18000, guardianEstimateTokens: 20000 };

// An activated disposable copy and a separate clean product repository.
function fixture(t, { status = 'activated-disposable-smoke' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-launch-'))), team = join(base, 'demo.rw-active'), product = join(base, 'product');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  write(team, 'agents/roster.md', roster); write(team, 'profiles/team-mode.json', JSON.stringify({ status }));
  for (const file of ['charter.md', 'CLAUDE.md', 'profiles/project.md', 'profiles/stack.md', 'agents/pm.md', 'agents/templates.md', 'agents/_shared/meta-rules.md', 'decisions/0001-x.md'])
    write(team, file, '# fixture\n');
  for (const duty of DUTIES) write(team, `.claude/agents/sample-worker-${duty}.md`, wrapper(duty));
  mkdirSync(join(team, '.claude/workflows')); copyFileSync(ENGINE, join(team, '.claude/workflows/run-n-rounds.js'));
  write(product, 'src/tag-list/view.ts', 'export const x = 1;\n');
  git(product, 'init', '-q'); git(product, 'add', '-A'); git(product, 'commit', '-q', '-m', 'product');
  const prepare = (overrides = {}) => prepareLaunch({ inputs: [inputFixture()], run: RUN, teamRoot: team, productRoot: product, hookPath: HOOK, ...overrides });
  return { base, team, product, prepare, launchFile: join(team, LAUNCH_FILE), leased: () => readLease({ productRoot: product }).status };
}
const refusal = result => result.errors?.[0];
const releaseLeaseOf = f => releaseLease({ productRoot: f.product, lease: f.launch.lease });

test('prepare takes the lease, arms the boundary, observes the gate clear and writes one launch record', async t => {
  const f = fixture(t), result = await f.prepare();
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.stage, 'launch-prepared'); assert.equal(result.runId, RUN.runId);
  const held = readLease({ productRoot: f.product });
  assert.equal(held.status, 'held'); assert.equal(held.lease.teamRoot, f.team); assert.equal(result.lease, held.lease.digest);
  const observed = observeIsolation({ teamRoot: f.team, productRoot: f.product, lease: result.lease });
  assert.equal(observed.status, 'clear'); assert.equal(result.isolationDigest, observed.digest);
  assert.equal(result.productHead, git(f.product, 'rev-parse', 'HEAD').trim());
  const frozen = await freezeRun({ inputs: [inputFixture()], run: RUN, teamRoot: f.team });
  assert.deepEqual(result.args, frozen.args); assert.deepEqual(result.runRecord, frozen.record); assert.equal(result.argsDigest, digest(frozen.args));
  assert.equal(result.boundaryDigest, JSON.parse(readFileSync(join(f.team, '.claude/rw-write-boundary.json'), 'utf8')).digest);
  const { digest: recorded, ...body } = result;
  assert.equal(recorded, digest(body));
  assert.deepEqual(JSON.parse(readFileSync(f.launchFile, 'utf8')), result, 'the record on disk is the record returned');
  assert.ok(result.unresolved.includes('in-run-admission') && result.unresolved.includes('owner-attendance'));
});

test('prepare chains the launch manifest: the frozen arguments carry its digest, and a failing preflight takes nothing', async t => {
  const f = fixture(t), seen = [];
  const manifest = args => { seen.push(args); return { digest: 'sha256:' + 'a'.repeat(64) }; };
  const result = await f.prepare({ manifest });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.args.launchManifestDigest, 'sha256:' + 'a'.repeat(64)); assert.equal(result.launchManifest, 'chained');
  assert.equal(seen.length, 1); assert.equal(seen[0].launchManifestDigest, undefined, 'the manifest is taken of the arguments without the digest');
  assert.deepEqual({ ...result.args, launchManifestDigest: undefined }, { ...seen[0], launchManifestDigest: undefined });
  assert.ok(!result.unresolved.includes('launch-manifest-preflight'));
  const refused = fixture(t), failing = await refused.prepare({ manifest: () => ({ errors: [{ code: 'PREFLIGHT_FAILED', field: 'launch', reason: 'FAIL - wrappers' }] }) });
  assert.equal(refusal(failing).code, 'PREFLIGHT_FAILED'); assert.equal(refused.leased(), 'free'); assert.equal(existsSync(refused.launchFile), false);
  const supplied = await fixture(t).prepare({ run: { ...RUN, launchManifestDigest: 'sha256:' + 'b'.repeat(64) }, manifest });
  assert.equal(supplied.launchManifest, 'supplied'); assert.equal(seen.length, 1, 'a digest in RUN.json is kept and no preflight runs');
  const absent = await fixture(t).prepare();
  assert.equal(absent.launchManifest, 'absent'); assert.ok(absent.unresolved.includes('launch-manifest-preflight'));
});

test('an activated copy is prepared once; a second prepare is refused and changes nothing', async t => {
  const f = fixture(t), first = await f.prepare(), before = readFileSync(f.launchFile, 'utf8');
  const again = await f.prepare();
  assert.equal(refusal(again).code, 'LAUNCH_REFUSED'); assert.match(refusal(again).reason, /already/);
  assert.equal(readFileSync(f.launchFile, 'utf8'), before); assert.equal(readLease({ productRoot: f.product }).lease.digest, first.lease);
});

test('a run that cannot be frozen is refused before anything is taken or written', async t => {
  const f = fixture(t), result = await f.prepare({ run: { ...RUN, budgetCeilingTokens: 100000 } });
  assert.equal(refusal(result).code, 'BUDGET_CEILING_TOO_LOOSE');
  assert.equal(f.leased(), 'free'); assert.equal(existsSync(f.launchFile), false);
  assert.equal(existsSync(join(f.team, '.claude/rw-write-boundary.json')), false);
});

test('a gate that is not clear refuses the launch, names the findings and releases the lease', async t => {
  const dirty = fixture(t); write(dirty.product, 'notes.txt', 'x\n');
  const result = await dirty.prepare();
  assert.equal(refusal(result).code, 'LAUNCH_REFUSED'); assert.match(refusal(result).reason, /PRODUCT_DIRTY/);
  assert.equal(dirty.leased(), 'free'); assert.equal(existsSync(dirty.launchFile), false);
  assert.ok(!JSON.stringify(result).includes(dirty.base), 'the refusal names no host path');
  const standing = fixture(t, { status: 'staged-structurally-validated' });
  assert.equal(refusal(await standing.prepare()).code, 'BOUNDARY_REFUSED');
  assert.equal(standing.leased(), 'free'); assert.equal(existsSync(standing.launchFile), false);
});

test('a product leased to another host is refused and that lease is left alone', async t => {
  const f = fixture(t), other = join(f.base, 'other.team'); mkdirSync(other);
  const theirs = acquireLease({ teamRoot: other, productRoot: f.product }).lease.digest;
  assert.equal(refusal(await f.prepare()).code, 'LEASE_HELD');
  assert.equal(readLease({ productRoot: f.product }).lease.digest, theirs); assert.equal(existsSync(f.launchFile), false);
});

test('an input selecting an approved method is prepared with the loader-verified bundle, by the module and by the CLI', async t => {
  const bundle = loadMethods(), input = inputFixture();
  input.schemaVersion = 2; input.catalog = methodCatalog(bundle);
  input.policy = { ...input.policy, schemaVersion: 2, maxBriefChars: 20000, methodAllowlist: { exec: [], check: ['pstack-blast-radius'], guard: [] } };
  input.proposal = { ...input.proposal, checkMethodIds: ['pstack-blast-radius'], checkSelectionReason: 'Review downstream effects' };
  input.mandate.policyDigest = digest(input.policy);
  const without = fixture(t);
  assert.equal(refusal(await without.prepare({ inputs: [input] })).code, 'METHOD_BUNDLE_REQUIRED'); assert.equal(without.leased(), 'free');
  const result = await fixture(t).prepare({ inputs: [input], methodBundle: bundle });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors)); assert.equal(result.stage, 'launch-prepared');
  const f = fixture(t), file = join(f.base, 'run.json'); writeFileSync(file, JSON.stringify({ run: RUN, inputs: [input] }));
  const cli = spawnSync(process.execPath, [CLI, 'prepare', file, '--team-root', f.team, '--product-root', f.product], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const arm = fixture(t), armed = spawnSync(process.execPath, [ARM, file, '--team-root', arm.team, '--product-root', arm.product], { encoding: 'utf8' });
  assert.equal(armed.status, 0, armed.stderr);
});

test('CLI prepares from RUN.json, exits 2 on refusal and 1 on usage', t => {
  const f = fixture(t), file = join(f.base, 'run.json'), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify({ run: RUN, inputs: [inputFixture()] }));
  const ok = run('prepare', file, '--team-root', f.team, '--product-root', f.product);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).stage, 'launch-prepared');
  assert.equal(JSON.parse(ok.stdout).launchManifest, 'chained'); assert.match(JSON.parse(ok.stdout).args.launchManifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(JSON.parse(readFileSync(join(f.team, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command, /scripts\/hooks\/rw-write-boundary\.mjs"$/);
  assert.equal(run('prepare', file, '--team-root', f.team, '--product-root', f.product).status, 2);
  assert.equal(run('prepare', file).status, 1); assert.equal(run('launch', file, '--team-root', f.team, '--product-root', f.product).status, 1);
});

// A prepared copy and the return of the real engine for its arguments (mock agents, no model).
async function ran(t, agents = {}, overrides = {}) {
  const f = fixture(t), launch = await f.prepare(overrides);
  const { result } = await runWorkflow({ scriptPath: join(f.team, '.claude/workflows/run-n-rounds.js'), args: launch.args, agentImpl: makeAgentImpl(agents) });
  return { ...f, launch, result, close: (overrides = {}) => closeLaunch({ teamRoot: f.team, result, ...overrides }), closeFile: join(f.team, CLOSE_FILE) };
}

test('close accounts the engine return against the launch record, lists the product changes and releases the lease', async t => {
  const f = await ran(t); write(f.product, 'src/tag-list/empty.ts', 'export const y = 2;\n'); writeFileSync(join(f.product, 'src/tag-list/view.ts'), 'changed\n');
  const closed = f.close();
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.equal(closed.stage, 'launch-closed'); assert.equal(closed.status, 'clean', JSON.stringify(closed.findings));
  assert.equal(closed.launchDigest, f.launch.digest); assert.equal(closed.account.status, 'accounted'); assert.deepEqual(closed.account.calls, { exec: 1, check: 1, guard: 1 });
  assert.deepEqual(closed.changedPaths, ['src/tag-list/empty.ts', 'src/tag-list/view.ts']); assert.equal(closed.leaseReleased, true);
  assert.equal(f.leased(), 'free');
  const { digest: recorded, ...body } = closed;
  assert.equal(recorded, digest(body)); assert.deepEqual(JSON.parse(readFileSync(f.closeFile, 'utf8')), closed);
  assert.ok(closed.unresolved.includes('usage-settlement'));
  assert.deepEqual(closed.ignoredChanges, { count: 0, topLevel: {} });
  assert.deepEqual(closed.candidate, candidateOf(f.product), 'the product state the run ended in');
  assert.equal(observeIsolation({ teamRoot: f.team, productRoot: f.product, lease: acquireLease({ teamRoot: f.team, productRoot: f.product }).lease.digest, retryOf: closed.digest }).status, 'clear');
  assert.deepEqual(closed.hookLog, { calls: 0, wrapperCalls: 0, wrapperBashCalls: 0, denied: 0, callsWithoutAgentType: 0, unreadableLines: 0 }, 'no hook ran under the mock engine, and the record says so');
  assert.equal(refusal(f.close()).code, 'LAUNCH_REFUSED', 'a launch is closed once');
});

test('close reports what the run left that the gates do not allow, and still releases the lease', async t => {
  const outside = await ran(t); write(outside.product, 'src/auth/session.ts', 'x\n'); write(outside.product, 'src/tag-list/ok.ts', 'x\n');
  const closed = outside.close();
  assert.equal(closed.status, 'review'); assert.deepEqual(closed.findings, [{ code: 'WRITE_OUTSIDE_BOUNDARY', paths: ['src/auth/session.ts'] }]);
  assert.equal(outside.leased(), 'free');
  const committed = await ran(t); write(committed.product, 'src/tag-list/ok.ts', 'x\n'); git(committed.product, 'add', '-A'); git(committed.product, 'commit', '-q', '-m', 'worker commit');
  assert.ok(committed.close().findings.some(finding => finding.code === 'PRODUCT_HEAD_MOVED'));
  const edited = await ran(t), file = join(edited.team, '.claude/rw-write-boundary.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('src/tag-list/**', '**'));
  assert.ok(edited.close().findings.some(finding => finding.code === 'BOUNDARY_CHANGED'));
  const taken = await ran(t); releaseLeaseOf(taken); const other = join(taken.base, 'other.team'); mkdirSync(other);
  const theirs = acquireLease({ teamRoot: other, productRoot: taken.product }).lease.digest, result = taken.close();
  assert.ok(result.findings.some(finding => finding.code === 'LEASE_NOT_HELD_BY_THIS_LAUNCH')); assert.equal(result.leaseReleased, false);
  assert.equal(readLease({ productRoot: taken.product }).lease.digest, theirs, 'another host\'s lease is left alone');
});

test('git-ignored paths the run left are counted by top-level directory and do not keep the close from clean', async t => {
  const ignoring = fixture(t); write(ignoring.product, '.gitignore', 'build/\n.dart_tool/\n'); git(ignoring.product, 'add', '-A'); git(ignoring.product, 'commit', '-q', '-m', 'ignore');
  const launch = await ignoring.prepare(), { result } = await runWorkflow({ scriptPath: join(ignoring.team, '.claude/workflows/run-n-rounds.js'), args: launch.args, agentImpl: makeAgentImpl({}) });
  write(ignoring.product, 'build/a.o', 'x'); write(ignoring.product, 'build/deep/b.o', 'x'); write(ignoring.product, '.dart_tool/version', 'x'); write(ignoring.product, 'src/tag-list/ok.ts', 'x\n');
  const closed = closeLaunch({ teamRoot: ignoring.team, result });
  assert.equal(closed.status, 'clean', JSON.stringify(closed.findings));
  assert.deepEqual(closed.changedPaths, ['src/tag-list/ok.ts']);
  assert.deepEqual(closed.ignoredChanges, { count: 3, topLevel: { '.dart_tool': 1, build: 2 } });
  const mixed = await ran(t); write(mixed.product, 'stray.txt', 'x\n');
  assert.deepEqual(mixed.close().findings, [{ code: 'WRITE_OUTSIDE_BOUNDARY', paths: ['stray.txt'] }], 'an untracked path outside the boundary is still a finding');
});

test('close summarizes the hook log of the run', async t => {
  const f = await ran(t), line = entry => JSON.stringify({ at: '2026-11-13T10:00:00.000Z', judged: false, decision: 'allow', ...entry }) + '\n';
  writeFileSync(join(f.team, '.claude/rw-write-boundary.log.jsonl'), line({ tool: 'Write', agentType: 'sample-worker-exec', judged: true })
    + line({ tool: 'Write', agentType: 'sample-worker-exec', judged: true, decision: 'deny' }) + line({ tool: 'Bash', agentType: 'sample-worker-check' })
    + line({ tool: 'Write', agentType: null }) + line({ tool: 'Write', agentType: 'sample-auditor' }) + '{torn');
  assert.deepEqual(f.close().hookLog, { calls: 5, wrapperCalls: 3, wrapperBashCalls: 1, denied: 1, callsWithoutAgentType: 1, unreadableLines: 1 });
});

test('close refuses a return that is not the return of the prepared launch, and keeps the lease', async t => {
  const f = await ran(t);
  assert.equal(refusal(f.close({ result: { ...f.result, runId: 'another-run' } })).code, 'LAUNCH_REFUSED');
  assert.equal(refusal(f.close({ result: null })).code, 'LAUNCH_REFUSED');
  const loosened = f.close({ result: { ...f.result, budgetStatus: { ...f.result.budgetStatus, ceiling: f.result.budgetStatus.ceiling * 10 } } });
  assert.match(refusal(loosened).reason, /RUN_IDENTITY_MISMATCH/, 'a launch with another ceiling than the frozen one');
  assert.equal(f.leased(), 'held'); assert.equal(existsSync(f.closeFile), false);
  const record = JSON.parse(readFileSync(f.launchFile, 'utf8')); record.args.budgetCeilingTokens += 1;
  writeFileSync(f.launchFile, JSON.stringify(record));
  assert.match(refusal(f.close()).reason, /launch record/); assert.equal(f.leased(), 'held');
  const never = fixture(t);
  assert.equal(refusal(closeLaunch({ teamRoot: never.team, result: f.result })).code, 'LAUNCH_REFUSED');
});

test('CLI closes from RESULT.json; exit 0 clean, 2 review or refused, 1 usage', async t => {
  const f = await ran(t), file = join(f.base, 'result.json'), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify(f.result));
  assert.equal(run('close', file).status, 1);
  const ok = run('close', file, '--team-root', f.team);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).status, 'clean');
  assert.equal(run('close', file, '--team-root', f.team).status, 2);
  const review = await ran(t); write(review.product, 'stray.txt', 'x\n'); writeFileSync(file, JSON.stringify(review.result));
  const flagged = run('close', file, '--team-root', review.team);
  assert.equal(flagged.status, 2); assert.equal(JSON.parse(flagged.stdout).status, 'review');
});

// Settlement after close: a Claude Code session directory in the real on-disk layout, metered by the real meter.
const METER = fileURLToPath(new URL('../scripts/measure-spawn.mjs', import.meta.url));
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const usageRow = (id, agentId, create) => ({ type: 'assistant', isSidechain: Boolean(agentId), agentId, requestId: `req_${id}`,
  message: { id: `msg_${id}`, model: 'm', role: 'assistant', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: create, cache_read_input_tokens: 0, output_tokens: 100 } } });
const relayed = text => ({ type: 'user', message: { role: 'user', content: `The computed task text follows:\n${text.split('\n').map(line => '  ' + line).join('\n')}\n  ` } });
function metered(f, { execBrief, order = ['exec1', 'check1', 'guard1'], tokens = { exec1: 12000, check1: 6000, guard1: 5000 } } = {}) {
  const plan = f.launch.args.plan[0], dir = join(f.base, 'projects'), wf = join(dir, 'sess/subagents/workflows/wf_1');
  const agents = { exec1: ['sample-worker-exec', execBrief ?? plan.brief], check1: ['sample-worker-check', plan.verifierBrief], guard1: ['sample-worker-guard', 'Audit this run.'] };
  mkdirSync(wf, { recursive: true }); writeFileSync(join(dir, 'sess.jsonl'), jsonl([usageRow('main', undefined, 7000)]));
  for (const [id, [agentType, brief]] of Object.entries(agents)) {
    writeFileSync(join(wf, `agent-${id}.jsonl`), jsonl([{ type: 'user', message: { role: 'user', content: 'harness preamble' } }, relayed(brief), usageRow(id, id, tokens[id])]));
    writeFileSync(join(wf, `agent-${id}.meta.json`), JSON.stringify({ agentType, description: id }));
  }
  writeFileSync(join(wf, 'journal.jsonl'), jsonl([{ type: 'launched' }, ...order.flatMap(agentId => [{ type: 'started', agentId }, { type: 'result', agentId, result: {} }])]));
  const run = spawnSync(process.execPath, [METER, join(dir, 'sess'), '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
const rules = loadRetryRules();
const settle = (f, meter, overrides = {}) => settleLaunch({ teamRoot: f.team, result: f.result, meter, rules, ...overrides });

test('settle maps the metered agents to the calls of the run, checks the briefs and settles tickets and run', async t => {
  const f = await ran(t); f.close();
  const settled = settle(f, metered(f));
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors));
  assert.equal(settled.stage, 'launch-settled'); assert.equal(settled.status, 'clear', JSON.stringify([settled.findings, settled.run.reasons]));
  assert.deepEqual(settled.calls.map(({ ticket, duty, agentId, tokens, finished }) => ({ ticket, duty, agentId, tokens, finished })), [
    { ticket: 'US-08', duty: 'exec', agentId: 'exec1', tokens: 12010, finished: true }, { ticket: 'US-08', duty: 'check', agentId: 'check1', tokens: 6010, finished: true },
    { ticket: null, duty: 'guard', agentId: 'guard1', tokens: 5010, finished: true }]);
  assert.equal(settled.run.runGate, 'clear'); assert.equal(settled.run.ticketTokens, 18020); assert.equal(settled.run.guardianTokens, 5010);
  assert.equal(settled.mainSessionTokens, 7010); assert.deepEqual(settled.findings, []);
  assert.equal(settled.journalSource, 'reconstructed-after-run'); assert.equal(settled.launchDigest, f.launch.digest);
  const kept = settled.ticketRecords[0];
  assert.equal(kept.ticketId, 'US-08'); assert.equal(kept.journal.digest, kept.settlement.journalDigest); assert.equal(kept.ledger.digest, kept.settlement.ledgerDigest);
  assert.equal(kept.settlement.digest, settled.run.tickets[0].settlementDigest, 'the kept settlement is the one the run settlement counted');
  const state = inspectRetryJournal({ journal: kept.journal, rules });
  assert.deepEqual(state.assignments.map(a => [a.assignmentId, a.status, a.outcome]), [['US-08.exec.1', 'closed', 'candidate'], ['US-08.check.1', 'closed', 'pass']]);
  const { digest: recorded, ...body } = settled;
  assert.equal(recorded, digest(body)); assert.deepEqual(JSON.parse(readFileSync(join(f.team, SETTLE_FILE), 'utf8')), settled);
  assert.ok(!JSON.stringify(settled).includes(f.base), 'no host path in the record');
  assert.equal(refusal(settle(f, metered(f))).code, 'LAUNCH_REFUSED', 'a launch is settled once');
});

test('settle reports a call whose transcript does not carry the frozen brief, and usage beyond an estimate', async t => {
  const changed = await ran(t); changed.close();
  const settled = settle(changed, metered(changed, { execBrief: changed.launch.args.plan[0].brief.replace('US-08', 'US-99') }));
  assert.equal(settled.status, 'review'); assert.deepEqual(settled.findings, [{ code: 'BRIEF_NOT_FOUND', ticket: 'US-08', duty: 'exec' }]);
  const heavy = await ran(t); heavy.close();
  const over = settle(heavy, metered(heavy, { tokens: { exec1: 12000, check1: 6000, guard1: 25000 } }));
  assert.equal(over.status, 'review'); assert.equal(over.run.runGate, 'blocked'); assert.deepEqual(over.run.reasons, ['guardian-over-estimate']);
});

test('a blocked worker whose returned work was checked settles as a stopped ticket; one that was not checked settles without a check call', async t => {
  const blockedWorker = { worker: () => ({ outcome: 'blocked', progress: true, filesTouched: ['src/tag-list/view.ts'], decisionsCount: 1, selfReportTokens: 100, blocked: true, terminalStop: false, notes: '' }) };
  const f = await ran(t, blockedWorker); f.close();
  const checked = f.result.results[0].estimates.verifier !== null, meter = metered(f, checked ? {} : { order: ['exec1', 'guard1'] });
  if (!checked) meter.subagents = meter.subagents.filter(row => row.agentId !== 'check1');
  const settled = settle(f, meter);
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors));
  assert.deepEqual(settled.calls.map(call => call.duty), checked ? ['exec', 'check', 'guard'] : ['exec', 'guard']);
  assert.equal(settled.run.tickets[0].ticketId, 'US-08'); assert.equal(settled.run.runGate, 'clear');
});

test('settle refuses a meter that is not the calls of this run, an unclosed launch and another return; nothing is written', async t => {
  const f = await ran(t), file = join(f.team, SETTLE_FILE);
  assert.match(refusal(settle(f, metered(f))).reason, /closed/);
  f.close();
  assert.match(refusal(settle(f, metered(f, { order: ['check1', 'exec1', 'guard1'] }))).reason, /calls of this run/);
  const partial = metered(f); partial.subagents = partial.subagents.filter(row => row.agentId !== 'guard1');
  assert.equal(refusal(settle(f, partial)).code, 'LAUNCH_REFUSED');
  assert.equal(refusal(settle(f, metered(f), { result: { ...f.result, runId: 'another' } })).code, 'LAUNCH_REFUSED');
  assert.equal(refusal(settle(f, null)).code, 'LAUNCH_REFUSED');
  assert.equal(existsSync(file), false);
});

test('CLI settles from RESULT.json and METER.json; exit 0 clear, 2 review or refused, 1 usage', async t => {
  const f = await ran(t), result = join(f.base, 'result.json'), meter = join(f.base, 'meter.json'), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  f.close(); writeFileSync(result, JSON.stringify(f.result)); writeFileSync(meter, JSON.stringify(metered(f)));
  assert.equal(run('settle', result, '--team-root', f.team).status, 1);
  const ok = run('settle', result, meter, '--team-root', f.team);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).status, 'clear');
  assert.equal(run('settle', result, meter, '--team-root', f.team).status, 2);
});

// Retry after a failed check: prepared by the launch host, sent by the PM session of the copy.
const failingCheck = { verifier: () => ({ pass: false, staticPass: false, e2ePass: true, summary: 'one test fails', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['tag list test'] }) };
async function failed(t, agents = failingCheck, overrides = {}) {
  const f = await ran(t, agents, overrides); write(f.product, 'src/tag-list/view.ts', 'export const x = 2;\n');
  const closed = f.close(), settled = settle(f, metered(f));
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors));
  const request = (overrides = {}) => {
    const input = inputFixture();
    input.proposal.assignmentId = 'US-08.exec.2'; input.proposal.checkAssignmentId = 'US-08.check.2'; input.baseline.candidateRef = closed.candidate;
    return { input, divergence: { reason: 'The failed check named the tag list test; fix the empty-state branch', evidenceRef: { id: 'rw-settlement', digest: settled.digest } }, ...overrides };
  };
  return { ...f, closed, settled, request, retry: (overrides = {}) => prepareRetry({ teamRoot: f.team, request: request(), rules, ...overrides }) };
}

test('retry prepare compiles the continuation from the kept journal, takes the lease and admits the closed candidate', async t => {
  const f = await failed(t), result = f.retry();
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.stage, 'retry-prepared'); assert.equal(result.ticket, 'US-08'); assert.equal(result.duty, 'exec'); assert.equal(result.attempt, 2);
  assert.equal(result.continuationOf, 'US-08.exec.1'); assert.equal(result.resumeAgentId, 'exec1', 'the agent the PM session resumes');
  assert.equal(result.wrapper, 'sample-worker-exec'); assert.match(result.renderedBrief, /US-08\.exec\.1/);
  assert.equal(result.closeDigest, f.closed.digest); assert.equal(result.settlementDigest, f.settled.digest);
  const held = readLease({ productRoot: f.product });
  assert.equal(held.status, 'held'); assert.equal(result.lease, held.lease.digest);
  const state = inspectRetryJournal({ journal: result.journal, rules });
  assert.deepEqual(state.assignments.at(-1), { ...state.assignments.at(-1), assignmentId: 'US-08.exec.2', status: 'prepared', attempt: 2 });
  const { digest: recorded, ...body } = result;
  assert.equal(recorded, digest(body)); assert.deepEqual(JSON.parse(readFileSync(join(f.team, 'rw-retry-1.json'), 'utf8')), result);
  assert.ok(!JSON.stringify(result).includes(f.base), 'no host path in the record');
  assert.equal(refusal(f.retry()).code, 'LAUNCH_REFUSED', 'one retry is pending at a time');
  assert.equal(readLease({ productRoot: f.product }).lease.digest, result.lease);
});

test('retry prepare refuses and takes nothing when the ticket may not be retried or the product moved', async t => {
  const passed = await failed(t, {});
  assert.equal(refusal(passed.retry()).code, 'RETRY_STOPPED', 'a passing check is not retried'); assert.equal(passed.leased(), 'free');
  const moved = await failed(t); writeFileSync(join(moved.product, 'src/tag-list/view.ts'), 'edited after close\n');
  assert.match(refusal(moved.retry()).reason, /CANDIDATE_NOT_ADMITTED/); assert.equal(moved.leased(), 'free');
  assert.equal(existsSync(join(moved.team, 'rw-retry-1.json')), false);
  const narrow = inputFixture(); narrow.mandate.allowedWritePaths = ['src/tag-list/**']; narrow.proposal.expectedPaths = ['src/tag-list/view.ts'];
  const wider = await failed(t, failingCheck, { inputs: [narrow] });
  assert.match(refusal(wider.retry()).reason, /write boundary/, 'the retry asks for paths the run was not armed for'); assert.equal(wider.leased(), 'free');
  const stale = await failed(t), other = stale.request(); other.input.baseline.candidateRef = { id: 'another', digest: digest('another') };
  assert.equal(refusal(stale.retry({ request: other })).code, 'STALE_CANDIDATE');
  const unsettled = await ran(t, failingCheck); unsettled.close();
  assert.match(refusal(prepareRetry({ teamRoot: unsettled.team, request: passed.request(), rules })).reason, /settled/);
});

test('CLI prepares a retry from REQUEST.json; exit 0 prepared, 2 refused, 1 usage', async t => {
  const f = await failed(t), file = join(f.base, 'retry.json'), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify(f.request()));
  assert.equal(run('retry', file).status, 1);
  const ok = run('retry', file, '--team-root', f.team);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).stage, 'retry-prepared');
  assert.equal(run('retry', file, '--team-root', f.team).status, 2);
});
