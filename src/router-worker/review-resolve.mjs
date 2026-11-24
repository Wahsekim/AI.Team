import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, bytesDigest } from '../loop/contracts.mjs';
import { git, gitRun, acquireLease, releaseLease, readLease } from './lease.mjs';
import { readBoundary, closeBoundary, stateOf } from './write-boundary.mjs';
import { runCommands, confirmedOf } from './run-commands.mjs';
import { AFTER_FILE, RESOLUTION_FILE, changedPaths, contentOf, hooksOf, plain } from './batch.mjs';
import { openBatch, intact, Refusal, IN_PROGRESS, ABANDON } from './batch-close.mjs';
import { reviewGate, verdictsOf, briefsOf } from './review-judge.mjs';

// ADR 0011, decisions 14 and 15, with the owner's answer of 2026-11-20: once the reviews are over, each ticket a review
// rejected or could not obtain is saved as a patch and taken out of the work tree; when a later ticket is still to be
// committed, the verification commands run again, and if they fail or change a file still to be committed, every
// ticket after the first removed one is held too. The resolution record is what commit commits.
export { RESOLUTION_FILE };
export const HELD = 'reviews/held';
const LEDGER = 'pm-decisions.md', AFTER_REMOVAL = 'verification-failed-after-removal';
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const sealed = body => ({ ...body, digest: digest(body) });
const replace = (path, record) => { writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2) + '\n'); renameSync(`${path}.tmp`, path); };
const ok = step => step.status === 0 && !step.error;
const literal = (product, args, paths, options = {}) => gitRun(product, ['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { ...options, input: paths.join('\0') });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// The paths' change from the batch's start as a binary patch, untracked files included, through an index of its own.
function patchOf(product, head, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'rw-held-')), env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    const steps = [gitRun(product, ['read-tree', head], { env }), literal(product, ['add', '-A'], paths, { env })];
    const diff = gitRun(product, ['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', head], { env, encoding: 'buffer' });
    need([...steps, diff].every(ok) && diff.stdout.length > 0, 'The patch of a held ticket could not be made');
    return diff.stdout;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Back to the batch's start: a path the start holds is checked out from it, index included; any other is unstaged and deleted.
function removeFrom(product, head, paths) {
  const listed = gitRun(product, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', head, '--', ...paths]);
  need(ok(listed), 'The paths of a held ticket could not be read from the batch\'s start');
  const tracked = new Set(listed.stdout.split('\0').filter(Boolean)), old = paths.filter(path => tracked.has(path)), fresh = paths.filter(path => !tracked.has(path));
  if (old.length) need(ok(literal(product, ['checkout', head], old)), `${old.slice(0, 5).map(plain).join(', ')} could not be checked out from the batch's start`);
  if (fresh.length) need(ok(literal(product, ['rm', '--cached', '-q', '--ignore-unmatch'], fresh)), `${fresh.slice(0, 5).map(plain).join(', ')} could not be unstaged`);
  for (const path of fresh) rmSync(join(product, path), { force: true });
  const still = changedPaths(product).filter(path => paths.includes(path));
  need(!still.length, `${still.slice(0, 5).map(plain).join(', ')} still show as changed after the held ticket was removed`);
}

// The commits after the first removed one, from the first ticket whose file a command changed if that comes earlier.
function heldAfterVerification(commits, first, verification) {
  if (!verification?.ran || (!verification.failed && !verification.changed.length)) return [];
  const changedAt = commits.findIndex(commit => commit.paths.some(path => verification.changed.includes(path)));
  return commits.slice(changedAt === -1 ? first + 1 : Math.min(first + 1, changedAt));
}

export function resolveBatch({ teamRoot, instanceRoot, run = runCommands }) {
  let lease = null, product;
  try {
    const { instance, batch } = openBatch(teamRoot, instanceRoot), after = readJSON(join(instance, AFTER_FILE)), path = join(instance, RESOLUTION_FILE);
    need(intact(after, 'batch-closed') && after.batchDigest === batch.digest, `The batch is not closed, or ${AFTER_FILE} was changed or belongs to another batch. ${ABANDON}`);
    const kept = exists(path) ? readJSON(path) : null;
    if (intact(kept, 'batch-resolved') && kept.afterDigest === after.digest) return kept;
    need(!kept || (kept.stage === 'batch-resolving' && kept.runId === batch.runId && kept.afterDigest === after.digest && Array.isArray(kept.removed)), `${RESOLUTION_FILE} cannot be read, or belongs to another batch. ${ABANDON}`);
    const boundary = readBoundary(instance);
    need(boundary && ((stateOf(boundary) === 'review' && boundary.runId === batch.runId) || (kept && stateOf(boundary) === 'closed')), 'No batch is in review in this team: resolve follows the reviews of a flagged batch');
    const reviewsDigest = digest(verdictsOf(instance, batch.runId));
    need(!kept || kept.reviewsDigest === reviewsDigest, `${RESOLUTION_FILE} was started on other verdicts than those in the team now. ${ABANDON}`);
    const { reasons } = reviewGate(instance, batch, after);
    // The commands the kit ran for each reviewer's latest brief. A failure there holds the batch when that tree was exactly
    // what would be committed: after left nothing beside the tickets and no review holds one. Otherwise it is recorded.
    const failedAtBrief = batch.review.reviewers.flatMap(reviewer => { const brief = briefsOf(instance, reviewer, batch.runId).at(-1);
      return (brief?.verification ?? []).filter(run => run.exit !== 0 || run.timedOut).map(({ command, exit, timedOut }) => ({ reviewer, attempt: brief.attempt, command, exit, timedOut })); });
    const failures = failedAtBrief.map(run => `${plain(run.command)} (${run.reviewer}'s brief ${run.attempt}: ${run.timedOut ? 'timed out' : `exit ${run.exit}`})`).join(', ');
    need(!failedAtBrief.length || after.left.length || reasons.some(Boolean), `A verification command failed when the review was briefed, on a work tree that held only what would be committed: ${failures}. ${ABANDON}`);
    product = batch.productRoot;
    // The lock of a resolve that died is taken over; one that still runs is not.
    const held = readLease({ productRoot: product });
    if (kept?.lease && held.status === 'held' && held.lease.digest === kept.lease) { need(!alive(kept.pid), 'Another resolve of this batch is running'); lease = kept.lease; }
    else { const taken = acquireLease({ teamRoot: instance, productRoot: product }); need(!taken.errors, `The lock on the product repository could not be taken: ${taken.errors?.[0]?.reason}`); lease = taken.lease.digest; }
    // Another resolve may have finished between the first read and the lock.
    const current = exists(path) ? readJSON(path) : null;
    if (intact(current, 'batch-resolved') && current.afterDigest === after.digest) return current;
    need(JSON.stringify(current) === JSON.stringify(kept), `${RESOLUTION_FILE} changed while this resolve waited for the lock; run resolve again`);

    need(git(product, 'rev-parse', 'HEAD')?.trim() === batch.productHead, `The product branch moved since the batch opened. ${ABANDON}`);
    need(git(product, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() === batch.branch, `The product repository is no longer on the batch's branch (${plain(batch.branch)}). ${ABANDON}`);
    const gitDir = git(product, 'rev-parse', '--absolute-git-dir')?.trim(), busy = IN_PROGRESS.filter(name => gitDir && exists(join(gitDir, name)));
    need(gitDir && !busy.length, `A Git operation is in progress in the product repository (${busy.join(', ')})`);
    need(hooksOf(product).digest === batch.hooks?.digest, `The repository's commit hooks were changed or moved since the batch opened. ${ABANDON}`);

    let journal = { schemaVersion: 1, stage: 'batch-resolving', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, reviewsDigest, lease, pid: process.pid,
      removed: kept?.removed ?? [], verification: kept?.verification ?? null };
    const save = next => { journal = next; replace(path, journal); };
    save(journal);
    for (const entry of journal.removed) need(exists(join(instance, entry.patch)) && bytesDigest(readFileSync(join(instance, entry.patch))) === entry.patchDigest, `${plain(entry.patch)} is missing or was changed since resolve saved it. ${ABANDON}`);

    const commits = after.commits, first = reasons.findIndex(Boolean), pinned = id => after.tickets.find(ticket => ticket.id === id)?.content ?? {};
    const isRemoved = id => journal.removed.some(entry => entry.ticket === id);
    const drift = list => list.flatMap(commit => { const now = contentOf(product, commit.paths), was = pinned(commit.ticket); return commit.paths.filter(file => now[file] !== was[file]); });
    // What is not yet removed must be what after recorded and the reviewers read; on a resume, the tickets the commands
    // already condemned are exempt, since a command may have changed them.
    const condemned = new Set(heldAfterVerification(commits, first, journal.verification).map(commit => commit.ticket));
    const moved = drift(commits.filter(commit => !isRemoved(commit.ticket) && !condemned.has(commit.ticket)));
    need(!moved.length, `${moved.slice(0, 5).map(plain).join(', ')} changed since after; what would be committed is not what was reviewed. Restore it, or abort the batch`);

    const hold = (commit, reason) => {
      if (!isRemoved(commit.ticket)) {
        const patch = `${HELD}/${batch.runId}/${commit.ticket}.patch`, bytes = patchOf(product, batch.productHead, commit.paths), file = join(instance, patch);
        mkdirSync(join(instance, HELD, batch.runId), { recursive: true });
        writeFileSync(`${file}.tmp`, bytes); renameSync(`${file}.tmp`, file);
        save({ ...journal, removed: [...journal.removed, { ticket: commit.ticket, reason, patch, patchDigest: bytesDigest(bytes), paths: commit.paths }] });
      }
      removeFrom(product, batch.productHead, commit.paths);
    };
    commits.forEach((commit, i) => { if (reasons[i]) hold(commit, reasons[i]); });

    if (first !== -1 && !journal.verification && commits.slice(first + 1).some(commit => !isRemoved(commit.ticket))) {
      const toCommit = commits.filter(commit => !isRemoved(commit.ticket)), committing = new Set(toCommit.flatMap(commit => commit.paths));
      const ours = list => list.filter(file => !batch.preexisting.includes(file)), before = new Set(ours(changedPaths(product)));
      const { allowed, commands, dropped } = confirmedOf(instance, batch.verificationCommands);
      const runs = run({ productRoot: product, commands, frozen: batch.verificationCommands, allowed });
      need(!runs.errors, runs.errors?.[0]?.reason);
      // No confirmed command left to run proves nothing about the tickets that remain.
      const failed = !runs.length || runs.some(entry => entry.exit !== 0 || entry.timedOut);
      save({ ...journal, verification: { ran: true, failed, commands: runs.map(({ command, exit, timedOut, outputDigest, tail }) => ({ command, exit, timedOut, outputDigest, tail })), dropped,
        changed: drift(toCommit).sort(), wrote: ours(changedPaths(product)).filter(file => !before.has(file) && !committing.has(file)) } });
    }
    for (const commit of heldAfterVerification(commits, first, journal.verification)) hold(commit, AFTER_REMOVAL);

    const now = readBoundary(instance);
    if (now && stateOf(now) === 'review') closeBoundary({ teamRoot: instance });
    const at = new Date().toISOString(), removed = journal.removed, plan = commits.filter(commit => !isRemoved(commit.ticket));
    const verification = journal.verification ?? { ran: false, failed: false, commands: [], dropped: [], changed: [], wrote: [] };
    const record = sealed({ schemaVersion: 1, stage: 'batch-resolved', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, reviewsDigest, resolvedAt: at,
      removed, verification, failedAtBrief, commits: plan, left: after.left });
    const again = verification.ran ? `; verification run again ${verification.failed ? 'FAILED' : 'passed'}${verification.changed.length ? `, changed ${verification.changed.slice(0, 10).map(plain).join(', ')}` : ''}${verification.wrote.length ? `, wrote ${verification.wrote.slice(0, 10).map(plain).join(', ')} (left uncommitted)` : ''}` : '';
    appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${batch.runId} RESOLVED: ${removed.length ? `held ${removed.map(entry => `${entry.ticket} (${entry.reason})`).join(', ')} as patches under ${HELD}/${batch.runId}/` : 'nothing held'}; ${plan.length} to commit${again}${failures ? `; verification failed when the review was briefed: ${failures}` : ''}.\n`);
    replace(path, record);
    return record;
  } catch (error) {
    return { errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: error instanceof Refusal ? error.message : `The batch could not be resolved: ${error?.code ?? error?.message}` }] };
  } finally { if (lease) releaseLease({ productRoot: product, lease }); }
}
