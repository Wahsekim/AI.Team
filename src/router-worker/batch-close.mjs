import { readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest, bytesDigest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { git, gitRun, acquireLease, releaseLease, readLease } from './lease.mjs';
import { accountRun, guardianHold } from './run-args.mjs';
import { readBoundary, closeBoundary, reviewBoundary, stateOf, within, LOG_FILE } from './write-boundary.mjs';
import { flagPaths } from './review-triggers.mjs';
import { reviewGate, verdictsOf } from './review-judge.mjs';
import { escalationsOf } from './escalations.mjs';
import { runCommands, confirmedOf } from './run-commands.mjs';
import { BATCH_FILE, AFTER_FILE, PROGRESS_FILE, RETURN_FILE, RESOLUTION_FILE, RECORDS, ARCHIVE, RUN_ID, TICKET_ID, oneLine, changedPaths, contentOf, hooksOf, archiveBatch, plain, proposedTokens, HOOKS_FIRST, HOOKS_MOVED } from './batch.mjs';

// ADR 0010, decisions 12 and 13: what a PM runs when a batch ends in a standing Router/Worker team.
// after: the engine's return is matched against what was frozen, the product is compared with the tickets'
//   paths, the write boundary is closed and the lock released. It decides which tickets may be committed.
// commit: one commit per such ticket, on the batch's branch, then the batch is archived. Nothing is pushed.
const LEDGER = 'pm-decisions.md';
export const IN_PROGRESS = ['index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
// Findings after which no ticket of the batch is committed by the kit: what ran is not what was frozen, or the tree it
// would commit fails its verification and no ticket can be told apart.
export const HOLD_ALL = ['BOUNDARY_CHANGED', 'PRODUCT_HEAD_MOVED', 'PRODUCT_BRANCH_CHANGED', 'GUARDIAN_NOT_CLEAN', 'HOOKS_CHANGED', 'HOOKS_WRITTEN', 'HOOK_SAW_NO_WORKER', 'CHECK_RUNS_MISSING', 'VERIFICATION_FAILED'];
// A claim that names no process, an earlier kit's, is taken to be running while it is this recent.
const CLAIM_MS = 60000;
export const alive = pid => { if (!Number.isSafeInteger(pid) || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
export const LEFT_COMMAND = 'rw-batch.mjs left --instance <instance-root>';
export const ABANDON = `If the batch cannot be committed by the kit, archive it with: rw-batch.mjs abort --instance <instance-root>, which saves each ticket flagged for review that no review passed as a patch under reviews/held/<run id>/ and takes it out of the work tree; then save the work each other ticket left as a patch, out of the work tree, with: ${LEFT_COMMAND}, and commit or discard the rest by hand`;

export class Refusal extends Error {}
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const refuse = error => ({ errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: error instanceof Refusal ? error.message : `The batch could not be closed: ${error?.code ?? error?.message}` }] });
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export const intact = (value, stage) => { if (!value || typeof value !== 'object') return false; const { digest: recorded, ...body } = value; return recorded === digest(body) && value.stage === stage; };
const sealed = body => ({ ...body, digest: digest(body) });
const failedRuns = runs => runs.filter(run => run.exit !== 0 || run.timedOut);
const replace = (path, record) => { writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n'); renameSync(`${path}.tmp`, path); };

// The open batch of this team. Its record is a file the PM can write: what reaches a path, the ledger or a
// commit message is checked again here, whatever its digest says.
export function openBatch(teamRoot, instanceRoot) {
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

// What the write-boundary hook logged since the batch opened. No worker call after a batch that changed files means
// the session never loaded the hook, so the write limits were not enforced, or the hook could not append to its log.
// `checkRuns`: the batch's commands the hook approved for the checker, one entry per run.
function hookSeen(instance, wrappers, checker, since) {
  let text = '';
  try { text = readFileSync(join(instance, LOG_FILE), 'utf8'); } catch { /* the hook never ran */ }
  const calls = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(call => call && typeof call.at === 'string' && call.at >= since);
  const workers = calls.filter(call => wrappers.includes(call.agentType));
  const refused = [...new Set(workers.filter(call => call.tool === 'Bash' && call.decision === 'deny' && typeof call.command === 'string' && call.command).map(call => call.command))].slice(0, 20);
  const checkRuns = workers.filter(call => call.agentType === checker && call.tool === 'Bash' && call.decision === 'approve' && typeof call.command === 'string').map(call => call.command);
  return { calls: calls.length, workerCalls: workers.length, denied: workers.filter(call => call.decision === 'deny').length, refused, checkRuns };
}

// The output ceiling is the tickets' allowances plus the Guardian's share: the proposal is for the share used most against its limit.
function outputReached(limits, spent, guardian, count) {
  const perTicket = observed => { const allowance = proposedTokens(observed);
    return { limit: 'outputAllowancePerTicket', observed, current: limits.outputAllowancePerTicket,
      proposal: { outputAllowancePerTicket: allowance, ...(allowance > limits.authorizationPerTicket ? { authorizationPerTicket: allowance } : {}) } }; };
  if (!Number.isSafeInteger(guardian) || guardian < 0 || guardian > spent)
    return { ...perTicket(Math.ceil(spent / Math.max(1, count))), note: 'The engine return does not give the Guardian\'s spend apart: the figure per ticket includes it' };
  const tickets = Math.ceil((spent - guardian) / Math.max(1, count));
  return guardian / limits.guardianOutputShare > tickets / limits.outputAllowancePerTicket
    ? { limit: 'guardianOutputShare', observed: guardian, current: limits.guardianOutputShare, proposal: { guardianOutputShare: proposedTokens(guardian) } }
    : perTicket(tickets);
}

// Each limit that stopped work in this batch, with what was observed and a proposal for the owner, who decides.
// Nothing here writes a limit.
function limitsReached(limits, result, refused) {
  const report = [], ran = result.results;
  if (result.budgetGateTripped === true && Number.isSafeInteger(result.budgetStatus?.loopSpent)) report.push(outputReached(limits, result.budgetStatus.loopSpent, result.guardianTokens, ran.length));
  // The engine retries only a clean execution whose verification failed: such a ticket at the cap ran out of attempts.
  const spent = ran.filter(r => r.attempts >= limits.attemptsPerTicket && r.workerStatus === 'succeeded' && r.verificationStatus === 'failed');
  if (spent.length) report.push({ limit: 'attemptsPerTicket', observed: Math.max(...spent.map(r => r.attempts)), current: limits.attemptsPerTicket,
    proposal: limits.attemptsPerTicket < 3 ? { attemptsPerTicket: limits.attemptsPerTicket + 1 } : null, tickets: spent.map(r => r.ticket) });
  // A refused command that is a confirmed one in another form (no "cd" to the product root, or a bare "cd") needs no new limit.
  for (const command of refused) {
    const bare = command.replace(/^\s*cd\s+("[^"]*"|\S+)\s*&&\s*/, '').trim(), form = limits.allowedCommands.includes(bare) || /^cd(\s|$)/.test(bare);
    report.push({ limit: 'allowedCommands', observed: command, current: limits.allowedCommands, proposal: null,
      ...(form ? { note: 'a confirmed command, or a cd, in a form the hook does not accept; no limit change is needed. Workers run each command exactly as listed, from the product root' } : {}) });
  }
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

// ADR 0010, amendment of 2026-11-26: the batch's frozen commands the owner still confirms, run by the kit on the product as it stands.
// No confirmed command left to run proves nothing about the tree.
function verifyTree(instance, batch, run) {
  const { allowed, commands, dropped } = confirmedOf(instance, batch.verificationCommands);
  const runs = run({ productRoot: batch.productRoot, commands, frozen: batch.verificationCommands, allowed });
  need(!runs.errors, runs.errors?.[0]?.reason);
  return { ran: true, failed: !runs.length || failedRuns(runs).length > 0, commands: runs.map(({ command, exit, timedOut, outputDigest, tail }) => ({ command, exit, timedOut, outputDigest, tail })), dropped };
}

export function afterBatch({ teamRoot, instanceRoot, result, run = runCommands }) {
  try {
    const { instance, batch } = openBatch(teamRoot, instanceRoot), product = batch.productRoot, afterPath = join(instance, AFTER_FILE);
    // A return that is not this batch's return changes nothing: the lock stays held and the boundary open.
    const account = accountRun({ args: batch.args, record: batch.runRecord, result });
    need(account.status === 'accounted', `The engine return is not the return of this batch: ${account.findings.join(', ')}`);
    need(Array.isArray(batch.review?.triggers) && Array.isArray(batch.review.reviewers) && batch.review.reviewers.every(reviewer => typeof batch.reviewWrappers?.[reviewer] === 'string'),
      `${BATCH_FILE} holds no frozen review trigger list or reviewer wrappers: an earlier kit opened it. ${ABANDON}`);
    // The close is claimed before anything is changed, so two calls never close the same batch together and
    // one that died is taken up again, not judged as if someone had tampered with the batch.
    const earlier = readJSON(afterPath), claim = () => ({ stage: 'batch-closing', runId: batch.runId, claimedAt: new Date().toISOString(), pid: process.pid });
    need(!exists(afterPath) || earlier?.stage === 'batch-closing' || earlier?.stage !== 'batch-closed', 'This batch was already closed; finish it with: rw-batch.mjs commit --instance <instance-root>');
    need(!exists(afterPath) || earlier?.stage === 'batch-closing', `${AFTER_FILE} cannot be read. ${ABANDON}`);
    const resumed = earlier?.stage === 'batch-closing', age = resumed ? Date.now() - Date.parse(earlier.claimedAt) : null;
    // An after runs the verification commands, as long as they take: its claim stands while its process lives. A claim
    // with no process, no readable time, or a time in the future, is not a running after.
    need(!resumed || (earlier.pid === undefined ? !(age >= 0 && age <= CLAIM_MS) : !alive(earlier.pid)),
      `Another after is closing this batch${earlier?.pid === undefined ? '; if none is running, run the command again in a minute' : ` (process ${plain(earlier.pid)}); it may be running the verification commands: wait for it to end`}`);
    if (resumed) replace(afterPath, claim());
    else {
      try { writeFileSync(afterPath, JSON.stringify(claim()) + '\n', { flag: 'wx' }); }
      catch (error) { need(error?.code !== 'EEXIST', 'Another after is closing this batch'); throw error; }
    }

    const findings = [], boundary = readBoundary(instance);
    // A resumed close may find its own work done: the boundary already closed, the lock already released.
    const workers = [batch.args.plan[0].agentType, batch.args.plan[0].verifierAgentType, batch.args.guardianAgentType].sort();
    const ownClosed = resumed && boundary && boundary.productRoot === product && stateOf(boundary) !== 'batch'
      && digest(Object.entries(boundary.wrappers).filter(([, entry]) => entry.duty !== 'review').map(([name]) => name).sort()) === digest(workers);
    if (boundary?.digest !== batch.boundaryDigest && !ownClosed) findings.push({ code: 'BOUNDARY_CHANGED' });
    if ((git(product, 'rev-parse', 'HEAD')?.trim() ?? null) !== batch.productHead) findings.push({ code: 'PRODUCT_HEAD_MOVED' });
    if ((git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() ?? null) !== batch.branch) findings.push({ code: 'PRODUCT_BRANCH_CHANGED' });
    if (hooksOf(product).digest !== batch.hooks?.digest) findings.push({ code: 'HOOKS_CHANGED' });
    // accountRun applies the same rule to arguments frozen with standingBatch, so its blockers name the Guardian exactly when this holds the commits.
    const guardian = result.guardian ?? {}, hold = guardianHold(result, batch.args.standingBatch === true);
    if (hold) findings.push({ code: 'GUARDIAN_NOT_CLEAN', status: plain(guardian.status ?? 'none'), verdict: plain(guardian.verdict ?? 'none'), ...(hold.gateFault ? { budgetGate: 'inconsistent' } : {}) });
    else if (guardian.verdict !== 'clean') findings.push({ code: 'GUARDIAN_ATTENTION', verdict: plain(guardian.verdict ?? 'none'), missedHaltRisk: guardian.missedHaltRisk === true, budgetGateCorrect: guardian.budgetGateCorrect === true });

    // What the batch changed: everything the work tree holds now that was not already there when it opened.
    const changedNow = () => changedPaths(product).filter(path => !batch.preexisting.includes(path)), worked = changedNow();
    // A path changed where the hooks live, or beside husky's stub folder, through a worker's shell: it would run at the commit.
    const hooked = worked.filter(path => (batch.hooks?.guarded ?? []).some(guard => path === guard || path.startsWith(`${guard}/`)));
    if (hooked.length) findings.push({ code: 'HOOKS_WRITTEN', paths: hooked });
    const outcomes = batch.tickets.map((ticket, i) => outcomeOf(result.results[i]));
    const { refused, checkRuns, ...hook } = hookSeen(instance, workers, batch.args.plan[0].verifierAgentType, batch.openedAt);
    // A resumed path that still holds what "before" applied was written by the PM, not by a worker.
    const applied = Object.assign({}, ...batch.tickets.map(ticket => ticket.resume?.content ?? {})), now = contentOf(product, Object.keys(applied));
    if (worked.some(path => !Object.hasOwn(applied, path) || applied[path] !== now[path]) && hook.workerCalls === 0) findings.push({ code: 'HOOK_SAW_NO_WORKER' });
    // The log does not say which ticket a run was for, so the runs are counted against every passed ticket. An earlier kit's hook logged no approved command.
    if (batch.hookLogsCommands === true) {
      const short = batch.verificationCommands.map(command => ({ command,
        needed: outcomes.filter((outcome, i) => outcome.status === 'passed' && (batch.tickets[i].verificationCommands ?? batch.verificationCommands).includes(command)).length,
        seen: checkRuns.filter(run => run === command).length })).filter(entry => entry.seen < entry.needed);
      if (short.length) findings.push({ code: 'CHECK_RUNS_MISSING', commands: short });
    }
    // ADR 0010, amendment of 2026-11-26: the commands run before anything is pinned, so what is pinned is what they left; they run
    // under the lock the batch still holds. A batch held already, or with no ticket passed, has nothing they could clear.
    const verification = findings.some(finding => HOLD_ALL.includes(finding.code)) || !outcomes.some(outcome => outcome.status === 'passed')
      ? { ran: false, failed: false, commands: [], dropped: [] } : verifyTree(instance, batch, run);
    if (verification.failed) findings.push({ code: 'VERIFICATION_FAILED', commands: failedRuns(verification.commands).map(({ command, exit, timedOut }) => ({ command, exit, timedOut })), dropped: verification.dropped });
    const changed = verification.ran ? changedNow() : worked;
    // A changed path that is a directory is a repository of its own inside the product: Git would commit a link to it, not its files.
    const nested = changed.filter(path => path.endsWith('/')), files = changed.filter(path => !path.endsWith('/'));
    if (nested.length) findings.push({ code: 'NESTED_REPOSITORY', paths: nested });
    const was = batch.preexistingContent ?? {}, is = contentOf(product, batch.preexisting);
    const rechanged = batch.preexisting.filter(path => Object.hasOwn(was, path) && was[path] !== is[path]);
    if (rechanged.length) findings.push({ code: 'PREEXISTING_PATH_CHANGED', paths: rechanged });
    const tickets = batch.tickets.map((ticket, i) => ({ id: ticket.id, ...outcomes[i], changedPaths: files.filter(path => within(path, ticket.paths)) }));
    // ADR 0011, decision 3: the reviewers each passed ticket's changes require, by the list frozen at "before"; commit is gated on their verdicts.
    // Every changed path is pinned, flagged or not: an elective review reads what after saw, not what is there later.
    // A passed ticket that changed nothing is not committed, so it is not flagged, even when it declared itself sensitive.
    for (const ticket of tickets.filter(entry => entry.status === 'passed' && entry.changedPaths.length)) {
      ticket.review = flagPaths(batch.review, ticket.changedPaths, batch.tickets.find(entry => entry.id === ticket.id).declared ?? []);
      ticket.content = contentOf(product, ticket.changedPaths);
    }
    const reviews = Object.fromEntries(batch.review.reviewers.map(name => [name, { tickets: tickets.filter(ticket => ticket.review?.required.includes(name)).map(ticket => ticket.id) }]).filter(([, entry]) => entry.tickets.length));
    const outside = files.filter(path => !batch.tickets.some(ticket => within(path, ticket.paths)));
    if (outside.length) findings.push({ code: 'WRITE_OUTSIDE_PATHS', paths: outside });

    // ADR 0011, decision 4: a batch whose changes need a review leaves the workers closed and the reviewers judged.
    // A batch whose commits are all held is not reviewed: no verdict could release them.
    if (findings.some(finding => HOLD_ALL.includes(finding.code))) for (const name of Object.keys(reviews)) delete reviews[name];
    let boundaryClosed = false;
    try {
      if (Object.keys(reviews).length) reviewBoundary({ teamRoot: instance, runId: batch.runId, reviewers: batch.reviewWrappers }); else closeBoundary({ teamRoot: instance });
      boundaryClosed = true;
    } catch { findings.push({ code: 'BOUNDARY_NOT_RESTORED' }); }
    const lease = readLease({ productRoot: product }), ours = lease.status === 'held' && lease.lease.digest === batch.lease, alreadyFree = resumed && lease.status === 'free';
    const leaseReleased = alreadyFree || (ours && !releaseLease({ productRoot: product, lease: batch.lease }).errors);
    if (!leaseReleased) findings.push({ code: ours ? 'LOCK_RELEASE_FAILED' : 'LOCK_NOT_HELD_BY_THIS_BATCH' });

    // Decision 13: one commit per ticket that passed, of that ticket's own paths. Everything else stays in the work tree.
    const holdAll = findings.some(finding => HOLD_ALL.includes(finding.code));
    const commits = holdAll ? [] : tickets.filter(ticket => ticket.status === 'passed' && ticket.changedPaths.length)
      .map(ticket => ({ ticket: ticket.id, message: batch.tickets.find(entry => entry.id === ticket.id).commitMessage, paths: ticket.changedPaths }));
    const committed = new Set(commits.flatMap(commit => commit.paths)), at = new Date().toISOString(), passed = tickets.filter(ticket => ticket.status === 'passed').length;
    const left = changed.filter(path => !committed.has(path)), next = [];
    if (!boundaryClosed) next.push('The write-boundary file is missing or was changed: every subagent write and shell command is refused until a mode switch to specialist and back rebuilds it');
    const hooksTouched = findings.some(finding => ['HOOKS_CHANGED', 'HOOKS_WRITTEN'].includes(finding.code));
    if (holdAll) next.push(`No ticket of this batch is committed by the kit. ${hooksTouched ? `${HOOKS_FIRST}. ` : ''}${ABANDON}`);
    const broke = findings.find(finding => finding.code === 'VERIFICATION_FAILED');
    if (broke) next.push(`The kit ran the batch's verification commands on the product as it stands and ${broke.commands.length ? `${broke.commands.map(entry => `${plain(entry.command)} (${entry.timedOut ? 'timed out' : `exit ${entry.exit}`})`).join(', ')} did not pass` : `no verification command confirmed for the team was left to run (${broke.dropped.map(plain).join(' | ')})`}: the kit cannot tell which ticket broke the tree, so it commits none. Read the output in the record's verification`);
    if (findings.some(finding => finding.code === 'HOOK_SAW_NO_WORKER')) next.push('The hook logged no call of this batch\'s workers: either the session that ran the batch did not load the write-boundary hook of the team root (.claude/settings.json), so the write limits were not enforced, or the hook ran and could not append to its log (.claude/rw-write-boundary.log.jsonl), so what it decided is not known. Inspect every changed path before any commit by hand, and run the next batch from a session that loads the hook, with that log writable');
    const missing = findings.find(finding => finding.code === 'CHECK_RUNS_MISSING')?.commands ?? [];
    if (missing.length) next.push(`The checker ran ${missing.map(entry => `${plain(entry.command)} (${entry.seen} of ${entry.needed})`).join(', ')} fewer times than the tickets that passed verify with it: a ticket passed without its checker running its verification commands, and the log cannot say which. Run the verification commands yourself before any commit by hand`);
    if (!holdAll && left.length) next.push(`Paths are left uncommitted in the product; the next batch refuses until they are dealt with, or it is started as is. Once the batch is committed or archived, save the work each ticket left as a patch, out of the work tree, with: ${LEFT_COMMAND}; commit or discard by hand only what belongs to no ticket`);
    const reviewers = Object.keys(reviews);
    if (reviewers.length) next.push(`The batch is in review: brief each reviewer with ${reviewers.map(reviewer => `rw-batch.mjs review-brief --reviewer ${reviewer} --instance <instance-root>`).join(', and ')}; no batch, switch or change of limits starts until the review is over`);
    const status = () => findings.length || account.blockers.length || reviewers.length ? 'review' : 'clean';
    try { appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${batch.runId} CLOSED (${status()}): ${passed} of ${tickets.length} ticket(s) passed; ${commits.length} to commit, ${left.length} changed path(s) left${reviewers.length ? `; review required by ${reviewers.join(', ')}` : ''}${findings.length ? `; findings: ${findings.map(finding => finding.code).join(', ')}` : ''}.\n`); }
    catch { findings.push({ code: 'LEDGER_NOT_WRITTEN' }); }
    // The engine's return is kept beside the record, which carries its digest: the settlement of usage needs it, and so does anyone who audits the batch.
    const kept = JSON.parse(JSON.stringify(result));
    const record = sealed({ schemaVersion: 1, stage: 'batch-closed', runId: batch.runId, batchDigest: batch.digest, closedAt: at, status: status(),
      account, returnDigest: digest(kept), tickets, reviews, commits, left, holdAll, hook, verification, findings, limits: limitsReached(batch.limits, result, refused), boundaryClosed, leaseReleased, next });
    replace(join(instance, RETURN_FILE), kept);
    replace(afterPath, record);
    return record;
  } catch (error) { return refuse(error); }
}

// The plan of a batch: after's commits, or for a reviewed batch the commits of its resolution, checked again against
// the verdicts, after's plan and the held patches on disk.
export const HELD_REASONS = ['rejected', 'review-not-obtained', 'verification-failed-after-removal'];
function resolutionOf(instance, batch, after) {
  const { reasons, flagged } = reviewGate(instance, batch, after);
  if (!flagged) return { plan: after.commits, held: [], wrote: [], reviewed: false };
  const path = join(instance, RESOLUTION_FILE), resolution = readJSON(path);
  need(intact(resolution, 'batch-resolved'), `This batch was reviewed: resolve it first with: rw-batch.mjs resolve --instance <instance-root>${exists(path) ? `. ${RESOLUTION_FILE} is not a finished resolution: run resolve again` : ''}`);
  need(resolution.afterDigest === after.digest && resolution.reviewsDigest === digest(verdictsOf(instance, batch.runId)), `${RESOLUTION_FILE} belongs to another close of the batch or to other verdicts. ${ABANDON}`);
  const removed = Array.isArray(resolution.removed) ? resolution.removed : null, ids = new Set((removed ?? []).map(entry => entry?.ticket));
  const plan = after.commits.filter(commit => !ids.has(commit.ticket));
  need(removed && removed.every(entry => HELD_REASONS.includes(entry.reason) && after.commits.some(commit => commit.ticket === entry.ticket && digest(commit.paths) === digest(entry.paths))) && digest(resolution.commits) === digest(plan)
    && after.commits.every((commit, i) => !reasons[i] || ids.has(commit.ticket)) && Array.isArray(resolution.verification?.wrote),
  `${RESOLUTION_FILE} does not hold after's commits less the tickets a review held. ${ABANDON}`);
  const lost = removed.filter(entry => entry.patch !== `reviews/held/${batch.runId}/${entry.ticket}.patch` || !exists(join(instance, entry.patch)) || bytesDigest(readFileSync(join(instance, entry.patch))) !== entry.patchDigest);
  need(!lost.length, `The patch of ${lost.map(entry => plain(String(entry.ticket))).join(', ')} is missing or was changed; the held work would be lost. ${ABANDON}`);
  const committing = new Set(plan.flatMap(commit => commit.paths)), wrote = resolution.verification.wrote;
  need(wrote.every(file => typeof file === 'string' && !committing.has(file)), `${RESOLUTION_FILE} records as written by a command a path it commits. ${ABANDON}`);
  return { plan, held: removed.map(({ ticket, reason, patch }) => ({ ticket, reason, patch })), wrote, reviewed: true };
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
    // A held batch commits nothing: archiving it with commit would log it as committed.
    need(after.holdAll !== true, `Every commit of this batch is held (${(after.findings ?? []).filter(finding => typeof finding?.code === 'string').map(finding => plain(finding.code)).join(', ')}); nothing can be committed. Archive it with: rw-batch.mjs abort --instance <instance-root>`);
    // ADR 0011, decisions 14 and 15: a reviewed batch commits what its resolution kept; the tickets it held are patches.
    const { plan, held, wrote, reviewed } = resolutionOf(instance, batch, after);
    product = batch.productRoot;
    const taken = acquireLease({ teamRoot: instance, productRoot: product });
    need(!taken.errors, `The lock on the product repository could not be taken: ${taken.errors?.[0]?.reason}`);
    lease = taken.lease.digest;

    need(git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() === batch.branch, `The product repository is no longer on the batch's branch (${plain(batch.branch)}). ${ABANDON}`);
    const gitDir = git(product, 'rev-parse', '--absolute-git-dir')?.trim(), busy = IN_PROGRESS.filter(name => gitDir && exists(join(gitDir, name)));
    need(gitDir && !busy.length, `A Git operation is in progress in the product repository (${busy.join(', ')})`);
    need(hooksOf(product).digest === batch.hooks?.digest, `${HOOKS_MOVED}. ${ABANDON}`);
    need(!exists(join(instance, ARCHIVE, batch.runId)), `batches/${batch.runId} already exists: an archive of this batch was started. ${ABANDON}`);
    // The commits this command already made, by their ids: the branch must be the batch's start plus exactly those.
    const progressPath = join(instance, PROGRESS_FILE), progress = exists(progressPath) ? readJSON(progressPath) : { commits: [] };
    need(Array.isArray(progress?.commits) && progress.commits.length <= plan.length && progress.commits.every((made, i) => made?.ticket === plan[i].ticket && /^[a-f0-9]{40}$/.test(made.sha ?? '')),
      `${PROGRESS_FILE} cannot be read. ${ABANDON}`);
    const done = progress.commits, head = () => git(product, 'rev-parse', 'HEAD')?.trim(), parentOf = sha => git(product, 'rev-parse', `${sha}^`)?.trim();
    const holds = (sha, paths) => digest((git(product, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha) ?? '').split('\0').filter(Boolean).sort()) === digest([...paths].sort());
    const drift = commits => commits.flatMap(commit => { const now = contentOf(product, commit.paths), was = after.tickets.find(ticket => ticket.id === commit.ticket)?.content ?? {}; return commit.paths.filter(path => now[path] !== was[path]); });
    // A commit that was made just before this command died, and so was never recorded, is taken up when it is the next planned one.
    const tip = done.length ? done.at(-1).sha : batch.productHead, upNext = plan[done.length];
    if (upNext && head() !== tip && parentOf(head()) === tip && holds(head(), upNext.paths)) {
      // It holds what after saw when the work tree does and the commit is the work tree.
      const unlike = [...new Set([...drift([upNext]), ...changedPaths(product).filter(path => upNext.paths.includes(path))])];
      need(!unlike.length, `The commit ${head().slice(0, 8)} found for ticket ${upNext.ticket} does not hold what after saw (${unlike.slice(0, 5).map(plain).join(', ')}). ${ABANDON}`);
      done.push({ ticket: upNext.ticket, sha: head() }); replace(progressPath, { schemaVersion: 1, runId: batch.runId, commits: done });
    }
    need(done.every((made, i) => holds(made.sha, plan[i].paths)), `A commit recorded for this batch does not hold its ticket's paths. ${ABANDON}`);
    need(head() === (done.length ? done.at(-1).sha : batch.productHead) && done.every((made, i) => parentOf(made.sha) === (i ? done[i - 1].sha : batch.productHead)),
      `The product branch is not the batch's start plus the commits this command made: someone committed, or moved the branch. ${ABANDON}`);
    const todo = plan.slice(done.length);
    // What is still to commit must be exactly what after saw, less what resolve removed, plus what its commands wrote.
    const pending = changedPaths(product).filter(path => !batch.preexisting.includes(path)), expected = [...new Set([...todo.flatMap(commit => commit.paths), ...after.left, ...wrote])].sort();
    need(digest(pending) === digest(expected), `The product repository changed since the batch was closed. ${ABANDON}`);
    const moved = drift(todo);
    need(!moved.length, `${moved.slice(0, 5).map(plain).join(', ')} changed since the batch was closed; what would be committed is not what after saw${reviewed ? ' and the review read' : ''}. ${ABANDON}`);

    for (const commit of todo) {
      // A path a worker already removed from the index has nothing to add; the commit below records its deletion.
      const addable = commit.paths.filter(path => exists(join(product, path)) || (git(product, '--literal-pathspecs', 'ls-files', '--', path) ?? '').trim() !== '');
      const added = addable.length ? withPaths(product, ['add', '-A'], addable) : { status: 0 };
      need(added.status === 0 && !added.error, `git add failed for ticket ${commit.ticket}: ${said(added)}. ${ABANDON}`);
      // --only: what else is staged, such as a path changed before the batch, is not carried into this commit.
      const parent = head(), committed = withPaths(product, ['commit', '-q', '-m', commit.message, '--only'], commit.paths, 600000);
      need(committed.status === 0 && !committed.error, `git commit failed for ticket ${commit.ticket} (${done.length} of ${plan.length} made): ${said(committed)}. Fix the cause and run commit again. ${ABANDON}`);
      const sha = head();
      need(sha && sha !== parent && parentOf(sha) === parent, `The commit of ticket ${commit.ticket} did not land on the product branch. ${ABANDON}`);
      // A hook may have put other paths into the commit: what it holds must be the ticket's paths, nothing else.
      need(holds(sha, commit.paths), `The commit of ticket ${commit.ticket} (${sha.slice(0, 8)}) does not hold exactly that ticket's paths; a commit hook may have added or dropped some. It is left as it is. ${ABANDON}`);
      // And each file holds the bytes after saw, which a hook that rewrites and stages a file would change (review finding R23-01).
      const was = after.tickets.find(ticket => ticket.id === commit.ticket)?.content ?? {};
      const blob = path => { const shown = gitRun(product, ['cat-file', 'blob', `${sha}:${path}`], { encoding: 'buffer' }); return shown.status === 0 ? bytesDigest(shown.stdout) : null; };
      const rewritten = commit.paths.filter(path => typeof was[path] === 'string' && blob(path) !== was[path]);
      need(!rewritten.length, `The commit of ticket ${commit.ticket} (${sha.slice(0, 8)}) holds other bytes than after saw in ${rewritten.slice(0, 5).map(plain).join(', ')}; a commit hook may have rewritten them. It is left as it is: inspect the hooks and the commit before anything else. ${ABANDON}`);
      done.push({ ticket: commit.ticket, sha });
      replace(progressPath, { schemaVersion: 1, runId: batch.runId, commits: done });
    }
    const left = changedPaths(product).filter(path => !batch.preexisting.includes(path)), at = new Date().toISOString(), escalations = escalationsOf(instance, batch.runId);
    const record = sealed({ schemaVersion: 1, stage: 'batch-committed', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, committedAt: at, branch: batch.branch, commits: done, held, escalations, left, pushed: false });
    let ledgerWritten = true;
    try { appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${batch.runId} COMMITTED on ${plain(batch.branch)}: ${done.length} commit(s)${done.length ? ` (${done.map(commit => `${commit.ticket} ${commit.sha.slice(0, 8)}`).join(', ')})` : ''}; ${left.length} changed path(s) left uncommitted${left.length ? ` (${left.slice(0, 10).map(plain).join(', ')}${left.length > 10 ? ', ...' : ''})` : ''}${held.length ? `; held: ${held.map(entry => `${entry.ticket} (${entry.reason})`).join(', ')}` : ''}${escalations.length ? `; escalated to the owner: ${escalations.map(entry => entry.id).join(', ')}` : ''}. Nothing was pushed.\n`); }
    catch { ledgerWritten = false; }
    archiveBatch(instance, batch.runId, { 'commit.json': record }, RECORDS);
    return ledgerWritten ? record : { ...record, warning: `${LEDGER} could not be written; add the COMMITTED line by hand` };
  } catch (error) { return refuse(error); } finally { if (lease) releaseLease({ productRoot: product, lease }); }
}
