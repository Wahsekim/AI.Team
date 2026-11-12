// Activation for one disposable smoke run: a new copy of the instance in which the
// draft wrappers are runnable. It needs an owner approval bound to the exact spec
// and draft; the instance and its kit are never written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { activateTeam } from '../src/router-worker/activate.mjs';
import { draftTeam } from '../src/router-worker/draft.mjs';
import { observeIsolation } from '../src/router-worker/isolation.mjs';
import { acquireLease } from '../src/router-worker/lease.mjs';
import { digest, bytesDigest } from '../src/loop/contracts.mjs';
import { draftSpecFixture } from './fixtures/router-worker/draft-spec.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/activate-router-worker.mjs', import.meta.url));
const snapshot = dir => execFileSync('bash', ['-c', 'cd "$1" && find . -type f -exec shasum -a 256 {} + | sort', 'sh', dir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' });
const GOVERNANCE = ['architect', 'coach', 'auditor', 'security'];
const readOnly = { model: 'fixture-governance-model', effort: 'medium', maxTurns: 12, tools: ['Read', 'Grep', 'Glob'] };
const staffedSpec = () => ({ ...draftSpecFixture(), governance: Object.fromEntries(GOVERNANCE.map(role =>
  [role, ['architect', 'coach'].includes(role) ? { ...readOnly, tools: [...readOnly.tools, 'Write', 'Edit'] } : readOnly])) });

// A bootstrapped two-root instance with the interview answered, a staffed draft and an owner approval for it.
function fixture(t, { spec = staffedSpec(), answered = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-activate-'))), root = join(base, 'fixture.team'), kit = join(root, 'kit');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n')
    .filter(path => path && !/^(tests|src|docs\/design|\.github)\//.test(path));
  for (const path of tracked) { mkdirSync(dirname(join(kit, path)), { recursive: true }); cpSync(join(ROOT, path), join(kit, path)); }
  const boot = spawnSync('bash', [join(kit, 'scripts/bootstrap-team.sh'), '--project-name', 'Tag List Fixture', '--product-repo', '/fixture-product-not-created', root], { encoding: 'utf8' });
  assert.equal(boot.status, 0, boot.stdout + boot.stderr);
  if (answered) for (const path of ['charter.md', 'profiles/project.md', 'profiles/stack.md', 'agents/_shared/verify-discipline.md', 'CLAUDE.md'])
    writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace(/\{\{[^}]*\}\}/g, 'fixture-answer'));
  const roots = { teamRoot: kit, instanceRoot: root }, { draft, errors } = draftTeam(spec, roots);
  assert.equal(errors, undefined, JSON.stringify(errors));
  const approvalPath = join(base, 'activation-approval.json'), active = join(base, 'fixture.rw-active');
  const approve = (overrides = {}) => {
    const body = { schemaVersion: 1, purpose: 'router-worker-activation', status: 'approved', scope: 'disposable-smoke',
      specDigest: digest(spec), draftDigest: draft.digest, approvedBy: 'fixture owner', acceptedUnknowns: ['BASH_NOT_SANDBOXED'], ...overrides };
    writeFileSync(approvalPath, JSON.stringify(body, null, 2) + '\n');
    return bytesDigest(readFileSync(approvalPath));
  };
  const expectedApprovalDigest = approve();
  const activate = (overrides = {}) => activateTeam(spec, draft, overrides.path ?? active, { ...roots, approvalPath, expectedApprovalDigest, ...overrides });
  return { base, root, kit, roots, spec, draft, active, approvalPath, approve, expectedApprovalDigest, activate };
}
const frontmatter = text => text.split('\n').slice(0, text.split('\n').indexOf('---', 1)).filter(line => !line.startsWith('description:'));
const leftovers = base => readdirSync(base).filter(name => /\.rw-(active|staging)$/.test(name));

test('an approved, fully staffed, validated draft is activated in a new copy; the instance is untouched', t => {
  const f = fixture(t), before = snapshot(f.root), result = f.activate();
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.stage, 'activated-disposable-smoke'); assert.equal(result.path, f.active); assert.equal(result.scope, 'disposable-smoke');
  assert.equal(result.approvalFileDigest, f.expectedApprovalDigest); assert.equal(result.draftDigest, f.draft.digest);
  assert.match(result.validator.verdict, /^DEPLOYMENT-STRUCTURALLY-COMPLETE/);
  assert.equal(snapshot(f.root), before, 'the instance and its kit are byte-identical');
  assert.deepEqual(leftovers(f.base), ['fixture.rw-active'], 'no staging directory is left behind');
  const wrappers = readdirSync(join(f.active, '.claude/agents'));
  assert.equal(wrappers.length, 7);
  for (const name of wrappers) {
    const text = readFileSync(join(f.active, '.claude/agents', name), 'utf8'), drafted = f.draft.files[`.claude/agents/${name}`];
    assert.ok(!/Do not run from this draft|Inactive|inactive/.test(text), `${name} carries no inactive marker`);
    assert.deepEqual(frontmatter(text), frontmatter(drafted), `${name}: model, turns, tools, denials and permission mode are exactly the drafted ones`);
    assert.match(text, /owner-approved disposable smoke run/);
  }
  for (const path of ['agents/worker-exec.md', 'agents/router-worker-contract.md', 'agents/router-worker-router.md', 'agents/roster.md'])
    assert.ok(!/INACTIVE|inactive deployment draft/.test(readFileSync(join(f.active, path), 'utf8')), path);
  const mode = JSON.parse(readFileSync(join(f.active, 'profiles/team-mode.json'), 'utf8'));
  assert.equal(mode.status, 'activated-disposable-smoke'); assert.equal(mode.launchable, true);
  assert.deepEqual(mode.activation, { scope: 'disposable-smoke', approvalFileDigest: f.expectedApprovalDigest, specDigest: digest(f.spec),
    draftDigest: f.draft.digest, acceptedUnknowns: ['BASH_NOT_SANDBOXED'] });
  assert.ok(result.unresolved.includes('live-runtime-evidence'));
  const { digest: recorded, ...body } = result;
  assert.equal(recorded, digest(body));
});

test('the activated copy observes as clear against a clean leased product; the same wrappers as a draft do not', t => {
  const f = fixture(t), product = join(f.base, 'product');
  mkdirSync(join(product, 'src'), { recursive: true }); writeFileSync(join(product, 'src/app.js'), 'export const x = 1;\n');
  git(product, 'init', '-q'); git(product, 'add', '-A'); git(product, 'commit', '-q', '-m', 'product');
  assert.equal(f.activate().errors, undefined);
  const lease = acquireLease({ teamRoot: f.active, productRoot: product }).lease.digest;
  const observed = observeIsolation({ teamRoot: f.active, productRoot: product, lease });
  assert.equal(observed.status, 'clear', JSON.stringify(observed.findings));
  assert.ok(observed.findings.every(finding => finding.severity === 'accepted'), 'only owner-accepted findings remain, and they stay visible');
});

test('activation is refused without a matching owner approval, and nothing is left on disk', t => {
  const f = fixture(t), code = result => result.errors?.[0].code;
  assert.equal(code(f.activate({ expectedApprovalDigest: bytesDigest('another file') })), 'APPROVAL_CHANGED');
  assert.equal(code(f.activate({ approvalPath: join(f.base, 'missing.json') })), 'APPROVAL_MISSING');
  const cases = [{ draftDigest: digest('another draft') }, { specDigest: digest('another spec') }, { status: 'pending' }, { scope: 'production' },
    { purpose: 'offline-preflight' }, { acceptedUnknowns: ['PRODUCT_DIRTY'] }, { acceptedUnknowns: ['WRAPPER_INACTIVE_DRAFT'] }, { approvedBy: '' }, { extra: true }];
  for (const overrides of cases)
    assert.equal(code(f.activate({ expectedApprovalDigest: f.approve(overrides) })), 'APPROVAL_INVALID', JSON.stringify(overrides));
  assert.deepEqual(leftovers(f.base), []);
  assert.equal(code(f.activate({ path: join(f.base, 'fixture.rw-staging') })), 'INVALID_ACTIVATION', 'the destination must end in .rw-active');
  mkdirSync(f.active);
  assert.equal(code(f.activate({ expectedApprovalDigest: f.approve() })), 'INVALID_ACTIVATION', 'an existing destination is never reused');
});

test('activation is refused when the staged team is incomplete', t => {
  const code = result => result.errors?.[0].code;
  const unstaffed = fixture(t, { spec: draftSpecFixture() });
  const refused = unstaffed.activate();
  assert.equal(code(refused), 'ACTIVATION_REFUSED'); assert.match(refused.errors[0].reason, /unstaffed/);
  assert.deepEqual(leftovers(unstaffed.base), []);
  const unanswered = fixture(t, { answered: false });
  assert.equal(code(unanswered.activate()), 'ACTIVATION_REFUSED', 'a copy the deployment validator fails is not activated');
  assert.deepEqual(leftovers(unanswered.base), []);
});

test('CLI activates, exits 2 on refusal and 1 on usage', t => {
  const f = fixture(t), specFile = join(f.base, 'spec.json'), draftFile = join(f.base, 'draft.json');
  writeFileSync(specFile, JSON.stringify(f.spec)); writeFileSync(draftFile, JSON.stringify(f.draft));
  const run = (...argv) => spawnSync(process.execPath, [join(f.kit, 'scripts/activate-router-worker.mjs'), ...argv], { encoding: 'utf8' });
  cpSync(join(ROOT, 'src'), join(f.kit, 'src'), { recursive: true });
  const refused = run(specFile, draftFile, f.active, '--instance', f.root, '--approval', f.approvalPath, '--approval-digest', bytesDigest('wrong'));
  assert.equal(refused.status, 2, refused.stdout);
  const ok = run(specFile, draftFile, f.active, '--instance', f.root, '--approval', f.approvalPath, '--approval-digest', f.expectedApprovalDigest);
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).stage, 'activated-disposable-smoke');
  assert.equal(spawnSync(process.execPath, [CLI, specFile], { encoding: 'utf8' }).status, 1);
});
