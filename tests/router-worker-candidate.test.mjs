import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/loop/contracts.mjs';
import { observeCandidate, candidateObservation, bindCandidate, assertCandidateCurrent, bindCheckReport } from '../src/router-worker/candidate.mjs';
import { inputFixture, failedCheckReport } from './fixtures/router-worker/input.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (root, path, text) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-candidate-')));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  git(root, 'init', '-q');
  put(root, 'src/tag-list/view.ts', 'export const retry = false;\n');
  put(root, 'src/api/tags.ts', 'export const tags = [];\n');
  put(root, '.gitignore', 'generated/\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
  const baseline = observeCandidate({ root }), observed = candidateObservation(baseline), input = inputFixture();
  input.baseline.commit = observed.snapshot.baseCommit; input.baseline.candidateRef = observed.reference;
  return { root, input, baseline };
}
function changed(f) { put(f.root, 'src/tag-list/view.ts', 'export const retry = true;\n'); return observeCandidate({ root: f.root }); }

test('binds actual local changes to the compiled assignment without accepting or executing them', t => {
  const f = fixture(t), candidate = changed(f), before = readFileSync(join(f.root, 'src/tag-list/view.ts'));
  const result = bindCandidate({ ...f, candidate });
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.summary.changedPaths, ['src/tag-list/view.ts']);
  assert.deepEqual(result.summary.unplannedPaths, []);
  assert.equal(result.summary.deliveryAuthorized, false); assert.equal(result.summary.launchable, false);
  assert.equal(result.summary.evidenceStatus, 'not-executed');
  const { digest: hash, ...body } = result.summary; assert.equal(hash, digest(body));
  assert.equal(assertCandidateCurrent(result.binding).errors, undefined);
  assert.deepEqual(readFileSync(join(f.root, 'src/tag-list/view.ts')), before);
  assert.equal(git(f.root, 'rev-parse', 'HEAD').trim(), f.input.baseline.commit);
});

test('observations and bindings cannot be supplied as serialized worker claims', t => {
  const f = fixture(t), candidate = changed(f);
  assert.equal(bindCandidate({ ...f, baseline: { ...f.baseline }, candidate }).errors[0].code, 'UNVERIFIED_CANDIDATE');
  assert.throws(() => candidateObservation({ kind: 'local-candidate-observation' }), /local observation token/);
  const result = bindCandidate({ ...f, candidate });
  assert.equal(assertCandidateCurrent({ ...result.binding }).errors[0].code, 'UNVERIFIED_CANDIDATE');
});

test('detached metadata mutations do not alter observed state or binding authority', t => {
  const f = fixture(t), metadata = candidateObservation(f.baseline);
  metadata.snapshot.inventory.length = 0;
  assert.equal(candidateObservation(f.baseline).snapshot.inventory.length, 3);
  const result = bindCandidate({ ...f, candidate: changed(f) }), hash = result.summary.digest;
  result.summary.deliveryAuthorized = true; result.summary.candidateRef.digest = digest('forged');
  const current = assertCandidateCurrent(result.binding);
  assert.equal(current.bindingDigest, hash); assert.equal(current.deliveryAuthorized, false);
});

for (const [name, mutate, code] of [
  ['wrong baseline', f => { f.input.baseline.candidateRef.digest = digest('wrong'); }, 'BASELINE_MISMATCH'],
  ['wrong commit', f => { f.input.baseline.commit = 'a'.repeat(40); }, 'BASELINE_MISMATCH'],
  ['actual out-of-scope file', f => put(f.root, 'outside.txt', 'new'), 'SCOPE_NOT_AUTHORIZED'],
  ['actual newly sensitive file', f => {
    f.input.policy.sensitivePaths.push('src/tag-list/secret.ts'); f.input.mandate.policyDigest = digest(f.input.policy);
    put(f.root, 'src/tag-list/secret.ts', 'sensitive');
  }, 'SECURITY_CHECK_REQUIRED'],
  ['changed HEAD', f => git(f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', 'unexpected'), 'CANDIDATE_HEAD_CHANGED'],
]) test(`refuses ${name}`, t => {
  const f = fixture(t); changed(f); mutate(f);
  assert.equal(bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) }).errors[0].code, code);
});

test('rename is checked as both removed and added paths; unplanned authorized paths are disclosed', t => {
  const f = fixture(t);
  renameSync(join(f.root, 'src/tag-list/view.ts'), join(f.root, 'src/tag-list/renamed.ts'));
  const ok = bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) });
  assert.deepEqual(ok.summary.changedPaths, ['src/tag-list/renamed.ts', 'src/tag-list/view.ts']);
  assert.deepEqual(ok.summary.unplannedPaths, ['src/tag-list/renamed.ts']);
  renameSync(join(f.root, 'src/tag-list/renamed.ts'), join(f.root, 'outside.ts'));
  assert.equal(bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) }).errors[0].code, 'SCOPE_NOT_AUTHORIZED');
});

test('path grants remain exact or terminal /**; a directory name is not an implicit recursive grant', t => {
  const f = fixture(t);
  f.input.policy.allowedWritePaths.push('other'); f.input.mandate.allowedWritePaths.push('other');
  f.input.mandate.policyDigest = digest(f.input.policy);
  put(f.root, 'other/child.ts', 'not authorized');
  assert.equal(bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) }).errors[0].code, 'SCOPE_NOT_AUTHORIZED');
});

test('candidate drift before binding and after checking invalidates the earlier candidate', t => {
  const f = fixture(t), candidate = changed(f);
  put(f.root, 'src/tag-list/view.ts', 'another candidate');
  assert.equal(bindCandidate({ ...f, candidate }).errors[0].code, 'STALE_CANDIDATE');
  const bound = bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) });
  put(f.root, 'src/tag-list/view.ts', 'late mutation');
  assert.equal(assertCandidateCurrent(bound.binding).errors[0].code, 'STALE_CANDIDATE');
});

test('no change cannot be presented as candidate progress', t => {
  const f = fixture(t);
  assert.equal(bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) }).errors[0].code, 'NO_CANDIDATE_PROGRESS');
});

test('root identity, symlinks and executable-bit changes are observed', t => {
  const f = fixture(t), other = fixture(t);
  assert.equal(bindCandidate({ ...f, candidate: changed(other) }).errors[0].code, 'CANDIDATE_TARGET_MISMATCH');
  chmodSync(join(f.root, 'src/tag-list/view.ts'), 0o755);
  assert.deepEqual(bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) }).summary.changedPaths, ['src/tag-list/view.ts']);
  symlinkSync(join(f.root, 'src/api/tags.ts'), join(f.root, 'src/tag-list/link.ts'));
  assert.throws(() => observeCandidate({ root: f.root }), /Symlink/);
});

test('ignored outputs are explicitly outside this snapshot policy, not silently claimed as verified', t => {
  const f = fixture(t); changed(f); put(f.root, 'generated/output.js', 'ignored');
  const result = bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) });
  assert.equal(result.summary.snapshotPolicy, 'tracked-and-nonignored-untracked-working-tree');
  assert.ok(result.summary.unresolved.includes('ignored-files-and-git-metadata-boundary'));
  assert.equal(result.summary.deliveryAuthorized, false);
});

test('ambient Git redirection is refused without altering process environment', t => {
  const f = fixture(t), module = fileURLToPath(new URL('../src/router-worker/candidate.mjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { observeCandidate } from ${JSON.stringify(module)}; try { observeCandidate({root:${JSON.stringify(f.root)}}); process.exit(1); } catch(e) { console.log(e.code); }`],
  { encoding: 'utf8', env: { ...process.env, GIT_DIR: '/does-not-exist' } });
  assert.equal(run.status, 0); assert.match(run.stdout, /UNSUPPORTED_ENVIRONMENT/);
});

test('noninteractive observation never executes an inherited pager', t => {
  const f = fixture(t), module = fileURLToPath(new URL('../src/router-worker/candidate.mjs', import.meta.url));
  const marker = join(f.root, 'pager-ran');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { observeCandidate } from ${JSON.stringify(module)}; observeCandidate({root:${JSON.stringify(f.root)}});`],
  { encoding: 'utf8', env: { ...process.env, GIT_PAGER: `touch '${marker}'` } });
  assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(marker), false);
});

test('noninteractive observation accepts the host editor setting without invoking it', t => {
  const f = fixture(t), module = fileURLToPath(new URL('../src/router-worker/candidate.mjs', import.meta.url));
  const marker = join(f.root, 'editor-ran');
  for (const editor of ['true', `touch '${marker}'`]) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { observeCandidate } from ${JSON.stringify(module)}; observeCandidate({root:${JSON.stringify(f.root)}});`],
    { encoding: 'utf8', env: { ...process.env, GIT_EDITOR: editor } });
    assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(marker), false);
  }
});

test('editor compatibility does not admit Git discovery, index, object or config overrides', t => {
  const f = fixture(t), module = fileURLToPath(new URL('../src/router-worker/candidate.mjs', import.meta.url));
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
    'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { observeCandidate } from ${JSON.stringify(module)}; try { observeCandidate({root:${JSON.stringify(f.root)}}); process.exit(1); } catch(e) { console.log(e.code); }`],
    { encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true', [key]: '/does-not-exist' } });
    assert.equal(run.status, 0, key); assert.match(run.stdout, /UNSUPPORTED_ENVIRONMENT/, key);
  }
});

test('actual changes must satisfy both policy and mandate, regardless of staging', t => {
  for (const wider of ['policy', 'mandate']) {
    const f = fixture(t); f.input[wider].allowedWritePaths.push('extra/**');
    f.input.mandate.policyDigest = digest(f.input.policy);
    put(f.root, 'extra/staged.ts', 'staged'); git(f.root, 'add', 'extra/staged.ts');
    assert.equal(bindCandidate({ ...f, candidate: observeCandidate({ root: f.root }) }).errors[0].code, 'SCOPE_NOT_AUTHORIZED');
  }
});

test('malformed compiler inputs yield no candidate binding', t => {
  const f = fixture(t), candidate = changed(f); f.input.proposal.attempt = 2;
  const result = bindCandidate({ ...f, candidate });
  assert.deepEqual(Object.keys(result), ['errors']);
});

test('check report accounts for frozen commands but even a consistent PASS is not host evidence', t => {
  const f = fixture(t), bound = bindCandidate({ ...f, candidate: changed(f) });
  const report = structuredClone(failedCheckReport); report.candidateRef = bound.summary.candidateRef.id;
  const failed = bindCheckReport(bound.binding, report);
  assert.equal(failed.claimedOutcome, 'fail'); assert.equal(failed.evidenceStatus, 'unverified');
  report.outcome = 'pass'; report.findings = []; report.uncertainties = []; report.unexecutedChecks = [];
  report.commandsRun = f.input.policy.verificationCommands.map((command, i) => ({ command, exitCode: 0, evidenceRef: `evidence/${i}.log` }));
  const passed = bindCheckReport(bound.binding, report);
  assert.equal(passed.claimedOutcome, 'pass'); assert.equal(passed.evidenceStatus, 'unverified');
  assert.equal(passed.deliveryAuthorized, false);
  for (const [mutate, code] of [
    [r => { r.assignmentId = f.input.proposal.assignmentId; }, 'REPORT_BINDING_MISMATCH'],
    [r => { r.ticketId = 'US-09'; }, 'REPORT_BINDING_MISMATCH'],
    [r => { r.candidateRef = 'old-candidate'; }, 'REPORT_BINDING_MISMATCH'],
    [r => { r.commandsRun.pop(); }, 'REPORT_COMMAND_MISMATCH'],
    [r => { r.commandsRun[1].command = r.commandsRun[0].command; }, 'REPORT_COMMAND_MISMATCH'],
    [r => { r.commandsRun[1].command = 'echo pass'; }, 'REPORT_COMMAND_MISMATCH'],
    [r => { r.outcome = 'fail'; r.commandsRun[0].exitCode = -1; }, 'INVALID_CHECK_EXIT'],
  ]) {
    const changed = structuredClone(report); mutate(changed);
    assert.equal(bindCheckReport(bound.binding, changed).errors[0].code, code);
  }
  put(f.root, 'src/tag-list/view.ts', 'candidate after check');
  assert.equal(bindCheckReport(bound.binding, report).errors[0].code, 'STALE_CANDIDATE');
});

test('failed/blocked reports cannot conceal missing checks or label a check both run and unexecuted', t => {
  const f = fixture(t), bound = bindCandidate({ ...f, candidate: changed(f) });
  const report = structuredClone(failedCheckReport); report.candidateRef = bound.summary.candidateRef.id;
  report.unexecutedChecks = [];
  assert.equal(bindCheckReport(bound.binding, report).errors[0].code, 'REPORT_COMMAND_MISMATCH');
  report.unexecutedChecks = [...f.input.policy.verificationCommands];
  assert.equal(bindCheckReport(bound.binding, report).errors[0].code, 'REPORT_COMMAND_MISMATCH');
  report.commandsRun = []; report.outcome = 'blocked'; report.blockers = ['No isolated runner'];
  assert.equal(bindCheckReport(bound.binding, report).claimedOutcome, 'blocked');
});
