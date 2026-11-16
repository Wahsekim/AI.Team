import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { bytesDigest } from '../loop/contracts.mjs';

// What a run changed, as one patch against the commit it started on: tracked changes, new files
// and commits made during the run; Git-ignored paths are left out. The clone is only read: the
// patch is built in a throwaway index, never in the clone's own.
export const EXPORT_FILE = 'rw-result.patch';

export function exportChanges({ productRoot, baseCommit, teamRoot }) {
  const scratch = mkdtempSync(join(tmpdir(), 'rw-export-'));
  try {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C', GIT_INDEX_FILE: join(scratch, 'index') };
    const git = (...args) => {
      const run = spawnSync('git', ['-C', productRoot, ...args], { env, timeout: 60000, maxBuffer: 256 * 1024 * 1024 });
      if (run.status !== 0 || run.error) throw Error(`git ${args[0]} failed`);
      return run.stdout;
    };
    git('read-tree', baseCommit); git('add', '-A');
    const paths = git('diff', '--cached', '--name-only', '-z', baseCommit).toString('utf8').split('\0').filter(Boolean).sort();
    if (!paths.length) return null;
    const patch = git('diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', baseCommit);
    writeFileSync(join(teamRoot, EXPORT_FILE), patch, { flag: 'wx' });
    return { file: EXPORT_FILE, digest: bytesDigest(patch), baseCommit, paths };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
