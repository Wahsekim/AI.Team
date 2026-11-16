import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// One exclusive lock per run around every read-decide-append of the dispatch log, so that two
// hook processes, or a hook and a close, never decide against the same log version.
export const DISPATCH_LOCK = '.claude/rw-dispatch.lock';
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export function withDispatchLock(teamRoot, fn, { waitMs = 10000 } = {}) {
  const path = join(teamRoot, DISPATCH_LOCK), deadline = Date.now() + waitMs;
  for (;;) {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() < deadline) { sleep(20); continue; }
      let holder;
      try { holder = JSON.parse(readFileSync(path, 'utf8')).pid; } catch { holder = null; }
      // A lock is never taken over: a holder that died mid-decision may have written half a record.
      throw Object.assign(Error(Number.isInteger(holder) && !alive(holder)
        ? `The dispatch lock ${DISPATCH_LOCK} was left by a process that is gone; inspect the dispatch log, then remove the lock file`
        : 'The dispatch lock is held by another process'), { code: 'DISPATCH_LOCKED' });
    }
  }
  try { return fn(); } finally { try { unlinkSync(path); } catch { /* already removed by the operator */ } }
}
