// Rollout gate G-02: one host owns a product at a time. The lease lives in the
// product's Git metadata, so it is shared by every team root and work tree and
// never appears in the candidate diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { acquireLease, readLease, releaseLease } from '../src/router-worker/lease.mjs';
import { digest } from '../src/loop/contracts.mjs';

const CLI = fileURLToPath(new URL('../scripts/lease-router-worker.mjs', import.meta.url));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
const readFileSyncText = path => fs.readFileSync(path, 'utf8');
const write = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-lease-'))), team = join(base, 'demo.team'), other = join(base, 'other.team'), product = join(base, 'product');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(team); mkdirSync(other);
  write(product, 'src/app.js', 'export const x = 1;\n');
  git(product, 'init', '-q'); git(product, 'add', '-A'); git(product, 'commit', '-q', '-m', 'product');
  return { base, team, other, product };
}

test('a free product is acquired once; the lease is self-digested and leaves the work tree clean', t => {
  const f = fixture(t);
  assert.deepEqual(readLease({ productRoot: f.product }), { status: 'free' });
  const acquired = acquireLease({ teamRoot: f.team, productRoot: f.product });
  assert.equal(acquired.errors, undefined, JSON.stringify(acquired.errors));
  assert.equal(acquired.status, 'held'); assert.equal(acquired.lease.teamRoot, f.team); assert.equal(acquired.lease.productRoot, f.product);
  const { digest: recorded, ...body } = acquired.lease;
  assert.equal(recorded, digest(body));
  assert.equal(git(f.product, 'status', '--porcelain', '--ignored'), '', 'the lease is not a work-tree path');
  assert.deepEqual(readLease({ productRoot: f.product }), acquired);
});

test('a held product refuses a second host and a second session of the same team root', t => {
  const f = fixture(t), first = acquireLease({ teamRoot: f.team, productRoot: f.product });
  for (const team of [f.other, f.team]) {
    const second = acquireLease({ teamRoot: team, productRoot: f.product });
    assert.equal(second.errors?.[0].code, 'LEASE_HELD', JSON.stringify(second));
  }
  assert.deepEqual(readLease({ productRoot: f.product }), first, 'the refused attempts leave the lease untouched');
  assert.deepEqual(readdirSync(join(f.product, '.git')).filter(name => name.includes('rw-ownership')), ['rw-ownership-lease.json'], 'no temporary file is left behind');
});

test('a linked work tree shares the lease of its repository', t => {
  const f = fixture(t), second = join(f.base, 'second');
  git(f.product, 'worktree', 'add', '-q', second, '-b', 'other');
  const first = acquireLease({ teamRoot: f.team, productRoot: f.product });
  assert.equal(acquireLease({ teamRoot: f.other, productRoot: second }).errors?.[0].code, 'LEASE_HELD');
  assert.equal(readLease({ productRoot: second }).lease.digest, first.lease.digest);
});

test('release needs the digest of the lease that is held; afterwards the product is free again', t => {
  const f = fixture(t), held = acquireLease({ teamRoot: f.team, productRoot: f.product });
  assert.equal(releaseLease({ productRoot: f.product, lease: 'sha256:' + '0'.repeat(64) }).errors?.[0].code, 'LEASE_MISMATCH');
  assert.equal(readLease({ productRoot: f.product }).status, 'held');
  assert.deepEqual(releaseLease({ productRoot: f.product, lease: held.lease.digest }), { status: 'free', released: held.lease.digest });
  assert.equal(releaseLease({ productRoot: f.product, lease: held.lease.digest }).errors?.[0].code, 'LEASE_NOT_HELD');
  const again = acquireLease({ teamRoot: f.other, productRoot: f.product });
  assert.equal(again.status, 'held'); assert.notEqual(again.lease.digest, held.lease.digest, 'every lease is distinct');
});

test('an unreadable lease is unknown: it is neither taken over nor released by the tool', t => {
  const f = fixture(t), held = acquireLease({ teamRoot: f.team, productRoot: f.product });
  writeFileSync(join(f.product, '.git/rw-ownership-lease.json'), JSON.stringify({ ...held.lease, teamRoot: f.other }));
  assert.equal(readLease({ productRoot: f.product }).status, 'unknown', 'a record that does not match its digest is not trusted');
  assert.equal(acquireLease({ teamRoot: f.team, productRoot: f.product }).errors?.[0].code, 'LEASE_HELD');
  assert.equal(releaseLease({ productRoot: f.product, lease: held.lease.digest }).errors?.[0].code, 'LEASE_MISMATCH');
});

test('releases are serialized: a release paused before its unlink cannot remove a later lease', t => {
  const f = fixture(t), held = acquireLease({ teamRoot: f.team, productRoot: f.product }), path = join(f.product, '.git/rw-ownership-lease.json');
  const unlink = fs.unlinkSync, during = {};
  fs.unlinkSync = function (target) {
    if (target === path && !during.entered) {
      during.entered = true;
      during.release = releaseLease({ productRoot: f.product, lease: held.lease.digest });
      during.acquire = acquireLease({ teamRoot: f.other, productRoot: f.product });
    }
    return unlink(target);
  };
  syncBuiltinESMExports();
  let outer;
  try { outer = releaseLease({ productRoot: f.product, lease: held.lease.digest }); } finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  assert.equal(during.release.errors?.[0].code, 'LEASE_BUSY', 'a second release waits outside while the first holds the release lock');
  assert.equal(during.acquire.errors?.[0].code, 'LEASE_HELD', 'no replacement lease exists before the unlink');
  assert.deepEqual(outer, { status: 'free', released: held.lease.digest });
  assert.deepEqual(readdirSync(join(f.product, '.git')).filter(name => name.includes('rw-ownership')), [], 'the release lock is removed');
});

test('an interrupted release leaves its lock: later releases are refused until the operator removes it', t => {
  const f = fixture(t), held = acquireLease({ teamRoot: f.team, productRoot: f.product }), lock = join(f.product, '.git/rw-ownership-lease.json.release-lock');
  writeFileSync(lock, 'left by a crashed release\n');
  assert.equal(releaseLease({ productRoot: f.product, lease: held.lease.digest }).errors?.[0].code, 'LEASE_BUSY');
  assert.deepEqual(readLease({ productRoot: f.product }), held, 'the lease and the foreign lock are untouched');
  assert.equal(readFileSyncText(lock), 'left by a crashed release\n');
  rmSync(lock);
  assert.equal(releaseLease({ productRoot: f.product, lease: held.lease.digest }).status, 'free');
});

test('only a repository root separate from the team root can be leased', t => {
  const f = fixture(t);
  assert.equal(acquireLease({ teamRoot: f.team, productRoot: join(f.product, 'src') }).errors?.[0].code, 'INVALID_LEASE');
  assert.equal(acquireLease({ teamRoot: f.team, productRoot: f.base }).errors?.[0].code, 'INVALID_LEASE');
  assert.equal(acquireLease({ teamRoot: f.product, productRoot: f.product }).errors?.[0].code, 'INVALID_LEASE');
  assert.equal(readLease({ productRoot: f.product }).status, 'free');
});

test('concurrent hosts: exactly one acquires', async t => {
  const f = fixture(t);
  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise(done => {
    const child = spawn(process.execPath, [CLI, 'acquire', '--team-root', f.team, '--product-root', f.product], { stdio: 'ignore' });
    child.on('close', done);
  })));
  assert.equal(runs.filter(code => code === 0).length, 1, `exit codes ${runs}`);
  assert.equal(runs.filter(code => code === 2).length, 7);
  assert.equal(readLease({ productRoot: f.product }).status, 'held');
});

test('CLI: acquire, status and release with exit 0 held/free-as-asked, 2 refused, 1 usage', t => {
  const f = fixture(t), run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const free = run('status', '--product-root', f.product);
  assert.equal(free.status, 0, free.stderr); assert.equal(JSON.parse(free.stdout).status, 'free');
  const acquired = run('acquire', '--team-root', f.team, '--product-root', f.product);
  assert.equal(acquired.status, 0, acquired.stderr);
  const lease = JSON.parse(acquired.stdout).lease.digest;
  assert.equal(run('acquire', '--team-root', f.other, '--product-root', f.product).status, 2);
  assert.equal(JSON.parse(run('status', '--product-root', f.product).stdout).lease.digest, lease);
  assert.equal(run('release', '--product-root', f.product, '--lease', 'sha256:' + '1'.repeat(64)).status, 2);
  assert.equal(run('release', '--product-root', f.product, '--lease', lease).status, 0);
  assert.equal(run('acquire', '--product-root', f.product).status, 1, 'acquire needs a team root');
  assert.equal(run('seize', '--product-root', f.product).status, 1);
});
