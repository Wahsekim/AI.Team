import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { git, acquireLease, releaseLease, readLease } from './lease.mjs';
import { accountRun } from './run-args.mjs';
import { readBoundary, closeBoundary, within, LOG_FILE } from './write-boundary.mjs';
import { BATCH_FILE, AFTER_FILE, ARCHIVE, changedPaths, plain } from './batch.mjs';

// ADR 0010, decisions 12 and 13: what a PM runs when a batch ends in a standing Router/Worker team.
// after: the engine's return is matched against what was frozen, the product is compared with the tickets'
//   paths, the write boundary is closed and the lock released. It decides which tickets may be committed.
// commit: one commit per such ticket, on the batch's branch, then the batch is archived. Nothing is pushed.
const LEDGER = 'pm-decisions.md', IN_PROGRESS = ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
// Findings after which no ticket of the batch is committed by the kit: what ran is not what was frozen.
const HOLD_ALL = ['BOUNDARY_CHANGED', 'PRODUCT_HEAD_MOVED', 'PRODUCT_BRANCH_CHANGED', 'GUARDIAN_NOT_CLEAN'];

class Refusal extends Error {}
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const refuse = error => ({ errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: error instanceof Refusal ? error.message : `The batch could not be closed: ${error?.code ?? error?.message}` }] });
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const intact = (value, stage) => { if (!value || typeof value !== 'object') return false; const { digest: recorded, ...body } = value; return recorded === digest(body) && value.stage === stage; };
const sealed = body => ({ ...body, digest: digest(body) });

function openRecords(teamRoot, instanceRoot) {
  let instance;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
  need(instance, 'An instance root is required');
  const batch = readJSON(join(instance, BATCH_FILE));
  need(exists(join(instance, BATCH_FILE)), 'No batch is open in this team');
  need(intact(batch, 'batch-open'), `${BATCH_FILE} was changed after the batch opened; abort the batch and judge the work by hand`);
  return { instance, batch };
}

// What the write-boundary hook logged since the batch opened. No worker call after a batch that changed
// files means the session never loaded the hook, so the write limits were not enforced while it ran.
function hookSeen(instance, wrappers, since) {
  let text = '';
  try { text = readFileSync(join(instance, LOG_FILE), 'utf8'); } catch { /* the hook never ran */ }
  const calls = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(call => call && typeof call.at === 'string' && call.at >= since);
  const workers = calls.filter(call => wrappers.includes(call.agentType));
  return { calls: calls.length, workerCalls: workers.length, denied: workers.filter(call => call.decision === 'deny').length };
}

export function afterBatch({ teamRoot, instanceRoot, result }) {
  try {
    const { instance, batch } = openRecords(teamRoot, instanceRoot), product = batch.productRoot;
    need(!exists(join(instance, AFTER_FILE)), 'This batch was already closed; finish it with: rw-batch.mjs commit --instance <instance-root>');
    // A return that is not this batch's return changes nothing: the lock stays held and the boundary open.
    const account = accountRun({ args: batch.args, record: batch.runRecord, result });
    need(account.status === 'accounted', `The engine return is not the return of this batch: ${account.findings.join(', ')}`);

    const findings = [], boundary = readBoundary(instance);
    if (boundary?.digest !== batch.boundaryDigest) findings.push({ code: 'BOUNDARY_CHANGED' });
    if ((git(product, 'rev-parse', 'HEAD')?.trim() ?? null) !== batch.productHead) findings.push({ code: 'PRODUCT_HEAD_MOVED' });
    if ((git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() ?? null) !== batch.branch) findings.push({ code: 'PRODUCT_BRANCH_CHANGED' });
    if (result.guardian?.status !== 'ok' || result.guardian?.verdict !== 'clean') findings.push({ code: 'GUARDIAN_NOT_CLEAN', status: result.guardian?.status ?? null, verdict: result.guardian?.verdict ?? null });

    // What the batch changed: everything the work tree holds now that was not already there when it opened.
    const changed = changedPaths(product).filter(path => !batch.preexisting.includes(path));
    const tickets = batch.tickets.map((ticket, i) => {
      const outcome = result.results[i];
      return { id: ticket.id, status: !outcome ? 'not-run' : outcome.done === true ? 'passed' : 'not-passed',
        ...(outcome && outcome.done !== true ? { workerStatus: outcome.workerStatus ?? null, verificationStatus: outcome.verificationStatus ?? null } : {}),
        changedPaths: changed.filter(path => within(path, ticket.paths)) };
    });
    const outside = changed.filter(path => !batch.tickets.some(ticket => within(path, ticket.paths)));
    if (outside.length) findings.push({ code: 'WRITE_OUTSIDE_PATHS', paths: outside });
    const hook = hookSeen(instance, batch.args.allowedAgentTypes, batch.openedAt);
    if (changed.length && hook.workerCalls === 0) findings.push({ code: 'HOOK_SAW_NO_WORKER' });

    let boundaryClosed = false;
    try { closeBoundary({ teamRoot: instance }); boundaryClosed = true; } catch { findings.push({ code: 'BOUNDARY_NOT_RESTORED' }); }
    const lease = readLease({ productRoot: product }), ours = lease.status === 'held' && lease.lease.digest === batch.lease;
    const leaseReleased = ours && !releaseLease({ productRoot: product, lease: batch.lease }).errors;
    if (!leaseReleased) findings.push({ code: ours ? 'LOCK_RELEASE_FAILED' : 'LOCK_NOT_HELD_BY_THIS_BATCH' });

    // Decision 13: one commit per ticket that passed, of that ticket's own paths. Everything else stays in the work tree.
    const holdAll = findings.some(finding => HOLD_ALL.includes(finding.code));
    const commits = holdAll ? [] : tickets.filter(ticket => ticket.status === 'passed' && ticket.changedPaths.length)
      .map(ticket => ({ ticket: ticket.id, message: batch.tickets.find(entry => entry.id === ticket.id).commitMessage, paths: ticket.changedPaths }));
    const committed = new Set(commits.flatMap(commit => commit.paths)), at = new Date().toISOString();
    const body = { schemaVersion: 1, stage: 'batch-closed', runId: batch.runId, batchDigest: batch.digest, closedAt: at, status: findings.length || account.blockers.length ? 'review' : 'clean',
      account, tickets, commits, left: changed.filter(path => !committed.has(path)), holdAll, hook, findings, boundaryClosed, leaseReleased };
    const record = sealed(body);
    writeFileSync(join(instance, AFTER_FILE), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    const passed = tickets.filter(ticket => ticket.status === 'passed').length;
    appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${batch.runId} CLOSED (${record.status}): ${passed} of ${tickets.length} ticket(s) passed; ${commits.length} to commit, ${record.left.length} changed path(s) left${findings.length ? `; findings: ${findings.map(finding => finding.code).join(', ')}` : ''}.\n`);
    return record;
  } catch (error) { return refuse(error); }
}

const run = (product, ...args) => spawnSync('git', ['-C', product, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
// A path is given to Git as itself, never as a pattern.
const literal = path => `:(literal,top)${path}`;

export function commitBatch({ teamRoot, instanceRoot }) {
  let lease = null, product;
  try {
    const { instance, batch } = openRecords(teamRoot, instanceRoot), after = readJSON(join(instance, AFTER_FILE));
    need(exists(join(instance, AFTER_FILE)), 'This batch has not been closed; run: rw-batch.mjs after RESULT.json --instance <instance-root>');
    need(intact(after, 'batch-closed') && after.batchDigest === batch.digest, `${AFTER_FILE} was changed, or belongs to another batch`);
    product = batch.productRoot;
    const taken = acquireLease({ teamRoot: instance, productRoot: product });
    need(!taken.errors, `The lock on the product repository could not be taken: ${taken.errors?.[0]?.reason}`);
    lease = taken.lease.digest;

    need(git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() === batch.branch, `The product repository is no longer on the batch's branch (${batch.branch})`);
    const gitDir = git(product, 'rev-parse', '--absolute-git-dir')?.trim(), busy = IN_PROGRESS.filter(name => gitDir && exists(join(gitDir, name)));
    need(gitDir && !busy.length, `A Git operation is in progress in the product repository (${busy.join(', ')})`);
    // Commits this command made earlier, if it was interrupted: they are the planned ones, in order.
    const made = (git(product, 'log', '--reverse', '--format=%H%x00%s', `${batch.productHead}..HEAD`) ?? '').split('\n').filter(Boolean).map(line => line.split('\0'));
    need(made.length <= after.commits.length && made.every(([, subject], i) => subject === after.commits[i].message), 'The product repository holds commits that are not this batch\'s; commit by hand and archive the batch records yourself');
    const done = made.map(([sha], i) => ({ ticket: after.commits[i].ticket, sha })), todo = after.commits.slice(made.length);
    // What is still to commit must be exactly what after saw: nothing was edited in between.
    const pending = changedPaths(product).filter(path => !batch.preexisting.includes(path)), expected = [...todo.flatMap(commit => commit.paths), ...after.left].sort();
    need(digest(pending) === digest(expected), 'The product repository changed since the batch was closed; commit by hand and archive the batch records yourself');

    for (const commit of todo) {
      const added = run(product, 'add', '-A', '--', ...commit.paths.map(literal));
      need(added.status === 0, `git add failed for ticket ${commit.ticket}: ${plain((added.stderr ?? '').trim().slice(0, 300))}`);
      // --only: what else is staged, such as a path changed before the batch, is not carried into this commit.
      const committed = run(product, 'commit', '-q', '-m', commit.message, '--only', '--', ...commit.paths.map(literal));
      need(committed.status === 0, `git commit failed for ticket ${commit.ticket} (${done.length} of ${after.commits.length} made): ${plain(((committed.stderr ?? '') + (committed.stdout ?? '')).trim().slice(0, 300))}`);
      done.push({ ticket: commit.ticket, sha: git(product, 'rev-parse', 'HEAD').trim() });
    }
    const left = changedPaths(product).filter(path => !batch.preexisting.includes(path)), at = new Date().toISOString(), archive = join(instance, ARCHIVE, batch.runId);
    const record = sealed({ schemaVersion: 1, stage: 'batch-committed', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, committedAt: at, branch: batch.branch,
      commits: done, left, pushed: false });
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'commit.json'), JSON.stringify(record, null, 2) + '\n');
    appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${batch.runId} COMMITTED on ${batch.branch}: ${done.length} commit(s)${done.length ? ` (${done.map(commit => `${commit.ticket} ${commit.sha.slice(0, 8)}`).join(', ')})` : ''}; ${left.length} changed path(s) left uncommitted${left.length ? ` (${left.slice(0, 10).map(plain).join(', ')}${left.length > 10 ? ', ...' : ''})` : ''}. Nothing was pushed.\n`);
    // The records leave the team's root last: until then the batch is still the open one.
    renameSync(join(instance, AFTER_FILE), join(archive, 'after.json')); renameSync(join(instance, BATCH_FILE), join(archive, 'batch.json'));
    return record;
  } catch (error) { return refuse(error); } finally { if (lease) releaseLease({ productRoot: product, lease }); }
}
