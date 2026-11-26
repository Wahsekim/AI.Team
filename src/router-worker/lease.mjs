import { readFileSync, writeFileSync, linkSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, join, isAbsolute, sep } from 'node:path';
import { digest } from '../loop/contracts.mjs';

// Rollout gate G-02: exclusive ownership of a product. The lease is one file in
// the repository's common Git directory: shared by every team root and work
// tree, outside the work tree and the candidate diff.
// A lease is held either across commands (a batch from before to after, a launch), or by one command for its own
// length: that lease carries the command's process (`commandPid`), and once that process is gone the same team takes it over.
const FILE = 'rw-ownership-lease.json';
const KIND = 'router-worker-product-lease';
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function requireValue(condition, message) { if (!condition) throw Error(message); }
export const alive = pid => { if (!Number.isSafeInteger(pid) || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// This process is running too, though `alive` leaves it out.
export const commandRunning = lease => Number.isSafeInteger(lease?.commandPid) && (lease.commandPid === process.pid || alive(lease.commandPid));
export const inside = (path, root) => path === root || path.startsWith(root + sep);
// Ambient GIT_* variables could redirect discovery to another repository.
// The identity a commit is made with may come from the environment and is kept.
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') || /^GIT_(AUTHOR|COMMITTER)_/.test(key))), LC_ALL: 'C' });
export function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024, env: gitEnv() });
  return result.status === 0 && !result.error ? result.stdout : null;
}
// A Git command whose outcome matters, under the same scrubbed environment: {status, stdout, stderr, error}.
export function gitRun(root, args, { input, timeout = 120000, env = {}, encoding = 'utf8' } = {}) {
  return spawnSync('git', ['-C', root, ...args], { encoding, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...gitEnv(), ...env }, ...(input === undefined ? {} : { input }) });
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
    const { commandPid, ...common } = body;
    if (body.schemaVersion === 1 && body.kind === KIND && DIGEST.test(recorded) && recorded === digest(body)
      && Object.keys(common).sort().join() === 'acquiredAt,kind,nonce,productRoot,schemaVersion,teamRoot' && (commandPid === undefined || (Number.isSafeInteger(commandPid) && commandPid > 0))
      && [body.teamRoot, body.productRoot, body.nonce, body.acquiredAt].every(value => typeof value === 'string'))
      return { status: 'held', lease: { ...body, digest: recorded } };
  } catch { /* unreadable: reported as unknown below */ }
  return { status: 'unknown' };
}

export function readLease({ productRoot }) {
  try { return parse(leasePath(productRoot).path); } catch (error) { return fail('INVALID_LEASE', error.message); }
}

// Why `team` cannot take the lease held now; null when it is a command's of `team` whose process has ended.
function heldReason(current, team) {
  if (current.status === 'free') return null;
  if (current.status !== 'held') return 'The product carries an ownership lease that cannot be read; inspect it with status';
  const { teamRoot, commandPid } = current.lease;
  if (teamRoot !== team) return 'The product is locked by another team root';
  if (commandPid === undefined) return 'The product is locked, held across commands by this team: a batch from before to after, or a launch';
  return commandRunning(current.lease) ? `The product is locked by a command of this team that is still running (process ${commandPid})` : null;
}

// `command`: the lease is this process's for its own length, and recorded with its process id.
export function acquireLease({ teamRoot, productRoot, command = false }) {
  let target, team;
  try {
    team = canonicalDirectory(teamRoot, 'Team root');
    target = leasePath(productRoot);
    requireValue(!inside(team, target.product) && !inside(target.product, team), 'The team root and the product root contain one another');
    const nonce = randomBytes(16).toString('hex');
    const body = { schemaVersion: 1, kind: KIND, teamRoot: team, productRoot: target.product, nonce, acquiredAt: new Date().toISOString(), ...(command ? { commandPid: process.pid } : {}) };
    target.lease = { ...body, digest: digest(body) }; target.temporary = `${target.path}.${nonce}.tmp`;
  } catch (error) { return fail('INVALID_LEASE', error.message); }
  const held = () => fail('LEASE_HELD', heldReason(parse(target.path), team) ?? 'The product was locked by another command just now; run the command again');
  try {
    writeFileSync(target.temporary, JSON.stringify(target.lease, null, 2) + '\n', { flag: 'wx' });
    // A hard link either creates the complete record or fails because one exists.
    try { linkSync(target.temporary, target.path); return { status: 'held', lease: target.lease }; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (heldReason(parse(target.path), team)) return held();
    // The take-over is serialized with releases by their lock, so the dead lease is still the one removed.
    const lock = `${target.path}.release-lock`;
    try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return fail('LEASE_BUSY', `Another command is taking over or releasing the lease (${lock}); run the command again. If none is, the operator removes the lock file`);
    }
    try {
      const current = parse(target.path);
      if (heldReason(current, team)) return held();
      if (current.status === 'held') unlinkSync(target.path);
      try { linkSync(target.temporary, target.path); return { status: 'held', lease: target.lease }; } catch (error) { if (error.code !== 'EEXIST') throw error; return held(); }
    } finally { unlinkSync(lock); }
  } catch (error) {
    return fail('INVALID_LEASE', `The lease could not be written: ${error.code ?? error.message}`);
  } finally { try { unlinkSync(target.temporary); } catch { /* never created */ } }
}

export function releaseLease({ productRoot, lease }) {
  let lock = null;
  try {
    const { path } = leasePath(productRoot);
    // Only a release frees the path, so with releases serialized no other lease can appear between the check and the unlink.
    try { writeFileSync(`${path}.release-lock`, `${process.pid}\n`, { flag: 'wx' }); lock = `${path}.release-lock`; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return fail('LEASE_BUSY', `Another release holds ${path}.release-lock; if that release was interrupted, the operator removes the lock file`);
    }
    const current = parse(path);
    if (current.status === 'free') return fail('LEASE_NOT_HELD', 'The product carries no ownership lease');
    if (current.status !== 'held' || current.lease.digest !== lease)
      return fail('LEASE_MISMATCH', 'The presented digest is not the lease the product carries; an unreadable lease is removed by the operator, not by this tool');
    unlinkSync(path);
    return { status: 'free', released: lease };
  } catch (error) { return fail('INVALID_LEASE', error.message); } finally { if (lock) unlinkSync(lock); }
}
