import { writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { freezeRun, accountRun } from './run-args.mjs';
import { acquireLease, releaseLease, readLease, git } from './lease.mjs';
import { armBoundary, readBoundary, within, LOG_FILE } from './write-boundary.mjs';
import { observeIsolation } from './isolation.mjs';

// Launch host, before the run: the gates run in one fixed order and a launch
// record exists only when all of them passed. A copy is prepared once.
export const LAUNCH_FILE = 'rw-launch.json';
export const CLOSE_FILE = 'rw-close.json';
const CLOSE_UNRESOLVED = ['usage-settlement', 'retry-journal', 'work-quality'];
const UNRESOLVED = ['owner-attendance', 'launch-manifest-preflight', 'in-run-admission', 'bash-writes'];
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

// Paths the product work tree holds beyond the commit the run started from. Git-ignored ones
// (build output) are kept apart: they are counted, not judged against the boundary.
function changedPaths(product) {
  const fields = (git(product, 'status', '--porcelain', '-z', '--untracked-files=all', '--ignored') ?? '').split('\0').filter(Boolean), changed = [], ignored = [];
  for (let i = 0; i < fields.length; i++) {
    (fields[i].startsWith('!!') ? ignored : changed).push(fields[i].slice(3));
    if (/^[RC]/.test(fields[i])) i++;
  }
  const topLevel = {};
  for (const path of ignored) { const top = path.split('/')[0]; topLevel[top] = (topLevel[top] ?? 0) + 1; }
  return { changed: changed.sort(), ignoredChanges: { count: ignored.length, topLevel: Object.fromEntries(Object.entries(topLevel).sort(([a], [b]) => a.localeCompare(b))) } };
}

// What the write-boundary hook saw. Zero wrapper calls after a run that wrote means the hook
// did not load or the runtime did not name the agent.
function hookLog(teamRoot, wrappers) {
  let text = '';
  try { text = readFileSync(join(teamRoot, LOG_FILE), 'utf8'); } catch { /* the hook never ran */ }
  const parsed = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  const calls = parsed.filter(Boolean), ofWrappers = calls.filter(call => wrappers.includes(call.agentType));
  return { calls: calls.length, wrapperCalls: ofWrappers.length, wrapperBashCalls: ofWrappers.filter(call => call.tool === 'Bash').length,
    denied: calls.filter(call => call.decision === 'deny').length, callsWithoutAgentType: calls.filter(call => call.agentType === null).length,
    unreadableLines: parsed.length - calls.length };
}

// After the run. A return that is not the return of this launch is refused and the lease stays held;
// otherwise the lease is released and what the run left is recorded, clean or not.
export function closeLaunch({ teamRoot, result }) {
  if (typeof teamRoot !== 'string') return refuse('The team root is required');
  let launch;
  try { launch = JSON.parse(readFileSync(join(teamRoot, LAUNCH_FILE), 'utf8')); } catch { return refuse('This copy has no readable launch record'); }
  const { digest: recorded, ...launchBody } = launch;
  if (recorded !== digest(launchBody) || launch.stage !== 'launch-prepared' || launch.teamRoot !== teamRoot) return refuse('The launch record was changed or belongs to another copy');
  const closePath = join(teamRoot, CLOSE_FILE);
  if (lstatSync(closePath, { throwIfNoEntry: false })) return refuse('This launch was already closed');
  const account = accountRun({ args: launch.args, record: launch.runRecord, result });
  if (account.status !== 'accounted') return refuse(`The engine return is not the return of this launch: ${account.findings.join(', ')}`);

  const product = launch.productRoot, findings = [];
  const boundary = readBoundary(teamRoot);
  if (boundary?.digest !== launch.boundaryDigest) findings.push({ code: 'BOUNDARY_CHANGED' });
  const head = git(product, 'rev-parse', 'HEAD')?.trim() ?? null;
  if (head !== launch.productHead) findings.push({ code: 'PRODUCT_HEAD_MOVED' });
  const { changed, ignoredChanges } = changedPaths(product), grants = Object.values(boundary?.wrappers ?? {}).flatMap(entry => entry.writePaths ?? []);
  const outside = changed.filter(path => !within(path, grants));
  if (outside.length) findings.push({ code: 'WRITE_OUTSIDE_BOUNDARY', paths: outside });
  const lease = readLease({ productRoot: product });
  const ours = lease.status === 'held' && lease.lease.digest === launch.lease;
  const leaseReleased = ours && !releaseLease({ productRoot: product, lease: launch.lease }).errors;
  if (!leaseReleased) findings.push({ code: ours ? 'LEASE_RELEASE_FAILED' : 'LEASE_NOT_HELD_BY_THIS_LAUNCH' });

  const body = { schemaVersion: 1, stage: 'launch-closed', runId: launch.runId, launchDigest: launch.digest, status: findings.length ? 'review' : 'clean',
    account, productHead: head, changedPaths: changed, ignoredChanges, hookLog: hookLog(teamRoot, launch.args.allowedAgentTypes), findings, leaseReleased, unresolved: CLOSE_UNRESOLVED };
  const record = { ...body, digest: digest(body) };
  try { writeFileSync(closePath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { return refuse(`The close record could not be written: ${error.code ?? 'unknown error'}`); }
  return record;
}
