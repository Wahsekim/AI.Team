// Runtime write boundary: a PreToolUse hook that refuses file-tool writes of the
// Router/Worker wrappers outside the frozen product paths of the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { armBoundary, decideWrite } from '../src/router-worker/write-boundary.mjs';
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
  const verdict = (agent, tool, path, extra) => decideWrite({ input: call(f, agent, tool, path, extra), boundary }).decision;
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
