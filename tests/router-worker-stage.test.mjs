// Rollout gate G-01: an instance draft is materialized into an isolated staging
// copy that the unmodified deployment validator judges; the instance and its kit
// are never written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { draftTeam } from '../src/router-worker/draft.mjs';
import { stageTeam } from '../src/router-worker/stage.mjs';
import { draftSpecFixture } from './fixtures/router-worker/draft-spec.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const snapshot = dir => execFileSync('bash', ['-c', 'cd "$1" && find . -type f -not -path "./kit/.git/*" -exec shasum -a 256 {} + | sort', 'sh', dir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' });

function instance(t, { versioned = false } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-stage-'))), root = join(base, 'fixture.team'), kit = join(root, 'kit');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n')
    .filter(path => path && !/^(tests|src|docs\/design|\.github)\//.test(path));
  for (const path of tracked) { mkdirSync(dirname(join(kit, path)), { recursive: true }); cpSync(join(ROOT, path), join(kit, path)); }
  if (versioned) { git(kit, 'init', '-q'); git(kit, 'add', '-A'); git(kit, 'commit', '-q', '-m', 'fixture kit'); }
  const run = spawnSync('bash', [join(kit, 'scripts/bootstrap-team.sh'), '--project-name', 'Tag List Fixture', '--product-repo', '/fixture-product-not-created', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // A specialist wrapper the instance had before the mode change.
  mkdirSync(join(root, '.claude/agents'), { recursive: true });
  writeFileSync(join(root, '.claude/agents/tag-list-fixture-frontend.md'), '---\nname: "tag-list-fixture-frontend"\ndescription: "specialist"\nmodel: "opus"\n---\n\nSpecialist wrapper.\n');
  const roots = { teamRoot: kit, instanceRoot: root }, spec = draftSpecFixture(), { draft, errors } = draftTeam(spec, roots);
  assert.equal(errors, undefined, JSON.stringify(errors));
  return { base, root, kit, roots, spec, draft, staging: join(base, 'fixture.rw-staging') };
}
// The interview answers a real deployment supplies; the validator rejects open placeholders.
function answerInterview(root) {
  for (const path of ['charter.md', 'profiles/project.md', 'profiles/stack.md', 'agents/_shared/verify-discipline.md', 'CLAUDE.md'])
    writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace(/\{\{[^}]*\}\}/g, 'fixture-answer'));
}

test('stage materializes the draft in a new isolated copy and never writes the instance or kit', t => {
  const f = instance(t), before = snapshot(f.root);
  writeFileSync(join(f.root, '.claude/settings.local.json'), '{"fixture":"local"}\n');
  writeFileSync(join(f.root, '.e' + 'nv'), 'FIXTURE=1\n');
  symlinkSync(f.kit, join(f.root, 'link-out'));
  const during = snapshot(f.root), result = stageTeam(f.spec, f.draft, f.staging, f.roots);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(snapshot(f.root), during, 'the instance and its kit are byte-identical after staging');
  assert.notEqual(during, before);
  assert.equal(result.launchable, false); assert.equal(result.instanceUnchanged, true); assert.equal(result.path, f.staging);
  for (const [path, text] of Object.entries(f.draft.files)) assert.equal(readFileSync(join(f.staging, path), 'utf8'), text, path);
  assert.equal(readFileSync(join(f.staging, 'charter.md'), 'utf8'), readFileSync(join(f.root, 'charter.md'), 'utf8'), 'instance authority is copied, not re-instantiated');
  assert.equal(readFileSync(join(f.staging, 'kit/charter.template.md'), 'utf8'), readFileSync(join(f.kit, 'charter.template.md'), 'utf8'));
  assert.deepEqual(readdirSync(join(f.staging, '.claude/agents')).sort(),
    ['tag-list-fixture-worker-check.md', 'tag-list-fixture-worker-exec.md', 'tag-list-fixture-worker-guard.md']);
  assert.deepEqual(result.removedWrappers, ['.claude/agents/tag-list-fixture-frontend.md']);
  for (const path of ['.claude/settings.local.json', '.e' + 'nv', 'link-out']) {
    assert.equal(existsSync(join(f.staging, path)), false, `${path} must not be copied`);
    assert.ok(result.skipped.includes(path), `${path} is reported as skipped`);
  }
  assert.equal(JSON.parse(readFileSync(join(f.staging, 'profiles/team-mode.json'), 'utf8')).launchable, false);
});

test('stage reports the deployment validator verdict from the staging copy', t => {
  const pending = instance(t), failed = stageTeam(pending.spec, pending.draft, pending.staging, pending.roots);
  assert.equal(failed.errors, undefined, JSON.stringify(failed.errors));
  assert.equal(failed.stage, 'staged-validation-failed');
  assert.match(failed.validator.verdict, /DEPLOYMENT-INCOMPLETE/);
  assert.ok(failed.validator.failures.some(line => /placeholders/.test(line)), JSON.stringify(failed.validator));
  assert.ok(existsSync(pending.staging), 'a failed staging copy is kept for inspection');

  const f = instance(t); answerInterview(f.root);
  const { draft } = draftTeam(f.spec, f.roots), result = stageTeam(f.spec, draft, f.staging, f.roots);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.stage, 'staged-structurally-validated', JSON.stringify(result.validator));
  assert.match(result.validator.verdict, /DEPLOYMENT-STRUCTURALLY-COMPLETE/);
  assert.deepEqual(result.validator.failures, []);
  assert.equal(result.launchable, false, 'a validated staging copy is still not launchable');
  assert.ok(result.unresolved.includes('live-activation'));
});

test('stage lists every enabled workflow duty that the staged roster does not staff', t => {
  const f = instance(t), result = stageTeam(f.spec, f.draft, f.staging, f.roots);
  const enabled = f.draft.coverage.rows.filter(row => row.status === 'enabled');
  const expected = enabled.flatMap(row => row.duties.filter(d => ['design', 'coach', 'audit', 'security'].includes(d)).map(d => `${row.id}:${d}`)).sort();
  assert.ok(expected.length > 0, 'the fixture enables workflows with governance duties');
  assert.deepEqual(result.unstaffed.map(u => `${u.workflow}:${u.duty}`).sort(), expected);
  assert.ok(result.unstaffed.every(u => ['architect', 'coach', 'auditor', 'security'].includes(u.role)));
  assert.ok(!result.unstaffed.some(u => ['pm', 'exec', 'check', 'guard'].includes(u.duty)), 'PM and the three workers are staffed');
});

test('stage clones a versioned kit at the pinned commit and refuses a dirty kit', t => {
  const f = instance(t, { versioned: true }), head = git(f.kit, 'rev-parse', 'HEAD').trim();
  assert.match(readFileSync(join(f.root, 'kit.lock'), 'utf8'), new RegExp(`kit_commit=${head}`));
  const result = stageTeam(f.spec, f.draft, f.staging, f.roots);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.deepEqual(result.kit, { source: 'git-clone', commit: head });
  assert.equal(git(join(f.staging, 'kit'), 'rev-parse', 'HEAD').trim(), head);
  assert.equal(git(f.kit, 'status', '--porcelain'), '', 'the instance kit work tree stays clean');
  assert.equal(git(f.kit, 'rev-parse', 'HEAD').trim(), head);
  assert.ok(!result.validator.failures.some(line => /^FAIL - kit-/.test(line)), JSON.stringify(result.validator.failures));

  const dirty = instance(t, { versioned: true });
  writeFileSync(join(dirty.kit, 'charter.template.md'), readFileSync(join(dirty.kit, 'charter.template.md'), 'utf8') + '\nlocal edit\n');
  assert.ok(stageTeam(dirty.spec, dirty.draft, dirty.staging, dirty.roots).errors);
  assert.equal(existsSync(dirty.staging), false);
});

test('stage refuses unsafe destinations, a draft that does not verify, and kit mode', t => {
  const f = instance(t), stage = (path, draft = f.draft, roots = f.roots) => stageTeam(f.spec, draft, path, roots);
  mkdirSync(join(f.base, 'taken.rw-staging'));
  for (const path of [join(f.base, 'taken.rw-staging'), join(f.base, 'not-a-staging-name'), join(f.root, 'inside.rw-staging'),
    join(f.kit, 'inside.rw-staging'), join(f.base, 'missing-parent/x.rw-staging'), join(f.base, '.claude/x.rw-staging'), 'relative.rw-staging'])
    assert.ok(stage(path).errors, path);
  assert.ok(stage(f.staging, { ...f.draft, files: { ...f.draft.files, 'agents/roster.md': f.draft.files['agents/roster.md'] + 'x' } }).errors, 'tampered draft');
  assert.ok(stage(f.staging, f.draft, { teamRoot: f.kit }).errors, 'staging needs an instance');
  writeFileSync(join(f.root, 'charter.md'), readFileSync(join(f.root, 'charter.md'), 'utf8') + '\nedited after the draft\n');
  assert.ok(stage(f.staging).errors, 'a draft older than the instance charter is refused');
  assert.equal(existsSync(f.staging), false, 'a refused stage leaves nothing behind');
});

test('team-mode CLI: stage writes the staging copy and exits by validator verdict', t => {
  const f = instance(t), specPath = join(f.base, 'spec.json'), draftPath = join(f.base, 'fixture.rw-draft.json');
  writeFileSync(specPath, JSON.stringify(f.spec));
  cpSync(join(ROOT, 'src'), join(f.kit, 'src'), { recursive: true });
  const cli = (...args) => spawnSync(process.execPath, [join(f.kit, 'scripts/team-mode.mjs'), ...args], { encoding: 'utf8', cwd: f.root });
  assert.equal(cli('draft', specPath, draftPath, '--instance', '.').status, 0);
  const pending = cli('stage', specPath, draftPath, f.staging, '--instance', '.');
  assert.equal(pending.status, 2, pending.stdout + pending.stderr);
  assert.equal(JSON.parse(pending.stdout).stage, 'staged-validation-failed');
  assert.equal(cli('stage', specPath, draftPath, f.staging, '--instance', '.').status, 2, 'an existing staging copy is never overwritten');
  assert.equal(cli('stage', specPath, draftPath, join(f.base, 'other.rw-staging')).status, 1, 'stage requires --instance');
});
