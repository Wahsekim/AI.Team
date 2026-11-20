import { readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { git, gitRun, acquireLease, releaseLease, readLease } from './lease.mjs';
import { accountRun } from './run-args.mjs';
import { readBoundary, closeBoundary, within, LOG_FILE } from './write-boundary.mjs';
import { flagPaths } from './review-triggers.mjs';
import { BATCH_FILE, AFTER_FILE, PROGRESS_FILE, RETURN_FILE, RECORDS, ARCHIVE, RUN_ID, TICKET_ID, oneLine, changedPaths, contentOf, hooksOf, archiveBatch, plain, proposedTokens } from './batch.mjs';

// ADR 0010, decisions 12 and 13: what a PM runs when a batch ends in a standing Router/Worker team.
// after: the engine's return is matched against what was frozen, the product is compared with the tickets'
//   paths, the write boundary is closed and the lock released. It decides which tickets may be committed.
// commit: one commit per such ticket, on the batch's branch, then the batch is archived. Nothing is pushed.
const LEDGER = 'pm-decisions.md', IN_PROGRESS = ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
// Findings after which no ticket of the batch is committed by the kit: what ran is not what was frozen.
export const HOLD_ALL = ['BOUNDARY_CHANGED', 'PRODUCT_HEAD_MOVED', 'PRODUCT_BRANCH_CHANGED', 'GUARDIAN_NOT_CLEAN', 'HOOKS_CHANGED', 'HOOKS_WRITTEN'];
// An after that was claimed this recently is taken to be running; an older claim is one that died.
const CLAIM_MS = 60000;
const ABANDON = 'If the batch cannot be committed by the kit, archive it with: rw-batch.mjs abort --instance <instance-root>, then commit or discard its changes by hand';

class Refusal extends Error {}
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const refuse = error => ({ errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: error instanceof Refusal ? error.message : `The batch could not be closed: ${error?.code ?? error?.message}` }] });
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const intact = (value, stage) => { if (!value || typeof value !== 'object') return false; const { digest: recorded, ...body } = value; return recorded === digest(body) && value.stage === stage; };
const sealed = body => ({ ...body, digest: digest(body) });
const replace = (path, record) => { writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n'); renameSync(`${path}.tmp`, path); };

// The open batch of this team. Its record is a file the PM can write: what reaches a path, the ledger or a
// commit message is checked again here, whatever its digest says.
function openBatch(teamRoot, instanceRoot) {
  let instance;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
  need(instance, 'An instance root is required');
  need(exists(join(instance, BATCH_FILE)), 'No batch is open in this team');
  const batch = readJSON(join(instance, BATCH_FILE));
  need(intact(batch, 'batch-open'), `${BATCH_FILE} was changed after the batch opened. ${ABANDON}`);
  need(typeof batch.runId === 'string' && RUN_ID.test(batch.runId) && Array.isArray(batch.tickets)
    && batch.tickets.every(ticket => typeof ticket?.id === 'string' && TICKET_ID.test(ticket.id) && oneLine(ticket.commitMessage) && Array.isArray(ticket.paths)),
  `${BATCH_FILE} does not hold a plain run id, ticket ids and one-line commit messages. ${ABANDON}`);
  return { instance, batch };
}

// What the write-boundary hook logged since the batch opened. No worker call after a batch that changed
// files means the session never loaded the hook, so the write limits were not enforced while it ran.
function hookSeen(instance, wrappers, since) {
  let text = '';
  try { text = readFileSync(join(instance, LOG_FILE), 'utf8'); } catch { /* the hook never ran */ }
  const calls = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(call => call && typeof call.at === 'string' && call.at >= since);
  const workers = calls.filter(call => wrappers.includes(call.agentType));
  const refused = [...new Set(workers.filter(call => call.tool === 'Bash' && call.decision === 'deny' && typeof call.command === 'string' && call.command).map(call => call.command))].slice(0, 20);
  return { calls: calls.length, workerCalls: workers.length, denied: workers.filter(call => call.decision === 'deny').length, refused };
}

// Each limit that stopped work in this batch, with what was observed and a proposal for the owner, who decides.
// Nothing here writes a limit.
function limitsReached(limits, result, refused) {
  const report = [], ran = result.results;
  if (result.budgetGateTripped === true && Number.isSafeInteger(result.budgetStatus?.loopSpent)) {
    const observed = Math.ceil(result.budgetStatus.loopSpent / Math.max(1, ran.length)), allowance = proposedTokens(observed);
    report.push({ limit: 'outputAllowancePerTicket', observed, current: limits.outputAllowancePerTicket,
      proposal: { outputAllowancePerTicket: allowance, ...(allowance > limits.authorizationPerTicket ? { authorizationPerTicket: allowance } : {}) } });
  }
  // The engine retries only a clean execution whose verification failed: such a ticket at the cap ran out of attempts.
  const spent = ran.filter(r => r.attempts >= limits.attemptsPerTicket && r.workerStatus === 'succeeded' && r.verificationStatus === 'failed');
  if (spent.length) report.push({ limit: 'attemptsPerTicket', observed: Math.max(...spent.map(r => r.attempts)), current: limits.attemptsPerTicket,
    proposal: limits.attemptsPerTicket < 3 ? { attemptsPerTicket: limits.attemptsPerTicket + 1 } : null, tickets: spent.map(r => r.ticket) });
  for (const command of refused) report.push({ limit: 'allowedCommands', observed: command, current: limits.allowedCommands, proposal: null });
  return report;
}

// A ticket passed when the engine says it is done and nothing else in its own record says otherwise.
function outcomeOf(outcome) {
  if (!outcome) return { status: 'not-run' };
  // Every ticket of this mode ships code, so its verification must have passed, whatever the return says is required.
  const passed = outcome.done === true && outcome.needsFixRetest !== true && outcome.needsRecovery !== true && outcome.verifierPass !== false
    && outcome.verificationStatus === 'passed' && outcome.acceptanceStatus !== 'rejected';
  return passed ? { status: 'passed' } : { status: 'not-passed', workerStatus: plain(outcome.workerStatus ?? 'none'), verificationStatus: plain(outcome.verificationStatus ?? 'none') };
}

export function afterBatch({ teamRoot, instanceRoot, result }) {
  try {
    const { instance, batch } = openBatch(teamRoot, instanceRoot), product = batch.productRoot, afterPath = join(instance, AFTER_FILE);
    // A return that is not this batch's return changes nothing: the lock stays held and the boundary open.
    const account = accountRun({ args: batch.args, record: batch.runRecord, result });
    need(account.status === 'accounted', `The engine return is not the return of this batch: ${account.findings.join(', ')}`);
    need(Array.isArray(batch.review?.triggers) && Array.isArray(batch.review.reviewers), `${BATCH_FILE} holds no frozen review trigger list: an earlier kit opened it. ${ABANDON}`);
    // The close is claimed before anything is changed, so two calls never close the same batch together and
    // one that died is taken up again, not judged as if someone had tampered with the batch.
    const earlier = readJSON(afterPath), claim = () => ({ stage: 'batch-closing', runId: batch.runId, claimedAt: new Date().toISOString() });
    need(!exists(afterPath) || earlier?.stage === 'batch-closing' || earlier?.stage !== 'batch-closed', 'This batch was already closed; finish it with: rw-batch.mjs commit --instance <instance-root>');
    need(!exists(afterPath) || earlier?.stage === 'batch-closing', `${AFTER_FILE} cannot be read. ${ABANDON}`);
    const resumed = earlier?.stage === 'batch-closing', age = resumed ? Date.now() - Date.parse(earlier.claimedAt) : null;
    // A claim with no readable time, or one from the future, is not a running after.
    need(!resumed || !(age >= 0 && age <= CLAIM_MS), 'Another after is closing this batch; if none is running, run the command again in a minute');
    if (resumed) replace(afterPath, claim());
    else {
      try { writeFileSync(afterPath, JSON.stringify(claim()) + '\n', { flag: 'wx' }); }
      catch (error) { need(error?.code !== 'EEXIST', 'Another after is closing this batch'); throw error; }
    }

    const findings = [], boundary = readBoundary(instance);
    // A resumed close may find its own work done: the boundary already closed, the lock already released.
    const workers = [batch.args.plan[0].agentType, batch.args.plan[0].verifierAgentType, batch.args.guardianAgentType].sort();
    const ownClosed = resumed && boundary && boundary.productRoot === product && digest(Object.keys(boundary.wrappers).sort()) === digest(workers) && Object.values(boundary.wrappers).every(entry => entry.writePaths.length === 0);
    if (boundary?.digest !== batch.boundaryDigest && !ownClosed) findings.push({ code: 'BOUNDARY_CHANGED' });
    if ((git(product, 'rev-parse', 'HEAD')?.trim() ?? null) !== batch.productHead) findings.push({ code: 'PRODUCT_HEAD_MOVED' });
    if ((git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() ?? null) !== batch.branch) findings.push({ code: 'PRODUCT_BRANCH_CHANGED' });
    if (hooksOf(product).digest !== batch.hooks?.digest) findings.push({ code: 'HOOKS_CHANGED' });
    if (result.guardian?.status !== 'ok' || result.guardian?.verdict !== 'clean') findings.push({ code: 'GUARDIAN_NOT_CLEAN', status: plain(result.guardian?.status ?? 'none'), verdict: plain(result.guardian?.verdict ?? 'none') });

    // What the batch changed: everything the work tree holds now that was not already there when it opened.
    const changed = changedPaths(product).filter(path => !batch.preexisting.includes(path));
    // A changed path that is a directory is a repository of its own inside the product: Git would commit a link to it, not its files.
    const nested = changed.filter(path => path.endsWith('/')), files = changed.filter(path => !path.endsWith('/'));
    if (nested.length) findings.push({ code: 'NESTED_REPOSITORY', paths: nested });
    // A path changed where the hooks live, or beside husky's stub folder, through a worker's shell: it would run at the commit.
    const hooked = changed.filter(path => (batch.hooks?.guarded ?? []).some(guard => path === guard || path.startsWith(`${guard}/`)));
    if (hooked.length) findings.push({ code: 'HOOKS_WRITTEN', paths: hooked });
    const was = batch.preexistingContent ?? {}, is = contentOf(product, batch.preexisting);
    const rechanged = batch.preexisting.filter(path => Object.hasOwn(was, path) && was[path] !== is[path]);
    if (rechanged.length) findings.push({ code: 'PREEXISTING_PATH_CHANGED', paths: rechanged });
    const tickets = batch.tickets.map((ticket, i) => ({ id: ticket.id, ...outcomeOf(result.results[i]), changedPaths: files.filter(path => within(path, ticket.paths)) }));
    // ADR 0011, decision 3: the reviewers each passed ticket's changes require, by the list frozen at "before". Not a gate yet.
    for (const ticket of tickets.filter(entry => entry.status === 'passed' && entry.changedPaths.length)) {
      const flags = flagPaths(batch.review, ticket.changedPaths);
      ticket.review = { ...flags, content: contentOf(product, flags.flaggedFiles) };
    }
    const reviews = Object.fromEntries(batch.review.reviewers.map(name => [name, { tickets: tickets.filter(ticket => ticket.review?.required.includes(name)).map(ticket => ticket.id) }]).filter(([, entry]) => entry.tickets.length));
    const outside = files.filter(path => !batch.tickets.some(ticket => within(path, ticket.paths)));
    if (outside.length) findings.push({ code: 'WRITE_OUTSIDE_PATHS', paths: outside });
    const { refused, ...hook } = hookSeen(instance, batch.args.allowedAgentTypes, batch.openedAt);
    if (changed.length && hook.workerCalls === 0) findings.push({ code: 'HOOK_SAW_NO_WORKER' });

    let boundaryClosed = false;
    try { closeBoundary({ teamRoot: instance }); boundaryClosed = true; } catch { findings.push({ code: 'BOUNDARY_NOT_RESTORED' }); }
    const lease = readLease({ productRoot: product }), ours = lease.status === 'held' && lease.lease.digest === batch.lease, alreadyFree = resumed && lease.status === 'free';
    const leaseReleased = alreadyFree || (ours && !releaseLease({ productRoot: product, lease: batch.lease }).errors);
    if (!leaseReleased) findings.push({ code: ours ? 'LOCK_RELEASE_FAILED' : 'LOCK_NOT_HELD_BY_THIS_BATCH' });

    // Decision 13: one commit per ticket that passed, of that ticket's own paths. Everything else stays in the work tree.
    const holdAll = findings.some(finding => HOLD_ALL.includes(finding.code));
    const commits = holdAll ? [] : tickets.filter(ticket => ticket.status === 'passed' && ticket.changedPaths.length)
      .map(ticket => ({ ticket: ticket.id, message: batch.tickets.find(entry => entry.id === ticket.id).commitMessage, paths: ticket.changedPaths }));
    const committed = new Set(commits.flatMap(commit => commit.paths)), at = new Date().toISOString(), passed = tickets.filter(ticket => ticket.status === 'passed').length;
    const left = changed.filter(path => !committed.has(path)), next = [];
    if (!boundaryClosed) next.push('The write-boundary file is missing or was changed: every agent write is refused until a mode switch to specialist and back rebuilds it');
    if (holdAll) next.push(`No ticket of this batch is committed by the kit. ${ABANDON}`);
    if (!holdAll && left.length) next.push('Paths are left uncommitted in the product; the next batch refuses until they are committed or discarded by hand, or it is started as is');
    const status = () => findings.length || account.blockers.length ? 'review' : 'clean';
    try { appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${batch.runId} CLOSED (${status()}): ${passed} of ${tickets.length} ticket(s) passed; ${commits.length} to commit, ${left.length} changed path(s) left${findings.length ? `; findings: ${findings.map(finding => finding.code).join(', ')}` : ''}.\n`); }
    catch { findings.push({ code: 'LEDGER_NOT_WRITTEN' }); }
    // The engine's return is kept beside the record, which carries its digest: the settlement of usage needs it, and so does anyone who audits the batch.
    const kept = JSON.parse(JSON.stringify(result));
    const record = sealed({ schemaVersion: 1, stage: 'batch-closed', runId: batch.runId, batchDigest: batch.digest, closedAt: at, status: status(),
      account, returnDigest: digest(kept), tickets, reviews, commits, left, holdAll, hook, findings, limits: limitsReached(batch.limits, result, refused), boundaryClosed, leaseReleased, next });
    replace(join(instance, RETURN_FILE), kept);
    replace(afterPath, record);
    return record;
  } catch (error) { return refuse(error); }
}

// Paths go to Git on standard input, NUL-separated and taken literally: no length limit, no pattern.
const withPaths = (product, args, paths, timeout) => gitRun(product, ['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0'), timeout });
const said = result => plain(`${result.error?.code ?? ''} ${result.stderr ?? ''} ${result.stdout ?? ''}`.trim().slice(0, 300));

export function commitBatch({ teamRoot, instanceRoot }) {
  let lease = null, product;
  try {
    // A commit that archived the batch and died before it cleared the team's root is finished here. The archive
    // must be this batch's own: its record there, and a result that names the after record still in the root.
    try {
      const root = instanceOf(resolve(teamRoot), instanceRoot), closed = readJSON(join(root, AFTER_FILE)), id = closed?.runId ?? readJSON(join(root, PROGRESS_FILE))?.runId ?? readJSON(join(root, BATCH_FILE))?.runId;
      const folder = typeof id === 'string' && RUN_ID.test(id) ? join(root, ARCHIVE, id) : null, archived = folder ? readJSON(join(folder, 'commit.json')) : null;
      const still = exists(join(root, BATCH_FILE)) ? readJSON(join(root, BATCH_FILE)) : null;
      if ((!exists(join(root, BATCH_FILE)) || (intact(still, 'batch-open') && still.digest === archived?.batchDigest && closed)) && intact(archived, 'batch-committed') && intact(readJSON(join(folder, 'batch.json')), 'batch-open') && archived.batchDigest === readJSON(join(folder, 'batch.json')).digest
        && (!closed || closed.digest === archived.afterDigest)) { for (const file of Object.values(RECORDS)) rmSync(join(root, file), { force: true }); return archived; }
    } catch { /* judged below */ }
    const { instance, batch } = openBatch(teamRoot, instanceRoot), after = readJSON(join(instance, AFTER_FILE));
    need(exists(join(instance, AFTER_FILE)) && after?.stage !== 'batch-closing', 'This batch has not been closed; run: rw-batch.mjs after RESULT.json --instance <instance-root>');
    need(intact(after, 'batch-closed') && after.batchDigest === batch.digest, `${AFTER_FILE} was changed, or belongs to another batch. ${ABANDON}`);
    // The plan is derived again from the tickets: a path is committed only inside the paths of a ticket that passed.
    const planned = Array.isArray(after.commits) && after.commits.every(commit => {
      const ticket = batch.tickets.find(entry => entry.id === commit?.ticket), outcome = after.tickets?.find(entry => entry.id === commit?.ticket);
      return ticket && outcome?.status === 'passed' && commit.message === ticket.commitMessage && Array.isArray(commit.paths) && commit.paths.length > 0
        && commit.paths.every(path => typeof path === 'string' && !path.endsWith('/') && within(path, ticket.paths) && !batch.preexisting.includes(path));
    });
    need(planned && (after.holdAll !== true || after.commits.length === 0), `${AFTER_FILE} plans a commit that is not a passed ticket's own paths. ${ABANDON}`);
    product = batch.productRoot;
    const taken = acquireLease({ teamRoot: instance, productRoot: product });
    need(!taken.errors, `The lock on the product repository could not be taken: ${taken.errors?.[0]?.reason}`);
    lease = taken.lease.digest;

    need(git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() === batch.branch, `The product repository is no longer on the batch's branch (${plain(batch.branch)}). ${ABANDON}`);
    const gitDir = git(product, 'rev-parse', '--absolute-git-dir')?.trim(), busy = IN_PROGRESS.filter(name => gitDir && exists(join(gitDir, name)));
    need(gitDir && !busy.length, `A Git operation is in progress in the product repository (${busy.join(', ')})`);
    need(hooksOf(product).digest === batch.hooks?.digest, `The repository's commit hooks were changed or moved since the batch opened. ${ABANDON}`);
    need(!exists(join(instance, ARCHIVE, batch.runId)), `batches/${batch.runId} already exists: an archive of this batch was started. ${ABANDON}`);
    // The commits this command already made, by their ids: the branch must be the batch's start plus exactly those.
    const progressPath = join(instance, PROGRESS_FILE), progress = exists(progressPath) ? readJSON(progressPath) : { commits: [] };
    need(Array.isArray(progress?.commits) && progress.commits.length <= after.commits.length && progress.commits.every((made, i) => made?.ticket === after.commits[i].ticket && /^[a-f0-9]{40}$/.test(made.sha ?? '')),
      `${PROGRESS_FILE} cannot be read. ${ABANDON}`);
    const done = progress.commits, head = () => git(product, 'rev-parse', 'HEAD')?.trim(), parentOf = sha => git(product, 'rev-parse', `${sha}^`)?.trim();
    const holds = (sha, paths) => digest((git(product, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha) ?? '').split('\0').filter(Boolean).sort()) === digest([...paths].sort());
    // A commit that was made just before this command died, and so was never recorded, is taken up when it is the next planned one.
    const tip = done.length ? done.at(-1).sha : batch.productHead, upNext = after.commits[done.length];
    if (upNext && head() !== tip && parentOf(head()) === tip && holds(head(), upNext.paths)) { done.push({ ticket: upNext.ticket, sha: head() }); replace(progressPath, { schemaVersion: 1, runId: batch.runId, commits: done }); }
    need(done.every((made, i) => holds(made.sha, after.commits[i].paths)), `A commit recorded for this batch does not hold its ticket's paths. ${ABANDON}`);
    need(head() === (done.length ? done.at(-1).sha : batch.productHead) && done.every((made, i) => parentOf(made.sha) === (i ? done[i - 1].sha : batch.productHead)),
      `The product branch is not the batch's start plus the commits this command made: someone committed, or moved the branch. ${ABANDON}`);
    const todo = after.commits.slice(done.length);
    // What is still to commit must be exactly what after saw: nothing was edited in between.
    const pending = changedPaths(product).filter(path => !batch.preexisting.includes(path)), expected = [...todo.flatMap(commit => commit.paths), ...after.left].sort();
    need(digest(pending) === digest(expected), `The product repository changed since the batch was closed. ${ABANDON}`);

    for (const commit of todo) {
      // A path a worker already removed from the index has nothing to add; the commit below records its deletion.
      const addable = commit.paths.filter(path => exists(join(product, path)) || (git(product, '--literal-pathspecs', 'ls-files', '--', path) ?? '').trim() !== '');
      const added = addable.length ? withPaths(product, ['add', '-A'], addable) : { status: 0 };
      need(added.status === 0 && !added.error, `git add failed for ticket ${commit.ticket}: ${said(added)}. ${ABANDON}`);
      // --only: what else is staged, such as a path changed before the batch, is not carried into this commit.
      const parent = head(), committed = withPaths(product, ['commit', '-q', '-m', commit.message, '--only'], commit.paths, 600000);
      need(committed.status === 0 && !committed.error, `git commit failed for ticket ${commit.ticket} (${done.length} of ${after.commits.length} made): ${said(committed)}. Fix the cause and run commit again. ${ABANDON}`);
      const sha = head();
      need(sha && sha !== parent && parentOf(sha) === parent, `The commit of ticket ${commit.ticket} did not land on the product branch. ${ABANDON}`);
      // A hook may have put other paths into the commit: what it holds must be the ticket's paths, nothing else.
      need(holds(sha, commit.paths), `The commit of ticket ${commit.ticket} (${sha.slice(0, 8)}) does not hold exactly that ticket's paths; a commit hook may have added or dropped some. It is left as it is. ${ABANDON}`);
      done.push({ ticket: commit.ticket, sha });
      replace(progressPath, { schemaVersion: 1, runId: batch.runId, commits: done });
    }
    const left = changedPaths(product).filter(path => !batch.preexisting.includes(path)), at = new Date().toISOString();
    const record = sealed({ schemaVersion: 1, stage: 'batch-committed', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, committedAt: at, branch: batch.branch, commits: done, left, pushed: false });
    let ledgerWritten = true;
    try { appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${batch.runId} COMMITTED on ${plain(batch.branch)}: ${done.length} commit(s)${done.length ? ` (${done.map(commit => `${commit.ticket} ${commit.sha.slice(0, 8)}`).join(', ')})` : ''}; ${left.length} changed path(s) left uncommitted${left.length ? ` (${left.slice(0, 10).map(plain).join(', ')}${left.length > 10 ? ', ...' : ''})` : ''}. Nothing was pushed.\n`); }
    catch { ledgerWritten = false; }
    archiveBatch(instance, batch.runId, { 'commit.json': record }, RECORDS);
    return ledgerWritten ? record : { ...record, warning: `${LEDGER} could not be written; add the COMMITTED line by hand` };
  } catch (error) { return refuse(error); } finally { if (lease) releaseLease({ productRoot: product, lease }); }
}
