import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, bytesDigest } from '../loop/contracts.mjs';
import { git, gitRun, acquireLease, releaseLease, readLease } from './lease.mjs';
import { readBoundary, closeBoundary, stateOf } from './write-boundary.mjs';
import { runCommands, confirmedOf } from './run-commands.mjs';
import { AFTER_FILE, RESOLUTION_FILE, RUN_ID, TICKET_ID, changedPaths, contentOf, hooksOf, plain, HOOKS_MOVED } from './batch.mjs';
import { openBatch, intact, Refusal, IN_PROGRESS, ABANDON, HELD_REASONS, alive } from './batch-close.mjs';
import { reviewGate, verdictsOf, briefsOf, finalOf } from './review-judge.mjs';

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
export const resolving = resolution => resolution?.stage === 'batch-resolving' && alive(resolution.pid);

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
const savePatch = (instance, patch, bytes) => { const file = join(instance, patch); mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, bytes); renameSync(`${file}.tmp`, file); };
export const heldAt = (runId, ticket) => typeof runId === 'string' && RUN_ID.test(runId) ? `${HELD}/${runId}/${ticket}.patch` : null;
// What a ticket whose removal failed part-way still has in the tree is also in the patch saved before the removal.
export const savedWhole = patch => `its saved patch ${patch} is the complete one: discard what is left of that ticket in the work tree, and do not save it again`;
// Which ticket a changed path belongs to is told only by the records before and after sealed.
export const attributable = (batch, after) => intact(batch, 'batch-open') && intact(after, 'batch-closed') && after.batchDigest === batch.digest && Array.isArray(batch.tickets) && Array.isArray(after.tickets);
export const BY_HAND = 'no command of the kit can tell which ticket each changed path belongs to: save it by hand before the work tree is cleaned (in the product: git add -A, then git diff --cached --binary HEAD > <a file outside the product>)';
// A patch is one section per file: a saved patch holds what is left of its ticket when it holds each section of that part.
const sections = bytes => bytes.toString('latin1').split(/^(?=diff --git )/m);
const holdsAll = (saved, part) => { const whole = new Set(sections(saved)); return sections(part).every(section => whole.has(section)); };
export const productState = (productRoot, taken) => {
  const head = git(productRoot, 'rev-parse', 'HEAD')?.trim(), gitDir = git(productRoot, 'rev-parse', '--absolute-git-dir')?.trim(), busy = IN_PROGRESS.filter(name => gitDir && exists(join(gitDir, name)));
  let changed = null; try { changed = changedPaths(productRoot); } catch { /* named below */ }
  const problem = taken.errors ? `The lock on the product repository could not be taken: ${taken.errors[0].reason}` : !head || !gitDir ? 'The product repository cannot be read'
    : busy.length ? `A Git operation is in progress in the product repository (${busy.join(', ')})` : changed ? null : 'The state of the product repository cannot be read';
  return { head, changed, problem };
};

// One ticket's work in the work tree (`changed` less what is not `recorded` as its own) saved at `patch` against `head`, then
// taken out. Nothing is removed before its patch is on disk, and a patch already there is never written over: one with the
// same bytes is the work of a run that died after saving it, one that holds all that is left is a removal that failed part-way.
// Out of the tree, the ticket is named by the one of `found` on disk written last.
export function setAside({ instance, productRoot, head, changed, problem, recorded, patch, found }) {
  const paths = changed ? changed.filter(path => recorded.includes(path)) : recorded;
  if (changed && !paths.length) {
    const at = [...new Set(found)].filter(path => path && exists(join(instance, path))).sort((a, b) => lstatSync(join(instance, a)).mtimeMs - lstatSync(join(instance, b)).mtimeMs).at(-1);
    return at ? { state: 'patch', patch: at } : { state: 'not-in-tree' };
  }
  let saved = false;
  try {
    need(!problem, problem);
    const bytes = patchOf(productRoot, head, paths), file = join(instance, patch);
    const kept = exists(file) ? readFileSync(file) : null;
    if (!kept) savePatch(instance, patch, bytes);
    else if (!kept.equals(bytes)) {
      saved = holdsAll(kept, bytes);
      need(false, saved ? `what is left of this ticket in the work tree is all in ${patch}, saved before a removal that failed part-way` : `${patch} already holds another patch, which is not written over`);
    }
    saved = true;
    removeFrom(productRoot, head, paths);
    return { state: 'patch', patch };
  } catch (error) { return { state: 'in-tree', paths, problem: plain(error?.message ?? error).slice(0, 300), ...(saved ? { patch } : {}) }; }
}

// ADR 0011, amendment of 2026-11-26: abort holds each ticket after flagged that no review passed, and each one resolve held.
// Against the product's HEAD, where a resume applies; a saved patch is never written over, so a second abort finds the first one's work done.
export function holdUnpassed({ instance, productRoot, runId }) {
  const after = readJSON(join(instance, AFTER_FILE));
  if (!Array.isArray(after?.tickets)) return [];
  const tickets = after.tickets.filter(ticket => typeof ticket?.id === 'string' && TICKET_ID.test(ticket.id) && Array.isArray(ticket.changedPaths) && ticket.changedPaths.every(path => typeof path === 'string'));
  // A record changed since after wrote it cannot say which ticket a review needed: nothing is taken out on its word.
  if (!intact(after, 'batch-closed')) return tickets.filter(ticket => ticket.changedPaths.length)
    .map(ticket => ({ ticket: ticket.id, reason: 'not-reviewed', state: 'in-tree', paths: ticket.changedPaths, problem: `${AFTER_FILE} is not the record after wrote: it was changed since after wrote it, so nothing is taken out` }));
  let verdicts = [];
  try { verdicts = verdictsOf(instance, after.runId); } catch { /* verdicts that cannot be read pass no ticket */ }
  const resolution = readJSON(join(instance, RESOLUTION_FILE)), byResolve = new Map((Array.isArray(resolution?.removed) ? resolution.removed : []).map(entry => [entry?.ticket, entry]));
  // Why no review passed it, weighed as reviewGate weighs it; a reviewer with no final verdict never reviewed it.
  const outcome = (id, reviewer) => { const final = finalOf(verdicts, reviewer), verdict = final?.tickets?.find?.(item => item?.id === id)?.verdict;
    return !final ? 'not-reviewed' : verdict === 'passed' ? null : verdict === 'rejected' ? 'rejected' : 'review-not-obtained'; };
  const reasonOf = ticket => { const resolved = byResolve.get(ticket.id)?.reason; if (HELD_REASONS.includes(resolved)) return resolved;
    const outcomes = (Array.isArray(ticket.review?.required) ? ticket.review.required : []).map(reviewer => outcome(ticket.id, reviewer));
    return outcomes.find(reason => reason === 'rejected') ?? outcomes.find(Boolean) ?? null; };
  const held = tickets.map(ticket => ({ ticket: ticket.id, reason: reasonOf(ticket), recorded: ticket.changedPaths })).filter(entry => entry.reason);
  if (!held.length) return [];
  // abort releases this team's lock, which a resolve still running holds: its removals are not raced.
  if (resolving(resolution))
    return held.map(({ ticket, reason, recorded }) => ({ ticket, reason, state: 'in-tree', paths: recorded, problem: `A resolve of this batch is still running (process ${resolution.pid}); nothing is taken out while it runs` }));
  const taken = acquireLease({ teamRoot: instance, productRoot });
  try {
    const { head, changed, problem } = productState(productRoot, taken);
    return held.map(({ ticket, reason, recorded }) => {
      // An abort that archives under another name than the batch's run id finds what resolve or an earlier abort saved under that id.
      const out = setAside({ instance, productRoot, head, changed, problem, recorded, patch: heldAt(runId, ticket), found: [heldAt(after.runId, ticket), heldAt(runId, ticket)] });
      return out.state === 'patch' ? { ticket, reason, state: 'patch', patch: out.patch, by: out.patch === byResolve.get(ticket)?.patch ? 'resolve' : 'abort' } : { ticket, reason, ...out };
    });
  } finally { if (!taken.errors) releaseLease({ productRoot, lease: taken.lease.digest }); }
}

// The commits after the first removed one, from the first ticket whose file a command changed if that comes earlier.
function heldAfterVerification(commits, first, verification) {
  if (!verification?.ran || (!verification.failed && !verification.changed.length)) return [];
  const changedAt = commits.findIndex(commit => commit.paths.some(path => verification.changed.includes(path)));
  return commits.slice(changedAt === -1 ? first + 1 : Math.min(first + 1, changedAt));
}

// The batch's frozen commands the owner still confirms, run from the product root. No confirmed command left to run proves nothing.
function runFrozen(instance, batch, run) {
  const { allowed, commands, dropped } = confirmedOf(instance, batch.verificationCommands);
  const runs = run({ productRoot: batch.productRoot, commands, frozen: batch.verificationCommands, allowed });
  need(!runs.errors, runs.errors?.[0]?.reason);
  return { failed: !runs.length || runs.some(entry => entry.exit !== 0 || entry.timedOut), commands: runs.map(({ command, exit, timedOut, outputDigest, tail }) => ({ command, exit, timedOut, outputDigest, tail })), dropped };
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
    // The latest complete brief's run of the commands decides, whichever reviewer it was for: a failure there holds the batch,
    // whatever else the tree held (ADR 0011, amendment of 2026-11-26); an earlier failure it cleared is recorded. A record made
    // before briefs were numbered (no seq) comes before every numbered one.
    const briefs = batch.review.reviewers.flatMap(reviewer => briefsOf(instance, reviewer, batch.runId))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.madeAt > b.madeAt) - (a.madeAt < b.madeAt));
    const failing = brief => (brief?.verification ?? []).filter(run => run.exit !== 0 || run.timedOut).map(({ command, exit, timedOut }) => ({ reviewer: brief.reviewer, attempt: brief.attempt, command, exit, timedOut }));
    // Only a brief that ran every frozen command can clear an earlier failure (no command run proves nothing); a later failure, complete or not, stands.
    const complete = briefs.filter(brief => brief.verification?.length && !brief.dropped?.length);
    const failedAtBrief = briefs.flatMap(failing), holding = complete.length ? briefs.slice(briefs.lastIndexOf(complete.at(-1))).flatMap(failing) : failedAtBrief;
    const named = runs => runs.map(run => `${plain(run.command)} (${run.reviewer}'s brief ${run.attempt}: ${run.timedOut ? 'timed out' : `exit ${run.exit}`})`).join(', '), failures = named(failedAtBrief);
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
    need(hooksOf(product).digest === batch.hooks?.digest, `${HOOKS_MOVED}. ${ABANDON}`);
    // ADR 0011, amendment of 2026-11-26: a failure at a brief is run again once, on the tree as it stands, before it ends the batch.
    // Only a run of every frozen command, each passing, clears it.
    const ran = holding.length ? kept?.rerun ?? runFrozen(instance, batch, run) : null, rerun = ran && { ...ran, failed: ran.failed || ran.dropped.length > 0 };
    const failedAgain = rerun?.commands.filter(entry => entry.exit !== 0 || entry.timedOut).map(entry => `${plain(entry.command)} (${entry.timedOut ? 'timed out' : `exit ${entry.exit}`})`).join(', ');
    need(!rerun?.failed, `A verification command failed when the review was briefed: ${named(holding)}, and again when resolve ran the commands: ${failedAgain || `not every frozen command is still confirmed for the team (${rerun?.dropped.map(plain).join(' | ')})`}. The kit cannot tell which ticket broke the tree, so it commits none. A reviewer can be briefed again, which runs the commands again, only while its verdict is not final (rw-batch.mjs review-brief --reviewer <reviewer> --instance <instance-root>). ${ABANDON}`);

    let journal = { schemaVersion: 1, stage: 'batch-resolving', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, reviewsDigest, lease, pid: process.pid,
      removed: kept?.removed ?? [], verification: kept?.verification ?? null, rerun };
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
        const patch = `${HELD}/${batch.runId}/${commit.ticket}.patch`, bytes = patchOf(product, batch.productHead, commit.paths);
        savePatch(instance, patch, bytes);
        save({ ...journal, removed: [...journal.removed, { ticket: commit.ticket, reason, patch, patchDigest: bytesDigest(bytes), paths: commit.paths }] });
      }
      removeFrom(product, batch.productHead, commit.paths);
    };
    commits.forEach((commit, i) => { if (reasons[i]) hold(commit, reasons[i]); });

    if (first !== -1 && !journal.verification && commits.slice(first + 1).some(commit => !isRemoved(commit.ticket))) {
      const toCommit = commits.filter(commit => !isRemoved(commit.ticket));
      save({ ...journal, verification: { ran: true, ...runFrozen(instance, batch, run), changed: drift(toCommit).sort() } });
    }
    for (const commit of heldAfterVerification(commits, first, journal.verification)) hold(commit, AFTER_REMOVAL);

    const now = readBoundary(instance);
    if (now && stateOf(now) === 'review') closeBoundary({ teamRoot: instance });
    const at = new Date().toISOString(), removed = journal.removed, plan = commits.filter(commit => !isRemoved(commit.ticket));
    // A path changed now that after did not leave and no ticket to commit holds was written since after: by a command, at a
    // brief or here, or by hand. commit leaves it uncommitted and names it.
    const seen = new Set([...after.left, ...plan.flatMap(commit => commit.paths)]);
    const wrote = changedPaths(product).filter(file => !batch.preexisting.includes(file) && !seen.has(file));
    const verification = { ...(journal.verification ?? { ran: false, failed: false, commands: [], dropped: [], changed: [] }), wrote };
    const record = sealed({ schemaVersion: 1, stage: 'batch-resolved', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, reviewsDigest, resolvedAt: at,
      removed, verification, failedAtBrief, rerun, commits: plan, left: after.left });
    const again = `${verification.ran ? `; verification run again ${verification.failed ? 'FAILED' : 'passed'}${verification.changed.length ? `, changed ${verification.changed.slice(0, 10).map(plain).join(', ')}` : ''}` : ''}${wrote.length ? `; written since after, left uncommitted: ${wrote.slice(0, 10).map(plain).join(', ')}` : ''}`;
    appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} BATCH ${batch.runId} RESOLVED: ${removed.length ? `held ${removed.map(entry => `${entry.ticket} (${entry.reason})`).join(', ')} as patches under ${HELD}/${batch.runId}/` : 'nothing held'}; ${plan.length} to commit${again}${failures ? `; verification failed when the review was briefed: ${failures}` : ''}${rerun ? '; run again by resolve: passed' : ''}.\n`);
    replace(path, record);
    return record;
  } catch (error) {
    return { errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: error instanceof Refusal ? error.message : `The batch could not be resolved: ${error?.code ?? error?.message}` }] };
  } finally { if (lease) releaseLease({ productRoot: product, lease }); }
}
