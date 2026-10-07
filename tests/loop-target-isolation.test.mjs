import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, demoBundle } from '../src/loop/demo.mjs';
import { openStore } from '../src/loop/store.mjs';
import { acquireExecutionOwner, assertOwnedTarget, bindDriver, LOCK_FILE } from '../src/loop/execution-owner.mjs';
import { targetIdentity } from '../src/loop/product-target.mjs';

// ADR 0003: execution binds only the host-created clone inside its own state directory.
const major = Number(process.versions.node.split('.')[0]);
const sqlite = { skip: major < 24 ? 'Target isolation requires the Node 24+ execution owner (node:sqlite)' : false, timeout: 15000 };
const cli = fileURLToPath(new URL('../scripts/team-run.mjs', import.meta.url));
const tick = { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null };
const code = expected => error => error.code === expected;
const git = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe', timeout: 10000 });

function repo(root, content = 'one') {
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'file.txt'), content);
  git(root, ['init', '-q']); git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}
function temp(t, prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function stateDir(t, { run = false } = {}) {
  const directory = temp(t, 'ai-target-'), cleanup = [];
  t.after(() => cleanup.reverse().forEach(fn => fn()));
  const store = await openStore(join(directory, 'loop.sqlite')); cleanup.push(() => store.close());
  if (run) { const { spec, artifacts } = demoBundle('run'); store.create(spec, artifacts, { simulation: true }); }
  const own = async target => { const owner = await acquireExecutionOwner({ store, target }); cleanup.push(() => owner.release()); return owner; };
  return { directory, store, own, lock: join(directory, LOCK_FILE), product: join(directory, 'product') };
}
// Read only after release: no module other than execution-owner.mjs may open the lock file while held (ADR 0002 P3).
async function bindings(lock) {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(lock, { readOnly: true });
  try {
    const table = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) ? db.prepare(`SELECT * FROM ${name}`).all().map(row => ({ ...row })) : null;
    return { store: table('store_binding'), target: table('target_binding') };
  } finally { db.close(); }
}
const caseAlias = path => join(dirname(path), basename(path).toUpperCase());
function caseInsensitiveVolume() {
  if (major < 24) return false;
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ai-case-')));
  try { return existsSync(caseAlias(d)); } finally { rmSync(d, { recursive: true }); }
}
// Keep the old directory until the new one exists, so the filesystem cannot reuse its inode.
function replaceDirectory(path, recreate) {
  const before = statSync(path, { bigint: true }).ino, old = `${path}.old`;
  renameSync(path, old); recreate(); rmSync(old, { recursive: true, force: true });
  assert.notEqual(statSync(path, { bigint: true }).ino, before, 'precondition: the replacement has a new inode');
}

test('TI-1: an external target is refused before any lock file or marker exists', sqlite, async t => {
  const s = await stateDir(t), outside = repo(join(temp(t, 'ai-target-ext-'), 'product'));
  const link = join(s.directory, 'link'); symlinkSync(outside, link);
  for (const target of [outside, link, relative(process.cwd(), outside)]) {
    await assert.rejects(acquireExecutionOwner({ store: s.store, target }), code('TARGET_NOT_ISOLATED'), target);
  }
  assert.equal(existsSync(s.lock), false, 'no execution-owner.sqlite was created');
  assert.deepEqual(s.store.executions(), [], 'no executions row was written');

  // Two state directories cannot share a target: nesting and repositories around the state directory are refused.
  const inner = join(s.directory, 'inner'); mkdirSync(inner); const product = repo(join(inner, 'product'));
  const innerStore = await openStore(join(inner, 'loop.sqlite')); t.after(() => innerStore.close());
  (await acquireExecutionOwner({ store: innerStore, target: product })).release();
  await assert.rejects(acquireExecutionOwner({ store: s.store, target: product }), code('TARGET_NOT_ISOLATED'), 'outer state directory');
  const work = repo(join(temp(t, 'ai-target-work-'), 'repo')), nested = join(work, 'state'); mkdirSync(nested); repo(join(nested, 'product'));
  const nestedStore = await openStore(join(nested, 'loop.sqlite')); t.after(() => nestedStore.close());
  await assert.rejects(acquireExecutionOwner({ store: nestedStore, target: join(nested, 'product') }), code('TARGET_NOT_ISOLATED'), 'state inside a work tree');
  assert.equal(existsSync(s.lock) || existsSync(join(nested, LOCK_FILE)), false);
});

test('TI-2: aliases of the host-created clone share one identity; another clone in the directory is a mismatch', sqlite, async t => {
  const s = await stateDir(t); repo(s.product);
  const first = await acquireExecutionOwner({ store: s.store, target: s.product });
  assert.equal(first.target, realpathSync.native(s.product));
  assertOwnedTarget(first, s.product);
  assert.deepEqual(first.release(), { markerClosed: true });
  const { target: [bound] } = await bindings(s.lock), root = statSync(s.product, { bigint: true }), common = statSync(join(s.product, '.git'), { bigint: true });
  assert.deepEqual(bound, { id: 1, target_path: 'product', target_dev: String(root.dev), target_ino: String(root.ino),
    git_common_path: realpathSync.native(join(s.product, '.git')), git_common_dev: String(common.dev), git_common_ino: String(common.ino) });

  const external = temp(t, 'ai-target-alias-'), outsideLink = join(external, 'to-product'), insideLink = join(s.directory, 'alias');
  symlinkSync(s.product, outsideLink); symlinkSync(s.product, insideLink);
  const aliases = [outsideLink, insideLink, relative(process.cwd(), s.product), join(s.directory, '.', 'product')];
  if (caseInsensitiveVolume()) aliases.push(caseAlias(s.product)); else t.diagnostic('case alias not applicable: volume is case-sensitive');
  const identity = targetIdentity(s.product, s.directory);
  for (const alias of aliases) {
    assert.deepEqual(targetIdentity(alias, s.directory), identity, alias);
    const owner = await acquireExecutionOwner({ store: s.store, target: alias });
    assert.equal(owner.target, identity.path); assertOwnedTarget(owner, alias); assertOwnedTarget(owner, s.product);
    assert.deepEqual(owner.release(), { markerClosed: true });
  }

  const other = repo(join(s.directory, 'other'), 'two'), rows = s.store.executions().length;
  await assert.rejects(acquireExecutionOwner({ store: s.store, target: other }), code('TARGET_MISMATCH'));
  assert.equal(s.store.executions().length, rows, 'a mismatch writes no marker');
  const owner = await s.own(s.product);
  assert.throws(() => assertOwnedTarget(owner, other), code('TARGET_MISMATCH'), 'the driver root must be the owned target');
  owner.release();
  const untargeted = await s.own(undefined);
  assert.throws(() => assertOwnedTarget(untargeted, s.product), code('TARGET_NOT_ISOLATED'), 'an owner without a target cannot drive a product');
});

test('TI-3: a replaced clone root or Git common dir is a mismatch; a held owner dispatches nothing', sqlite, async t => {
  const s = await stateDir(t, { run: true }); repo(s.product);
  (await acquireExecutionOwner({ store: s.store, target: s.product })).release();
  replaceDirectory(s.product, () => repo(s.product));
  await assert.rejects(acquireExecutionOwner({ store: s.store, target: s.product }), code('TARGET_MISMATCH'));
  assert.equal(s.store.executions().filter(e => e.open === 1).length, 0);

  const t2 = await stateDir(t, { run: true }); repo(t2.product);
  (await acquireExecutionOwner({ store: t2.store, target: t2.product })).release();
  replaceDirectory(join(t2.product, '.git'), () => { git(t2.product, ['init', '-q']); });
  await assert.rejects(acquireExecutionOwner({ store: t2.store, target: t2.product }), code('TARGET_MISMATCH'), 'new .git inode');

  const t3 = await stateDir(t, { run: true }); repo(t3.product);
  const owner = await t3.own(t3.product), fenced = bindDriver(owner, t3.store).store;
  replaceDirectory(t3.product, () => repo(t3.product));
  assert.throws(() => owner.assertHeld(), code('TARGET_MISMATCH'));
  assert.throws(() => fenced.apply('tick', command(t3.store, 'run', tick)), code('TARGET_MISMATCH'));
  assert.deepEqual(t3.store.status('run').state.dispatches, {}, 'no dispatch after the target changed');
});

test('TI-4: worktrees and shared Git metadata are refused; an independent clone is a different target', sqlite, async t => {
  const s = await stateDir(t), main = repo(join(s.directory, 'main'));
  const shapes = { subdirectory: join(main, 'sub'), plain: join(s.directory, 'plain'), separate: join(s.directory, 'separate') };
  mkdirSync(shapes.subdirectory); mkdirSync(shapes.plain);
  git(s.directory, ['init', '-q', `--separate-git-dir=${join(s.directory, 'meta')}`, shapes.separate]);
  git(s.directory, ['clone', '-q', '--shared', main, join(s.directory, 'borrowing')]);
  for (const target of [...Object.values(shapes), join(s.directory, 'borrowing')]) {
    assert.throws(() => targetIdentity(target, s.directory), code('TARGET_NOT_ISOLATED'), target);
  }
  const plainIdentity = targetIdentity(main, s.directory);
  git(main, ['worktree', 'add', '-q', join(s.directory, 'wt')]);
  await assert.rejects(acquireExecutionOwner({ store: s.store, target: join(s.directory, 'wt') }), code('TARGET_NOT_ISOLATED'), 'linked worktree');
  await assert.rejects(acquireExecutionOwner({ store: s.store, target: main }), code('TARGET_NOT_ISOLATED'), 'repository with linked worktrees');
  assert.equal(existsSync(s.lock), false);

  const c = await stateDir(t); git(c.directory, ['clone', '-q', '--no-local', main, c.product]);
  const clone = targetIdentity(c.product, c.directory);
  assert.notDeepEqual([clone.stat.dev, clone.stat.ino], [plainIdentity.stat.dev, plainIdentity.stat.ino]);
  assert.notDeepEqual([clone.git.stat.dev, clone.git.stat.ino], [plainIdentity.git.stat.dev, plainIdentity.git.stat.ino]);
  (await c.own(c.product)).release();
});

test('TI-5: a state directory inside (or equal to) the product stays SCOPE_DENIED; only product-inside-state is accepted', sqlite, async t => {
  const product = repo(join(temp(t, 'ai-target-p-'), 'product')), inner = join(product, '.state'); mkdirSync(inner);
  const store = await openStore(join(inner, 'loop.sqlite')); t.after(() => store.close());
  await assert.rejects(acquireExecutionOwner({ store, target: product }), code('SCOPE_DENIED'));
  assert.equal(existsSync(join(inner, LOCK_FILE)), false, 'no lock file was opened inside the product');
  const self = await openStore(join(product, 'loop.sqlite')); t.after(() => self.close());
  await assert.rejects(acquireExecutionOwner({ store: self, target: product }), code('SCOPE_DENIED'), 'state directory is the product');
  assert.equal(existsSync(join(product, LOCK_FILE)), false);
});

test('TI-6: the fixture CLI binds store and target; inspection never touches the lock database', sqlite, async t => {
  const directory = join(temp(t, 'ai-target-cli-'), 'run-dir'), lock = join(directory, LOCK_FILE);
  const call = action => execFileSync(process.execPath, [cli, action, directory, 'fixture-run'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(JSON.parse(call('fixture')).value.state.status, 'COMPLETED');
  const sha = () => createHash('sha256').update(readFileSync(lock)).digest('hex'), before = sha();
  const { store: [store], target: [target] } = await bindings(lock);
  assert.equal(store.store_name, 'loop.sqlite');
  assert.equal(target.target_path, 'product');
  assert.equal(target.target_ino, String(statSync(join(directory, 'product'), { bigint: true }).ino));
  for (const action of ['status', 'events', 'audit', 'show']) call(action);
  assert.equal(sha(), before, 'inspection left the lock database byte-identical');

  const fresh = await stateDir(t, { run: true });
  for (const action of ['status', 'events', 'audit', 'show']) execFileSync(process.execPath, [cli, action, fresh.directory, 'run'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(existsSync(fresh.lock), false, 'inspection never creates the lock file or a target binding');
});
