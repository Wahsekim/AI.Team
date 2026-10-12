import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LoopError, requireThat } from './contracts.mjs';

// ADR 0003: the host executes only on a Git clone it created inside its own state directory.
const notIsolated = message => new LoopError('TARGET_NOT_ISOLATED', message);
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};
const canonical = path => {
  try { return realpathSync.native(path); } catch (error) { throw notIsolated(`Product target unavailable: ${error.code}`); }
};
// Ambient GIT_* variables could redirect discovery.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
// The ceiling stops discovery from walking above the target.
const gitEnv = path => ({ ...cleanEnv(), GIT_CEILING_DIRECTORIES: dirname(path) });

// A state directory inside a repository lies in that repository's work tree, which another host may own as its target.
// Only "not a git repository" passes; LC_ALL=C keeps that message untranslated.
export function outsideAnyRepository(statePath) {
  const result = spawnSync('git', ['-C', statePath, 'rev-parse', '--git-dir'], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanEnv(), GIT_DISCOVERY_ACROSS_FILESYSTEM: '1', LC_ALL: 'C', LANG: 'C', LANGUAGE: '' } });
  return result.status === 128 && /not a git repository/i.test(result.stderr ?? '');
}

function gitPaths(path) {
  let lines;
  try {
    lines = execFileSync('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(path) }).split('\n');
  } catch { throw notIsolated('Product target is not a Git repository root'); }
  if (lines.length !== 4 || lines[3] !== '' || lines.slice(0, 3).some(line => !isAbsolute(line))) throw notIsolated('Unexpected Git layout');
  const [top, gitDir, common] = lines.slice(0, 3).map(canonical);
  return { top, gitDir, common };
}

// Identity = canonical root + (dev, ino) of the root and of its Git common dir.
// Aliases (symlink, relative, case) resolve to one identity; shared metadata is refused.
export function targetIdentity(target, statePath) {
  requireThat(typeof target === 'string' && target !== '', 'INVALID_SPEC', 'Product target path required');
  const path = canonical(resolve(target));
  // ADR 0002 P3: a product snapshot would open and close the lock file in-process.
  requireThat(path !== statePath && !inside(path, statePath), 'SCOPE_DENIED', 'State directory must be outside product');
  // A direct child: one target has exactly one possible state directory, so R03a's lock covers it.
  if (dirname(path) !== statePath) throw notIsolated('Product target must be the host-created clone directly inside the state directory');
  if (!outsideAnyRepository(statePath)) throw notIsolated('State directory must not lie inside a Git repository');
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) throw notIsolated('Product target must be a directory');
  const git = gitPaths(path);
  if (git.top !== path) throw notIsolated('Product target must be its Git repository root');
  if (git.gitDir !== git.common || !inside(path, git.common)) throw notIsolated('Git metadata is outside the target (linked worktree or separate git dir)');
  const worktrees = join(git.common, 'worktrees');
  if (existsSync(worktrees) && readdirSync(worktrees).length) throw notIsolated('Target has linked worktrees sharing its Git metadata');
  if (existsSync(join(git.common, 'objects', 'info', 'alternates'))) throw notIsolated('Target borrows objects from another repository');
  return { path, stat, relativePath: relative(statePath, path), git: { path: git.common, stat: statSync(git.common, { bigint: true }) } };
}
