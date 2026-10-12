import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytesDigest, digest, relativePath, requireThat } from './contracts.mjs';

function contained(root, target) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

// Conservative v1: reject every symlink component, even an internal symlink.
// This prevents accidental traversal; it is not an OS sandbox against same-UID races.
export function resolveContained(root, path) {
  relativePath(path);
  const base = realpathSync(root); let current = base;
  for (const component of path.split('/')) {
    current = join(current, component);
    let stat;
    try { stat = lstatSync(current); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    requireThat(!stat.isSymbolicLink(), 'SCOPE_DENIED', `Symlink component: ${path}`);
    requireThat(contained(base, realpathSync(current)), 'SCOPE_DENIED', 'Path escapes root');
  }
  return current;
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function boundedRead(fd, limit) {
  const chunks = []; let count = 0;
  for (;;) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, limit - count + 1));
    const length = readSync(fd, buffer);
    if (!length) break;
    count += length; requireThat(count <= limit, 'LIMIT_REACHED', 'File exceeds snapshot byte cap');
    chunks.push(buffer.subarray(0, length));
  }
  return Buffer.concat(chunks, count);
}
export function snapshotRepository({ root, repoId = 'product', maxFileBytes = 32 * 1024 * 1024, maxTotalBytes = 128 * 1024 * 1024 }) {
  requireThat(['team', 'product'].includes(repoId), 'INVALID_SPEC', 'Invalid snapshot repoId');
  for (const n of [maxFileBytes, maxTotalBytes]) requireThat(Number.isSafeInteger(n) && n > 0, 'INVALID_SPEC', 'Invalid snapshot byte limit');
  const base = realpathSync(root);
  requireThat(realpathSync(utf8(git(base, ['rev-parse', '--show-toplevel'])).trim()) === base, 'INVALID_SPEC', 'Snapshot root must be the Git repository root');
  const baseCommit = utf8(git(base, ['rev-parse', '--verify', 'HEAD'])).trim();
  requireThat(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit), 'INVALID_SPEC', 'Full Git OID required');
  const index = utf8(git(base, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
  requireThat(!index.some(e => e.startsWith('160000 ')), 'CAPABILITY_MISSING', 'Submodules require an explicit snapshot policy');
  requireThat(index.every(e => /^\d{6} [a-f0-9]+ 0\t/.test(e)), 'RECOVERY_REQUIRED', 'Unmerged index cannot be snapshotted');
  const names = [...new Set(utf8(git(base, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))].sort();
  let total = 0;
  const inventory = names.map(path => {
    const absolute = resolveContained(base, path);
    let stat;
    try { stat = lstatSync(absolute); } catch (e) { if (e.code === 'ENOENT') return { path, kind: 'deleted' }; throw e; }
    requireThat(stat.isFile(), 'SCOPE_DENIED', `Non-regular candidate input: ${path}`);
    requireThat(stat.size <= maxFileBytes && total + stat.size <= maxTotalBytes, 'LIMIT_REACHED', 'Snapshot input exceeds byte cap');
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      requireThat(opened.isFile() && opened.ino === stat.ino && opened.dev === stat.dev, 'STALE_EVIDENCE', 'Candidate changed while opening');
      // Bounded read: reject growth after stat instead of allocating unbounded input.
      requireThat(opened.size <= maxFileBytes && total + opened.size <= maxTotalBytes, 'LIMIT_REACHED', 'Snapshot grew beyond byte cap');
      const bytes = boundedRead(fd, Math.min(maxFileBytes, maxTotalBytes - total)); const after = fstatSync(fd);
      requireThat(bytes.length <= maxFileBytes && total + bytes.length <= maxTotalBytes, 'LIMIT_REACHED', 'Snapshot grew beyond byte cap');
      requireThat(opened.size === after.size && opened.mtimeMs === after.mtimeMs && opened.ctimeMs === after.ctimeMs, 'STALE_EVIDENCE', 'Candidate changed during read');
      total += bytes.length;
      return { path, kind: 'file', executable: Boolean(after.mode & 0o111), bytes: bytes.length, digest: bytesDigest(bytes) };
    } finally { closeSync(fd); }
  });
  requireThat(utf8(git(base, ['rev-parse', '--verify', 'HEAD'])).trim() === baseCommit, 'STALE_EVIDENCE', 'HEAD changed while snapshotting');
  const treeDigest = digest({ baseCommit, inventory });
  return { schemaVersion: 1, id: `snapshot-${treeDigest.slice(7, 39)}`, repoId, baseCommit, treeDigest, inventory };
}

export function changedPaths(before, after) {
  const a = new Map(before.inventory.map(e => [e.path, digest(e)]));
  const b = new Map(after.inventory.map(e => [e.path, digest(e)]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter(path => a.get(path) !== b.get(path));
}

export function assertWriteScope(before, after, allowedPaths) {
  allowedPaths.forEach(relativePath);
  const changes = changedPaths(before, after);
  for (const path of changes) requireThat(allowedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`)), 'SCOPE_DENIED', `Out-of-scope change: ${path}`);
  return changes;
}
