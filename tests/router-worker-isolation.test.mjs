// Rollout gate G-02: the runtime-isolation admission gate is observed on the
// host, not declared. Any finding that is not clear means zero calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { observeIsolation } from '../src/router-worker/isolation.mjs';
import { acquireLease, releaseLease } from '../src/router-worker/lease.mjs';
import { digest } from '../src/loop/contracts.mjs';

const CLI = fileURLToPath(new URL('../scripts/isolation-router-worker.mjs', import.meta.url));
const DUTIES = ['exec', 'check', 'guard'];
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const wrapper = (duty, { tools, denied, mode = 'default', body = 'Active wrapper.' } = {}) => {
  tools ??= duty === 'exec' ? 'Read, Grep, Glob, Bash, Write, Edit' : 'Read, Grep, Glob';
  denied ??= duty === 'exec' ? 'Agent, Task' : 'Agent, Task, Write, Edit, NotebookEdit';
  return `---\nname: "demo-worker-${duty}"\ndescription: "fixture"\nmodel: "m"\neffort: "high"\nmaxTurns: 10\ntools: ${tools}\ndisallowedTools: ${denied}\npermissionMode: "${mode}"\n---\n\n${body}\n`;
};
const roster = ['| Role id | Role file | Wrapper file | Model | Reasoning | Status |', '|---|---|---|---|---|---|',
  '| pm | agents/pm.md | main session | inherits | owner | active |',
  ...DUTIES.map(d => `| worker-${d} | agents/worker-${d}.md | .claude/agents/demo-worker-${d}.md | m | high | active |`)].join('\n') + '\n';

// A team root with three clean wrappers and a separate, clean product repository.
function fixture(t, overrides = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-isolation-'))), team = join(base, 'demo.team'), product = join(base, 'product');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  write(team, 'agents/roster.md', roster);
  write(team, 'profiles/team-mode.json', JSON.stringify({ mode: 'router-worker', launchable: false }));
  for (const duty of DUTIES) write(team, `.claude/agents/demo-worker-${duty}.md`, overrides[duty] ?? wrapper(duty));
  write(product, 'src/app.js', 'export const x = 1;\n');
  git(product, 'init', '-q'); git(product, 'add', '-A'); git(product, 'commit', '-q', '-m', 'product');
  const lease = acquireLease({ teamRoot: team, productRoot: product }).lease.digest;
  return { base, team, product, lease, observe: () => observeIsolation({ teamRoot: team, productRoot: product, lease }) };
}
const codes = result => result.findings.map(f => f.code).sort();

test('a separate clean product and three least-privilege wrappers observe as clear', t => {
  const f = fixture(t), result = f.observe();
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.gate, 'runtime-isolation'); assert.equal(result.status, 'clear', JSON.stringify(result.findings));
  assert.deepEqual(result.findings, []);
  assert.equal(result.product.head, git(f.product, 'rev-parse', 'HEAD').trim());
  assert.deepEqual(result.wrappers, Object.fromEntries(DUTIES.map(d => [d, `demo-worker-${d}`])));
  const { digest: recorded, ...body } = result;
  assert.equal(recorded, digest(body), 'the record is self-digested');
  assert.ok(result.notObserved.includes('independent-sessions') && result.notObserved.includes('canary-negatives'), 'static observation states its limits');
  assert.ok(!result.notObserved.includes('exclusive-ownership-lease')); assert.equal(result.lease, f.lease);
  assert.deepEqual(f.observe(), result, 'deterministic for an unchanged host');
});

test('unexplained product state blocks: dirty tree, operation in progress, linked worktree', t => {
  const dirty = fixture(t); writeFileSync(join(dirty.product, 'src/app.js'), 'changed\n');
  assert.equal(dirty.observe().status, 'blocked'); assert.ok(codes(dirty.observe()).includes('PRODUCT_DIRTY'));
  const untracked = fixture(t); write(untracked.product, 'notes.txt', 'x\n');
  assert.ok(codes(untracked.observe()).includes('PRODUCT_DIRTY'));
  const merging = fixture(t); writeFileSync(join(merging.product, '.git/MERGE_HEAD'), 'x\n');
  assert.ok(codes(merging.observe()).includes('PRODUCT_OPERATION_IN_PROGRESS'));
  const locked = fixture(t); writeFileSync(join(locked.product, '.git/index.lock'), '');
  assert.ok(codes(locked.observe()).includes('PRODUCT_OPERATION_IN_PROGRESS'));
  const shared = fixture(t); git(shared.product, 'worktree', 'add', '-q', join(shared.base, 'second'), '-b', 'other');
  assert.ok(codes(shared.observe()).includes('PRODUCT_SHARED_METADATA'));
});

test('the product must be a repository root that neither contains nor lies inside the team root', t => {
  const f = fixture(t);
  assert.ok(codes(observeIsolation({ teamRoot: f.team, productRoot: join(f.product, 'src') })).includes('PRODUCT_NOT_REPOSITORY_ROOT'));
  assert.ok(codes(observeIsolation({ teamRoot: f.team, productRoot: f.base })).includes('PRODUCT_NOT_REPOSITORY_ROOT'));
  const nested = fixture(t), inner = join(nested.product, 'team');
  write(inner, 'agents/roster.md', roster); for (const duty of DUTIES) write(inner, `.claude/agents/demo-worker-${duty}.md`, wrapper(duty));
  assert.ok(codes(observeIsolation({ teamRoot: inner, productRoot: nested.product, lease: nested.lease })).includes('PRODUCT_NOT_SEPARATE'));
  const link = join(f.base, 'product-link'); symlinkSync(f.product, link);
  assert.ok(observeIsolation({ teamRoot: f.team, productRoot: link }).errors, 'a non-canonical product path is refused');
});

test('paths the candidate diff cannot see make the gate unknown, not clear', t => {
  const ignored = fixture(t); write(ignored.product, '.gitignore', 'build/\n'); git(ignored.product, 'add', '-A'); git(ignored.product, 'commit', '-q', '-m', 'ignore');
  write(ignored.product, 'build/out.bin', 'artifact\n');
  const result = ignored.observe();
  assert.equal(result.status, 'unknown'); assert.deepEqual(codes(result), ['IGNORED_PATHS_PRESENT']);
  const external = fixture(t); symlinkSync(external.base, join(external.product, 'outside')); git(external.product, 'add', '-A'); git(external.product, 'commit', '-q', '-m', 'link');
  assert.deepEqual(codes(external.observe()), ['EXTERNAL_SYMLINK']);
  const internal = fixture(t); symlinkSync('src/app.js', join(internal.product, 'alias.js')); git(internal.product, 'add', '-A'); git(internal.product, 'commit', '-q', '-m', 'link');
  assert.equal(internal.observe().status, 'clear', 'a symlink that stays inside the product is not a boundary problem');
});

test('wrapper permissions are read from the registry files, not from declarations', t => {
  const cases = [
    [{ check: wrapper('check', { tools: 'Read, Grep, Glob, Write' }) }, 'READ_ONLY_DUTY_CAN_WRITE', 'blocked'],
    [{ guard: wrapper('guard', { denied: 'Agent, Task' }) }, 'READ_ONLY_DUTY_CAN_WRITE', 'blocked'],
    [{ exec: wrapper('exec', { denied: 'Task' }) }, 'DELEGATION_ALLOWED', 'blocked'],
    [{ exec: wrapper('exec', { mode: 'bypassPermissions' }) }, 'PERMISSION_MODE', 'blocked'],
    [{ check: wrapper('check', { body: 'Do not run from this draft. Runtime activation is not implemented.' }) }, 'WRAPPER_INACTIVE_DRAFT', 'blocked'],
    [{ check: wrapper('check', { tools: 'Read, Grep, Glob, Bash' }) }, 'BASH_NOT_SANDBOXED', 'unknown'],
    [{ guard: '---\nname: "another-name"\ntools: Read\ndisallowedTools: Agent, Task, Write, Edit, NotebookEdit\npermissionMode: "default"\n---\n\nx\n' }, 'WRAPPER_IDENTITY', 'blocked'],
  ];
  for (const [overrides, code, status] of cases) {
    const result = fixture(t, overrides).observe();
    assert.ok(codes(result).includes(code), `${code}: ${JSON.stringify(result.findings)}`); assert.equal(result.status, status, code);
  }
  const missing = fixture(t); rmSync(join(missing.team, '.claude/agents/demo-worker-guard.md'));
  assert.ok(codes(missing.observe()).includes('WRAPPER_MISSING'));
});

test('host settings that bypass or widen permissions are findings, reported without their values', t => {
  const bypass = fixture(t); write(bypass.team, '.claude/settings.json', JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  assert.ok(codes(bypass.observe()).includes('HOST_PERMISSION_BYPASS')); assert.equal(bypass.observe().status, 'blocked');
  const wide = fixture(t);
  write(wide.team, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash', 'Read(//secret-host/**)'], additionalDirectories: ['/private/secret-dir'] } }));
  const result = wide.observe();
  assert.deepEqual(codes(result), ['ADDITIONAL_DIRECTORIES', 'BROAD_BASH_ALLOW']); assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('secret'), 'setting values never enter the record');
  const broken = fixture(t); write(broken.product, '.claude/settings.json', '{not json'); git(broken.product, 'add', '-A'); git(broken.product, 'commit', '-q', '-m', 'settings');
  assert.ok(codes(broken.observe()).includes('HOST_SETTINGS_UNREADABLE'));
});

test('zero calls without ownership: the gate needs the lease this host holds', t => {
  const f = fixture(t), other = join(f.base, 'other.team');
  const without = observeIsolation({ teamRoot: f.team, productRoot: f.product });
  assert.deepEqual(codes(without), ['OWNERSHIP_NOT_PRESENTED']); assert.equal(without.status, 'blocked');
  const wrong = observeIsolation({ teamRoot: f.team, productRoot: f.product, lease: 'sha256:' + '0'.repeat(64) });
  assert.deepEqual(codes(wrong), ['OWNERSHIP_HELD_BY_OTHER']); assert.equal(wrong.status, 'blocked');
  mkdirSync(other); write(other, 'agents/roster.md', roster); for (const duty of DUTIES) write(other, `.claude/agents/demo-worker-${duty}.md`, wrapper(duty));
  const stolen = observeIsolation({ teamRoot: other, productRoot: f.product, lease: f.lease });
  assert.deepEqual(codes(stolen), ['OWNERSHIP_HELD_BY_OTHER'], 'a lease digest does not transfer to another team root');
  assert.ok(!JSON.stringify(stolen).includes(f.team), 'the other holder is not disclosed');
  releaseLease({ productRoot: f.product, lease: f.lease });
  assert.deepEqual(codes(f.observe()), ['OWNERSHIP_NOT_HELD']);
  writeFileSync(join(f.product, '.git/rw-ownership-lease.json'), '{broken');
  const unreadable = f.observe();
  assert.deepEqual(codes(unreadable), ['OWNERSHIP_UNREADABLE']); assert.equal(unreadable.status, 'unknown');
});

test('CLI prints the record and exits 0 only when the gate is clear', t => {
  const f = fixture(t), run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const clear = run('--team-root', f.team, '--product-root', f.product, '--lease', f.lease);
  assert.equal(clear.status, 0, clear.stderr); assert.equal(JSON.parse(clear.stdout).status, 'clear');
  write(f.product, 'untracked.txt', 'x\n');
  const blocked = run('--team-root', f.team, '--product-root', f.product, '--lease', f.lease);
  assert.equal(JSON.parse(run('--team-root', f.team, '--product-root', f.product).stdout).findings.some(x => x.code === 'OWNERSHIP_NOT_PRESENTED'), true);
  assert.equal(blocked.status, 2); assert.equal(JSON.parse(blocked.stdout).status, 'blocked');
  assert.equal(run('--team-root', f.team).status, 1, 'usage error');
});
