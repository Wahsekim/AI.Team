// ADR 0010, decision 7: the kit proposes the staffing and the limits of a Router/Worker team; the owner confirms them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { draftRequest } from '../src/router-worker/request.mjs';
import { proposeSwitch, switchMode, proposeLimits, changeLimits, DEFAULT_LIMITS } from '../src/router-worker/switch.mjs';
import { acquireLease, releaseLease } from '../src/router-worker/lease.mjs';
import { fixture, CLI } from './fixtures/router-worker/standing-team.mjs';

const refusal = result => result.errors?.[0];
const IDS = Array.from({ length: 32 }, (_, i) => `WF-${String(i).padStart(2, '0')}`);
// The project profile as a PM leaves it after the bootstrap interview: slug answered, one line per workflow.
function interviewed(f, status = id => id === 'WF-16' ? 'deferred — first release is serial' : 'enabled') {
  const path = join(f.root, 'profiles/project.md'), text = readFileSync(path, 'utf8');
  const block = /workflow_status:\n[\s\S]*?```/.exec(text)[0];
  writeFileSync(path, text.replace(/^(\s*slug:\s*)"[^"]*"/m, '$1"tag-list-fixture"').replace(block, 'workflow_status:\n' + IDS.map(id => `  ${id}: "${status(id)}"`).join('\n') + '\n```'));
}

test('the request is drafted from the team\'s own profile with the ADR\'s staffing and limits, and the switch accepts it', t => {
  const f = fixture(t, { roles: null }); interviewed(f);
  const drafted = draftRequest({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(drafted.errors, undefined, JSON.stringify(drafted.errors));
  const { spec, limits } = drafted.request;
  assert.deepEqual(spec.project, { name: 'Tag List Fixture', slug: 'tag-list-fixture', productRoot: f.product, ui: false });
  assert.deepEqual(spec.profiles.exec, { model: 'opus', effort: 'high', maxTurns: 120, tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'] });
  assert.deepEqual(spec.profiles.check, { model: 'opus', effort: 'medium', maxTurns: 80, tools: ['Read', 'Grep', 'Glob', 'Bash'] });
  assert.deepEqual(spec.profiles.guard, { model: 'opus', effort: 'high', maxTurns: 40, tools: ['Read', 'Grep', 'Glob'] });
  assert.deepEqual(Object.keys(spec.governance).sort(), ['architect', 'auditor', 'coach', 'security']);
  assert.ok(!spec.governance.auditor.tools.includes('Write') && spec.governance.architect.tools.includes('Write'));
  assert.deepEqual(limits, DEFAULT_LIMITS);
  assert.deepEqual(spec.workflowStates['WF-16'], { status: 'deferred', reason: 'first release is serial', decisionRef: null });
  assert.deepEqual(spec.workflowStates['WF-00'], { status: 'enabled', reason: 'As recorded in profiles/project.md', decisionRef: null });
  // A team bootstrapped with no delivery role goes straight into Router/Worker mode with this request.
  const proposal = proposeSwitch({ to: 'router-worker', request: drafted.request, ...f.common });
  assert.equal(proposal.errors, undefined, JSON.stringify(proposal.errors)); assert.deepEqual(proposal.pack, ['agents/roster.md']);
  const done = switchMode({ to: 'router-worker', request: drafted.request, ...f.common, confirm: proposal.digest });
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.match(done.validator, /^DEPLOYMENT-STRUCTURALLY-COMPLETE/);
  const other = draftRequest({ teamRoot: f.kit, instanceRoot: f.root, model: 'sonnet', ui: true }).request.spec;
  assert.equal(other.profiles.exec.model, 'sonnet'); assert.equal(other.project.ui, true);
});

test('a profile the interview has not finished refuses the request and names what is missing', t => {
  const f = fixture(t, { roles: null }), path = join(f.root, 'profiles/project.md'), original = readFileSync(path, 'utf8');
  const draft = () => refusal(draftRequest({ teamRoot: f.kit, instanceRoot: f.root }));
  assert.equal(draft().code, 'REQUEST_REFUSED'); assert.match(draft().reason, /WF-01/, 'a workflow with no status line');
  interviewed(f); writeFileSync(path, readFileSync(path, 'utf8').replace(/^(\s*slug:\s*)"[^"]*"/m, '$1"{{PROJECT_SLUG | derive}}"'));
  assert.match(draft().reason, /slug/);
  writeFileSync(path, original); interviewed(f, id => id === 'WF-05' ? 'sometimes' : 'enabled');
  assert.match(draft().reason, /WF-05/);
  interviewed(f, id => id === 'WF-07' ? 'disabled — not needed' : 'enabled');
  const disabled = draftRequest({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(disabled.errors, undefined); assert.match(disabled.notes.join(' '), /WF-07.*decisionRef/, 'a disabled workflow needs the owner\'s decision added by hand');
  assert.equal(refusal(draftRequest({ teamRoot: f.kit, instanceRoot: f.root, model: 'not a model' })).code, 'REQUEST_REFUSED');
  assert.equal(refusal(draftRequest({ teamRoot: f.kit, instanceRoot: f.kit })).code, 'REQUEST_REFUSED', 'a single-root layout');
});

test('the limits of a live Router/Worker team are changed by a confirmed proposal, and never while a batch holds the lock', t => {
  const f = fixture(t), common = { teamRoot: f.kit, instanceRoot: f.root };
  assert.match(refusal(proposeLimits({ ...common, limits: { outputAllowancePerTicket: 20000 } })).reason, /not in Router\/Worker mode/);
  f.apply();
  const proposal = proposeLimits({ ...common, limits: { outputAllowancePerTicket: 20000 } });
  assert.equal(proposal.errors, undefined, JSON.stringify(proposal.errors));
  assert.deepEqual(proposal.from, DEFAULT_LIMITS); assert.deepEqual(proposal.to, { ...DEFAULT_LIMITS, outputAllowancePerTicket: 20000 });
  assert.equal(refusal(changeLimits({ ...common, limits: { outputAllowancePerTicket: 20000 }, confirm: 'sha256:' + '0'.repeat(64) })).code, 'LIMITS_NOT_CONFIRMED');
  assert.deepEqual(JSON.parse(f.read('profiles/team-mode.json')).limits, DEFAULT_LIMITS);
  for (const bad of [{ outputAllowancePerTicket: 0 }, { unknown: 5 }, { attemptsPerTicket: 4 }, {}, { outputAllowancePerTicket: 15000 }])
    assert.equal(refusal(proposeLimits({ ...common, limits: bad })).code, 'LIMITS_REFUSED', JSON.stringify(bad));
  const lock = acquireLease({ teamRoot: f.root, productRoot: f.product });
  assert.match(refusal(changeLimits({ ...common, limits: { outputAllowancePerTicket: 20000 }, confirm: proposal.digest })).reason, /lock/);
  releaseLease({ productRoot: f.product, lease: lock.lease.digest });
  const done = changeLimits({ ...common, limits: { outputAllowancePerTicket: 20000 }, confirm: proposal.digest, atTerminal: true });
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(done.stage, 'limits-changed');
  const mode = JSON.parse(f.read('profiles/team-mode.json'));
  assert.equal(mode.limits.outputAllowancePerTicket, 20000); assert.equal(mode.status, 'live'); assert.ok(mode.ownFiles.length > 0, 'the rest of the profile is kept');
  assert.match(f.read('pm-decisions.md'), /LIMITS CHANGED: outputAllowancePerTicket 15000 -> 20000; .*typed at an interactive terminal/);
  // The changed limits go on holiday and come back with the team.
  f.apply('specialist', {}); assert.equal(f.propose('router-worker', {}).limits.outputAllowancePerTicket, 20000);
});

test('CLI: request prints the drafted request; limits proposes and changes nothing without a terminal', t => {
  const f = fixture(t, { roles: null }); interviewed(f);
  const run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', input: 'x\n' });
  const drafted = run('request', '--instance', f.root, '--model', 'sonnet');
  assert.equal(drafted.status, 0, drafted.stderr); const request = JSON.parse(drafted.stdout);
  assert.equal(request.spec.profiles.check.model, 'sonnet'); assert.deepEqual(request.limits, DEFAULT_LIMITS);
  assert.equal(run('request').status, 1); assert.equal(run('request', '--instance', f.root, '--bogus', 'x').status, 1);
  assert.equal(switchMode({ to: 'router-worker', request, ...f.common, confirm: proposeSwitch({ to: 'router-worker', request, ...f.common }).digest }).errors, undefined);
  const file = join(f.base, 'limits.json'); writeFileSync(file, JSON.stringify({ guardianOutputShare: 8000 }));
  const proposed = run('limits', file, '--instance', f.root);
  assert.equal(proposed.status, 2); assert.equal(JSON.parse(proposed.stdout).stage, 'limits-proposed'); assert.match(proposed.stderr, /interactive terminal/);
  assert.equal(JSON.parse(f.read('profiles/team-mode.json')).limits.guardianOutputShare, 6000);
  assert.equal(run('limits', file).status, 1);
});
