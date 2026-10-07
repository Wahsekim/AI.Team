import { constants, copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LoopError, requireThat } from './contracts.mjs';

// R05b (ADR 0005). A synced ("hot") rollback journal makes every read-only open fail with this code (R05a review F1).
export const SQLITE_READONLY_ROLLBACK = 776;
export const SNAPSHOT_SOURCE = 'snapshot: uncommitted transaction pending rollback; store untouched';

function fileState(path) {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); }
  catch (error) { throw new LoopError('STORE_UNREADABLE', `Snapshot source unavailable (${error.code}): ${basename(path)}`); }
  requireThat(stat.isFile() && !stat.isSymbolicLink(), 'STORE_UNREADABLE', `Snapshot source is not a regular file: ${basename(path)}`);
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

// Copies the database and its journal into a private directory; refuses if either moved during the copy.
// SQLite rolls the COPY back on its first read; the originals are only read.
export function copyForRollback(filename) {
  const sources = [filename, `${filename}-journal`], before = sources.map(fileState);
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'ai-loop-snapshot-')));
  const remove = () => rmSync(directory, { recursive: true, force: true });
  try {
    const file = join(directory, basename(filename));
    copyFileSync(sources[0], file, constants.COPYFILE_EXCL);
    copyFileSync(sources[1], `${file}-journal`, constants.COPYFILE_EXCL);
    requireThat(sources.map(fileState).every((state, i) => state === before[i]), 'STORE_UNREADABLE',
      'Store or journal changed during the snapshot copy; a writer is active');
    return { file, remove };
  } catch (error) { remove(); throw error; }
}

const size = path => { try { return Number(lstatSync(path).size); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

// Read-only probe of one SQLite file: absent, readable (any leftover journal is not hot) or hot.
export async function journalState(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const view = { file: basename(file), databaseBytes: size(file), journalBytes: size(`${file}-journal`) };
  if (view.databaseBytes === null) return { ...view, state: 'absent' };
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); db.prepare('SELECT count(*) AS n FROM sqlite_master').get(); return { ...view, state: 'readable' }; }
  catch (error) {
    if (error.errcode === SQLITE_READONLY_ROLLBACK) return { ...view, state: 'hot' };
    return { ...view, state: 'unreadable', errcode: error.errcode ?? error.code ?? null };
  } finally { db?.close(); }
}

// recover-journal only, under the kernel lock: one writable open of an existing file (never created) rolls back its hot journal.
export async function rollbackInPlace(file) {
  const before = await journalState(file);
  if (before.state !== 'hot') return { ...before, rolledBack: false };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(new URL(`${pathToFileURL(file).href}?mode=rw`));
  try { db.exec('PRAGMA busy_timeout=0'); db.prepare('SELECT count(*) AS n FROM sqlite_master').get(); } finally { db.close(); }
  const after = await journalState(file);
  requireThat(after.state === 'readable', 'STORE_UNREADABLE', `${before.file} is still ${after.state} after rollback`);
  return { file: before.file, state: 'hot', rolledBack: true, before: { databaseBytes: before.databaseBytes, journalBytes: before.journalBytes },
    after: { databaseBytes: after.databaseBytes, journalBytes: after.journalBytes } };
}
