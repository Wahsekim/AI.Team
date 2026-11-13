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
  assert.match(JSON.parse(readFileSync(join(f.team, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command, /scripts\/hooks\/rw-write-boundary\.mjs"$/);
  assert.equal(run('prepare', file, '--team-root', f.team, '--product-root', f.product).status, 2);
  assert.equal(run('prepare', file).status, 1); assert.equal(run('launch', file, '--team-root', f.team, '--product-root', f.product).status, 1);
});

// A prepared copy and the return of the real engine for its arguments (mock agents, no model).
async function ran(t) {
  const f = fixture(t), launch = await f.prepare();
  const { result } = await runWorkflow({ scriptPath: join(f.team, '.claude/workflows/run-n-rounds.js'), args: launch.args, agentImpl: makeAgentImpl({}) });
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
