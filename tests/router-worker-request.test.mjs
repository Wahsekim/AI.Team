// ADR 0010, decision 7: the kit proposes the staffing and the limits of a Router/Worker team; the owner confirms them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { draftRequest } from '../src/router-worker/request.mjs';
import { proposeSwitch, switchMode, proposeLimits, changeLimits, DEFAULT_LIMITS } from '../src/router-worker/switch.mjs';
import { acquireLease, releaseLease, readLease } from '../src/router-worker/lease.mjs';
import { fixture, CLI } from './fixtures/router-worker/standing-team.mjs';
import { digest } from '../src/loop/contracts.mjs';

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
  const writes = { model: 'opus', effort: 'medium', maxTurns: 40, tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'] }, reads = { ...writes, tools: ['Read', 'Grep', 'Glob'] };
  assert.deepEqual(spec.governance, { architect: writes, coach: writes, auditor: reads, security: reads });
  assert.deepEqual(limits, DEFAULT_LIMITS); assert.ok(drafted.notes.some(note => /profiles\/stack\.md gives no verification commands/.test(note)), 'a stack profile that is not filled in proposes no command, and says so');
  // The commands a worker may run in a batch are proposed from the project's own required gates.
  writeFileSync(join(f.root, 'profiles/stack.md'), '# Stack\n\n```yaml\nverification:\n  code_shipping:\n    required:\n      - npm run lint\n      - "npm test"\n```\n');
  const proposed = draftRequest({ teamRoot: f.kit, instanceRoot: f.root });
  assert.deepEqual(proposed.request.limits.allowedCommands, ['npm run lint', 'npm test']); assert.ok(!proposed.notes.some(note => /stack\.md/.test(note)));
  // A gate the switch would refuse as it is written is left out, and named: the request that is printed is one the switch accepts.
  writeFileSync(join(f.root, 'profiles/stack.md'), '# Stack\n\n```yaml\nverification:\n  code_shipping:\n    required:\n      - npm run lint\n      - npm test  # the suite\n```\n');
  const partly = draftRequest({ teamRoot: f.kit, instanceRoot: f.root });
  assert.deepEqual(partly.request.limits.allowedCommands, ['npm run lint']); assert.ok(partly.notes.some(note => /1 gate\(s\) that cannot be confirmed as they are written.*npm test  # the suite/.test(note)));
  // Gates beyond the most a team may confirm are left out, and named.
  writeFileSync(join(f.root, 'profiles/stack.md'), '# Stack\n\n```yaml\nverification:\n  code_shipping:\n    required:\n' + Array.from({ length: 52 }, (_, i) => `      - make t${i}\n`).join('') + '```\n');
  const many = draftRequest({ teamRoot: f.kit, instanceRoot: f.root });
  assert.equal(many.request.limits.allowedCommands.length, 50); assert.ok(many.notes.some(note => /2 gate\(s\) beyond the 50 a team may confirm.*"make t50", "make t51"/.test(note)), JSON.stringify(many.notes));
  assert.deepEqual(spec.workflowStates['WF-16'], { status: 'deferred', reason: 'first release is serial', decisionRef: null });
  assert.deepEqual(spec.workflowStates['WF-00'], { status: 'enabled', reason: 'As recorded in profiles/project.md', decisionRef: null });
  // A team bootstrapped with no delivery role goes straight into Router/Worker mode with this request.
  const proposal = proposeSwitch({ to: 'router-worker', request: drafted.request, ...f.common });
  assert.equal(proposal.errors, undefined, JSON.stringify(proposal.errors)); assert.deepEqual(proposal.pack, ['agents/roster.md']);
  assert.deepEqual(proposal.project, spec.project, 'the owner sees what was read from the profile'); assert.deepEqual(proposal.workflowsNotEnabled, { 'WF-16': 'deferred' });
  const done = switchMode({ to: 'router-worker', request: drafted.request, ...f.common, confirm: proposal.digest, atTerminal: true });
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
  // Only the profile's own YAML blocks count, and a reason is kept whole.
  const reasons = { 'WF-03': 'deferred — POC (ADR 0002)', 'WF-04': 'deferred (until the API exists)', 'WF-05': 'profile-bound: needs a runtime', 'WF-06': 'deferred - later' };
  interviewed(f, id => reasons[id] ?? 'enabled');
  writeFileSync(path, '---\nname: "front matter"\nslug: "other-slug"\n---\n\nExample, not a status:\n\n  WF-05: "disabled — example only"\n\n' + readFileSync(path, 'utf8'));
  const read = draftRequest({ teamRoot: f.kit, instanceRoot: f.root }).request.spec;
  assert.equal(read.project.name, 'Tag List Fixture'); assert.equal(read.project.slug, 'tag-list-fixture');
  assert.deepEqual(['WF-03', 'WF-04', 'WF-05', 'WF-06'].map(id => [read.workflowStates[id].status, read.workflowStates[id].reason]),
    [['deferred', 'POC (ADR 0002)'], ['deferred', 'until the API exists'], ['profile-bound', 'needs a runtime'], ['deferred', 'later']]);
  for (const odd of ['enabled, but deferred until the API exists', 'enabled-later', 'enabled?', 'Enabled']) {
    interviewed(f, id => id === 'WF-09' ? odd : 'enabled'); assert.match(draft().reason, /not readable: WF-09$/, odd); }
  interviewed(f); writeFileSync(path, readFileSync(path, 'utf8').replace('  WF-02: "enabled"', '  WF-02: "enabled"\n  WF-02: "deferred"'));
  assert.match(draft().reason, /more than one value for: WF-02/);
  interviewed(f); writeFileSync(path, readFileSync(path, 'utf8').replace(/^(\s+name:\s*)"[^"]*"/m, '$1"Acme \\"Tag\\" Tool"'));
  assert.match(draft().reason, /does not answer: name/, 'an escaped quote is not read as a shorter name');
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
  for (const bad of [{ outputAllowancePerTicket: 0 }, { unknown: 5 }, { attemptsPerTicket: 4 }, {}, { outputAllowancePerTicket: 15000 }, { authorizationPerTicket: 14999 }, { outputAllowancePerTicket: 200001 }, null, [1]])
    assert.equal(refusal(proposeLimits({ ...common, limits: bad })).code, 'LIMITS_REFUSED', JSON.stringify(bad));
  // A stored profile that does not hold the four limits is refused by name, not completed by guesswork.
  const profile = join(f.root, 'profiles/team-mode.json'), stored = readFileSync(profile, 'utf8');
  for (const broken of [null, 'x', { attemptsPerTicket: 1 }]) {
    writeFileSync(profile, JSON.stringify({ ...JSON.parse(stored), limits: broken }));
    assert.match(refusal(proposeLimits({ ...common, limits: { attemptsPerTicket: 2 } })).reason, /team-mode\.json/, JSON.stringify(broken)); }
  writeFileSync(profile, stored);
  mkdirSync(join(f.root, 'holiday'), { recursive: true }); writeFileSync(join(f.root, 'holiday/.switch-in-progress.json'), '{}');
  assert.match(refusal(proposeLimits({ ...common, limits: { attemptsPerTicket: 2 } })).reason, /interrupted/);
  rmSync(join(f.root, 'holiday/.switch-in-progress.json'));
  // A change is never in force without its ledger line.
  chmodSync(join(f.root, 'pm-decisions.md'), 0o444);
  assert.equal(refusal(changeLimits({ ...common, limits: { outputAllowancePerTicket: 20000 }, confirm: proposal.digest, atTerminal: true })).code, 'LIMITS_REFUSED');
  assert.equal(readFileSync(profile, 'utf8'), stored); assert.equal(readLease({ productRoot: f.product }).status, 'free');
  chmodSync(join(f.root, 'pm-decisions.md'), 0o644);
  const lock = acquireLease({ teamRoot: f.root, productRoot: f.product });
  assert.match(refusal(changeLimits({ ...common, limits: { outputAllowancePerTicket: 20000 }, confirm: proposal.digest, atTerminal: true })).reason, /lock/);
  releaseLease({ productRoot: f.product, lease: lock.lease.digest });
  const done = changeLimits({ ...common, limits: { outputAllowancePerTicket: 20000 }, confirm: proposal.digest, atTerminal: true });
  assert.equal(done.errors, undefined, JSON.stringify(done.errors)); assert.equal(done.stage, 'limits-changed');
  const mode = JSON.parse(f.read('profiles/team-mode.json'));
  assert.equal(mode.limits.outputAllowancePerTicket, 20000); assert.equal(mode.status, 'live'); assert.ok(mode.ownFiles.length > 0, 'the rest of the profile is kept');
  assert.match(f.read('pm-decisions.md'), new RegExp(`LIMITS CHANGED: outputAllowancePerTicket 15000 -> 20000; .*typed at an interactive terminal; limits ${digest(mode.limits)}\\.\\n`));
  assert.equal(readLease({ productRoot: f.product }).status, 'free', 'the lock taken for the write is given back');
  // A program that calls the change confirms nothing, even one that says it runs at a terminal.
  const twice = { ...common, limits: { attemptsPerTicket: 2 }, confirm: proposeLimits({ ...common, limits: { attemptsPerTicket: 2 } }).digest }, ledger = f.read('pm-decisions.md');
  assert.equal(refusal(changeLimits(twice)).code, 'LIMITS_NOT_CONFIRMED');
  const { NODE_TEST_CONTEXT, ...outsideTests } = process.env;
  const program = spawnSync(process.execPath, ['--input-type=module', '-e', `import { changeLimits } from ${JSON.stringify(new URL('../src/router-worker/switch.mjs', import.meta.url).href)};
process.stdout.write(JSON.stringify(changeLimits(${JSON.stringify({ ...twice, atTerminal: true })})));`], { encoding: 'utf8', env: outsideTests });
  assert.equal(refusal(JSON.parse(program.stdout)).code, 'LIMITS_NOT_CONFIRMED', program.stderr); assert.match(refusal(JSON.parse(program.stdout)).reason, /interactive terminal/);
  assert.equal(f.read('pm-decisions.md'), ledger); assert.equal(JSON.parse(f.read('profiles/team-mode.json')).limits.attemptsPerTicket, 1);
  assert.equal(changeLimits({ ...twice, atTerminal: true }).errors, undefined);
  assert.match(f.read('pm-decisions.md'), /LIMITS CHANGED: attemptsPerTicket 1 -> 2; .*typed at an interactive terminal/);
  // The changed limits go on holiday and come back with the team.
  f.apply('specialist', {}); assert.equal(f.propose('router-worker', {}).limits.outputAllowancePerTicket, 20000);
  assert.equal(f.apply('router-worker', {}).errors, undefined);
  assert.match(f.read('pm-decisions.md').trim().split('\n').at(-1), new RegExp(`MODE SWITCH: from specialist to router-worker; .*; limits ${digest(JSON.parse(f.read('profiles/team-mode.json')).limits)}\\.$`), 'the team that comes back is bound to the limits it brings');
});

test('CLI: request prints the drafted request; limits proposes and changes nothing without a terminal', t => {
  const f = fixture(t, { roles: null }); interviewed(f);
  const run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', input: 'x\n' });
  const drafted = run('request', '--instance', f.root, '--model', 'sonnet');
  assert.equal(drafted.status, 0, drafted.stderr); const request = JSON.parse(drafted.stdout);
  assert.equal(request.spec.profiles.check.model, 'sonnet'); assert.deepEqual(request.limits, DEFAULT_LIMITS);
  assert.equal(run('request').status, 1); assert.equal(run('request', '--instance', f.root, '--bogus', 'x').status, 1); assert.equal(run('request', '--instance', '--ui').status, 1);
  assert.equal(switchMode({ to: 'router-worker', request, ...f.common, confirm: proposeSwitch({ to: 'router-worker', request, ...f.common }).digest, atTerminal: true }).errors, undefined);
  const file = join(f.base, 'limits.json'); writeFileSync(file, JSON.stringify({ guardianOutputShare: 8000 }));
  const proposed = run('limits', file, '--instance', f.root);
  assert.equal(proposed.status, 2); assert.equal(JSON.parse(proposed.stdout).stage, 'limits-proposed'); assert.match(proposed.stderr, /interactive terminal/);
  assert.equal(JSON.parse(f.read('profiles/team-mode.json')).limits.guardianOutputShare, 6000);
  assert.equal(run('limits', file).status, 1);
  const unreadable = run('limits', join(f.base, 'absent.json'), '--instance', f.root);
  assert.equal(unreadable.status, 2); assert.match(unreadable.stderr, /absent\.json is not readable JSON/);
});
