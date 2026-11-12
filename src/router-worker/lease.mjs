import { readFileSync, writeFileSync, linkSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, join, isAbsolute, sep } from 'node:path';
import { digest } from '../loop/contracts.mjs';

// Rollout gate G-02: exclusive ownership of a product. The lease is one file in
// the repository's common Git directory: shared by every team root and work
// tree, outside the work tree and the candidate diff.
const FILE = 'rw-ownership-lease.json';
const KIND = 'router-worker-product-lease';
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function requireValue(condition, message) { if (!condition) throw Error(message); }
export const inside = (path, root) => path === root || path.startsWith(root + sep);
// Ambient GIT_* variables could redirect discovery to another repository.
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C' });
export function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: gitEnv() });
  return result.status === 0 && !result.error ? result.stdout : null;
}
export function canonicalDirectory(path, label) {
  requireValue(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, `${label} must be a normalized absolute path`);
  requireValue(lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && realpathSync(path) === path, `${label} must be a canonical existing directory`);
  return path;
}
export function isRepositoryRoot(product) {
  const top = git(product, 'rev-parse', '--show-toplevel')?.trim();
  return Boolean(top) && realpathSync(top) === product;
}

const fail = (code, reason) => ({ errors: [{ code, field: 'lease', reason }] });
function leasePath(productRoot) {
  const product = canonicalDirectory(productRoot, 'Product root');
  requireValue(isRepositoryRoot(product), 'The product root is not the top of its own Git repository');
  const common = git(product, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.trim();
  requireValue(common, 'The Git directory of the product could not be resolved');
  return { product, path: join(common, FILE) };
}

function parse(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })) return { status: 'free' };
  try {
    const { digest: recorded, ...body } = JSON.parse(readFileSync(path, 'utf8'));
    if (body.schemaVersion === 1 && body.kind === KIND && DIGEST.test(recorded) && recorded === digest(body)
      && Object.keys(body).sort().join() === 'acquiredAt,kind,nonce,productRoot,schemaVersion,teamRoot'
      && [body.teamRoot, body.productRoot, body.nonce, body.acquiredAt].every(value => typeof value === 'string'))
      return { status: 'held', lease: { ...body, digest: recorded } };
  } catch { /* unreadable: reported as unknown below */ }
  return { status: 'unknown' };
}

export function readLease({ productRoot }) {
  try { return parse(leasePath(productRoot).path); } catch (error) { return fail('INVALID_LEASE', error.message); }
}

export function acquireLease({ teamRoot, productRoot }) {
  let target;
  try {
    const team = canonicalDirectory(teamRoot, 'Team root');
    target = leasePath(productRoot);
    requireValue(!inside(team, target.product) && !inside(target.product, team), 'The team root and the product root contain one another');
    const nonce = randomBytes(16).toString('hex');
    const body = { schemaVersion: 1, kind: KIND, teamRoot: team, productRoot: target.product, nonce, acquiredAt: new Date().toISOString() };
    target.lease = { ...body, digest: digest(body) }; target.temporary = `${target.path}.${nonce}.tmp`;
  } catch (error) { return fail('INVALID_LEASE', error.message); }
  try {
    writeFileSync(target.temporary, JSON.stringify(target.lease, null, 2) + '\n', { flag: 'wx' });
    // A hard link either creates the complete record or fails because one exists.
    linkSync(target.temporary, target.path);
    return { status: 'held', lease: target.lease };
  } catch (error) {
    if (error.code === 'EEXIST') return fail('LEASE_HELD', 'The product already carries an ownership lease; inspect it with status');
    return fail('INVALID_LEASE', `The lease could not be written: ${error.code ?? error.message}`);
  } finally { try { unlinkSync(target.temporary); } catch { /* never created */ } }
}

export function releaseLease({ productRoot, lease }) {
  try {
    const { path } = leasePath(productRoot), current = parse(path);
    if (current.status === 'free') return fail('LEASE_NOT_HELD', 'The product carries no ownership lease');
    if (current.status !== 'held' || current.lease.digest !== lease)
      return fail('LEASE_MISMATCH', 'The presented digest is not the lease the product carries; an unreadable lease is removed by the operator, not by this tool');
    unlinkSync(path);
    return { status: 'free', released: lease };
  } catch (error) { return fail('INVALID_LEASE', error.message); }
}
