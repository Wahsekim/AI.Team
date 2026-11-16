import { writeFileSync, readFileSync, appendFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { freezeRun, accountRun } from './run-args.mjs';
import { acquireLease, releaseLease, readLease, git } from './lease.mjs';
import { armBoundary, readBoundary, within, LOG_FILE } from './write-boundary.mjs';
import { observeIsolation } from './isolation.mjs';
import { CLOSE_FILE, candidateOf } from './closed-candidate.mjs';
import { armGate } from './dispatch-arm.mjs';
import { runSummary, DISPATCH_LOG } from './dispatch.mjs';
import { withDispatchLock } from './dispatch-lock.mjs';
import { exportChanges } from './export.mjs';

export { CLOSE_FILE };

// Launch host, before the run: the gates run in one fixed order and a launch
// record exists only when all of them passed. A copy is prepared once.
export const LAUNCH_FILE = 'rw-launch.json';
const CLOSE_UNRESOLVED = ['usage-settlement', 'retry-journal', 'work-quality'];
const UNRESOLVED = ['owner-attendance', 'launch-manifest-preflight', 'in-run-admission', 'bash-writes'];
const refuse = reason => ({ errors: [{ code: 'LAUNCH_REFUSED', field: 'launch', reason }] });

export async function prepareLaunch({ inputs, run, teamRoot, productRoot, hookPath, gateHookPath, methodBundle, manifest }) {
  if (typeof teamRoot !== 'string' || typeof productRoot !== 'string') return refuse('Team and product roots are required');
  const launchPath = join(teamRoot, LAUNCH_FILE);
  if (lstatSync(launchPath, { throwIfNoEntry: false })) return refuse('This copy was already prepared for a launch; an activated copy is used once');
  // Freezing writes nothing, so an invalid run is refused before the lease is taken.
  const freeze = frozenRun => freezeRun({ inputs, run: frozenRun, teamRoot, ...(methodBundle ? { methodBundle } : {}) });
  let frozen = await freeze(run), launchManifest = run?.launchManifestDigest === undefined ? 'absent' : 'supplied';
  if (frozen.errors) return frozen;
  // The manifest is taken of the arguments without its own digest, then the run is frozen again with it.
  if (manifest && launchManifest === 'absent') {
    const taken = await manifest(frozen.args, { teamRoot, productRoot });
    if (taken.errors) return taken;
    frozen = await freeze({ ...run, launchManifestDigest: taken.digest }); launchManifest = 'chained';
    if (frozen.errors) return frozen;
  }
  const acquired = acquireLease({ teamRoot, productRoot });
  if (acquired.errors) return acquired;
  const lease = acquired.lease.digest;
  let prepared = false;
  try {
    const armed = armBoundary({ inputs, teamRoot, productRoot, hookPath, ...(methodBundle ? { methodBundle } : {}) });
    if (armed.errors) return armed;
    const dispatch = frozen.record.dispatch;
    if (dispatch === 'main-session') { const gate = armGate({ teamRoot, hookPath: gateHookPath }); if (gate.errors) return gate; }
    const isolation = observeIsolation({ teamRoot, productRoot, lease, dispatch });
    if (isolation.errors) return isolation;
    if (isolation.status !== 'clear')
      return refuse(`The runtime-isolation gate is ${isolation.status}: ${isolation.findings.filter(f => f.severity !== 'accepted').map(f => f.code).join(', ')}`);
    const body = { schemaVersion: 1, stage: 'launch-prepared', dispatch, runId: frozen.args.runId, teamRoot, productRoot, productHead: isolation.product.head,
      lease, isolationDigest: isolation.digest, boundaryDigest: armed.boundaryDigest, argsDigest: frozen.record.argsDigest,
      runRecord: frozen.record, args: frozen.args, launchManifest,
      unresolved: UNRESOLVED.filter(item => (item !== 'launch-manifest-preflight' || launchManifest === 'absent') && (item !== 'in-run-admission' || dispatch !== 'main-session')) };
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

// The dispatch log of a main-session run, as the gate hook wrote it.
export function dispatchEvents(teamRoot) {
  try { return readFileSync(join(teamRoot, DISPATCH_LOG), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { return error.code === 'ENOENT' ? [] : null; }
}

// A main-session run has no engine return: its calls are the ones the gate admitted.
function dispatchAccount(launch, teamRoot) {
  // Dispatch is revoked first, under the gate's lock: after this line the hook admits nothing, whatever close does next.
  let events;
  try {
    events = withDispatchLock(teamRoot, () => {
      const read = dispatchEvents(teamRoot);
      if (read && !read.some(event => event.type === 'closed')) { const closed = { at: new Date().toISOString(), type: 'closed' }; appendFileSync(join(teamRoot, DISPATCH_LOG), JSON.stringify(closed) + '\n'); read.push(closed); }
      return read;
    });
  } catch { events = null; }
  const summary = events && runSummary({ launch, events });
  if (!summary) return { account: { status: 'unaccounted', findings: ['DISPATCH_LOG_UNREADABLE'] }, pending: null, callOut: false };
  const dispatched = summary.tickets.filter(ticket => ticket.attempts > 0), count = duty => summary.calls.filter(call => call.duty === duty).length;
  return { pending: summary.finished ? null : summary.pending, callOut: summary.callOut, account: { status: 'accounted', source: 'dispatch-log', findings: [],
    calls: { tickets: dispatched.length, exec: count('exec'), check: count('check'), guard: 0 }, attempts: dispatched.map(ticket => ticket.attempts),
    tickets: dispatched.map(({ ticket, status, attempts }) => ({ ticket, status, attempts })),
    blockers: dispatched.filter(ticket => ticket.status !== 'passed').map(ticket => `ticket-stopped:${ticket.ticket}:${ticket.status}`) } };
}

// After the run. A return that is not the return of this launch is refused and the lease stays held;
// otherwise the lease is released and what the run left is recorded, clean or not.
export function closeLaunch({ teamRoot, result, pendingStopped = false }) {
  if (typeof teamRoot !== 'string') return refuse('The team root is required');
  let launch;
  try { launch = JSON.parse(readFileSync(join(teamRoot, LAUNCH_FILE), 'utf8')); } catch { return refuse('This copy has no readable launch record'); }
  const { digest: recorded, ...launchBody } = launch;
  if (recorded !== digest(launchBody) || launch.stage !== 'launch-prepared' || launch.teamRoot !== teamRoot) return refuse('The launch record was changed or belongs to another copy');
  const closePath = join(teamRoot, CLOSE_FILE);
  if (lstatSync(closePath, { throwIfNoEntry: false })) return refuse('This launch was already closed');
  const mainSession = launch.dispatch === 'main-session', dispatched = mainSession ? dispatchAccount(launch, teamRoot) : null;
  const account = mainSession ? dispatched.account : accountRun({ args: launch.args, record: launch.runRecord, result });
  if (account.status !== 'accounted') return refuse(`The ${mainSession ? 'dispatch log' : 'engine return'} is not the return of this launch: ${account.findings.join(', ')}`);

  const product = launch.productRoot, findings = [];
  // The product is not freed under an agent that may still be writing: its hand-back, or the operator's word that it stopped, comes first.
  if (dispatched?.callOut && !pendingStopped)
    return refuse(`A call is still out (${dispatched.pending}). Dispatch is revoked; close again once it has handed back, or with --pending-stopped after confirming the agent has stopped`);
  // A run the main session left before its end is still closed: the lease must not outlive it.
  if (dispatched?.pending) findings.push({ code: 'RUN_NOT_FINISHED', pending: dispatched.pending });
  if (dispatched?.callOut) findings.push({ code: 'PENDING_CALL_STOPPED_BY_OPERATOR' });
  const boundary = readBoundary(teamRoot);
  if (boundary?.digest !== launch.boundaryDigest) findings.push({ code: 'BOUNDARY_CHANGED' });
  const head = git(product, 'rev-parse', 'HEAD')?.trim() ?? null;
  if (head !== launch.productHead) findings.push({ code: 'PRODUCT_HEAD_MOVED' });
  const { changed, ignoredChanges } = changedPaths(product), grants = Object.values(boundary?.wrappers ?? {}).flatMap(entry => entry.writePaths ?? []);
  const outside = changed.filter(path => !within(path, grants));
  if (outside.length) findings.push({ code: 'WRITE_OUTSIDE_BOUNDARY', paths: outside });
  // The work leaves the disposable clone as a patch in the copy; the owner decides whether it reaches a real repository.
  let exported = null;
  try { exported = exportChanges({ productRoot: product, baseCommit: launch.productHead, teamRoot }); }
  catch { findings.push({ code: 'EXPORT_FAILED' }); }
  const lease = readLease({ productRoot: product });
  const ours = lease.status === 'held' && lease.lease.digest === launch.lease;
  const leaseReleased = ours && !releaseLease({ productRoot: product, lease: launch.lease }).errors;
  if (!leaseReleased) findings.push({ code: ours ? 'LEASE_RELEASE_FAILED' : 'LEASE_NOT_HELD_BY_THIS_LAUNCH' });

  const body = { schemaVersion: 1, stage: 'launch-closed', runId: launch.runId, launchDigest: launch.digest, status: findings.length ? 'review' : 'clean',
    account, productHead: head, candidate: candidateOf(product), changedPaths: changed, export: exported, ignoredChanges, hookLog: hookLog(teamRoot, launch.args.allowedAgentTypes), findings, leaseReleased, unresolved: CLOSE_UNRESOLVED };
  const record = { ...body, digest: digest(body) };
  try { writeFileSync(closePath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { return refuse(`The close record could not be written: ${error.code ?? 'unknown error'}`); }
  return record;
}
