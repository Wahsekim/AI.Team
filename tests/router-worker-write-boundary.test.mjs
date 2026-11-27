// Runtime write boundary: a PreToolUse hook that refuses file-tool writes of the
// Router/Worker wrappers outside the frozen product paths of the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { armBoundary, decideCall, logEntry, quotable, redacted } from '../src/router-worker/write-boundary.mjs';
import { digest } from '../src/loop/contracts.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';

const HOOK = fileURLToPath(new URL('../scripts/hooks/rw-write-boundary.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/arm-boundary-router-worker.mjs', import.meta.url));

function fixture(t, { status = 'activated-disposable-smoke' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-boundary-'))), team = join(base, 'demo.rw-active'), product = join(base, 'product');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(team, 'profiles'), { recursive: true }); mkdirSync(join(team, '.claude'));
  mkdirSync(join(product, 'src/tag-list'), { recursive: true }); mkdirSync(join(product, 'src/auth'));
  writeFileSync(join(team, 'profiles/team-mode.json'), JSON.stringify({ status }));
  return { base, team, product };
}
const second = () => {
  const input = inputFixture();
  input.ticket.id = 'US-09'; input.mandate.ticketId = 'US-09'; input.proposal.assignmentId = 'US-09.exec.1'; input.proposal.checkAssignmentId = 'US-09.check.1';
  input.mandate.allowedWritePaths = ['src/api/tags.ts']; input.proposal.expectedPaths = ['src/api/tags.ts'];
  return input;
};
const arm = (f, overrides = {}) => armBoundary({ inputs: [inputFixture(), second()], teamRoot: f.team, productRoot: f.product, hookPath: HOOK, ...overrides });
const call = (f, agent, tool, path, extra = {}) => ({ session_id: 's', cwd: f.product, hook_event_name: 'PreToolUse', tool_name: tool,
  tool_input: tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path }, ...(agent ? { agent_type: agent, agent_id: 'a1' } : {}), ...extra });
const runHook = (f, input, env = {}) => spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: f.team, ...env } });

test('arming writes the boundary of the run and registers the hook in the activated copy only', t => {
  const f = fixture(t), result = arm(f);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  const boundary = JSON.parse(readFileSync(join(f.team, '.claude/rw-write-boundary.json'), 'utf8'));
  assert.equal(boundary.productRoot, f.product);
  assert.deepEqual(boundary.wrappers, { 'sample-worker-exec': { duty: 'exec', writePaths: ['src/api/tags.ts', 'src/tag-list/**', 'tests/tag-list/**'] },
    'sample-worker-check': { duty: 'check', writePaths: [] }, 'sample-worker-guard': { duty: 'guard', writePaths: [] } }, 'exec gets the union of the ticket mandates');
  const { digest: recorded, ...body } = boundary;
  assert.equal(recorded, digest(body)); assert.equal(result.boundaryDigest, recorded); assert.equal(result.launchable, false);
  const settings = JSON.parse(readFileSync(join(f.team, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Write|Edit|NotebookEdit|MultiEdit|Bash', hooks: [{ type: 'command', command: `node "${HOOK}"` }] }]);
  arm(f);
  assert.equal(JSON.parse(readFileSync(join(f.team, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 1, 'arming twice registers one hook');
  assert.ok(result.unresolved.includes('bash-writes'));
});

test('arming keeps existing settings and refuses a team root that is not an activated copy', t => {
  const f = fixture(t);
  writeFileSync(join(f.team, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Read(./secret)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }));
  arm(f);
  const settings = JSON.parse(readFileSync(join(f.team, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, { deny: ['Read(./secret)'] }); assert.equal(settings.hooks.PreToolUse.length, 2);
  const standing = fixture(t, { status: 'staged-structurally-validated' });
  assert.equal(arm(standing).errors?.[0].code, 'BOUNDARY_REFUSED');
  assert.equal(arm(f, { productRoot: join(f.product, 'missing') }).errors?.[0].code, 'BOUNDARY_REFUSED');
  const broken = inputFixture(); broken.proposal.expectedPaths = ['../outside'];
  assert.equal(arm(f, { inputs: [broken] }).errors?.[0].code, 'INVALID_INPUT', 'compiler findings pass through');
  const other = inputFixture(); other.policy.profiles.exec.wrapper = 'other-exec'; other.mandate.policyDigest = digest(other.policy);
  other.ticket.id = 'US-10'; other.mandate.ticketId = 'US-10';
  assert.equal(arm(f, { inputs: [inputFixture(), other] }).errors?.[0].code, 'BOUNDARY_REFUSED', 'one run has one policy');
});

test('the exec wrapper may write only inside the frozen product paths; read-only duties may not write at all', t => {
  const f = fixture(t); arm(f);
  const boundary = JSON.parse(readFileSync(join(f.team, '.claude/rw-write-boundary.json'), 'utf8'));
  const verdict = (agent, tool, path, extra) => decideCall({ input: call(f, agent, tool, path, extra), boundary }).decision;
  assert.equal(verdict('sample-worker-exec', 'Write', join(f.product, 'src/tag-list/view.ts')), 'allow');
  assert.equal(verdict('sample-worker-exec', 'Edit', 'src/api/tags.ts'), 'allow', 'a relative path resolves against the call cwd');
  assert.equal(verdict('sample-worker-exec', 'Edit', join(f.product, 'src/auth/session.ts')), 'deny');
  assert.equal(verdict('sample-worker-exec', 'Write', join(f.product, 'src/api/tags.ts.bak')), 'deny');
  assert.equal(verdict('sample-worker-exec', 'Write', join(f.team, 'agents/roster.md')), 'deny', 'the team root is outside the product');
  assert.equal(verdict('sample-worker-exec', 'Write', join(f.product, 'src/tag-list/../auth/x.ts')), 'deny');
  assert.equal(verdict('sample-worker-exec', 'NotebookEdit', join(f.product, 'notes.ipynb')), 'deny');
  assert.equal(verdict('sample-worker-exec', 'Write', undefined), 'deny', 'a write with no readable target');
  symlinkSync(join(f.product, 'src/auth'), join(f.product, 'src/tag-list/link'));
  assert.equal(verdict('sample-worker-exec', 'Write', join(f.product, 'src/tag-list/link/x.ts')), 'deny', 'a symlink inside an allowed directory does not widen it');
  for (const agent of ['sample-worker-check', 'sample-worker-guard'])
    assert.equal(verdict(agent, 'Write', join(f.product, 'src/tag-list/view.ts')), 'deny');
  assert.equal(verdict('sample-worker-exec', 'Read', join(f.product, 'src/auth/session.ts')), 'allow', 'only write tools are judged');
  assert.equal(verdict(undefined, 'Write', join(f.base, 'result.json')), 'allow', 'the main session is not a wrapper');
  assert.equal(verdict('sample-auditor', 'Write', join(f.team, 'audit.md')), 'allow', 'agents outside the run boundary are not judged here');
});

test('the hook process exits 0 to allow and 2 with a reason to deny; it fails closed for subagents', t => {
  const f = fixture(t); arm(f);
  assert.equal(runHook(f, call(f, 'sample-worker-exec', 'Write', join(f.product, 'src/tag-list/view.ts'))).status, 0);
  const denied = runHook(f, call(f, 'sample-worker-exec', 'Write', join(f.product, 'src/auth/session.ts')));
  assert.equal(denied.status, 2); assert.match(denied.stderr, /outside the write boundary/);
  assert.doesNotMatch(denied.stderr, new RegExp(f.base), 'the reason names no host path');
  assert.equal(runHook(f, '{broken').status, 2, 'an unreadable hook input is refused');
  const boundaryFile = join(f.team, '.claude/rw-write-boundary.json'), saved = readFileSync(boundaryFile, 'utf8');
  writeFileSync(boundaryFile, saved.replace('src/api/tags.ts', 'src/auth/**'));
  assert.equal(runHook(f, call(f, 'sample-worker-exec', 'Write', join(f.product, 'src/tag-list/view.ts'))).status, 2, 'an edited boundary is refused for every subagent write');
  assert.equal(runHook(f, call(f, undefined, 'Write', join(f.base, 'result.json'))).status, 0, 'the main session is still not blocked');
  rmSync(boundaryFile);
  assert.equal(runHook(f, call(f, 'sample-auditor', 'Write', join(f.team, 'audit.md'))).status, 2, 'no boundary: any subagent write is refused');
});

test('no session writes the team\'s limits with a file tool, the PM\'s included: the owner changes them with team-mode.mjs limits', t => {
  const f = fixture(t); arm(f);
  const limits = join(f.team, 'profiles/team-mode.json'), at = (path, cwd = f.team) => ({ ...call(f, undefined, 'Edit', path), cwd });
  for (const [input, why] of [[at(limits), 'the PM\'s session, absolute'], [at('profiles/team-mode.json'), 'relative to the team'], [at('../profiles/team-mode.json', join(f.team, '.claude')), 'through ..'],
    [at('PROFILES/Team-Mode.json'), 'another case'], [{ ...at(limits), agent_type: 'sample-auditor' }, 'a governance role'], [{ ...at(limits), agent_type: 'sample-worker-exec' }, 'a worker'],
    [{ ...call(f, undefined, 'MultiEdit', limits), cwd: f.team }, 'MultiEdit'], [{ ...call(f, undefined, 'Write', limits), cwd: f.team }, 'Write'], [{ ...call(f, undefined, 'NotebookEdit', limits), cwd: f.team }, 'NotebookEdit']]) {
    const denied = runHook(f, input);
    assert.equal(denied.status, 2, why); assert.match(denied.stderr, /only the owner changes them, with: node kit\/scripts\/team-mode\.mjs limits <LIMITS\.json> --instance <instance-root>, at an interactive terminal/, why);
  }
  symlinkSync(join(f.team, 'profiles'), join(f.base, 'linked')); assert.equal(runHook(f, at(join(f.base, 'linked/team-mode.json'))).status, 2, 'through a symbolic link');
  symlinkSync(join(f.base, 'nowhere.json'), join(f.team, 'dangling.json'));
  for (const [path, why] of [[join(f.team, 'dangling.json'), 'a dangling symbolic link'], [join(f.team, 'profiles/project.md/x'), 'under a file']]) {
    const written = runHook(f, { ...call(f, undefined, 'Write', path), cwd: f.team });
    assert.equal(written.status, 0, `${why}: ${written.stderr}`);
  }
  rmSync(limits); symlinkSync(limits, join(f.base, 'to-limits.json'));
  assert.equal(runHook(f, { ...call(f, undefined, 'Write', join(f.base, 'to-limits.json')), cwd: f.team }).status, 2, 'a dangling link that would create the missing limits file');
  assert.equal(runHook(f, at(join(f.team, 'profiles/project.md'))).status, 0, 'another file of the team');
  assert.equal(runHook(f, { ...call(f, undefined, 'Read', limits), cwd: f.team }).status, 0, 'reading it');
  assert.equal(runHook(f, { ...call(f, undefined, 'Bash'), cwd: f.team, tool_input: { command: 'cat profiles/team-mode.json' } }).status, 0, 'the PM\'s shell is not judged');
  rmSync(join(f.team, '.claude/rw-write-boundary.json')); assert.equal(runHook(f, at(limits)).status, 2, 'with no boundary file');
  assert.equal(decideCall({ input: at(limits), boundary: null, projectDir: f.team }).decision, 'deny');
});

test('no session writes the limits file\'s .tmp with a file tool: a change of limits renames it into place', t => {
  const f = fixture(t); arm(f);
  const at = (path, extra = {}) => ({ ...call(f, undefined, 'Write', path), cwd: f.team, ...extra });
  for (const [input, why] of [[at(join(f.team, 'profiles/team-mode.json.tmp')), 'the PM\'s session'], [at('profiles/team-mode.json.tmp', { agent_type: 'sample-auditor' }), 'a governance role'],
    [at('PROFILES/team-mode.JSON.tmp', { agent_type: 'sample-worker-exec' }), 'a worker, in another case'], [{ ...at('profiles/team-mode.json.tmp'), tool_name: 'Edit' }, 'Edit']])
    assert.equal(runHook(f, input).status, 2, why);
  assert.equal(runHook(f, at('profiles/team-mode.json.bak')).status, 0, 'another file');
});

test('every hook call is logged without paths or commands, so a write that got through can be explained', t => {
  const f = fixture(t); arm(f);
  const secret = 'echo TOP-SECRET > /somewhere/else';
  runHook(f, call(f, 'sample-worker-exec', 'Write', join(f.product, 'src/tag-list/view.ts')));
  runHook(f, call(f, 'sample-worker-exec', 'Write', join(f.product, 'src/auth/session.ts')));
  runHook(f, call(f, undefined, 'Write', join(f.base, 'result.json')));
  assert.equal(runHook(f, { ...call(f, 'sample-worker-exec', 'Bash'), tool_input: { command: secret } }).status, 0, 'Bash is logged, never judged');
  runHook(f, '{broken');
  const text = readFileSync(join(f.team, '.claude/rw-write-boundary.log.jsonl'), 'utf8'), lines = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(({ at, ...rest }) => rest), [
    { tool: 'Write', agentType: 'sample-worker-exec', judged: true, decision: 'allow' },
    { tool: 'Write', agentType: 'sample-worker-exec', judged: true, decision: 'deny' },
    { tool: 'Write', agentType: null, judged: false, decision: 'allow' },
    { tool: 'Bash', agentType: 'sample-worker-exec', judged: false, decision: 'allow' },
    { tool: null, agentType: null, judged: false, decision: 'deny' }]);
  assert.ok(lines.every(line => !Number.isNaN(Date.parse(line.at))));
  assert.ok(!text.includes('TOP-SECRET') && !text.includes(f.base), 'no command and no host path');
  const nowhere = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(call(f, undefined, 'Write', '/x')), encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: join(f.base, 'missing') } });
  assert.equal(nowhere.status, 0, 'a log that cannot be written does not change the verdict');
});

test('CLI arms from RUN.json, prints the record, exits 2 on refusal and 1 on usage', t => {
  const f = fixture(t), file = join(f.base, 'run.json'), run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  writeFileSync(file, JSON.stringify({ run: {}, inputs: [inputFixture()] }));
  const ok = run(file, '--team-root', f.team, '--product-root', f.product);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).stage, 'write-boundary-armed');
  assert.match(JSON.parse(readFileSync(join(f.team, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command, /scripts\/hooks\/rw-write-boundary\.mjs"$/);
  assert.equal(run(file, '--team-root', f.team, '--product-root', join(f.base, 'nope')).status, 2);
  assert.equal(run(file).status, 1);
});

test('a refused command is logged with the values that look like secrets redacted', () => {
  const cases = [
    ['API_TOKEN=abc123 npm test', 'API_TOKEN=<redacted> npm test'],
    ['DB_PASSWORD="p w" make check', 'DB_PASSWORD=<redacted> make check'],
    ['TOKEN=abc npm test', 'TOKEN=<redacted> npm test'],
    ['PASSWORD=x SECRET=s KEY=k make', 'PASSWORD=<redacted> SECRET=<redacted> KEY=<redacted> make'],
    ['export PASS=x; npm test', 'export PASS=<redacted>; npm test'],
    ['API_KEY=k&&npm test', 'API_KEY=<redacted>&&npm test'],
    ['curl -H "Authorization: Bearer xyz" https://example.test', 'curl -H "Authorization: <redacted>" https://example.test'],
    ['git clone https://user:pa55@example.test/r.git', 'git clone https://<redacted>@example.test/r.git'],
    ['echo ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'echo <redacted>'],
    ['node --test tests/router-worker/components/a-rather-long-file-name.test.mjs', 'node --test tests/router-worker/components/a-rather-long-file-name.test.mjs'],
    ['npm run test:tag-list', 'npm run test:tag-list'],
  ];
  for (const [command, expected] of cases) assert.equal(redacted(command), expected, command);
});

test('a product root is quotable unless it holds a character a double-quoted shell word would read', () => {
  for (const root of ['/x/a"b', '/x/a$b', '/x/a`b', '/x/a\\b', '/x/a!b', '/x/a\x00b', '/x/a\nb', '/x/a\x1fb', '/x/a\x7fb', null, 7])
    assert.equal(quotable(root), false, JSON.stringify(root));
  for (const root of ['/x/My Project', "/x/it's", '/x/p[1]', '/x/a#b', '/x/a&b', '/x/a*b', '/x/caf\u00e9']) assert.equal(quotable(root), true, root);
});

test('with no boundary every subagent write and shell command is judged, and the main session is not', () => {
  const judged = (tool, agent) => logEntry({ input: { tool_name: tool, ...(agent ? { agent_type: agent } : {}) }, boundary: null, decision: 'deny', at: 'now' }).judged;
  assert.deepEqual([judged('Write', 'any'), judged('Edit', 'any'), judged('Bash', 'any'), judged('Read', 'any'), judged('Write'), judged('Bash')], [true, true, true, false, false, false]);
});

test('the checker\'s approved command is logged as the batch\'s own command, the exec worker\'s with none; a refused one as its redacted text', () => {
  const move = 'git --literal-pathspecs rm -q -- "src/a.js"';
  const boundary = { productRoot: '/p', wrappers: { w: { duty: 'check', writePaths: [], commands: ['npm test', 'npm run lint'] }, x: { duty: 'exec', writePaths: ['src/**'], commands: ['npm test', move] } } };
  const logged = (command, cwd = '/t', agent = 'w') => { const input = { tool_name: 'Bash', agent_type: agent, cwd, tool_input: { command } }, verdict = decideCall({ input, boundary });
    const { at: _at, ...line } = logEntry({ input, boundary, decision: verdict.decision, command: verdict.command, at: 'now' }); return line; };
  const approved = command => ({ tool: 'Bash', agentType: 'w', judged: true, decision: 'approve', command });
  assert.deepEqual(logged('cd "/p" && npm test'), approved('npm test'));
  assert.deepEqual(logged(' cd /p && npm run lint\n'), approved('npm run lint'));
  assert.deepEqual(logged('npm test', '/p'), approved('npm test'));
  // A package's command that runs in its folder is one confirmed command, typed whole from the product root.
  const inFolder = { ...boundary, wrappers: { w: { duty: 'check', writePaths: [], commands: ['cd app && npm test'] } } }, asked = (command, cwd) => decideCall({ input: { tool_name: 'Bash', agent_type: 'w', cwd, tool_input: { command } }, boundary: inFolder }).decision;
  assert.deepEqual([asked('cd app && npm test', '/p'), asked('cd "/p" && cd app && npm test', '/t'), asked('npm test', '/p/app')], ['approve', 'approve', 'deny']);
  assert.deepEqual(logged('API_TOKEN=abc npm test'), { tool: 'Bash', agentType: 'w', judged: true, decision: 'deny', command: 'API_TOKEN=<redacted> npm test' });
  // A declared move or deletion names product paths; only the checker's runs are counted, so the exec worker's carry no command.
  for (const command of [move, 'npm test']) assert.deepEqual(logged(command, '/p', 'x'), { tool: 'Bash', agentType: 'x', judged: true, decision: 'approve' }, command);
});

test('a command asked to run outside the sandbox is refused whatever value asks for it', () => {
  const boundary = { productRoot: '/p', wrappers: { w: { duty: 'exec', writePaths: [], commands: ['npm test'] } } };
  const verdict = value => decideCall({ boundary, input: { tool_name: 'Bash', agent_type: 'w', cwd: '/p', tool_input: { command: 'npm test', ...(value === undefined ? {} : { dangerouslyDisableSandbox: value }) } } }).decision;
  assert.deepEqual([undefined, false, true, 'true', 1, {}, null].map(verdict), ['approve', 'approve', 'deny', 'deny', 'deny', 'deny', 'deny']);
});
