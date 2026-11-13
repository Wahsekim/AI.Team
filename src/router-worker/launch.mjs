import { writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { freezeRun } from './run-args.mjs';
import { acquireLease, releaseLease } from './lease.mjs';
import { armBoundary } from './write-boundary.mjs';
import { observeIsolation } from './isolation.mjs';

// Launch host, before the run: the gates run in one fixed order and a launch
// record exists only when all of them passed. A copy is prepared once.
export const LAUNCH_FILE = 'rw-launch.json';
const UNRESOLVED = ['owner-attendance', 'launch-manifest-preflight', 'in-run-admission', 'hook-fires-inside-workflow-agents', 'bash-writes'];
const refuse = reason => ({ errors: [{ code: 'LAUNCH_REFUSED', field: 'launch', reason }] });

export async function prepareLaunch({ inputs, run, teamRoot, productRoot, hookPath, methodBundle }) {
  if (typeof teamRoot !== 'string' || typeof productRoot !== 'string') return refuse('Team and product roots are required');
  const launchPath = join(teamRoot, LAUNCH_FILE);
  if (lstatSync(launchPath, { throwIfNoEntry: false })) return refuse('This copy was already prepared for a launch; an activated copy is used once');
  // Freezing writes nothing, so an invalid run is refused before the lease is taken.
  const frozen = await freezeRun({ inputs, run, teamRoot, ...(methodBundle ? { methodBundle } : {}) });
  if (frozen.errors) return frozen;
  const acquired = acquireLease({ teamRoot, productRoot });
  if (acquired.errors) return acquired;
  const lease = acquired.lease.digest;
  let prepared = false;
  try {
    const armed = armBoundary({ inputs, teamRoot, productRoot, hookPath, ...(methodBundle ? { methodBundle } : {}) });
    if (armed.errors) return armed;
    const isolation = observeIsolation({ teamRoot, productRoot, lease });
    if (isolation.errors) return isolation;
    if (isolation.status !== 'clear')
      return refuse(`The runtime-isolation gate is ${isolation.status}: ${isolation.findings.filter(f => f.severity !== 'accepted').map(f => f.code).join(', ')}`);
    const body = { schemaVersion: 1, stage: 'launch-prepared', runId: frozen.args.runId, teamRoot, productRoot, productHead: isolation.product.head,
      lease, isolationDigest: isolation.digest, boundaryDigest: armed.boundaryDigest, argsDigest: frozen.record.argsDigest,
      runRecord: frozen.record, args: frozen.args, unresolved: UNRESOLVED };
    const record = { ...body, digest: digest(body) };
    try { writeFileSync(launchPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { return refuse(`The launch record could not be written: ${error.code ?? 'unknown error'}`); }
    prepared = true;
    return record;
  } finally { if (!prepared) releaseLease({ productRoot, lease }); }
}
