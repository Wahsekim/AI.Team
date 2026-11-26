// ADR 0010, amendment of 2026-11-24: a ticket may move and delete tracked files, through the exact Git commands its
// declared moves and deletes give the exec worker for that batch only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { BATCH_FILE, abortBatch } from '../src/router-worker/batch.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { readBoundary, decideCall } from '../src/router-worker/write-boundary.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { git, checksRan, afterBatch } from './fixtures/router-worker/standing-team.mjs';
import { live, ticket, batchOf, refusal } from './fixtures/router-worker/review.mjs';

const [EXEC, CHECK, GUARD] = ['exec', 'check', 'guard'].map(duty => `tag-list-fixture-worker-${duty}`);
const LONG = Array.from({ length: 12 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n';
const taskData = brief => JSON.parse(brief.split('\n').find(line => line.startsWith('{"assignmentId"')));

// A live team whose product tracks the files the tickets move and delete.
function seeded(t) {
  const f = live(t);
  for (const [path, text] of Object.entries({ 'src/list/a.js': LONG, 'src/list/b.js': 'b\n', 'src/list/old.js': 'old\n' })) {
    mkdirSync(dirname(join(f.product, path)), { recursive: true }); writeFileSync(join(f.product, path), text);
  }
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  return f;
}
const untouched = f => { assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); assert.equal(f.state(), 'closed'); };
const lister = (extra, paths = ['src/list/**']) => batchOf(ticket('T-1', paths, { expectedPaths: ['src/list/a.js'], ...extra }));

test('before refuses a move or a deletion that is not one tracked file inside the ticket\'s grant, and changes nothing', async t => {
  const f = seeded(t), refused = async (batch, pattern) => { assert.match(refusal(await f.before(batch))?.reason ?? 'opened', pattern); untouched(f); };
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'lib/a.js' }] }), /T-1 moves or deletes lib\/a\.js, outside its paths/);
  await refused(lister({ deletes: ['src/app.js'] }), /T-1 moves or deletes src\/app\.js, outside its paths/);
  await refused(lister({ moves: [{ from: 'src/list/new.js', to: 'src/list/c.js' }] }), /T-1 moves or deletes src\/list\/new\.js, which is not a file tracked at the product's HEAD/);
  await refused(lister({ deletes: ['src/list'] }, ['src/**']), /src\/list, which is not a file tracked/);
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'src/list/b.js' }] }), /T-1 moves a file to src\/list\/b\.js, which already exists/);
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'src/list/c.js' }], deletes: ['src/list/A.js'] }), /T-1 names src\/list\/A\.js twice in its moves and deletes/);
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'src/list/c.js' }, { from: 'src/list/b.js', to: 'src/list/c.js' }] }), /names src\/list\/c\.js twice/);
  for (const odd of ['src/list/a"b.js', 'src/list/$x.js', 'src/list/a!.js', 'src/list/*.js', 'src/list/../app.js', 'src/list/**', '/src/list/a.js', 'src/list/a.js\n', 'src/list//a.js', 'src/list/',
    'src/list/:a.js', 'src/list/a:b.js', 'src/list/a\u202eb.js', 'src/list/a\u200bb.js', 'src/list/a\x85b.js'])
    await refused(lister({ deletes: [odd] }), /is not one plain file path a quoted shell command can hold/);
  await refused(lister({ deletes: ['src/list/.git/config'] }), /no ticket writes under \.git or \.claude/);
  for (const [field, value] of [['moves', [{ from: 'src/list/a.js' }]], ['moves', [{ from: 'src/list/a.js', to: 'src/list/c.js', force: true }]], ['moves', {}], ['deletes', 'src/list/a.js'], ['deletes', null]])
    await refused(lister({ [field]: value }), new RegExp(`T-1: ${field} must list at most 100`));
  const many = (id, folder) => ticket(id, [`${folder}/**`], { expectedPaths: [`${folder}/x.js`], deletes: Array.from({ length: 51 }, (_, i) => `${folder}/f${i}.js`) });
  await refused(batchOf(many('T-1', 'src/a'), many('T-2', 'src/b')), /may move or delete at most 100 files in all \(102 given\)/);
  // A folder that is a link would carry the moved file out of the product.
  mkdirSync(join(f.base, 'outside')); symlinkSync(join(f.base, 'outside'), join(f.product, 'src/list/out'));
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'link');
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'src/list/out/a.js' }] }), /moves a file to src\/list\/out\/a\.js, which already exists or does not lie in a folder of the product/);
});

test('before refuses a move a link or an earlier move of the batch could carry out of the grant, and a move into a submodule', async t => {
  const f = seeded(t), refused = async (batch, pattern, team = f) => { assert.match(refusal(await team.before(batch))?.reason ?? 'opened', pattern); untouched(team); };
  writeFileSync(join(f.product, 'src/list/run.sh'), '#!/bin/sh\necho benign\n'); symlinkSync('../../.git/hooks', join(f.product, 'src/list/hk'));
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'link');
  // The link moved first, then a file moved through it, would land in .git/hooks.
  await refused(lister({ moves: [{ from: 'src/list/hk', to: 'src/list/d' }, { from: 'src/list/run.sh', to: 'src/list/d/pre-commit' }] }), /T-1 names src\/list\/d\/pre-commit in its moves or deletes, under src\/list\/d, which ticket T-1 names too/);
  await refused(lister({ moves: [{ from: 'src/list/hk', to: 'src/list/d' }] }), /T-1 moves src\/list\/hk, a symbolic link/);
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'src/list/d' }, { from: 'src/list/b.js', to: 'src/list/d/b.js' }] }), /names src\/list\/d\/b\.js in its moves or deletes, under src\/list\/d/);
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'src/list/old.js/a.js' }], deletes: ['src/list/old.js'] }), /names src\/list\/old\.js\/a\.js in its moves or deletes, under src\/list\/old\.js/);
  await refused(batchOf(ticket('T-1', ['src/list/a.js', 'src/list/d'], { moves: [{ from: 'src/list/a.js', to: 'src/list/d' }] }), ticket('T-2', ['src/list/d/**', 'src/list/b.js'], { expectedPaths: ['src/list/d/b.js'], moves: [{ from: 'src/list/b.js', to: 'src/list/d/b.js' }] })),
    /T-2 names src\/list\/d\/b\.js in its moves or deletes, under src\/list\/d, which ticket T-1 names too/);
  assert.equal(existsSync(join(f.product, '.git/hooks/pre-commit')), false);
  // git rm removes a link itself and never follows it.
  const removed = await f.before(lister({ deletes: ['src/list/hk'] }));
  assert.equal(removed.errors, undefined, JSON.stringify(removed.errors)); assert.equal(abortBatch(f.common).errors, undefined);
  // git mv into a submodule's folder drops the submodule from the index; a product with one opens no batch at all.
  const sub = seeded(t);
  git(sub.product, 'update-index', '--add', '--cacheinfo', `160000,${git(sub.product, 'rev-parse', 'HEAD').trim()},src/list/sub`); mkdirSync(join(sub.product, 'src/list/sub'));
  git(sub.product, 'commit', '-q', '-m', 'submodule');
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'src/list/sub/a.js' }] }), /SUBMODULE_PRESENT/, sub);
});

test('before refuses a path the index hides, a link in the work tree, a path not in composed Unicode, and a nested path in another case', async t => {
  const f = seeded(t), refused = async (batch, pattern) => { assert.match(refusal(await f.before(batch))?.reason ?? 'opened', pattern); untouched(f); };
  writeFileSync(join(f.product, 'src/list/run.sh'), '#!/bin/sh\necho benign\n'); writeFileSync(join(f.product, 'src/list/hk'), 'plain\n');
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  // HEAD holds a file; the work tree holds a link into .git/hooks, which Git no longer looks at.
  git(f.product, 'update-index', '--assume-unchanged', 'src/list/hk');
  rmSync(join(f.product, 'src/list/hk')); symlinkSync('../../.git/hooks', join(f.product, 'src/list/hk'));
  assert.equal(git(f.product, 'status', '--porcelain', '--untracked-files=all'), '', 'git status does not see the link');
  await refused(lister({ moves: [{ from: 'src/list/hk', to: 'src/list/é' }, { from: 'src/list/run.sh', to: 'src/list/é/pre-commit' }] }), /"src\/list\/é\/pre-commit" is not one plain file path/);
  await refused(lister({ moves: [{ from: 'src/list/hk', to: 'src/list/x' }] }), /T-1 moves src\/list\/hk, a symbolic link/);
  await refused(lister({ deletes: ['src/list/hk'] }), /T-1 moves or deletes src\/list\/hk, which Git is told not to look at \(assume-unchanged or skip-worktree\)/);
  git(f.product, 'update-index', '--skip-worktree', 'src/list/b.js');
  await refused(lister({ moves: [{ from: 'src/list/b.js', to: 'src/list/c.js' }] }), /T-1 moves or deletes src\/list\/b\.js, which Git is told not to look at/);
  // On APFS the composed and decomposed forms of a name are one folder, so only the composed form is accepted.
  await refused(lister({ deletes: ['src/list/é.js'] }), /is not one plain file path .*composed Unicode \(NFC\)/);
  await refused(lister({ moves: [{ from: 'src/list/a.js', to: 'src/list/D' }, { from: 'src/list/old.js', to: 'src/list/d/old.js' }] }), /T-1 names src\/list\/d\/old\.js in its moves or deletes, under src\/list\/D/);
  assert.equal(existsSync(join(f.product, '.git/hooks/pre-commit')), false);
});

test('a ticket moves a file into a folder an earlier ticket emptied with git rm: the folder is made again and both commits land', async t => {
  const f = live(t);
  for (const [path, text] of Object.entries({ 'src/a/d/only.js': 'only\n', 'src/b.js': 'b\n' })) { mkdirSync(dirname(join(f.product, path)), { recursive: true }); writeFileSync(join(f.product, path), text); }
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'seed');
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/a/d/only.js'], { deletes: ['src/a/d/only.js'] }), ticket('T-2', ['src/b.js', 'src/a/d/x.js'], { moves: [{ from: 'src/b.js', to: 'src/a/d/x.js' }] })), verificationCommands: f.commands });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const hookCommand = JSON.parse(f.read('.claude/settings.json')).hooks.PreToolUse.at(-1).hooks[0].command;
  const worker = prompt => {
    for (const command of taskData(prompt).gitCommands) {
      const judged = spawnSync('sh', ['-c', hookCommand], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: f.root }, input: JSON.stringify({ tool_name: 'Bash', agent_type: EXEC, cwd: f.product, tool_input: { command } }) });
      assert.equal(JSON.parse(judged.stdout).hookSpecificOutput.permissionDecision, 'allow', command);
      execFileSync('sh', ['-c', command], { cwd: f.product });
    }
    return { outcome: 'done', progress: true, filesTouched: [], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'ran' };
  };
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker, verifier }) });
  checksRan(f.root, open);
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.status, 'clean', JSON.stringify(closed.findings ?? closed.errors));
  assert.deepEqual(closed.tickets.map(entry => [entry.id, entry.status, entry.changedPaths]), [['T-1', 'passed', ['src/a/d/only.js']], ['T-2', 'passed', ['src/a/d/x.js', 'src/b.js']]]);
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(done.commits.map(commit => commit.ticket), ['T-1', 'T-2']);
  assert.equal(git(f.product, 'show', 'HEAD:src/a/d/x.js'), 'b\n');
  assert.equal(git(f.product, 'status', '--porcelain').trim(), '', 'the product is clean again');
});

test('an empty moves or deletes list is the same as none', async t => {
  const f = seeded(t), open = await f.before(lister({ moves: [], deletes: [] }));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  assert.deepEqual([open.tickets[0].moves, open.tickets[0].deletes, taskData(open.args.plan[0].brief).gitCommands], [[], [], []]);
  assert.deepEqual(readBoundary(f.root).wrappers[EXEC].commands, [...f.commands].sort(), 'the exec worker runs the verification commands only');
});

test('the exec worker may run exactly the git commands its tickets declare, the checker and the Guardian may not; the exec brief names its grant and those commands', async t => {
  const f = seeded(t), moves = [{ from: 'src/list/a.js', to: 'src/list/c.js' }, { from: 'src/list/b.js', to: 'src/list/new/b.js' }];
  const open = await f.before(batchOf(ticket('T-1', ['src/list/**'], { expectedPaths: ['src/list/c.js'], moves, deletes: ['src/list/old.js'] }), ticket('T-2', ['src/app.js'])));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const mv = 'mkdir -p -- "src/list" && git --literal-pathspecs mv -- "src/list/a.js" "src/list/c.js"', made = 'mkdir -p -- "src/list/new" && git --literal-pathspecs mv -- "src/list/b.js" "src/list/new/b.js"', rm = 'git --literal-pathspecs rm -q -- "src/list/old.js"';
  assert.deepEqual([open.tickets[0].moves, open.tickets[0].deletes, open.tickets[1].moves, open.tickets[1].deletes], [moves, ['src/list/old.js'], [], []]);
  const shell = (agent, command) => decideCall({ boundary: readBoundary(f.root), input: { tool_name: 'Bash', agent_type: agent, cwd: f.root, tool_input: { command: `cd "${f.product}" && ${command}` } } }).decision;
  for (const command of [mv, made, rm]) assert.deepEqual([EXEC, CHECK, GUARD].map(agent => shell(agent, command)), ['approve', 'deny', 'deny'], command);
  for (const other of ['git mv -- "src/list/a.js" "src/list/c.js"', 'git --literal-pathspecs mv -- "src/list/a.js" "src/list/d.js"', 'git mv -- "src/list/b.js" "src/list/c.js"', 'git mv -f -- "src/list/a.js" "src/list/c.js"', 'git mv src/list/a.js src/list/c.js',
    'git --literal-pathspecs mv -- "src/list/a.js" "src/list/c.js"', 'git mv -- "src/list/b.js" "src/list/new/b.js"', 'git rm -q -- "src/app.js"', 'git rm -rq -- "src/list/old.js"', `${mv} && git status`, 'git status', 'mkdir -p -- "src/list/new"'])
    assert.equal(shell(EXEC, other), 'deny', other);
  assert.deepEqual([shell(EXEC, 'pwd'), shell(CHECK, 'pwd')], ['approve', 'approve'], 'both keep the verification commands');
  const [first, second] = open.args.plan;
  assert.deepEqual(taskData(first.brief).writePaths, ['src/list/**']); assert.deepEqual(taskData(first.brief).plannedPaths, ['src/list/c.js']);
  assert.deepEqual(taskData(first.brief).gitCommands, [mv, made, rm]); assert.deepEqual(taskData(second.brief).gitCommands, []);
  assert.match(first.brief, /run no other command, Git included/);
  for (const brief of [first.brief, first.verifierBrief]) assert.doesNotMatch(brief, /offline preview|not dispatch authority|isolated verification runner/);
  assert.ok(!first.verifierBrief.includes('git mv'), 'the checker is not given the moves');
});

test('a ticket that moves and deletes: the stand-in exec runs its commands through the hook, after accepts both sides, and commit makes one commit with the rename and the deletion', async t => {
  const f = seeded(t), start = git(f.product, 'rev-parse', 'HEAD').trim();
  const open = await f.before({ ...batchOf(ticket('T-1', ['src/list/**', 'lib/**'], { expectedPaths: ['lib/list/a.js'], moves: [{ from: 'src/list/a.js', to: 'lib/list/a.js' }], deletes: ['src/list/old.js'] })), verificationCommands: f.commands });
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  // The hook as the runtime runs it, which also logs each call of the worker.
  const hookCommand = JSON.parse(f.read('.claude/settings.json')).hooks.PreToolUse.at(-1).hooks[0].command;
  const hook = (tool, toolInput) => spawnSync('sh', ['-c', hookCommand], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: f.root }, input: JSON.stringify({ tool_name: tool, agent_type: EXEC, cwd: f.product, tool_input: toolInput }) });
  const worker = prompt => {
    for (const command of taskData(prompt).gitCommands) {
      const judged = hook('Bash', { command });
      assert.equal(judged.status, 0, judged.stderr); assert.equal(JSON.parse(judged.stdout).hookSpecificOutput.permissionDecision, 'allow', command);
      execFileSync('sh', ['-c', command], { cwd: f.product });
    }
    const edited = join(f.product, 'lib/list/a.js');
    assert.equal(hook('Edit', { file_path: edited }).status, 0); writeFileSync(edited, LONG.replace('line0 = 0', 'line0 = 10'));
    return { outcome: 'done', progress: true, filesTouched: ['lib/list/a.js'], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'moved' };
  };
  const verifier = () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: f.commands.map(command => ({ command, exitCode: 0 })), failures: [] });
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({ worker, verifier }) });
  checksRan(f.root, open);
  const closed = afterBatch({ ...f.common, result });
  assert.equal(closed.errors, undefined, JSON.stringify(closed.errors)); assert.equal(closed.status, 'clean', JSON.stringify(closed.findings));
  assert.deepEqual(closed.tickets[0].changedPaths, ['lib/list/a.js', 'src/list/a.js', 'src/list/old.js'], 'both sides of the rename, and the deletion');
  assert.deepEqual(closed.left, []);
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.deepEqual(done.commits.map(commit => commit.ticket), ['T-1']);
  assert.equal(git(f.product, 'rev-list', '--count', `${start}..HEAD`).trim(), '1');
  const names = git(f.product, 'show', '--name-status', '-M', '--format=', 'HEAD').trim().split('\n').sort();
  assert.equal(names.length, 2, names.join('\n')); assert.match(names[0], /^D\tsrc\/list\/old\.js$/); assert.match(names[1], /^R\d+\tsrc\/list\/a\.js\tlib\/list\/a\.js$/);
  assert.equal(git(f.product, 'status', '--porcelain').trim(), '', 'the product is clean again');
});
