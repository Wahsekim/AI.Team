// ADR 0010, decisions 8 to 12: the command a PM runs before a batch in a standing Router/Worker team.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, appendFileSync, readdirSync, chmodSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeBatch, abortBatch, BATCH_FILE, AFTER_FILE, RETURN_FILE, RECORDS } from '../src/router-worker/batch.mjs';
import { commitBatch, HOLD_ALL } from '../src/router-worker/batch-close.mjs';
import { settleBatch, markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { runWorkflow, makeAgentImpl, makeBudget } from '../scripts/lib/workflow-harness.mjs';
import { readLease, acquireLease, releaseLease } from '../src/router-worker/lease.mjs';
import { observeIsolation } from '../src/router-worker/isolation.mjs';
import { readBoundary, decideCall, closeBoundary } from '../src/router-worker/write-boundary.mjs';
import { DEFAULT_LIMITS, proposeLimits, changeLimits, boundLimits } from '../src/router-worker/switch.mjs';
import { fixture, git, runUnderHook, checksRan, afterBatch } from './fixtures/router-worker/standing-team.mjs';
import { meterOf } from './fixtures/router-worker/meter.mjs';
import { digest } from '../src/loop/contracts.mjs';

const refusal = result => result.errors?.[0];
const ticket = (id, paths, extra = {}) => ({ id, title: `Ticket ${id}`, goal: `Do ${id}`, acceptance: [`${id} works`], paths, estimate: { execTokens: 12000, checkTokens: 6000, reworkTokens: 6000 }, ...extra });
const batchOf = (...tickets) => ({ tickets, verificationCommands: ['npm test'], sensitivePaths: ['src/auth/**'], nextLifecycleNumber: 1 });
// A live Router/Worker team whose product is on a working branch.
function live(t) {
  const f = fixture(t); assert.equal(f.apply('router-worker', { spec: f.spec, limits: { allowedCommands: ['npm test', 'npm run lint'] } }).errors, undefined); git(f.product, 'checkout', '-q', '-b', 'work');
  const before = (batch, extra = {}) => beforeBatch({ teamRoot: f.kit, instanceRoot: f.root, batch, ...extra });
  const untouched = () => { assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
    assert.ok(Object.values(readBoundary(f.root).wrappers).every(entry => entry.writePaths.length === 0), 'the boundary is closed'); };
  return { ...f, before, untouched };
}

test('before freezes N tickets, computes the ceiling, takes the lock and opens the write boundary for the batch only', async t => {
  const f = live(t), record = await f.before(batchOf(ticket('US-01', ['src/list/**', 'src/app.js']), ticket('US-02', ['src/api/tags.js'])));
  assert.equal(record.errors, undefined, JSON.stringify(record.errors));
  assert.equal(record.stage, 'batch-open'); assert.equal(record.branch, 'work'); assert.deepEqual(record.preexisting, []);
  assert.equal(record.args.rounds, 2); assert.equal(record.args.failurePolicy, 'halt-on-failure'); assert.equal(record.args.maxAttemptsPerTicket, 1);
  assert.equal(record.args.budgetCeilingTokens, 2 * DEFAULT_LIMITS.outputAllowancePerTicket + DEFAULT_LIMITS.guardianOutputShare, 'N times the allowance plus the Guardian\'s share');
  assert.deepEqual(record.ceiling, { outputTokens: 36000, stopLine: 28800 });
  assert.equal(record.args.guardianAgentType, 'tag-list-fixture-worker-guard'); assert.equal(record.args.plan.length, 2);
  assert.deepEqual(record.runRecord.items.map(item => [item.ticket, item.authorizedTokens]), [['US-01', 200000], ['US-02', 200000]]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, BATCH_FILE), 'utf8')), record);
  const lease = readLease({ productRoot: f.product }); assert.equal(lease.status, 'held'); assert.equal(lease.lease.digest, record.lease);
  const boundary = readBoundary(f.root), write = (agent, path) => decideCall({ boundary, input: { tool_name: 'Edit', agent_type: agent, cwd: f.product, tool_input: { file_path: path } } }).decision;
  assert.equal(write('tag-list-fixture-worker-exec', 'src/list/view.js'), 'allow'); assert.equal(write('tag-list-fixture-worker-exec', 'src/api/tags.js'), 'allow');
  assert.equal(write('tag-list-fixture-worker-exec', 'src/other.js'), 'deny'); assert.equal(write('tag-list-fixture-worker-check', 'src/app.js'), 'deny');
  assert.deepEqual(record.sensitivePaths, ['src/auth/**']); assert.deepEqual(record.tickets[1], { id: 'US-02', title: 'Ticket US-02', goal: 'Do US-02', acceptance: ['US-02 works'], commitMessage: 'US-02: Ticket US-02', paths: ['src/api/tags.js'], expectedPaths: ['src/api/tags.js'], dependsOn: [], moves: [], deletes: [], declared: [], earlierRuns: { runs: [], count: 0 } });
  assert.match(refusal(await f.before(batchOf(ticket('US-03', ['src/x.js'])))).reason, /already open/);
  assert.equal(readLease({ productRoot: f.product }).lease.digest, record.lease, 'the open batch keeps its lock'); assert.equal(write('tag-list-fixture-worker-exec', 'src/list/view.js'), 'allow');
});

test('in a batch a worker\'s shell runs the confirmed verification commands from the product root, exactly as written, and nothing else', async t => {
  const f = live(t), exec = 'tag-list-fixture-worker-exec', check = 'tag-list-fixture-worker-check', one = batchOf(ticket('US-01', ['src/a.js']));
  // A command the owner did not confirm for the team stops the batch before anything is taken.
  assert.match(refusal(await f.before({ ...one, verificationCommands: ['npm test', 'npm run e2e'] })).reason, /not among the commands the owner confirmed for this team \(npm run e2e\).*team-mode\.mjs limits/); f.untouched();
  // It needs nothing from the product, so it is named first, before a product state the PM would fix in vain.
  writeFileSync(join(f.product, 'stray.txt'), 'x\n');
  assert.match(refusal(await f.before({ ...one, verificationCommands: ['npm test', 'npm run e2e'] })).reason, /not among the commands the owner confirmed/); rmSync(join(f.product, 'stray.txt'));
  assert.equal((await f.before(one)).errors, undefined);
  const shell = (agent, command, cwd = f.root, extra = {}) => decideCall({ boundary: readBoundary(f.root), input: { tool_name: 'Bash', ...(agent ? { agent_type: agent } : {}), cwd, tool_input: { command, ...extra } } });
  assert.equal(shell(exec, `cd "${f.product}" && npm test`).decision, 'approve'); assert.equal(shell(check, `cd ${f.product} && npm test`).decision, 'approve');
  assert.equal(shell(check, 'npm test', f.product).decision, 'approve', 'already at the product root'); assert.equal(shell(exec, ` cd "${f.product}" && npm test \n`, f.root, { run_in_background: true, timeout: 600000 }).decision, 'approve');
  // The same words run somewhere else are another command: the team folder, a folder of the product, a folder beside it.
  for (const elsewhere of [f.root, join(f.product, 'src'), `${f.product}x`, `${f.product}/../product`]) assert.equal(shell(exec, 'npm test', elsewhere).decision, 'deny', elsewhere);
  for (const other of [`cd "${f.product}" && npm test && rm -rf src`, `cd "${f.product}" && npm test -- --watch`, `cd "${f.product}"; npm test`, 'npm test; ls', 'ls', 'git status', '', `cd "${f.product}x" && npm test`,
    `cd "${f.product}" && npm test\u00a0`, `cd "${f.product}" && npm test\r`, `cd "${f.product}" && npm run lint`])
    assert.equal(shell(exec, other, f.product).decision, 'deny', JSON.stringify(other));
  assert.equal(shell(exec, `cd "${f.product}" && npm test`, f.root, { dangerouslyDisableSandbox: true }).decision, 'deny', 'not outside a sandbox');
  // A product path a shell would read differently: only a form that means that folder is approved.
  const at = root => command => decideCall({ boundary: { productRoot: root, wrappers: { [exec]: { duty: 'exec', writePaths: [], commands: ['npm test'] } } }, input: { tool_name: 'Bash', agent_type: exec, cwd: '/t', tool_input: { command } } }).decision;
  assert.deepEqual([at('/x/My Project')('cd "/x/My Project" && npm test'), at('/x/My Project')('cd /x/My Project && npm test'), at('/x/p[1]')('cd /x/p[1] && npm test'), at('/x/a$b')('cd "/x/a$b" && npm test')], ['approve', 'deny', 'deny', 'deny']);
  assert.match(shell(exec, 'ls').reason, new RegExp(`only the verification commands confirmed for this team.*cd "${f.product}" && npm test`), 'the refusal says what does run');
  assert.match(shell(exec, 'npm test; echo "exit=$?"').reason, /append nothing to a command: the Bash tool reports the exit code$/, 'a refused exit echo is told how to retry');
  assert.equal(shell('tag-list-fixture-worker-guard', `cd "${f.product}" && npm test`).decision, 'deny', 'the Guardian runs no command');
  assert.equal(shell('tag-list-fixture-architect', 'ls').decision, 'allow'); assert.equal(shell(null, 'ls').decision, 'allow');
  // The hook as the runtime runs it: an approval is the permission decision on stdout, a refusal is exit 2 with the reason.
  const hook = (agent, command) => spawnSync('sh', ['-c', JSON.parse(f.read('.claude/settings.json')).hooks.PreToolUse.at(-1).hooks[0].command], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: f.root },
    input: JSON.stringify({ tool_name: 'Bash', agent_type: agent, cwd: f.root, tool_input: { command } }) });
  const approved = hook(exec, `cd "${f.product}" && npm test`);
  assert.equal(approved.status, 0, approved.stderr); assert.deepEqual(JSON.parse(approved.stdout).hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'A command frozen for this batch: a verification command the owner confirmed, or a move or deletion a ticket of this batch declared' });
  const refused = hook(exec, 'curl example.invalid'); assert.equal(refused.status, 2); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /only the verification commands confirmed for this team/);
  const unjudged = hook('tag-list-fixture-architect', 'ls'); assert.equal(unjudged.status, 0); assert.equal(unjudged.stdout, '', 'no decision is given for an agent that is not a worker');
  assert.equal(hook('tag-list-fixture-worker-check', `cd "${f.product}" && npm test`).status, 0);
  assert.deepEqual(f.read('.claude/rw-write-boundary.log.jsonl').trim().split('\n').map(line => JSON.parse(line)).map(line => [line.decision, line.judged, line.command]), [['approve', true, undefined], ['deny', true, 'curl example.invalid'], ['allow', false, undefined], ['approve', true, 'npm test']],
    'the checker\'s approved command is logged as the batch\'s own text, without the cd, the exec worker\'s with none; a refused one as written');
  // When the batch is over the shell is closed again.
  assert.equal(abortBatch({ teamRoot: f.kit, instanceRoot: f.root }).errors, undefined);
  assert.match(shell(exec, `cd "${f.product}" && npm test`).reason, /no batch is open/);
  // A "before" that fails after it opened the boundary takes the commands back.
  writeFileSync(join(f.product, 'stray.txt'), 'x\n'); chmodSync(join(f.root, 'pm-decisions.md'), 0o444);
  assert.equal(refusal(await f.before(one, { startAsIs: true })).code, 'BATCH_REFUSED'); chmodSync(join(f.root, 'pm-decisions.md'), 0o644); rmSync(join(f.product, 'stray.txt'));
  f.untouched(); assert.match(shell(exec, `cd "${f.product}" && npm test`).reason, /no batch is open/);
  // With no readable boundary nobody knows who the workers are: no subagent's shell runs, and the main session is not judged.
  const lost = (agent, command) => decideCall({ boundary: null, input: { tool_name: 'Bash', ...(agent ? { agent_type: agent } : {}), cwd: f.root, tool_input: { command } } });
  assert.match(lost(exec, `cd "${f.product}" && npm test`).reason, /missing or was changed; no subagent runs a shell command/); assert.equal(lost('tag-list-fixture-architect', 'ls').decision, 'deny'); assert.equal(lost(null, 'ls').decision, 'allow');
  const boundaryText = f.read('.claude/rw-write-boundary.json'); writeFileSync(join(f.root, '.claude/rw-write-boundary.json'), boundaryText.replace('"exec"', '"check"'));
  assert.equal(hook(exec, 'ls').status, 2, 'an edited boundary file'); rmSync(join(f.root, '.claude/rw-write-boundary.json')); assert.equal(hook(exec, 'ls').status, 2, 'no boundary file'); writeFileSync(join(f.root, '.claude/rw-write-boundary.json'), boundaryText);
  // A boundary that carries no command list (a disposable launch) does not judge the shell.
  assert.equal(decideCall({ boundary: { productRoot: f.product, wrappers: { [exec]: { duty: 'exec', writePaths: [] } } }, input: { tool_name: 'Bash', agent_type: exec, cwd: f.root, tool_input: { command: 'ls' } } }).decision, 'allow');
  // A team that went live before the list existed holds none in its limits: no batch opens until the owner confirms one.
  const old = live(t), profile = JSON.parse(old.read('profiles/team-mode.json')), { allowedCommands: _none, ...counts } = profile.limits;
  writeFileSync(join(old.root, 'profiles/team-mode.json'), JSON.stringify({ ...profile, limits: counts }));
  assert.equal(refusal(await old.before(one)).code, 'LIMITS_NOT_BOUND');
  // Its boundary carries no command list either, so its workers' shell is not judged until the owner confirms one.
  const stood = readBoundary(old.root), bare = sealAgain({ schemaVersion: 1, productRoot: stood.productRoot, wrappers: Object.fromEntries(Object.entries(stood.wrappers).map(([name, entry]) => [name, { duty: entry.duty, writePaths: [] }])) });
  writeFileSync(join(old.root, '.claude/rw-write-boundary.json'), JSON.stringify(bare));
  const oldShell = () => decideCall({ boundary: readBoundary(old.root), input: { tool_name: 'Bash', agent_type: exec, cwd: old.root, tool_input: { command: 'ls' } } }).decision;
  assert.equal(oldShell(), 'allow');
  const added = proposeLimits({ teamRoot: old.kit, instanceRoot: old.root, limits: { allowedCommands: ['npm test'] } });
  assert.equal(added.errors, undefined, JSON.stringify(added.errors)); assert.deepEqual([added.from.allowedCommands, added.to.allowedCommands], [undefined, ['npm test']], 'a limit the old profile lacks is shown unset');
  assert.equal(changeLimits({ teamRoot: old.kit, instanceRoot: old.root, limits: { allowedCommands: ['npm test'] }, confirm: added.digest, atTerminal: true }).errors, undefined);
  assert.equal(oldShell(), 'deny', 'the change of limits closes the shell of a team that had no list');
  assert.match(old.read('pm-decisions.md'), /LIMITS CHANGED: allowedCommands unset -> \["npm test"\];/); assert.equal((await old.before(one)).errors, undefined);
});

test('before refuses a product repository whose path a quoted shell command cannot hold', async t => {
  const f = live(t), odd = join(f.base, 'pro!duct'), profile = JSON.parse(f.read('profiles/team-mode.json'));
  cpSync(f.product, odd, { recursive: true });
  writeFileSync(join(f.root, 'profiles/team-mode.json'), JSON.stringify({ ...profile, spec: { ...profile.spec, project: { ...profile.spec.project, productRoot: odd } } }));
  assert.match(refusal(await f.before(batchOf(ticket('US-01', ['src/a.js'])))).reason, /cannot be written inside a quoted shell command/);
  assert.equal(readLease({ productRoot: odd }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
});

test('a change of limits that cannot close the boundary of a team without a command list changes nothing', t => {
  const old = live(t), profile = JSON.parse(old.read('profiles/team-mode.json')), { allowedCommands: _none, ...counts } = profile.limits;
  writeFileSync(join(old.root, 'profiles/team-mode.json'), JSON.stringify({ ...profile, limits: counts }));
  const stood = readBoundary(old.root), boundaryFile = join(old.root, '.claude/rw-write-boundary.json');
  writeFileSync(boundaryFile, JSON.stringify(sealAgain({ schemaVersion: 1, productRoot: stood.productRoot, wrappers: Object.fromEntries(Object.entries(stood.wrappers).map(([name, entry]) => [name, { duty: entry.duty, writePaths: [] }])) })));
  const saved = old.read('profiles/team-mode.json'), ledger = old.read('pm-decisions.md');
  const proposal = proposeLimits({ teamRoot: old.kit, instanceRoot: old.root, limits: { allowedCommands: ['npm test'] } });
  chmodSync(boundaryFile, 0o444);
  const changed = changeLimits({ teamRoot: old.kit, instanceRoot: old.root, limits: { allowedCommands: ['npm test'] }, confirm: proposal.digest, atTerminal: true });
  chmodSync(boundaryFile, 0o644);
  assert.equal(refusal(changed).code, 'LIMITS_REFUSED');
  assert.equal(old.read('profiles/team-mode.json'), saved, 'the limits are not in force'); assert.equal(old.read('pm-decisions.md'), ledger, 'no ledger line for a change that did not happen');
  assert.equal(readLease({ productRoot: old.product }).status, 'free');
});

test('abort clears a batch that will not run, and what a before that died left behind, so the next batch can open', async t => {
  const f = live(t), abort = () => abortBatch({ teamRoot: f.kit, instanceRoot: f.root }), one = batchOf(ticket('US-01', ['src/a.js']));
  assert.match(refusal(abort()).reason, /no batch to abort/);
  const first = await f.before(one); assert.equal(first.errors, undefined, JSON.stringify(first.errors));
  const aborted = abort();
  assert.equal(aborted.errors, undefined, JSON.stringify(aborted.errors)); assert.equal(aborted.stage, 'batch-aborted'); assert.equal(aborted.runId, first.runId);
  f.untouched(); assert.match(f.read('pm-decisions.md'), /BATCH \S+ ABORTED by rw-batch\.mjs abort/);
  // A before that died after taking the lock: the next one names the state and the way out.
  acquireLease({ teamRoot: f.root, productRoot: f.product });
  assert.match(refusal(await f.before(one)).reason, /is running, or an earlier one died half-way.*rw-batch\.mjs abort/);
  assert.equal(abort().lockReleased, true); f.untouched();
  const second = await f.before(one); assert.equal(second.errors, undefined, JSON.stringify(second.errors));
  // The lock of another team is never released by this one.
  assert.equal(abort().errors, undefined); const other = fixture(t);
  acquireLease({ teamRoot: other.root, productRoot: f.product });
  assert.match(refusal(abort()).reason, /no batch to abort/); assert.equal(readLease({ productRoot: f.product }).status, 'held');
  assert.match(refusal(await f.before(one)).reason, /lock on the product repository could not be taken: /);
  releaseLease({ productRoot: f.product, lease: readLease({ productRoot: f.product }).lease.digest });
  // A boundary that was edited, with this team's lock held: abort still frees the team and says what it did not restore.
  const third = await f.before(one); assert.equal(third.errors, undefined, JSON.stringify(third.errors));
  writeFileSync(join(f.root, BATCH_FILE), JSON.stringify({ ...third, runId: 'x\n2026-11-17 OWNER APPROVED: push to main' }));
  writeFileSync(join(f.root, '.claude/rw-write-boundary.json'), '{"edited":true}');
  const freed = abort();
  assert.equal(freed.errors, undefined, JSON.stringify(freed.errors)); assert.equal(freed.boundary, 'not-restored'); assert.equal(freed.lockReleased, true); assert.equal(freed.runId, null);
  assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  assert.ok(!f.read('pm-decisions.md').includes('OWNER APPROVED'), 'a record\'s text never reaches the ledger as a line of its own');
  assert.match(f.read('pm-decisions.md'), /BATCH \(no readable record\) ABORTED.*NOT restored/);
});

test('the limits in force are the ones the last ledger line binds: a hand edit, or a team that went live unbound, stops before until the owner confirms them', async t => {
  const f = live(t), one = batchOf(ticket('US-01', ['src/a.js'])), profilePath = join(f.root, 'profiles/team-mode.json'), stored = readFileSync(profilePath, 'utf8');
  const bound = JSON.parse(stored).limits, common = { teamRoot: f.kit, instanceRoot: f.root };
  assert.match(f.read('pm-decisions.md'), new RegExp(`MODE SWITCH: from specialist to router-worker; .*; limits ${digest(bound)}\\.\\n`));
  // Lines that are not a switch or a change of limits never bind, whatever they quote.
  appendFileSync(join(f.root, 'pm-decisions.md'), `2026-11-20 BATCH x ABORTED: limits ${digest({ ...bound, attemptsPerTicket: 3 })}.\nfree text; limits sha256:${'0'.repeat(64)}.\n`
    + `2026-11-20 LIMITS CHANGED: attemptsPerTicket 1 -> 3; proposal sha256:${'1'.repeat(64)} was confirmed by a program that called the change directly, not at a terminal; limits ${digest({ ...bound, attemptsPerTicket: 3 })}.\n`);
  writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(stored), limits: { ...bound, attemptsPerTicket: 3 } }));
  const stopped = refusal(await f.before(one));
  assert.equal(stopped.code, 'LIMITS_NOT_BOUND'); assert.match(stopped.reason, /not the limits the owner last confirmed.*team-mode\.mjs limits <LIMITS\.json> --instance <instance-root>/); f.untouched();
  // The owner re-confirms the limits as they stand: the proposal changes nothing, the ledger line binds them.
  const again = proposeLimits({ ...common, limits: {} });
  assert.equal(again.errors, undefined, JSON.stringify(again.errors)); assert.deepEqual(again.from, again.to); assert.equal(again.to.attemptsPerTicket, 3);
  assert.equal(changeLimits({ ...common, limits: {}, confirm: again.digest, atTerminal: true }).errors, undefined);
  assert.match(f.read('pm-decisions.md'), new RegExp(`LIMITS CHANGED: none, the limits in force re-confirmed as they stand; .*; limits ${digest(again.to)}\\.\\n`));
  assert.match(refusal(proposeLimits({ ...common, limits: {} })).reason, /already has/, 'bound limits are not re-confirmed');
  const opened = await f.before(one); assert.equal(opened.errors, undefined, JSON.stringify(opened.errors)); assert.equal(opened.limits.attemptsPerTicket, 3);
  assert.equal(abortBatch(common).errors, undefined);
  writeFileSync(join(f.root, 'pm-decisions.md'), f.read('pm-decisions.md').replace(/\n/g, '\r\n'));
  assert.equal(boundLimits(f.root), digest(again.to), 'a ledger saved with CRLF line ends');
  // A team that went live before the ledger bound its limits.
  const old = live(t), ledgerPath = join(old.root, 'pm-decisions.md');
  writeFileSync(ledgerPath, old.read('pm-decisions.md').replace(/; limits sha256:[a-f0-9]{64}\./g, '.'));
  assert.equal(refusal(await old.before(one)).code, 'LIMITS_NOT_BOUND'); old.untouched();
  const legacy = proposeLimits({ teamRoot: old.kit, instanceRoot: old.root, limits: {} }); assert.equal(legacy.errors, undefined, JSON.stringify(legacy.errors));
  assert.equal(changeLimits({ teamRoot: old.kit, instanceRoot: old.root, limits: {}, confirm: legacy.digest, atTerminal: true }).errors, undefined);
  assert.equal((await old.before(one)).errors, undefined);
});

test('the isolation check accepts for a standing team only what the decisions accept', t => {
  const f = live(t), observed = observeIsolation({ teamRoot: f.root, productRoot: f.product, dispatch: 'engine', standing: ['OWNERSHIP_NOT_HELD', 'PRODUCT_DIRTY', 'WRAPPER_MISSING'] });
  assert.equal(observed.status, 'blocked'); assert.equal(observed.findings.find(finding => finding.code === 'OWNERSHIP_NOT_HELD').severity, 'blocked');
});

test('before refuses, and leaves the lock free and the boundary closed, when the batch or the repository is not fit', async t => {
  const f = live(t), refused = async (batch, pattern, extra) => { const result = await f.before(batch, extra); assert.match(refusal(result)?.reason ?? JSON.stringify(result).slice(0, 200), pattern); f.untouched(); };
  await refused(batchOf(ticket('US-01', ['src/a.js']), ticket('US-02', ['src/a.js'])), /US-01 and US-02 claim the same file \(src\/a\.js\)/);
  await refused(batchOf(ticket('US-01', ['src/list/**', 'src/x.js']), ticket('US-02', ['src/list/view.js'])), /claim the same file/);
  await refused(batchOf(ticket('US-01', ['src/A.js']), ticket('US-02', ['src/a.js'])), /claim the same file/);
  await refused(batchOf(ticket('US-01', ['src/a.js']), ticket('us-01', ['src/b.js'])), /appears twice/);
  await refused(batchOf(ticket('US-01', ['src/list/**'])), /grants only folders; add "expectedPaths"/);
  await refused(batchOf(ticket('US-01', ['.git/hooks/pre-commit', 'src/a.js'])), /no ticket writes under \.git or \.claude/);
  await refused(batchOf(ticket('US-01', ['.claude/**'], { expectedPaths: ['.claude/x'] })), /no ticket writes under/);
  await refused(batchOf(ticket('US-01', ['sub/.git/hooks/x'])), /no ticket writes under/);
  await refused(batchOf(...Array.from({ length: 51 }, (_, i) => ticket(`T-${i}`, [`src/f${i}.js`, `src/g${i}.js`]))), /at most 100 paths in all \(102 given\)/);
  await refused(batchOf(...Array.from({ length: 101 }, (_, i) => ticket(`T-${i}`, [`src/f${i}.js`]))), /1 to 100 tickets/);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { estimate: { execTokens: 1, checkTokens: 1, reworkTokens: 1, bonus: 5 } })), /estimate must carry exactly/);
  await refused({ ...batchOf(ticket('US-01', ['src/a.js'])), sensitivePaths: [] }, /sensitivePaths must list/);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { acceptance: [] })), /US-01 is incomplete: acceptance missing/);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { goal: undefined })), /incomplete: goal/);
  await refused({ ...batchOf(ticket('US-01', ['src/a.js'])), budgetCeilingTokens: 999999 }, /must carry/, undefined);
  await refused(batchOf(ticket('US-01', ['src/a.js'], { estimate: { execTokens: 150000, checkTokens: 60000, reworkTokens: 6000 } })), /cannot be frozen.*estimate/i);
  // Refusals that come after the lock was taken give it back.
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /injected preflight/, { manifest: () => ({ errors: [{ reason: 'injected preflight failure' }] }) });
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /could not be prepared: boom/, { manifest: () => { throw Error('boom'); } });
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /changed while the batch was being prepared/, { manifest: () => { writeFileSync(join(f.product, 'late.txt'), 'x'); return { digest: 'sha256:' + 'a'.repeat(64) }; }, startAsIs: true });
  rmSync(join(f.product, 'late.txt'));
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /changed while the batch was being prepared/, { manifest: () => { git(f.product, 'commit', '-q', '--allow-empty', '-m', 'moved on'); return { digest: 'sha256:' + 'a'.repeat(64) }; } });
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /default branch|changed while/, { manifest: () => { git(f.product, 'checkout', '-q', '-'); return { digest: 'sha256:' + 'a'.repeat(64) }; } });
  git(f.product, 'checkout', '-q', 'work');
  // The lock taken by this command is replaced by another holder's while it prepares: the batch does not open, and the other lock is left alone.
  const stolen = await f.before(batchOf(ticket('US-01', ['src/a.js'])), { manifest: () => { releaseLease({ productRoot: f.product, lease: readLease({ productRoot: f.product }).lease.digest }); acquireLease({ teamRoot: f.root, productRoot: f.product }); return { digest: 'sha256:' + 'a'.repeat(64) }; } });
  assert.match(refusal(stolen).reason, /lock on the product repository was released|OWNERSHIP_HELD_BY_OTHER/); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.equal(readLease({ productRoot: f.product }).status, 'held');
  releaseLease({ productRoot: f.product, lease: readLease({ productRoot: f.product }).lease.digest });
  // The limits are the mode profile's, checked again where they are used.
  const profilePath = join(f.root, 'profiles/team-mode.json'), profile = readFileSync(profilePath, 'utf8');
  writeFileSync(profilePath, JSON.stringify({ ...JSON.parse(profile), limits: { ...DEFAULT_LIMITS, attemptsPerTicket: 9 } }));
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /limits in profiles\/team-mode\.json are not valid/);
  writeFileSync(profilePath, profile);
  writeFileSync(join(f.product, 'notes.txt'), 'x\n');
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /uncommitted changes \(notes\.txt\).*start as is/);
  rmSync(join(f.product, 'notes.txt')); writeFileSync(join(f.product, '.git/MERGE_HEAD'), 'x\n');
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /in progress/, { startAsIs: true });
  rmSync(join(f.product, '.git/MERGE_HEAD')); git(f.product, 'checkout', '-q', '-');
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /default branch/, { startAsIs: true });
  git(f.product, 'checkout', '-q', 'work'); mkdirSync(join(f.root, 'holiday'), { recursive: true }); writeFileSync(join(f.root, 'holiday/.switch-in-progress.json'), '{}');
  await refused(batchOf(ticket('US-01', ['src/a.js'])), /interrupted/);
  rmSync(join(f.root, 'holiday/.switch-in-progress.json'));
  const specialist = fixture(t);
  assert.match(refusal(await beforeBatch({ teamRoot: specialist.kit, instanceRoot: specialist.root, batch: batchOf(ticket('US-01', ['src/a.js'])) })).reason, /not live in Router\/Worker mode/);
});

test('start as is: a repository that is not clean starts only on the explicit word, which is logged with the paths; ignored build output never counts', async t => {
  const f = live(t); writeFileSync(join(f.product, '.gitignore'), 'dist/\n'); git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'ignore');
  mkdirSync(join(f.product, 'dist')); writeFileSync(join(f.product, 'dist/out.js'), 'built\n');
  writeFileSync(join(f.product, 'notes.txt'), 'x\n');
  git(f.product, 'mv', 'src/app.js', 'src/app 2.js');
  const ledger = f.read('pm-decisions.md');
  assert.match(refusal(await f.before(batchOf(ticket('US-01', ['src/a.js'])), { startAsIs: true, manifest: () => ({ errors: [{ reason: 'injected' }] }) })).reason, /injected/);
  assert.equal(f.read('pm-decisions.md'), ledger, 'a batch that did not open leaves no ledger line');
  const record = await f.before(batchOf(ticket('US-01', ['src/a.js'])), { startAsIs: true });
  assert.equal(record.errors, undefined, JSON.stringify(record.errors)); assert.equal(record.startedAsIs, true);
  assert.deepEqual(record.preexisting, ['notes.txt', 'src/app 2.js', 'src/app.js'], 'plain paths, both sides of a rename');
  assert.match(f.read('pm-decisions.md'), /BATCH \S+ STARTED AS IS: 3 path\(s\) were already changed.*notes\.txt/);
});

test('CLI: before prints the batch record with the preflight manifest chained into the arguments; exit 0 open, 2 refused, 1 usage', t => {
  const f = live(t), file = join(f.base, 'batch.json'), run = (...argv) => spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify(batchOf(ticket('US-01', ['src/a.js']))));
  assert.equal(run('before').status, 1); assert.equal(run('before', file, '--instance', f.root, '--bogus').status, 1); assert.equal(run('finish', file, '--instance', f.root).status, 1);
  const done = run('before', file, '--instance', f.root);
  assert.equal(done.status, 0, done.stdout + done.stderr); const record = JSON.parse(done.stdout);
  assert.equal(record.stage, 'batch-open'); assert.equal(record.launchManifest, 'chained'); assert.match(record.args.launchManifestDigest, /^sha256:[a-f0-9]{64}$/);
  const again = run('before', file, '--instance', f.root);
  assert.equal(again.status, 2); assert.match(again.stderr, /already open/);
  assert.equal(run('before', join(f.base, 'absent.json'), '--instance', f.root).status, 2);
  assert.equal(run('abort').status, 1); const cleared = run('abort', '--instance', f.root);
  assert.equal(cleared.status, 0, cleared.stderr); assert.equal(JSON.parse(cleared.stdout).stage, 'batch-aborted'); assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(run('abort', '--instance', f.root).status, 2);
});

// A batch run by the real engine with mock agents; `edits` is what the workers leave in the product, `spend` the output tokens of each agent call.
async function ran(t, { tickets, agents = {}, edits = {}, hook = true, extra = {}, hooks = () => ({}), fields = {}, spend = 0, seed = {} }) {
  const f = live(t);
  // Files the product's history holds before the batch opens.
  for (const [path, text] of Object.entries(seed)) { writeFileSync(join(f.product, path), text); git(f.product, 'add', path); git(f.product, 'commit', '-q', '-m', `seed ${path}`); }
  // Commit hooks the repository had before the batch; one written later is a finding.
  for (const [name, script] of Object.entries(hooks(f))) writeFileSync(join(f.product, '.git/hooks', name), script, { mode: 0o755 });
  const open = await f.before({ ...batchOf(...tickets), ...fields }, extra);
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  // The Guardian's brief is kept as the engine wrote it: it names the run, and the settlement reads that.
  let guardianBrief = null; const mock = makeAgentImpl(agents), budget = makeBudget(), agentImpl = (prompt, opts, index) => { if (opts?.schema?.required?.includes('runawayDetected')) guardianBrief = prompt; budget.bump(spend); return mock(prompt, opts, index); };
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl, budgetImpl: budget });
  for (const [path, text] of Object.entries(edits)) { mkdirSync(join(f.product, path, '..'), { recursive: true }); writeFileSync(join(f.product, path), text); }
  if (hook) checksRan(f.root, open);
  const after = () => afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result }), commit = () => commitBatch({ teamRoot: f.kit, instanceRoot: f.root });
  const log = () => git(f.product, 'log', '--format=%s', `${open.productHead}..HEAD`).trim().split('\n').filter(Boolean).reverse();
  // The next batch opens only after this one is settled; a test that is about something else marks it as not metered.
  const unmetered = () => assert.equal(markNotMetered({ teamRoot: f.kit, instanceRoot: f.root, reason: 'not measured in this test', runId: open.runId }).errors, undefined);
  return { ...f, open, result, guardianBrief, after, commit, log, unmetered, status: () => git(f.product, 'status', '--porcelain').trim() };
}
const two = [ticket('US-01', ['src/list/**', 'src/app.js'], { expectedPaths: ['src/app.js'] }), ticket('US-02', ['src/api/tags.js'], { commitMessage: 'feat(api): tags endpoint' })];

test('after matches the engine return, closes the boundary and frees the lock; commit makes one commit per ticket and archives the batch', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n', 'src/list/view.js': 'view\n', 'src/api/tags.js': 'tags\n' } });
  assert.match(refusal(f.commit()).reason, /has not been closed/);
  const closed = f.after();
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.stage, 'batch-closed'); assert.equal(closed.status, 'clean', JSON.stringify(closed.findings) + JSON.stringify(closed.account.blockers));
  assert.deepEqual(closed.tickets.map(entry => [entry.id, entry.status, entry.changedPaths]), [['US-01', 'passed', ['src/app.js', 'src/list/view.js']], ['US-02', 'passed', ['src/api/tags.js']]]);
  assert.deepEqual(closed.commits.map(entry => [entry.ticket, entry.message]), [['US-01', 'US-01: Ticket US-01'], ['US-02', 'feat(api): tags endpoint']]); assert.deepEqual(closed.left, []);
  assert.deepEqual(closed.limits, [], 'no limit stopped the work');
  assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.ok(Object.values(readBoundary(f.root).wrappers).every(entry => entry.writePaths.length === 0), 'no worker may write any more');
  assert.match(refusal(f.after()).reason, /already closed/); assert.match(refusal(await f.before(batchOf(ticket('US-09', ['src/z.js'])))).reason, /already open/);
  assert.equal(git(f.product, 'rev-parse', 'HEAD').trim(), f.open.productHead, 'after commits nothing');
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(done.stage, 'batch-committed'); assert.equal(done.pushed, false);
  assert.deepEqual(f.log(), ['US-01: Ticket US-01', 'feat(api): tags endpoint']); assert.equal(f.status(), '', 'the product is clean again');
  assert.deepEqual(git(f.product, 'show', '--name-only', '--format=', 'HEAD~1').trim().split('\n').sort(), ['src/app.js', 'src/list/view.js'], 'each commit holds its ticket\'s files only');
  assert.equal(git(f.product, 'symbolic-ref', '--short', 'HEAD').trim(), 'work');
  assert.deepEqual(readdirSync(join(f.root, 'batches', f.open.runId)).sort(), ['after.json', 'batch.json', 'commit.json', 'commits.json', 'return.json']); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.equal(existsSync(join(f.root, AFTER_FILE)), false);
  assert.match(f.read('pm-decisions.md'), /BATCH \S+ CLOSED \(clean\): 2 of 2 ticket\(s\) passed; 2 to commit, 0 changed path\(s\) left/); assert.match(f.read('pm-decisions.md'), /BATCH \S+ COMMITTED on work: 2 commit\(s\).*Nothing was pushed/);
  f.unmetered(); const next = await f.before(batchOf(ticket('US-03', ['src/b.js'])));
  assert.equal(next.errors, undefined, JSON.stringify(next.errors)); assert.notEqual(next.runId, f.open.runId);
});

test('a ticket that did not pass is not committed and is set aside as a patch; a write outside every ticket is reported and left', async t => {
  let checks = 0;
  const f = await ran(t, { tickets: two, agents: { verifier: () => ++checks === 1 ? { pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: [{ command: 'npm test', exitCode: 0 }], failures: [] }
    : { pass: false, staticPass: false, e2ePass: false, summary: 'broken', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['tags test fails'] } },
    edits: { 'src/app.js': 'export const x = 2;\n', 'src/api/tags.js': 'half done\n', 'package-lock.json': '{}\n' } });
  const closed = f.after();
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.status, 'review');
  assert.deepEqual(closed.tickets.map(entry => [entry.id, entry.status]), [['US-01', 'passed'], ['US-02', 'not-passed']]);
  assert.deepEqual(closed.findings.find(finding => finding.code === 'WRITE_OUTSIDE_PATHS').paths, ['package-lock.json']);
  assert.deepEqual(closed.setAside.map(entry => [entry.ticket, entry.state, entry.patch]), [['US-02', 'patch', `left/${f.open.runId}/US-02.patch`]]);
  assert.deepEqual(closed.findings.find(finding => finding.code === 'VERIFICATION_NOT_RUN')?.paths, ['package-lock.json'], 'the path of no ticket keeps the kit from verifying');
  assert.deepEqual(closed.commits.map(entry => entry.ticket), ['US-01']); assert.deepEqual(closed.left, ['package-lock.json']);
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(f.log(), ['US-01: Ticket US-01']); assert.deepEqual(done.left, ['package-lock.json']);
  assert.match(f.read('pm-decisions.md'), /COMMITTED on work: 1 commit\(s\).*1 changed path\(s\) left uncommitted \(package-lock\.json\)/);
  // What is left makes the next batch refuse until the PM deals with it, or starts as is.
  f.unmetered();
  assert.match(refusal(await f.before(batchOf(ticket('US-03', ['src/b.js'])))).reason, /uncommitted changes/);
  const next = await f.before(batchOf(ticket('US-03', ['src/b.js'])), { startAsIs: true });
  assert.equal(next.errors, undefined, JSON.stringify(next.errors)); assert.deepEqual(next.preexisting, ['package-lock.json']);
});

test('after refuses a return that is not this batch\'s and changes nothing; findings that question the run hold every commit', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n' } });
  for (const bad of [undefined, {}, { ...f.result, runId: 'other' }, { ...f.result, results: f.result.results.slice(0, 1) }]) {
    assert.match(refusal(afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result: bad })).reason, /not the return of this batch/);
    assert.equal(readLease({ productRoot: f.product }).status, 'held'); assert.equal(existsSync(join(f.root, AFTER_FILE)), false); }
  git(f.product, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  const closed = f.after();
  assert.equal(closed.status, 'review'); assert.ok(closed.findings.some(finding => finding.code === 'PRODUCT_HEAD_MOVED')); assert.equal(closed.holdAll, true); assert.deepEqual(closed.commits, []);
  assert.equal(readLease({ productRoot: f.product }).status, 'free', 'the lock does not outlive the batch');
  assert.match(refusal(f.commit()).reason, /Every commit of this batch is held \(PRODUCT_HEAD_MOVED\); nothing can be committed\. Archive it with: rw-batch\.mjs abort/);
  assert.match(closed.next.join(' '), /No ticket of this batch is committed by the kit.*rw-batch\.mjs abort/, 'the record says what to do');
  // The way out of a closed batch the kit will not commit: its records are archived, the work stays in the tree.
  const out = abortBatch({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(out.errors, undefined, JSON.stringify(out.errors)); assert.equal(out.stage, 'batch-archived-without-commit');
  assert.equal(out.lockReleased, 'already-free', 'after had released the lock; abort does not say it failed to');
  assert.deepEqual(readdirSync(join(f.root, 'batches', f.open.runId)).sort(), ['abandoned.json', 'after.json', 'batch.json', 'return.json']); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  assert.match(f.read('pm-decisions.md'), /ARCHIVED WITHOUT COMMIT by rw-batch\.mjs abort/); assert.ok(f.status().includes('src/app.js'), 'the work is still there');
  f.unmetered(); assert.equal((await f.before(batchOf(ticket('US-07', ['src/q.js'])), { startAsIs: true })).errors, undefined, 'and the team can open its next batch');
  const noHook = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n' }, hook: false });
  assert.ok(noHook.after().findings.some(finding => finding.code === 'HOOK_SAW_NO_WORKER'), 'files changed and the hook logged no worker: the write limits were not enforced');
  const edited = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n' } });
  writeFileSync(join(edited.root, BATCH_FILE), JSON.stringify({ ...edited.open, branch: 'main' }));
  assert.match(refusal(edited.after()).reason, /was changed after the batch opened/);
});

test('after reports, and does not change, each limit that stopped work: the output ceiling, the attempts, a refused command', async t => {
  const failed = { pass: false, staticPass: false, e2ePass: false, summary: 'broken', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['the test fails'] };
  const f = await ran(t, { tickets: two, agents: { verifier: () => failed } }), exec = 'tag-list-fixture-worker-exec';
  // A worker's shell command the hook refused during the batch, as the runtime runs the hook.
  const hook = command => spawnSync('sh', ['-c', JSON.parse(f.read('.claude/settings.json')).hooks.PreToolUse.at(-1).hooks[0].command], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: f.root },
    input: JSON.stringify({ tool_name: 'Bash', agent_type: exec, cwd: f.product, tool_input: { command } }) });
  for (const command of ['npm run e2e', 'npm run e2e', 'npm test', 'cd /elsewhere && npm test', 'cd']) hook(command);
  const profile = f.read('profiles/team-mode.json');
  const tripped = { ...f.result, budgetGateTripped: true, budgetStatus: { ...f.result.budgetStatus, loopSpent: 30000, tripped: true }, guardianTokens: 2000 };
  const closed = afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result: tripped });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors));
  assert.deepEqual(closed.limits, [
    { limit: 'outputAllowancePerTicket', observed: 28000, current: 15000, proposal: { outputAllowancePerTicket: 36000 } },
    { limit: 'attemptsPerTicket', observed: 1, current: 1, proposal: { attemptsPerTicket: 2 }, tickets: ['US-01'] },
    { limit: 'allowedCommands', observed: 'npm run e2e', current: ['npm test', 'npm run lint'], proposal: null },
    ...['cd /elsewhere && npm test', 'cd'].map(observed => ({ limit: 'allowedCommands', observed, current: ['npm test', 'npm run lint'], proposal: null,
      note: 'a confirmed command, or a cd, in a form the hook does not accept; no limit change is needed. Workers run each command exactly as listed, from the product root' }))]);
  assert.equal(f.read('profiles/team-mode.json'), profile, 'nothing writes the limits');
  // The ceiling is the tickets' allowances plus the Guardian's share: the proposal is for the share that ran out.
  const closeAgain = result => { writeFileSync(join(f.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: f.open.runId, claimedAt: '2000-01-01T00:00:00.000Z' }));
    const again = afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result }); assert.equal(again.errors, undefined, JSON.stringify(again.errors)); return again.limits[0]; };
  assert.deepEqual(closeAgain({ ...tripped, guardianTokens: 20000 }), { limit: 'guardianOutputShare', observed: 20000, current: 6000, proposal: { guardianOutputShare: 26000 } });
  const { guardianTokens, ...unsplit } = tripped;
  assert.deepEqual(closeAgain(unsplit), { limit: 'outputAllowancePerTicket', observed: 30000, current: 15000, proposal: { outputAllowancePerTicket: 38000 },
    note: 'The engine return does not give the Guardian\'s spend apart: the figure per ticket includes it' });
});

test('commit refuses when the product changed after the batch was closed, keeps paths changed before the batch out of every commit, and resumes after a failure', async t => {
  const blocking = f => ({ 'pre-commit': `#!/bin/sh\n[ -e "${join(f.base, 'block')}" ] && git diff --cached --name-only | grep -q tags.js && exit 1\nexit 0\n` });
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'export const x = 2;\n', 'src/api/tags.js': 'tags\n' }, hooks: blocking }), closed = f.after();
  assert.equal(closed.errors, undefined); assert.deepEqual(closed.reviews, {}, 'no ticket is flagged for review');
  writeFileSync(join(f.product, 'src/app.js'), 'export const x = 3;\n'); writeFileSync(join(f.product, 'src/late.js'), 'late\n');
  assert.match(refusal(f.commit()).reason, /changed since the batch was closed/); assert.deepEqual(f.log(), []); assert.equal(readLease({ productRoot: f.product }).status, 'free');
  rmSync(join(f.product, 'src/late.js'));
  // The same paths with other content are not what after saw, in a batch no review flagged too.
  assert.match(refusal(f.commit()).reason, /src\/app\.js changed since the batch was closed/); assert.deepEqual(f.log(), []);
  writeFileSync(join(f.product, 'src/app.js'), 'export const x = 2;\n');
  // A commit hook that refuses the second commit: the first stays, and a second run makes only what is missing.
  writeFileSync(join(f.base, 'block'), '');
  assert.match(refusal(f.commit()).reason, /git commit failed for ticket US-02 \(1 of 2 made\)/); assert.deepEqual(f.log(), ['US-01: Ticket US-01']); assert.ok(existsSync(join(f.root, BATCH_FILE)));
  rmSync(join(f.base, 'block'));
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(f.log(), ['US-01: Ticket US-01', 'feat(api): tags endpoint']); assert.equal(done.commits.length, 2);
  assert.equal(git(f.product, 'show', 'HEAD~1:src/app.js'), 'export const x = 2;\n', 'the commit holds what after saw');

  const dirty = await (async () => { const g = live(t); writeFileSync(join(g.product, 'notes.txt'), 'mine\n'); git(g.product, 'add', 'notes.txt'); return g; })();
  assert.match(refusal(await dirty.before(batchOf(ticket('US-01', ['notes.txt', 'src/a.js'])), { startAsIs: true })).reason, /already changed and lie where a ticket of this batch writes \(notes\.txt\)/);
  const open = await dirty.before(batchOf(ticket('US-01', ['src/a.js'])), { startAsIs: true });
  const { result } = await runWorkflow({ scriptPath: join(dirty.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  writeFileSync(join(dirty.product, 'src/a.js'), 'a\n'); checksRan(dirty.root, open);
  assert.equal(afterBatch({ teamRoot: dirty.kit, instanceRoot: dirty.root, result }).errors, undefined);
  assert.equal(commitBatch({ teamRoot: dirty.kit, instanceRoot: dirty.root }).errors, undefined);
  assert.deepEqual(git(dirty.product, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['src/a.js'], 'the staged path from before the batch is not in the commit');
  assert.equal(git(dirty.product, 'status', '--porcelain').trim(), 'A  notes.txt', 'and is still staged, as the owner left it');
});

test('CLI: after exits 2 in review and runs no command on a tree that holds a path outside every ticket; commit exits 0', async t => {
  const f = await ran(t, { tickets: two, seed: { 'package.json': '{ "scripts": { "test": "exit 0" } }\n' }, edits: { 'src/app.js': 'export const x = 2;\n', 'stray.txt': 'x\n' } }), file = join(f.base, 'result.json');
  const run = (...argv) => spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify(f.result));
  assert.equal(run('after', file).status, 1); assert.equal(run('after', join(f.base, 'absent.json'), '--instance', f.root).status, 2);
  const closed = run('after', file, '--instance', f.root);
  assert.equal(closed.status, 2, 'a batch in review'); assert.equal(JSON.parse(closed.stdout).status, 'review');
  assert.deepEqual(JSON.parse(closed.stdout).findings.find(finding => finding.code === 'VERIFICATION_NOT_RUN')?.paths, ['stray.txt'], 'the path in the way is named');
  assert.equal(JSON.parse(closed.stdout).verification.ran, false);
  const done = run('commit', '--instance', f.root);
  assert.equal(done.status, 0, done.stderr); assert.equal(JSON.parse(done.stdout).commits.length, 1); assert.equal(run('commit', '--instance', f.root).status, 2);
});

const sealAgain = record => { const { digest: _old, ...body } = record; return { ...body, digest: digest(body) }; };

test('commit handles what a worker did through Git: a staged deletion, a staged rename inside a ticket, and many paths', async t => {
  const f = live(t); mkdirSync(join(f.product, 'lib')); for (const name of ['one.js', 'mv.js']) writeFileSync(join(f.product, 'lib', name), name + '\n');
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  const open = await f.before(batchOf(ticket('US-01', ['lib/**'], { expectedPaths: ['lib/one.js'] })));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  git(f.product, 'rm', '-q', 'lib/one.js'); git(f.product, 'mv', 'lib/mv.js', 'lib/moved.js');
  for (let i = 0; i < 300; i++) writeFileSync(join(f.product, 'lib', `gen ${i} é.js`), 'x\n');
  checksRan(f.root, open);
  assert.equal(afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result }).status, 'clean');
  const done = commitBatch({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(git(f.product, 'status', '--porcelain').trim(), '');
  const names = git(f.product, 'show', '--name-status', '--no-renames', '--format=', 'HEAD');
  assert.match(names, /D\tlib\/one\.js/); assert.match(names, /D\tlib\/mv\.js/); assert.match(names, /A\tlib\/moved\.js/); assert.equal(names.trim().split('\n').length, 303);
});

test('a commit hook written or moved during a batch holds it; a hook that stages more than the ticket is found out; another repository in the environment is ignored', async t => {
  // Hooks kept in the work tree, in the layouts teams use: no ticket may write where they live.
  const husky = live(t); git(husky.product, 'config', 'core.hooksPath', '.husky');
  assert.match(refusal(await husky.before(batchOf(ticket('US-01', ['.husky/**'], { expectedPaths: ['.husky/pre-commit'] })))).reason, /commit hooks live in \.husky; no ticket writes there/);
  const nine = live(t); mkdirSync(join(nine.product, '.husky/_'), { recursive: true }); git(nine.product, 'config', 'core.hooksPath', '.husky/_');
  assert.match(refusal(await nine.before(batchOf(ticket('US-01', ['.husky/pre-commit'])))).reason, /no ticket writes there/, 'husky 9: the stub folder runs the scripts beside it');
  const linked = live(t); mkdirSync(join(linked.product, 'tools/githooks'), { recursive: true }); symlinkSync('tools/githooks', join(linked.product, 'hooks')); git(linked.product, 'config', 'core.hooksPath', 'hooks');
  git(linked.product, 'add', '-A'); git(linked.product, 'commit', '-q', '-m', 'hooks');
  assert.match(refusal(await linked.before(batchOf(ticket('US-01', ['tools/githooks/**'], { expectedPaths: ['tools/githooks/pre-commit'] })))).reason, /no ticket writes there/, 'the folder the link points to');
  // A hook that appears in .git/hooks during the batch, as a worker's shell could write it; and a hooks path that is moved.
  const written = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } });
  writeFileSync(join(written.product, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch /tmp/never\n', { mode: 0o755 });
  const caught = written.after(); assert.ok(caught.findings.some(finding => finding.code === 'HOOKS_CHANGED')); assert.equal(caught.holdAll, true); assert.deepEqual(caught.commits, []);
  const handFirst = /A commit by hand runs the repository's commit hooks as you: inspect .* and remove every hook the batch added or changed, before any commit by hand/;
  assert.match(caught.next.join('\n'), handFirst, 'the PM is told to clear the hook before committing by hand');
  assert.match(abortBatch({ teamRoot: written.kit, instanceRoot: written.root }).next, handFirst, 'abort says it too before it says to commit by hand');
  const moved = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); git(moved.product, 'config', 'core.hooksPath', 'hooks');
  assert.ok(moved.after().findings.some(finding => finding.code === 'HOOKS_CHANGED'));
  const late = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(late.after().status, 'clean');
  writeFileSync(join(late.product, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.match(refusal(late.commit()).reason, /commit hooks were changed or moved/); assert.match(refusal(late.commit()).reason, handFirst); assert.deepEqual(late.log(), []);
  // Husky 9, and a worker's shell writing the script beside the stub folder, which no ticket granted.
  const stub = live(t); mkdirSync(join(stub.product, '.husky/_'), { recursive: true }); writeFileSync(join(stub.product, '.husky/_/pre-commit'), '#!/bin/sh\n. "$(dirname "$0")/../pre-commit"\n', { mode: 0o755 });
  git(stub.product, 'add', '-A'); git(stub.product, 'commit', '-q', '-m', 'husky'); git(stub.product, 'config', 'core.hooksPath', '.husky/_');
  const opened = await stub.before(batchOf(...two)), ranStub = await runWorkflow({ scriptPath: join(stub.root, '.claude/workflows/run-n-rounds.js'), args: opened.args, agentImpl: makeAgentImpl({}) });
  writeFileSync(join(stub.product, 'src/app.js'), 'x\n'); writeFileSync(join(stub.product, '.husky/pre-commit'), `#!/bin/sh\ntouch "${join(stub.base, 'ran-as-pm')}"\n`, { mode: 0o755 });
  checksRan(stub.root, opened);
  const stubbed = afterBatch({ teamRoot: stub.kit, instanceRoot: stub.root, result: ranStub.result });
  assert.deepEqual(stubbed.findings.find(finding => finding.code === 'HOOKS_WRITTEN')?.paths, ['.husky/pre-commit']); assert.equal(stubbed.holdAll, true);
  assert.ok(refusal(commitBatch({ teamRoot: stub.kit, instanceRoot: stub.root })) || true); assert.equal(existsSync(join(stub.base, 'ran-as-pm')), false, 'the script never ran');
  // A hook the repository already had that stages more than the ticket's paths: the commit is found out and the batch stops there.
  const greedy = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 'tags\n' }, hooks: () => ({ 'pre-commit': '#!/bin/sh\ngit add -A\n' }) });
  assert.equal(greedy.after().errors, undefined);
  assert.match(refusal(greedy.commit()).reason, /does not hold exactly that ticket's paths.*rw-batch\.mjs abort/);
  // An ambient GIT_DIR pointing elsewhere is ignored; an identity given in the environment is kept.
  const other = join(greedy.base, 'elsewhere'); mkdirSync(other); git(other, 'init', '-q'); git(other, 'commit', '-q', '--allow-empty', '-m', 'other');
  const env = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(env.after().errors, undefined);
  Object.assign(process.env, { GIT_DIR: join(other, '.git'), GIT_AUTHOR_NAME: 'PM Session', GIT_AUTHOR_EMAIL: 'pm@example.invalid', GIT_COMMITTER_NAME: 'PM Session', GIT_COMMITTER_EMAIL: 'pm@example.invalid' });
  const clear = () => { for (const key of ['GIT_DIR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[key]; }; t.after(clear);
  const done = env.commit(); clear();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(env.log(), ['US-01: Ticket US-01']); assert.equal(git(other, 'log', '--format=%s').trim(), 'other');
  assert.equal(git(env.product, 'log', '-1', '--format=%an <%ae>').trim(), 'PM Session <pm@example.invalid>');
});

test('after reports a repository created inside the product and a path from before the batch that was changed again', async t => {
  const f = live(t); writeFileSync(join(f.product, 'notes.txt'), 'mine\n');
  const open = await f.before(batchOf(ticket('US-01', ['lib/**'], { expectedPaths: ['lib/a.js'] })), { startAsIs: true });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  mkdirSync(join(f.product, 'lib')); writeFileSync(join(f.product, 'lib/a.js'), 'a\n'); writeFileSync(join(f.product, 'notes.txt'), 'changed by a worker\n');
  mkdirSync(join(f.product, 'lib/sub')); git(join(f.product, 'lib/sub'), 'init', '-q'); git(join(f.product, 'lib/sub'), 'commit', '-q', '--allow-empty', '-m', 'inner');
  checksRan(f.root, open);
  const closed = afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result });
  assert.deepEqual(closed.findings.find(finding => finding.code === 'NESTED_REPOSITORY').paths, ['lib/sub/']); assert.deepEqual(closed.findings.find(finding => finding.code === 'PREEXISTING_PATH_CHANGED').paths, ['notes.txt']);
  assert.deepEqual(closed.commits[0].paths, ['lib/a.js'], 'the nested repository is not in the commit'); assert.ok(closed.left.includes('lib/sub/'));
  assert.equal(commitBatch({ teamRoot: f.kit, instanceRoot: f.root }).errors, undefined);
  assert.deepEqual(git(f.product, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['lib/a.js']);
});

test('commit resumes by the commits it recorded, and refuses a branch that is not the batch\'s start plus those', async t => {
  assert.match(refusal(await live(t).before(batchOf(ticket('US-01', ['src/a.js'], { commitMessage: 'feat: x ' })))).reason, /no space at either end/);
  // A hook that rewrites the subject does not confuse the resume.
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 'tags\n' }, hooks: g => ({ 'prepare-commit-msg': '#!/bin/sh\nprintf "[auto] %s" "$(cat "$1")" > "$1"\n',
    'pre-commit': `#!/bin/sh\n[ -e "${join(g.base, 'block')}" ] && git diff --cached --name-only | grep -q tags.js && exit 1\nexit 0\n` }) });
  assert.equal(f.after().errors, undefined); writeFileSync(join(f.base, 'block'), '');
  assert.match(refusal(f.commit()).reason, /git commit failed for ticket US-02 \(1 of 2 made\)/);
  rmSync(join(f.base, 'block'));
  const done = f.commit(); assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(f.log(), ['[auto] US-01: Ticket US-01', '[auto] feat(api): tags endpoint']);
  assert.deepEqual(readdirSync(join(f.root, 'batches', f.open.runId)).sort(), ['after.json', 'batch.json', 'commit.json', 'commits.json', 'return.json']);
  // The branch rewound between after and commit.
  const rewound = live(t); git(rewound.product, 'commit', '-q', '--allow-empty', '-m', 'extra');
  const open = await rewound.before(batchOf(ticket('US-01', ['src/new.js'])));
  const { result } = await runWorkflow({ scriptPath: join(rewound.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  writeFileSync(join(rewound.product, 'src/new.js'), 'n\n'); checksRan(rewound.root, open);
  assert.equal(afterBatch({ teamRoot: rewound.kit, instanceRoot: rewound.root, result }).errors, undefined);
  git(rewound.product, 'reset', '-q', '--hard', 'HEAD~1'); writeFileSync(join(rewound.product, 'src/new.js'), 'n\n');
  assert.match(refusal(commitBatch({ teamRoot: rewound.kit, instanceRoot: rewound.root })).reason, /not the batch's start plus the commits/);
});

test('after is taken up again after a death, refuses a second caller, and is not a refusal when only the ledger fails', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), afterPath = join(f.root, AFTER_FILE);
  // An after that claimed the batch a moment ago is running.
  writeFileSync(afterPath, JSON.stringify({ stage: 'batch-closing', runId: f.open.runId, claimedAt: new Date().toISOString() }));
  assert.match(refusal(f.after()).reason, /Another after is closing this batch/); assert.match(refusal(f.commit()).reason, /has not been closed/);
  // One that died after it closed the boundary and released the lock: the next call finishes it, with no false alarm.
  closeBoundary({ teamRoot: f.root }); releaseLease({ productRoot: f.product, lease: f.open.lease });
  writeFileSync(afterPath, JSON.stringify({ stage: 'batch-closing', runId: f.open.runId, claimedAt: new Date(Date.now() - 120000).toISOString() }));
  const closed = f.after();
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.status, 'clean', JSON.stringify(closed.findings)); assert.equal(closed.commits.length, 1);
  // The ledger cannot be written: the batch is closed all the same, and says so.
  const mute = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); chmodSync(join(mute.root, 'pm-decisions.md'), 0o444);
  const quiet = mute.after(); chmodSync(join(mute.root, 'pm-decisions.md'), 0o644);
  assert.equal(quiet.errors, undefined, JSON.stringify(quiet.errors)); assert.ok(quiet.findings.some(finding => finding.code === 'LEDGER_NOT_WRITTEN')); assert.equal(readLease({ productRoot: mute.product }).status, 'free');
  // A boundary that cannot be read: the record says how it is rebuilt, and so does the next before.
  const broken = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); writeFileSync(join(broken.root, '.claude/rw-write-boundary.json'), '{}');
  const record = broken.after(); assert.ok(record.findings.some(finding => finding.code === 'BOUNDARY_NOT_RESTORED')); assert.match(record.next.join(' '), /mode switch/);
  assert.equal(abortBatch({ teamRoot: broken.kit, instanceRoot: broken.root }).stage, 'batch-archived-without-commit');
  broken.unmetered(); assert.match(refusal(await broken.before(batchOf(ticket('US-08', ['src/z.js'])), { startAsIs: true })).reason, /rebuilt by a mode switch/);
});

test('a commit that died after archiving is finished by the next call; nothing in a record the PM can write reaches a path, the ledger or a commit unchecked', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(f.after().errors, undefined);
  // The records leave the root one after another, the batch record first: a death in between leaves the after record.
  const closedText = readFileSync(join(f.root, AFTER_FILE), 'utf8'), done = f.commit(); assert.equal(done.errors, undefined);
  writeFileSync(join(f.root, AFTER_FILE), closedText);
  assert.deepEqual(f.commit(), done, 'the archived result is returned'); assert.equal(existsSync(join(f.root, AFTER_FILE)), false); assert.deepEqual(f.log(), ['US-01: Ticket US-01']);
  // A death before the first removal leaves both records; they are the archived batch's own.
  writeFileSync(join(f.root, AFTER_FILE), closedText); writeFileSync(join(f.root, BATCH_FILE), readFileSync(join(f.root, 'batches', f.open.runId, 'batch.json')));
  assert.deepEqual(f.commit(), done); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.deepEqual(f.log(), ['US-01: Ticket US-01']);

  // The engine return says "done" for a ticket whose own record says it failed.
  let checks = 0;
  const lied = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' }, agents: { verifier: () => ++checks === 1 ? { pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: [{ command: 'npm test', exitCode: 0 }], failures: [] }
    : { pass: false, staticPass: false, e2ePass: false, summary: 'broken', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['x'] } } });
  const flipped = { ...lied.result, results: lied.result.results.map((entry, i) => i === 1 ? { ...entry, done: true } : entry) };
  assert.deepEqual(afterBatch({ teamRoot: lied.kit, instanceRoot: lied.root, result: flipped }).tickets.map(entry => entry.status), ['passed', 'not-passed']);

  // Records sealed again by hand.
  const escaped = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } });
  writeFileSync(join(escaped.root, BATCH_FILE), JSON.stringify(sealAgain({ ...escaped.open, runId: '../../escaped' })));
  assert.match(refusal(escaped.after()).reason, /plain run id/); assert.equal(existsSync(join(escaped.base, 'escaped')), false);
  const stray = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'stray.txt': 's\n' } }), closed = stray.after();
  writeFileSync(join(stray.root, AFTER_FILE), JSON.stringify(sealAgain({ ...closed, commits: [{ ...closed.commits[0], paths: ['src/app.js', 'stray.txt'] }], left: [] })));
  assert.match(refusal(stray.commit()).reason, /plans a commit that is not a passed ticket's own paths/); assert.deepEqual(stray.log(), []);
});

test('each finding that questions the run holds every commit; each check of commit refuses on its own', async t => {
  assert.deepEqual([...HOLD_ALL].sort(), ['BOUNDARY_CHANGED', 'CHECK_RUNS_MISSING', 'ENTRIES_NOT_READ', 'GUARDIAN_NOT_CLEAN', 'HOOKS_CHANGED', 'HOOKS_WRITTEN', 'HOOK_SAW_NO_WORKER', 'PRODUCT_BRANCH_CHANGED', 'PRODUCT_HEAD_MOVED', 'VERIFICATION_FAILED']);
  const edits = { 'src/app.js': 'x\n' }, holds = (closed, code) => { assert.ok(closed.findings.some(finding => finding.code === code), `${code}: ${JSON.stringify(closed.findings)}`); assert.equal(closed.holdAll, true); assert.deepEqual(closed.commits, []); };
  const boundary = await ran(t, { tickets: two, edits }), file = join(boundary.root, '.claude/rw-write-boundary.json'), body = (({ digest: _old, ...rest }) => rest)(JSON.parse(readFileSync(file, 'utf8')));
  const widened = { ...body, wrappers: { ...body.wrappers, 'tag-list-fixture-worker-exec': { duty: 'exec', writePaths: ['**'] } } };
  writeFileSync(file, JSON.stringify({ ...widened, digest: digest(widened) })); holds(boundary.after(), 'BOUNDARY_CHANGED');
  const branch = await ran(t, { tickets: two, edits }); git(branch.product, 'checkout', '-q', '-b', 'elsewhere'); holds(branch.after(), 'PRODUCT_BRANCH_CHANGED');
  const guard = await ran(t, { tickets: two, edits, agents: { guardian: () => ({ verdict: 'runaway', findings: ['the worker looped'], summary: 'not clean' }) } }); holds(guard.after(), 'GUARDIAN_NOT_CLEAN');
  // A Guardian flag that reports a problem in the run holds every commit.
  const audit = (flags, verdict = 'main-session-action-required') => () => ({ runawayDetected: false, missedHaltRisk: false, budgetGateCorrect: true, droppedFixRetest: false, ...flags, verdict, findings: ['x'], newPatternCandidates: [] });
  for (const flags of [{ runawayDetected: true }, { droppedFixRetest: true }]) {
    const held = (await ran(t, { tickets: two, edits, agents: { guardian: audit(flags) } })).after();
    holds(held, 'GUARDIAN_NOT_CLEAN'); assert.ok(held.account.blockers.includes('guardian-not-clean'), JSON.stringify(held.account.blockers));
  }
  // The budget gate is judged from the engine's figures: a Guardian that finds the ceiling generous is attention only.
  const generous = (await ran(t, { tickets: two, edits, agents: { guardian: audit({ budgetGateCorrect: false }) } })).after();
  assert.equal(generous.holdAll, false); assert.equal(generous.findings.find(finding => finding.code === 'GUARDIAN_ATTENTION')?.budgetGateCorrect, false);
  const forged = await ran(t, { tickets: two, edits }), untripped = { ...forged.result, budgetStatus: { ...forged.result.budgetStatus, loopSpent: forged.result.budgetStatus.ceiling, tripped: false } };
  const gateFault = afterBatch({ teamRoot: forged.kit, instanceRoot: forged.root, result: untripped });
  holds(gateFault, 'GUARDIAN_NOT_CLEAN'); assert.deepEqual(gateFault.account.blockers, ['guardian-not-clean'], 'a clean verdict over inconsistent budget figures is still a blocker');
  holds((await ran(t, { tickets: two, edits, agents: { guardian: audit({}, 'halt-and-investigate') } })).after(), 'GUARDIAN_NOT_CLEAN');
  // No observer watched the run, as in every headless batch: recorded, nothing held.
  const unwatched = (await ran(t, { tickets: two, edits, agents: { guardian: audit({ missedHaltRisk: true }) } })).after();
  assert.equal(unwatched.holdAll, false); assert.ok(!unwatched.findings.some(finding => finding.code === 'GUARDIAN_NOT_CLEAN'));
  assert.deepEqual(unwatched.findings.find(finding => finding.code === 'GUARDIAN_ATTENTION'), { code: 'GUARDIAN_ATTENTION', verdict: 'main-session-action-required', missedHaltRisk: true, budgetGateCorrect: true });
  assert.equal(unwatched.commits.length, 1);
  // A blocker names the Guardian exactly when the commits are held for it.
  assert.deepEqual(unwatched.account.blockers, []);
  // A lock another team holds when the batch ends, and hook log lines from before the batch opened.
  const stolen = await ran(t, { tickets: two, edits }); releaseLease({ productRoot: stolen.product, lease: stolen.open.lease }); acquireLease({ teamRoot: fixture(t).root, productRoot: stolen.product });
  assert.match(refusal(stolen.after()).reason, /locked by another team root\. Nothing was changed/); assert.equal(existsSync(join(stolen.root, AFTER_FILE)), false);
  const old = live(t); appendFileSync(join(old.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', tool: 'Edit', agentType: 'tag-list-fixture-worker-exec', decision: 'allow' }) + '\n');
  const opened = await old.before(batchOf(...two)), { result } = await runWorkflow({ scriptPath: join(old.root, '.claude/workflows/run-n-rounds.js'), args: opened.args, agentImpl: makeAgentImpl({}) });
  writeFileSync(join(old.product, 'src/app.js'), 'x\n');
  assert.ok(afterBatch({ teamRoot: old.kit, instanceRoot: old.root, result }).findings.some(finding => finding.code === 'HOOK_SAW_NO_WORKER'), 'a line from an earlier batch does not count');
  // A ticket that did not pass says why.
  const failed = await ran(t, { tickets: two, edits, agents: { verifier: () => ({ pass: false, staticPass: false, e2ePass: false, summary: 'no', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['x'] }) } });
  const first = failed.after().tickets[0]; assert.equal(first.status, 'not-passed'); assert.equal(first.verificationStatus, 'failed'); assert.equal(typeof first.workerStatus, 'string');

  const onBranch = await ran(t, { tickets: two, edits }); assert.equal(onBranch.after().errors, undefined); git(onBranch.product, 'checkout', '-q', '-b', 'side');
  assert.match(refusal(onBranch.commit()).reason, /no longer on the batch's branch/);
  const busy = await ran(t, { tickets: two, edits }); assert.equal(busy.after().errors, undefined); writeFileSync(join(busy.product, '.git/MERGE_HEAD'), 'x\n');
  assert.match(refusal(busy.commit()).reason, /Git operation is in progress/);
  const edited = await ran(t, { tickets: two, edits }), closed = edited.after();
  writeFileSync(join(edited.root, AFTER_FILE), JSON.stringify({ ...closed, holdAll: false, status: 'clean' }).replace('"review"', '"clean"').replace(closed.closedAt, '2020-01-01T00:00:00.000Z'));
  assert.match(refusal(edited.commit()).reason, /was changed, or belongs to another batch/);
});

test('the Guardian of a standing batch is told it has no observer and a ceiling from the owner\'s limits; its clean verdict closes the batch clean', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } });
  assert.match(f.guardianBrief, /no observer watches the run, by design/); assert.match(f.guardianBrief, /ceiling is computed from the owner's limits/);
  const closed = f.after();
  assert.equal(closed.status, 'clean', JSON.stringify(closed.findings) + JSON.stringify(closed.account.blockers));
  assert.ok(!closed.findings.some(finding => finding.code.startsWith('GUARDIAN_'))); assert.deepEqual(closed.account.blockers, []); assert.equal(closed.holdAll, false);
});

const EXEC = 'tag-list-fixture-worker-exec', CHECK = 'tag-list-fixture-worker-check', edited = { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' };
const held = (closed, code) => { assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.ok(closed.findings.some(finding => finding.code === code), `${code}: ${JSON.stringify(closed.findings)}`);
  assert.equal(closed.holdAll, true); assert.deepEqual(closed.commits, []); assert.match(closed.next.join('\n'), /No ticket of this batch is committed by the kit.*rw-batch\.mjs abort/); };

test('the budget gate of a standing batch is judged from the engine\'s trace of its gate decisions: a call past the stop line, or one the trace does not show, holds every commit', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), status = f.result.budgetStatus, trace = status.gateTrace, stopLine = f.open.ceiling.stopLine;
  assert.deepEqual(trace?.map(entry => [entry.spawn, entry.iter, entry.attempt, entry.dispatched]), [['worker', 1, 1, true], ['verifier', 1, 1, true], ['worker', 2, 1, true], ['verifier', 2, 1, true]]);
  const close = budgetStatus => { writeFileSync(join(f.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: f.open.runId, claimedAt: '2000-01-01T00:00:00.000Z' }));
    return afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result: { ...f.result, budgetStatus } }); };
  const { gateTrace: _trace, ...untraced } = status;
  for (const [why, budgetStatus] of [
    ['a call dispatched at the stop line', { ...status, gateTrace: trace.map((entry, i) => i === 2 ? { ...entry, loopSpent: stopLine } : entry) }],
    ['no trace', untraced],
    ['fewer dispatched entries than calls', { ...status, gateTrace: trace.slice(0, -1) }],
    ['a call declined below the stop line', { ...status, gateTrace: [...trace, { spawn: 'worker', iter: 3, attempt: 1, loopSpent: 0, dispatched: false }] }],
    ['an entry that is not a gate decision', { ...status, gateTrace: trace.map((entry, i) => i === 0 ? { ...entry, spawn: 'checker' } : entry) }]]) {
    const closed = close(budgetStatus);
    held(closed, 'GUARDIAN_NOT_CLEAN'); assert.equal(closed.findings.find(finding => finding.code === 'GUARDIAN_NOT_CLEAN').budgetGate, 'inconsistent', why);
    assert.ok(closed.account.blockers.includes('guardian-not-clean'), `${why}: ${JSON.stringify(closed.account.blockers)}`);
  }
});

test('a standing batch whose gate stopped the run at the stop line holds nothing more than the tripped gate', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' }, spend: 15000 });
  assert.equal(f.open.ceiling.stopLine, 28800);
  assert.deepEqual(f.result.budgetStatus.gateTrace, [{ spawn: 'worker', iter: 1, attempt: 1, loopSpent: 0, dispatched: true }, { spawn: 'verifier', iter: 1, attempt: 1, loopSpent: 15000, dispatched: true },
    { spawn: 'worker', iter: 2, attempt: 1, loopSpent: 30000, dispatched: false }]);
  const closed = f.after();
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.holdAll, false);
  assert.ok(!closed.findings.some(finding => finding.code.startsWith('GUARDIAN_')), JSON.stringify(closed.findings));
  assert.deepEqual(closed.account.blockers, ['budget-gate', 'run-incomplete', 'halt-requires-acknowledgement']);
  assert.deepEqual(closed.commits.map(commit => commit.ticket), ['US-01']);
});

test('a standing batch with a genuine gate trace closes clean and settles against the account it was closed with', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } });
  assert.equal(f.result.budgetStatus.gateTrace?.length, 4);
  const closed = f.after(); assert.equal(closed.status, 'clean', JSON.stringify(closed.findings)); assert.deepEqual(closed.account.blockers, []);
  const settled = settleBatch({ teamRoot: f.kit, instanceRoot: f.root, meter: meterOf(f, [12000, 6000, 12000, 6000, 5000]), rules: loadRetryRules({ teamRoot: f.kit, instanceRoot: f.root }) });
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors)); assert.equal(settled.stage, 'batch-settled');
});

test('a batch that changed files while the hook logged no call of its own workers holds every commit, whatever other agents of the team did', async t => {
  const f = await ran(t, { tickets: two, edits: edited, hook: false });
  assert.ok(f.open.args.allowedAgentTypes.includes('tag-list-fixture-architect'), 'a governance wrapper is an allowed agent of the run');
  assert.deepEqual(runUnderHook(f.root, 'tag-list-fixture-architect', ['ls']), ['allow']);
  const closed = f.after(); held(closed, 'HOOK_SAW_NO_WORKER');
  assert.equal(closed.hook.workerCalls, 0); assert.match(closed.next.join('\n'), /did not load the write-boundary hook.*or the hook ran and could not append to its log/);
});

test('every passed ticket needs a checker run of each of its verification commands in the hook log, or every commit is held', async t => {
  const short = await ran(t, { tickets: two, edits: edited, hook: false });
  // One checker run for two tickets; the exec worker's run of the same command does not count.
  assert.deepEqual([...runUnderHook(short.root, CHECK, ['npm test']), ...runUnderHook(short.root, EXEC, ['npm test'])], ['approve', 'approve']);
  const closed = short.after(); held(closed, 'CHECK_RUNS_MISSING');
  assert.deepEqual(closed.findings.find(finding => finding.code === 'CHECK_RUNS_MISSING').commands, [{ command: 'npm test', needed: 2, seen: 1 }]);
  assert.match(closed.next.join('\n'), /checker ran.*fewer times than the tickets that passed/);
  const full = await ran(t, { tickets: two, edits: edited, hook: false });
  assert.deepEqual(runUnderHook(full.root, CHECK, ['npm test', 'npm test']), ['approve', 'approve']);
  const clean = full.after(); assert.equal(clean.status, 'clean', JSON.stringify(clean.findings)); assert.deepEqual(clean.commits.map(commit => commit.ticket), ['US-01', 'US-02']);
  // A ticket with its own list needs runs of that list only.
  const subset = await ran(t, { tickets: [two[0], { ...two[1], verificationCommands: ['npm test'] }], edits: edited, hook: false, fields: { verificationCommands: ['npm test', 'npm run lint'] } });
  assert.deepEqual(runUnderHook(subset.root, CHECK, ['npm test', 'npm run lint', 'npm test']), ['approve', 'approve', 'approve']);
  const kept = subset.after(); assert.equal(kept.status, 'clean', JSON.stringify(kept.findings)); assert.deepEqual(kept.commits.map(commit => commit.ticket), ['US-01', 'US-02']);
  // The count runs over the batch's list, so a command listed twice would be counted twice: before refuses such a list.
  assert.match(refusal(await live(t).before({ ...batchOf(...two), verificationCommands: ['npm test', 'npm test'] })).reason, /verificationCommands: Duplicate entries/);
});

test('a batch opened by the earlier kit, whose hook did not log approved commands, closes without counting the checker\'s runs', async t => {
  const f = await ran(t, { tickets: two, edits: edited, hook: false });
  const { hookLogsCommands: _marker, ...earlier } = f.open; writeFileSync(join(f.root, BATCH_FILE), JSON.stringify(sealAgain(earlier)));
  assert.deepEqual(runUnderHook(f.root, EXEC, ['npm test']), ['approve']);
  const closed = f.after(); assert.equal(closed.status, 'clean', JSON.stringify(closed.findings)); assert.deepEqual(closed.commits.map(commit => commit.ticket), ['US-01', 'US-02']);
});

test('a batch the earlier kit opened is still held when the hook logged no call of its workers, though its checker\'s runs are not counted', async t => {
  const f = await ran(t, { tickets: two, edits: edited, hook: false });
  const { hookLogsCommands: _marker, ...earlier } = f.open; writeFileSync(join(f.root, BATCH_FILE), JSON.stringify(sealAgain(earlier)));
  assert.deepEqual(runUnderHook(f.root, 'tag-list-fixture-architect', ['ls']), ['allow']);
  const closed = f.after(); held(closed, 'HOOK_SAW_NO_WORKER');
  assert.deepEqual(closed.findings.filter(finding => finding.code === 'CHECK_RUNS_MISSING'), [], 'only HOOK_SAW_NO_WORKER holds this batch');
});

test('abort after a claimed or closed batch always frees the team; a forged archive never stands in for a commit', async t => {
  // An after that died right after its claim, whatever the claim says about its time.
  for (const claimedAt of [new Date().toISOString(), undefined, '2999-01-01T00:00:00.000Z']) {
    const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } });
    writeFileSync(join(f.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: f.open.runId, claimedAt }));
    if (claimedAt === undefined || claimedAt.startsWith('2999')) { const resumed = f.after(); assert.equal(resumed.errors, undefined, `a claim with no usable time is taken up: ${JSON.stringify(resumed.errors)}`); continue; }
    const out = abortBatch({ teamRoot: f.kit, instanceRoot: f.root });
    assert.equal(out.stage, 'batch-archived-without-commit'); assert.equal(out.lockReleased, true); assert.equal(out.boundary, 'closed'); f.untouched();
  }
  // A stale claim does not excuse a boundary that names other workers.
  const tampered = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), other = { schemaVersion: 1, productRoot: tampered.product, wrappers: { a: { duty: 'exec', writePaths: [] }, b: { duty: 'check', writePaths: [] }, c: { duty: 'guard', writePaths: [] } } };
  writeFileSync(join(tampered.root, '.claude/rw-write-boundary.json'), JSON.stringify({ ...other, digest: digest(other) })); releaseLease({ productRoot: tampered.product, lease: tampered.open.lease });
  writeFileSync(join(tampered.root, AFTER_FILE), JSON.stringify({ stage: 'batch-closing', runId: tampered.open.runId, claimedAt: '2020-01-01T00:00:00.000Z' }));
  assert.ok(tampered.after().findings.some(finding => finding.code === 'BOUNDARY_CHANGED'));
  // A commit.json planted under the run id of an open batch.
  const forged = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), planted = { schemaVersion: 1, stage: 'batch-committed', runId: forged.open.runId, batchDigest: forged.open.digest, commits: [], left: [], pushed: false };
  mkdirSync(join(forged.root, 'batches', forged.open.runId), { recursive: true }); writeFileSync(join(forged.root, 'batches', forged.open.runId, 'commit.json'), JSON.stringify({ ...planted, digest: digest(planted) }));
  assert.match(refusal(forged.commit()).reason, /has not been closed/); assert.ok(existsSync(join(forged.root, BATCH_FILE))); assert.equal(readLease({ productRoot: forged.product }).status, 'held');
  assert.equal(forged.after().errors, undefined); assert.match(refusal(forged.commit()).reason, /batches\/\S+ already exists/); assert.deepEqual(forged.log(), [], 'nothing is committed into a batch whose archive was started');
  // A commit made just before the command died is taken up; a recorded commit that is not the ticket's is refused; abort names the commits made.
  const died = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } }); assert.equal(died.after().errors, undefined);
  git(died.product, 'add', 'src/app.js'); git(died.product, 'commit', '-q', '-m', 'US-01: Ticket US-01');
  const taken = died.commit(); assert.equal(taken.errors, undefined, JSON.stringify(taken.errors)); assert.equal(taken.commits.length, 2); assert.equal(died.log().length, 2);
  // Such a commit is taken up only when it holds what after saw: neither other content, nor other content with the work tree put back.
  const edited = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } }); assert.equal(edited.after().errors, undefined);
  writeFileSync(join(edited.product, 'src/app.js'), 'y\n'); git(edited.product, 'add', 'src/app.js'); git(edited.product, 'commit', '-q', '-m', 'US-01: Ticket US-01');
  assert.match(refusal(edited.commit()).reason, /found for ticket US-01 .*src\/app\.js/);
  writeFileSync(join(edited.product, 'src/app.js'), 'x\n');
  assert.match(refusal(edited.commit()).reason, /found for ticket US-01 .*src\/app\.js/); assert.equal(existsSync(join(edited.root, 'rw-batch-commits.json')), false, 'nothing is taken up');
  const fake = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } }); assert.equal(fake.after().errors, undefined);
  writeFileSync(join(fake.product, 'zzz.js'), 'z\n'); git(fake.product, 'add', 'zzz.js', 'src/app.js'); git(fake.product, 'commit', '-q', '-m', 'by hand');
  writeFileSync(join(fake.root, 'rw-batch-commits.json'), JSON.stringify({ commits: [{ ticket: 'US-01', sha: git(fake.product, 'rev-parse', 'HEAD').trim() }] }));
  assert.match(refusal(fake.commit()).reason, /does not hold its ticket's paths/);
  const partial = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' }, hooks: g => ({ 'pre-commit': `#!/bin/sh\n[ -e "${join(g.base, 'block')}" ] && git diff --cached --name-only | grep -q tags.js && exit 1\nexit 0\n` }) });
  assert.equal(partial.after().errors, undefined); writeFileSync(join(partial.base, 'block'), ''); assert.ok(partial.commit().errors);
  const left = abortBatch({ teamRoot: partial.kit, instanceRoot: partial.root });
  assert.equal(left.commitsMade.length, 1); assert.match(left.next, /1 commit\(s\) were already made by the kit and stay on the branch/); assert.match(partial.read('pm-decisions.md'), /ARCHIVED WITHOUT COMMIT.*1 commit\(s\) were already made/);
});

const runaway = () => ({ verdict: 'runaway', findings: ['the worker looped'], summary: 'not clean' });
const inTree = (f, path) => existsSync(join(f.product, path)) ? readFileSync(join(f.product, path), 'utf8') : null;

test('abort of a batch a finding held saves each ticket flagged for review as a patch and takes it out of the work tree; the rest stays, and the patch resumes in a later batch', async t => {
  const flaggedEdits = { 'src/authz.js': 'export const token = "x";\n', 'src/app.js': 'export const x = 2;\n' };
  const f = await ran(t, { tickets: [ticket('US-01', ['src/authz.js', 'src/app.js']), ticket('US-02', ['src/api/tags.js'])], agents: { guardian: runaway }, edits: { ...flaggedEdits, 'src/api/tags.js': 'tags\n' } });
  const closed = f.after();
  assert.equal(closed.holdAll, true); assert.deepEqual(closed.reviews, {}, 'a held batch is not put in review'); assert.deepEqual(closed.tickets.map(entry => entry.review?.required), [['security'], []]);
  const out = abortBatch({ teamRoot: f.kit, instanceRoot: f.root }), patch = `reviews/held/${f.open.runId}/US-01.patch`;
  assert.equal(out.errors, undefined, JSON.stringify(out.errors)); assert.equal(out.stage, 'batch-archived-without-commit');
  assert.deepEqual(out.held, [{ ticket: 'US-01', reason: 'not-reviewed', state: 'patch', patch, by: 'abort' }]);
  assert.deepEqual(['src/app.js', 'src/authz.js', 'src/api/tags.js'].map(path => inTree(f, path)), [git(f.product, 'show', 'HEAD:src/app.js'), null, 'tags\n'],
    'the flagged ticket\'s paths hold what HEAD holds; the unflagged ticket\'s change is still there');
  assert.deepEqual(JSON.parse(f.read(`batches/${f.open.runId}/abandoned.json`)).held, out.held);
  assert.match(f.read('pm-decisions.md'), new RegExp(`BATCH ${f.open.runId} ARCHIVED WITHOUT COMMIT .*Held as patches, out of the work tree: US-01 \\(not-reviewed\\) ${patch}\\.`));
  assert.match(out.next, new RegExp(`US-01 \\(not-reviewed\\) ${patch}.*resume`));
  git(f.product, 'apply', join(f.root, patch));
  const flagged = ['src/app.js', 'src/authz.js'];
  assert.deepEqual(flagged.map(path => inTree(f, path)), flagged.map(path => flaggedEdits[path]), 'the patch gives back the same bytes');
  git(f.product, 'apply', '-R', join(f.root, patch));
  // The held patch comes back as the resume of the same ticket, where it is checked and reviewed as its work.
  f.unmetered();
  const replan = { cause: 'The guardian held the batch before a review', feasible: 'The checker passed the work as saved', change: 'The held patch is resumed and reviewed' };
  const next = await f.before(batchOf(ticket('US-01', ['src/authz.js', 'src/app.js'], { resume: patch, replan })), { startAsIs: true });
  assert.equal(next.errors, undefined, JSON.stringify(next.errors)); assert.equal(next.tickets[0].resume.patch, patch);
  assert.deepEqual(flagged.map(path => inTree(f, path)), flagged.map(path => flaggedEdits[path]));
});

test('abort names, and leaves in the work tree, a flagged ticket it cannot take out whole; the batch is archived all the same', async t => {
  const f = await ran(t, { tickets: [ticket('US-01', ['src/authz.js']), ticket('US-03', ['src/session.js'])], agents: { guardian: runaway }, edits: { 'src/authz.js': 'a\n', 'src/session.js': 's\n' } });
  assert.equal(f.after().holdAll, true);
  // A file already where US-03's patch goes is never overwritten: US-03 cannot be saved aside, so nothing of it is removed.
  const stale = `reviews/held/${f.open.runId}/US-03.patch`; mkdirSync(join(f.root, stale, '..'), { recursive: true }); writeFileSync(join(f.root, stale), 'another patch\n');
  const out = abortBatch({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(out.errors, undefined, JSON.stringify(out.errors)); assert.equal(out.stage, 'batch-archived-without-commit');
  assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.ok(existsSync(join(f.root, `batches/${f.open.runId}/abandoned.json`)));
  assert.deepEqual(out.held.map(entry => [entry.ticket, entry.state, entry.paths]), [['US-01', 'patch', undefined], ['US-03', 'in-tree', ['src/session.js']]]);
  assert.match(out.held[1].problem, /already holds another patch/);
  assert.deepEqual([inTree(f, 'src/authz.js'), inTree(f, 'src/session.js'), f.read(stale)], [null, 's\n', 'another patch\n']);
  assert.match(out.next, /never committed by hand.*LEFT IN THE WORK TREE with no review passed.*US-03 \(not-reviewed; /);
  assert.match(f.read('pm-decisions.md'), new RegExp(`BATCH ${f.open.runId} ARCHIVED WITHOUT COMMIT .*LEFT IN THE WORK TREE with no review passed.*US-03`));
  // A Git operation in progress in the product: abort takes nothing out, and says why.
  const busy = await ran(t, { tickets: [ticket('US-01', ['src/authz.js'])], agents: { guardian: runaway }, edits: { 'src/authz.js': 'a\n' } });
  assert.equal(busy.after().holdAll, true); writeFileSync(join(busy.product, '.git/index.lock'), '');
  const stuck = abortBatch({ teamRoot: busy.kit, instanceRoot: busy.root }); rmSync(join(busy.product, '.git/index.lock'));
  assert.equal(stuck.stage, 'batch-archived-without-commit'); assert.deepEqual(stuck.held.map(entry => [entry.ticket, entry.state]), [['US-01', 'in-tree']]);
  assert.match(stuck.held[0].problem, /Git operation is in progress.*index\.lock/);
  assert.equal(inTree(busy, 'src/authz.js'), 'a\n'); assert.equal(existsSync(join(busy.root, `reviews/held/${busy.open.runId}/US-01.patch`)), false);
});

test('before names the commits made on the branch outside the kit since the newest batch archived on it, for the owner\'s spot review', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), one = batchOf(ticket('US-03', ['src/b.js'])), abort = () => assert.equal(abortBatch({ teamRoot: f.kit, instanceRoot: f.root }).errors, undefined);
  const lines = () => f.read('pm-decisions.md').split('\n').filter(line => line.includes('OUTSIDE THE KIT'));
  assert.equal(f.open.outsideCommits.commits, null); assert.equal(f.open.outsideCommits.since, null); assert.match(f.open.outsideCommits.reason, /No batch was archived on this branch/);
  assert.equal(f.after().errors, undefined); const done = f.commit(); assert.equal(done.errors, undefined); f.unmetered();
  const tip = done.commits.at(-1).sha, clean = await f.before(one);
  assert.equal(clean.errors, undefined, JSON.stringify(clean.errors));
  assert.deepEqual(clean.outsideCommits, { since: { runId: f.open.runId, commit: tip }, commits: [], count: 0 }); assert.deepEqual(lines(), [], 'no line when the kit made every commit');
  abort();
  for (let i = 1; i <= 11; i++) git(f.product, 'commit', '-q', '--allow-empty', '-m', `by hand ${i}`);
  const hand = git(f.product, 'rev-list', '--reverse', `${tip}..HEAD`).trim().split('\n'), named = await f.before(one);
  assert.equal(named.errors, undefined, JSON.stringify(named.errors)); assert.equal(hand.length, 11);
  assert.deepEqual(named.outsideCommits, { since: { runId: f.open.runId, commit: tip }, commits: hand, count: 11 });
  assert.deepEqual(lines(), [`${named.openedAt.slice(0, 10)} BATCH ${named.runId} COMMITS MADE OUTSIDE THE KIT (owner spot review): 11 commit(s) on work since batch ${f.open.runId} ended at ${tip.slice(0, 8)} (${hand.slice(0, 10).map(sha => sha.slice(0, 8)).join(', ')}, ...).`]);
  abort();
  // The branch rebuilt under the batch's last commit: nothing can be compared, nothing is refused, and the owner is told why.
  git(f.product, 'reset', '-q', '--hard', f.open.productHead); git(f.product, 'commit', '-q', '--allow-empty', '-m', 'rebuilt');
  const rebuilt = await f.before(one);
  assert.equal(rebuilt.errors, undefined, JSON.stringify(rebuilt.errors)); assert.equal(rebuilt.outsideCommits.commits, null);
  assert.deepEqual(rebuilt.outsideCommits.since, { runId: f.open.runId, commit: tip }); assert.match(rebuilt.outsideCommits.reason, /is not an ancestor of HEAD: the branch was rebuilt since/);
  assert.deepEqual(lines().slice(1), [`${rebuilt.openedAt.slice(0, 10)} BATCH ${rebuilt.runId} COMMITS MADE OUTSIDE THE KIT CANNOT BE TOLD (owner spot review): on work since batch ${f.open.runId}: ${rebuilt.outsideCommits.reason}.`]);
  abort();
  // An end commit the repository does not hold makes Git fail: that is not said to be a rebuilt branch.
  const record = join(f.root, 'batches', f.open.runId, 'commit.json'), kept = readFileSync(record, 'utf8'), forged = JSON.parse(kept);
  writeFileSync(record, JSON.stringify({ ...forged, commits: [...forged.commits.slice(0, -1), { ...forged.commits.at(-1), sha: 'e'.repeat(40) }] }));
  const unknown = await f.before(one); writeFileSync(record, kept);
  assert.equal(unknown.errors, undefined, JSON.stringify(unknown.errors)); assert.equal(unknown.outsideCommits.commits, null);
  assert.match(unknown.outsideCommits.reason, /Git could not tell whether .*eeeeeeee/); assert.doesNotMatch(unknown.outsideCommits.reason, /not an ancestor/);
  assert.equal(lines().length, 3);
  abort();
  // A merge can bring thousands of commits: the record keeps the oldest hundred and the count.
  git(f.product, 'reset', '-q', '--hard', tip);
  for (let i = 1; i <= 101; i++) git(f.product, 'commit', '-q', '--allow-empty', '-m', `merged ${i}`);
  const many = await f.before(one), all = git(f.product, 'rev-list', '--reverse', `${tip}..HEAD`).trim().split('\n');
  assert.equal(many.errors, undefined, JSON.stringify(many.errors));
  assert.deepEqual(many.outsideCommits, { since: { runId: f.open.runId, commit: tip }, commits: all.slice(0, 100), count: 101 }); assert.match(lines().at(-1), /: 101 commit\(s\) on work since/);
  abort();
  // The newest archive on the branch cannot be read: its own commits would be counted as made outside the kit.
  writeFileSync(join(f.root, 'batches', f.open.runId, 'batch.json'), 'not json');
  const unread = await f.before(one);
  assert.equal(unread.errors, undefined, JSON.stringify(unread.errors));
  assert.deepEqual([unread.outsideCommits.since, unread.outsideCommits.commits], [{ runId: f.open.runId, commit: null }, null]); assert.match(unread.outsideCommits.reason, /batch record of .* cannot be read/);
  assert.match(lines().at(-1), new RegExp(`BATCH ${unread.runId} COMMITS MADE OUTSIDE THE KIT CANNOT BE TOLD \\(owner spot review\\): on work since batch ${f.open.runId}: `));
});

test('settle sets each ticket\'s measured usage against its authorization, before or after the commit, and reports a ticket over it', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' } }), rules = loadRetryRules({ teamRoot: f.kit, instanceRoot: f.root });
  const settle = (meter, extra = {}) => settleBatch({ teamRoot: f.kit, instanceRoot: f.root, meter, rules, ...extra });
  assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1]))).reason, /No closed batch is waiting/);
  assert.equal(f.after().errors, undefined);
  assert.match(refusal(settle({ subagents: [] })).reason, /meter/i, 'a meter that does not hold the run');
  const returnPath = join(f.root, 'rw-batch-return.json'), kept = readFileSync(returnPath, 'utf8'), edited = JSON.parse(kept);
  edited.results[1].verificationStatus = 'failed'; writeFileSync(returnPath, JSON.stringify(edited));
  assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1]))).reason, /missing or was changed/, 'a return edited after the batch was closed');
  writeFileSync(returnPath, kept);
  // One session holds the runs of every batch it ran: the run settled is the one whose Guardian was told this run's id.
  // Another batch of the same tickets at the same commit has the same briefs; only the id tells the two apart.
  assert.ok(f.guardianBrief.includes(`Loop config: runId=${f.open.runId}, `), 'the engine names the run in the Guardian\'s brief');
  // Not this run: an id this one is the start of; this id quoted from a worker's words inside the brief; this run's
  // Guardian brief in the transcript of an agent that is not the Guardian.
  const another = { wf: 'wf_0', guardBrief: f.guardianBrief.replace(`runId=${f.open.runId},`, `runId=${f.open.runId}0,`) + `\n  "workerReportedNotes": "Loop config: runId=${f.open.runId}, mode=wrappers",` };
  assert.match(refusal(settle(meterOf(f, [9, 9, 9, 9, 9], { ...another, session: 'other', briefOf: () => f.guardianBrief, request: `settle the last one:\nLoop config: runId=${f.open.runId}, mode=wrappers` }))).reason, /No metered run is run \S+: no Guardian transcript names it/);
  // A run id that is not a plain identifier never reaches the ledger or a path, whatever the digests say.
  const records = Object.fromEntries(['rw-batch.json', 'rw-batch-after.json'].map(name => [name, readFileSync(join(f.root, name), 'utf8')])), forged = sealAgain({ ...JSON.parse(records['rw-batch.json']), runId: '../batches/x' });
  writeFileSync(join(f.root, 'rw-batch.json'), JSON.stringify(forged)); writeFileSync(join(f.root, 'rw-batch-after.json'), JSON.stringify(sealAgain({ ...JSON.parse(records['rw-batch-after.json']), batchDigest: forged.digest })));
  assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1]))).reason, /plain run id/);
  // Each part of that check on its own: the id's form, the id the batch was closed under, the id the engine was given.
  const real = JSON.parse(records['rw-batch.json']), closedReal = JSON.parse(records['rw-batch-after.json']);
  for (const [why, batchId, afterId, argsId] of [['form', 'a b', 'a b', 'a b'], ['closed under', real.runId, 'rw-other', real.runId], ['run under', 'rw-other', 'rw-other', real.runId]]) {
    const again = sealAgain({ ...real, runId: batchId, args: { ...real.args, runId: argsId } });
    writeFileSync(join(f.root, 'rw-batch.json'), JSON.stringify(again)); writeFileSync(join(f.root, 'rw-batch-after.json'), JSON.stringify(sealAgain({ ...closedReal, runId: afterId, batchDigest: again.digest })));
    assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1]))).reason, /plain run id/, why);
  }
  for (const [name, text] of Object.entries(records)) writeFileSync(join(f.root, name), text);
  meterOf(f, [1, 1, 1, 1, 1], { session: 'twice' });
  assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1], { session: 'twice', wf: 'wf_2' }))).reason, /cannot be told apart/);
  // A settlement another caller wrote while this one was reading the transcripts is not overwritten.
  const settlementPath = join(f.root, 'rw-batch-settlement.json'), racing = meterOf(f, [1, 1, 1, 1, 1]), rows = racing.subagents; let reads = 0;
  Object.defineProperty(racing, 'subagents', { get() { if (!reads++) writeFileSync(settlementPath, 'another caller\n'); return rows; } });
  assert.match(refusal(settle(racing)).reason, /already settled/); assert.equal(readFileSync(settlementPath, 'utf8'), 'another caller\n'); rmSync(settlementPath);
  assert.deepEqual(readdirSync(f.root).filter(name => name.endsWith('.tmp')), [], 'no draft is left');
  // The other run of the session is not read beyond its Guardian: a transcript of it that is gone does not matter.
  meterOf(f, [9, 9, 9, 9, 9], another);
  const full = meterOf(f, [12000, 6000, 150000, 60000, 5000]); for (const gone of ['exec0', 'guard']) rmSync(join(f.base, `projects/sess/subagents/workflows/wf_0/agent-wf_0-${gone}.jsonl`));
  // A call that used every turn its staffing allows stopped at that limit, which no limit of the team names.
  const execTurns = JSON.parse(f.read('profiles/team-mode.json')).staffing.exec.maxTurns;
  full.subagents.find(row => row.agentId === 'wf_1-exec1').uniqueMessages = execTurns;
  const settled = settle(full); assert.ok(settled.calls?.every(call => call.agentId.startsWith('wf_1-')), JSON.stringify(settled.errors));
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors)); assert.equal(settled.stage, 'batch-settled');
  assert.deepEqual(settled.tickets.map(entry => [entry.ticket, entry.authorizedTokens, entry.spentTokens, entry.budgetGate]), [['US-01', 200000, 18020, 'clear'], ['US-02', 200000, 210020, 'blocked']]);
  assert.equal(settled.status, 'review', 'a ticket over its authorization puts the batch in review');
  assert.deepEqual(settled.limits, [{ limit: 'authorizationPerTicket', observed: 210020, current: 200000, proposal: { authorizationPerTicket: 263000 }, tickets: ['US-02'] },
    { limit: 'staffing.exec.maxTurns', observed: execTurns, current: execTurns, proposal: null, tickets: ['US-02'],
      note: 'the call used every turn its staffing allows and stopped there; staffing changes with a mode switch whose request raises it' }]); assert.equal(settled.calls.length, 5); assert.equal(settled.mainSessionTokens, 7010);
  assert.match(refusal(settle(meterOf(f, [1, 1, 1, 1, 1]))).reason, /already settled/);
  assert.match(f.read('pm-decisions.md'), /BATCH \S+ SETTLED \(review\): 228040 token\(s\) on 2 ticket\(s\) of 400000 authorized, Guardian 5010/);
  // Cost is reported, not enforced: the commits are made, and the settlement is archived with the batch.
  assert.equal(f.commit().errors, undefined); assert.equal(f.log().length, 2);
  assert.ok(readdirSync(join(f.root, 'batches', f.open.runId)).includes('settlement.json'));

  // An archived batch is settled by its id; a transcript that does not carry the frozen brief is a finding.
  const late = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), lateRules = loadRetryRules({ teamRoot: late.kit, instanceRoot: late.root });
  assert.equal(late.after().errors, undefined);
  // A commit that archived the batch and died before it cleared the root: the settlement goes to the archive.
  const root = Object.fromEntries(['rw-batch.json', 'rw-batch-after.json', 'rw-batch-return.json'].map(name => [name, readFileSync(join(late.root, name), 'utf8')]));
  assert.equal(late.commit().errors, undefined);
  for (const [name, text] of Object.entries(root)) writeFileSync(join(late.root, name), text);
  const settleLate = (meter, extra = {}) => settleBatch({ teamRoot: late.kit, instanceRoot: late.root, meter, rules: lateRules, ...extra });
  // This batch's run lost one brief; an earlier run of the same tickets kept them all. The run is still told by its id.
  meterOf(late, [9, 9, 9, 9, 9], { wf: 'wf_0', guardBrief: late.guardianBrief.replace(`runId=${late.open.runId},`, 'runId=rw-another-L1,') });
  const lateMeter = meterOf(late, [12000, 6000, 12000, 6000, 5000], { briefOf: brief => brief.replace('Ticket US-01', 'Another task') });
  const journal = join(late.base, 'projects/sess/subagents/workflows/wf_1/journal.jsonl'), order = readFileSync(journal, 'utf8'); rmSync(journal);
  assert.match(refusal(settleLate(lateMeter)).reason, /workflow journal of the metered run/, 'the other run does not stand in for a run whose journal is gone'); writeFileSync(journal, order);
  const archived = settleLate(lateMeter);
  assert.equal(archived.errors, undefined, JSON.stringify(archived.errors)); assert.ok(archived.findings.some(finding => finding.code === 'BRIEF_NOT_FOUND' && finding.ticket === 'US-01'));
  assert.ok(archived.calls.every(call => call.agentId.startsWith('wf_1-'))); assert.equal(archived.tickets[0].spentTokens, 18020);
  assert.ok(existsSync(join(late.root, 'batches', late.open.runId, 'settlement.json'))); assert.equal(existsSync(join(late.root, 'rw-batch-settlement.json')), false);
  assert.equal(late.commit().errors, undefined); assert.equal(existsSync(join(late.root, 'rw-batch-return.json')), false);
  assert.match(refusal(settleLate(lateMeter, { runId: late.open.runId })).reason, /already settled/);
  assert.match(refusal(settleLate({}, { runId: '../x' })).reason, /No archived batch/);
  // An archive is named by its id, letter for letter, and holds the batch of that id.
  assert.match(refusal(settleLate(lateMeter, { runId: late.open.runId.toLowerCase() })).reason, /No archived batch of that id/);
  cpSync(join(late.root, 'batches', late.open.runId), join(late.root, 'batches/rw-a-copy'), { recursive: true }); rmSync(join(late.root, 'batches/rw-a-copy/settlement.json'));
  assert.match(refusal(settleLate(lateMeter, { runId: 'rw-a-copy' })).reason, /plain run id/); rmSync(join(late.root, 'batches/rw-a-copy'), { recursive: true });
  // What an earlier batch left in the root is not read or archived as the next one's; the files that name the run leave the root last.
  const leftovers = ['rw-batch-commits.json', 'rw-batch-return.json', 'rw-batch-settlement.json'];
  for (const name of leftovers) writeFileSync(join(late.root, name), '{}\n');
  const first = await late.before(batchOf(ticket('US-07', ['src/q.js']))); assert.equal(first.errors, undefined);
  assert.deepEqual(leftovers.filter(name => existsSync(join(late.root, name))), []);
  // The same tickets prepared again after an abort are another run, with another id.
  assert.equal(abortBatch({ teamRoot: late.kit, instanceRoot: late.root }).errors, undefined);
  const second = await late.before(batchOf(ticket('US-07', ['src/q.js']))); assert.equal(second.errors, undefined); assert.notEqual(second.runId, first.runId);
  assert.deepEqual(Object.values(RECORDS).slice(-3), ['rw-batch.json', 'rw-batch-after.json', 'rw-batch-commits.json']);
  // A commit that archives the batch while it is being settled: the settlement follows the batch into the archive.
  const raced = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(raced.after().errors, undefined);
  const during = meterOf(raced, [12000, 6000, 150000, 10000, 5000]), list = during.subagents; let seen = 0;
  Object.defineProperty(during, 'subagents', { get() { if (!seen++) assert.equal(raced.commit().errors, undefined); return list; } });
  const moved = settleBatch({ teamRoot: raced.kit, instanceRoot: raced.root, meter: during, rules: loadRetryRules({ teamRoot: raced.kit, instanceRoot: raced.root }) });
  assert.equal(moved.errors, undefined, JSON.stringify(moved.errors)); assert.equal(existsSync(join(raced.root, 'rw-batch-settlement.json')), false);
  assert.deepEqual(moved.limits, [{ limit: 'authorizationPerTicket', observed: 160020, current: 200000, proposal: { authorizationPerTicket: 201000 }, tickets: ['US-02'] }], 'above 80% of the authorization is reported too');
  assert.equal(JSON.parse(readFileSync(join(raced.root, 'batches', raced.open.runId, 'settlement.json'), 'utf8')).digest, moved.digest);
  // CLI
  const cli = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(cli.after().errors, undefined);
  const meterFile = join(cli.base, 'meter.json'); writeFileSync(meterFile, JSON.stringify(meterOf(cli, [12000, 6000, 12000, 6000, 5000])));
  const run = (...argv) => spawnSync(process.execPath, [join(cli.kit, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  assert.equal(run('settle', meterFile).status, 1); assert.equal(run('settle', meterFile, '--instance', cli.root, '--run').status, 1);
  const unread = run('settle', join(cli.base, 'absent.json'), '--instance', cli.root);
  assert.equal(unread.status, 2); assert.match(unread.stderr, /absent\.json is not readable JSON/);
  const done = run('settle', meterFile, '--instance', cli.root);
  assert.equal(done.status, 0, done.stdout + done.stderr); assert.equal(JSON.parse(done.stdout).status, 'clear'); assert.deepEqual(JSON.parse(done.stdout).limits, []);
  const again = run('settle', meterFile, '--instance', cli.root); assert.equal(again.status, 2); assert.match(again.stderr, /already settled/);
});

test('a batch closed by the kit before the standing-batch argument settles after the upgrade, with the blockers it was closed with', async t => {
  const unwatched = () => ({ runawayDetected: false, missedHaltRisk: true, budgetGateCorrect: true, droppedFixRetest: false, verdict: 'main-session-action-required', findings: ['no observer'], newPatternCandidates: [] });
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n', 'src/api/tags.js': 't\n' }, agents: { guardian: unwatched } });
  assert.equal(f.after().errors, undefined);
  // The records as that kit wrote them: arguments without standingBatch, a return without a gate trace, and an account naming every verdict but clean as a blocker.
  const batchPath = join(f.root, BATCH_FILE), afterPath = join(f.root, AFTER_FILE), opened = JSON.parse(readFileSync(batchPath, 'utf8')), closed = JSON.parse(readFileSync(afterPath, 'utf8'));
  const { standingBatch: _flag, ...args } = opened.args, old = sealAgain({ ...opened, args, runRecord: sealAgain({ ...opened.runRecord, argsDigest: digest(args) }) });
  writeFileSync(batchPath, JSON.stringify(old));
  const returnPath = join(f.root, RETURN_FILE), { budgetStatus: { gateTrace: _trace, ...budgetStatus }, ...kept } = JSON.parse(readFileSync(returnPath, 'utf8')), earlier = { ...kept, budgetStatus };
  writeFileSync(returnPath, JSON.stringify(earlier));
  writeFileSync(afterPath, JSON.stringify(sealAgain({ ...closed, batchDigest: old.digest, returnDigest: digest(earlier), status: 'review', account: { ...closed.account, blockers: ['guardian-not-clean'] } })));
  const settled = settleBatch({ teamRoot: f.kit, instanceRoot: f.root, meter: meterOf(f, [12000, 6000, 12000, 6000, 5000]), rules: loadRetryRules({ teamRoot: f.kit, instanceRoot: f.root }) });
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors)); assert.equal(settled.stage, 'batch-settled');
});

test('settle after a run that halted: only the ticket that ran is settled, by the id of the archived batch, and exit 2 says it is in review', async t => {
  const failed = { pass: false, staticPass: false, e2ePass: false, summary: 'broken', commandsRun: [{ command: 'npm test', exitCode: 1 }], failures: ['the test fails'] };
  const f = await ran(t, { tickets: two, agents: { verifier: () => failed } });
  assert.equal(f.result.results.length, 1, 'the engine stopped at the first ticket'); assert.equal(f.after().errors, undefined); assert.equal(f.commit().errors, undefined);
  const meterFile = join(f.base, 'meter.json'); writeFileSync(meterFile, JSON.stringify(meterOf(f, [250000, 6000, 5000], { ticketsRun: 1 })));
  const done = spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'settle', meterFile, '--instance', f.root, '--run', f.open.runId], { encoding: 'utf8' });
  assert.equal(done.status, 2, done.stdout + done.stderr); const record = JSON.parse(done.stdout);
  assert.equal(record.status, 'review'); assert.deepEqual(record.tickets.map(entry => [entry.ticket, entry.authorizedTokens, entry.budgetGate]), [['US-01', 200000, 'blocked']]);
  assert.deepEqual(record.calls.map(call => call.duty), ['exec', 'check', 'guard']);
  assert.match(f.read('pm-decisions.md'), /SETTLED \(review\): 256020 token\(s\) on 1 ticket\(s\) of 200000 authorized/);
  assert.ok(existsSync(join(f.root, 'batches', f.open.runId, 'settlement.json')));
});

test('the next batch does not open until the last one is settled, or marked as not metered with a reason', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), next = () => f.before(batchOf(ticket('US-07', ['src/q.js'])));
  const mark = (reason, extra = {}) => markNotMetered({ teamRoot: f.kit, instanceRoot: f.root, reason, ...extra });
  assert.match(refusal(mark('too early')).reason, /No closed batch is waiting/);
  assert.equal(f.after().errors, undefined); assert.equal(f.commit().errors, undefined);
  const stopped = refusal(await next());
  assert.match(stopped.reason, new RegExp(`The usage of batch ${f.open.runId} was not settled\\. Settle it first: rw-batch\\.mjs settle METER\\.json --instance <instance-root> --run ${f.open.runId}; if it cannot be measured: rw-batch\\.mjs settle --not-metered`));
  assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  for (const bad of [undefined, '', ' padded ', 'two\nlines', 'x'.repeat(201)]) assert.match(refusal(mark(bad, { runId: f.open.runId })).reason, /with a reason: one line/, JSON.stringify(bad)?.slice(0, 20));
  assert.match(refusal(mark('why', { runId: 'rw-none' })).reason, /No archived batch of that id/);
  const run = (...argv) => spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  assert.equal(run('settle', '--not-metered').status, 1); assert.equal(run('settle', '--not-metered', 'why', '--instance', f.root, '--run').status, 1);
  const marked = run('settle', '--not-metered', 'the session transcripts were deleted', '--instance', f.root, '--run', f.open.runId);
  assert.equal(marked.status, 0, marked.stdout + marked.stderr); const record = JSON.parse(marked.stdout);
  assert.equal(record.stage, 'batch-not-metered'); assert.equal(record.runId, f.open.runId); assert.equal(record.reason, 'the session transcripts were deleted');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'batches', f.open.runId, 'settlement.json'), 'utf8')), record);
  assert.match(f.read('pm-decisions.md'), new RegExp(`BATCH ${f.open.runId} NOT METERED by rw-batch\\.mjs settle --not-metered: the session transcripts were deleted\\.`));
  assert.match(refusal(mark('again', { runId: f.open.runId })).reason, /already settled/);
  assert.match(refusal(settleBatch({ teamRoot: f.kit, instanceRoot: f.root, meter: meterOf(f, [1, 1, 1, 1, 1]), rules: loadRetryRules({ teamRoot: f.kit, instanceRoot: f.root }), runId: f.open.runId })).reason, /already settled/);
  const opened = await next(); assert.equal(opened.errors, undefined, JSON.stringify(opened.errors));
  // A batch that never ran leaves nothing to settle.
  assert.equal(abortBatch({ teamRoot: f.kit, instanceRoot: f.root }).errors, undefined); assert.equal((await next()).errors, undefined);
  assert.equal(abortBatch({ teamRoot: f.kit, instanceRoot: f.root }).errors, undefined);

  // Marked before the commit, the mark is archived with the batch; a batch abandoned after it ran must be settled or marked too.
  const early = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(early.after().errors, undefined);
  const first = markNotMetered({ teamRoot: early.kit, instanceRoot: early.root, reason: 'no meter on this machine' }); assert.equal(first.errors, undefined, JSON.stringify(first.errors));
  assert.equal(early.commit().errors, undefined); assert.equal(JSON.parse(readFileSync(join(early.root, 'batches', early.open.runId, 'settlement.json'), 'utf8')).stage, 'batch-not-metered');
  assert.equal((await early.before(batchOf(ticket('US-07', ['src/q.js'])))).errors, undefined);
  const dropped = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }); assert.equal(dropped.after().errors, undefined);
  assert.equal(abortBatch({ teamRoot: dropped.kit, instanceRoot: dropped.root }).stage, 'batch-archived-without-commit');
  assert.match(refusal(await dropped.before(batchOf(ticket('US-07', ['src/q.js'])), { startAsIs: true })).reason, /was not settled/);
  dropped.unmetered(); assert.equal((await dropped.before(batchOf(ticket('US-07', ['src/q.js'])), { startAsIs: true })).errors, undefined);
});


test('the gate reads a settlement of that run, sealed; a mark is refused whole when its ledger line cannot be written', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), id = f.open.runId, next = () => f.before(batchOf(ticket('US-07', ['src/q.js'])));
  const mark = (reason, extra = {}) => markNotMetered({ teamRoot: f.kit, instanceRoot: f.root, reason, runId: id, ...extra }), held = new RegExp(`The usage of batch ${id} was not settled`);
  assert.equal(f.after().errors, undefined); assert.equal(f.commit().errors, undefined);
  // A file the PM left among the archives is not a batch.
  writeFileSync(join(f.root, 'batches', 'notes.txt'), 'x'); assert.match(refusal(await next()).reason, held);
  for (const bad of ['a\u009bb', 'a\u200eb', 'a\ufeffb', 'a b', 'a b', 'a\u0085b', 'a‮b', 'a⁦b']) assert.match(refusal(mark(bad)).reason, /with a reason: one line/, JSON.stringify(bad));
  const settlement = join(f.root, 'batches', id, 'settlement.json'), seal = body => JSON.stringify({ ...body, digest: digest(body) });
  const body = { schemaVersion: 1, stage: 'batch-not-metered', runId: id, reason: 'forged', markedAt: new Date().toISOString() };
  for (const forged of ['', '{}', JSON.stringify({ ...body, digest: 'sha256:0' }), seal({ ...body, runId: 'rw-other' }), seal({ ...body, stage: 'batch-open' })]) {
    writeFileSync(settlement, forged); assert.match(refusal(await next()).reason, held, forged.slice(0, 60));
  }
  rmSync(settlement);
  const ledger = join(f.root, 'pm-decisions.md'); chmodSync(ledger, 0o444);
  assert.ok(refusal(mark('the meter is gone'))); chmodSync(ledger, 0o644);
  assert.equal(existsSync(settlement), false, 'no mark without its ledger line');
  assert.equal(mark('the meter is gone').errors, undefined); assert.equal((await next()).errors, undefined);
});

test('a mark of the closed batch is refused when its records do not agree on the run id', async t => {
  const f = await ran(t, { tickets: two, edits: { 'src/app.js': 'x\n' } }), mark = () => markNotMetered({ teamRoot: f.kit, instanceRoot: f.root, reason: 'no meter' });
  assert.equal(f.after().errors, undefined);
  const afterPath = join(f.root, AFTER_FILE), original = readFileSync(afterPath, 'utf8'), closed = JSON.parse(original);
  writeFileSync(afterPath, JSON.stringify(sealAgain({ ...closed, runId: 'rw-other' })));
  assert.match(refusal(mark()).reason, /do not agree/); assert.equal(existsSync(join(f.root, 'rw-batch-settlement.json')), false);
  writeFileSync(afterPath, original); assert.equal(f.commit().errors, undefined);
  // A record left in the root names the archive only when it is the archive's own.
  writeFileSync(afterPath, JSON.stringify(sealAgain({ ...closed, left: ['src/forged.js'] })));
  assert.match(refusal(mark()).reason, /do not agree/);
  writeFileSync(afterPath, original); const marked = mark(); assert.equal(marked.errors, undefined, JSON.stringify(marked.errors));
  assert.equal(JSON.parse(readFileSync(join(f.root, 'batches', f.open.runId, 'settlement.json'), 'utf8')).stage, 'batch-not-metered');
});
