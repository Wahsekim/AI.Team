import { readFileSync, appendFileSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { instanceOf } from './roots.mjs';
import { git, acquireLease, releaseLease } from './lease.mjs';
import { readBoundary, stateOf } from './write-boundary.mjs';
import { BATCH_FILE, AFTER_FILE, ARCHIVE, RUN_ID, TICKET_ID, plain } from './batch.mjs';
import { Refusal, intact, LEFT_COMMAND } from './batch-close.mjs';
import { setAside, heldAt, savedWhole, productState, attributable, resolving, BY_HAND } from './review-resolve.mjs';
import { resumePlan } from './batch-resume.mjs';
import { committedIn } from './earlier-runs.mjs';

// ADR 0010, amendment of 2026-11-26: the work an archived batch left in the product work tree is saved as one patch per
// ticket in the team folder and taken out of the tree, so that it comes back only as the resume of a later ticket. A patch
// carries the run id in its path (left/<run id>/<ticket>.patch): a ticket's work from two runs never shares one file.
export const LEFT = 'left';
const MODE_FILE = 'profiles/team-mode.json', JOURNAL = 'holiday/.switch-in-progress.json', LEDGER = 'pm-decisions.md';
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export const leftAt = (runId, ticket) => `${LEFT}/${runId}/${ticket}.patch`;
const listed = paths => `${paths.slice(0, 10).map(plain).join(', ')}${paths.length > 10 ? ', ...' : ''}`;

// The value a ticket of the next batch names as its `resume` for this patch, or why "before" would refuse it as it stands.
export function resumeOf({ instance, productRoot, ticket, patch }) {
  let checked; try { checked = resumePlan({ instance, productRoot, ticket: { id: ticket.id, resume: patch, paths: ticket.paths } }); } catch (error) { checked = { problem: plain(error?.message ?? error) }; }
  return checked.plan ? { resume: patch } : { resume: null, resumeProblem: checked.problem };
}
const kept = entry => `${entry.ticket} (${entry.problem}; ${entry.patch ? savedWhole(entry.patch) : 'nothing of it was removed: run left again once that is fixed'})`;
// What the PM does with each ticket's work that was set aside or could not be: the sentences after and left both print.
export const patchAdvice = entries => {
  const ready = entries.filter(entry => entry.resume), refused = entries.filter(entry => entry.state === 'patch' && !entry.resume), stuck = entries.filter(entry => entry.state === 'in-tree');
  return { ready: ready.length ? `Name each patch as the "resume" of a ticket of the next batch whose paths cover what it changes: ${ready.map(entry => `${entry.ticket} "resume": "${entry.resume}"`).join(', ')}` : '',
    refused: refused.length ? `before would refuse as a resume, as it stands, ${refused.map(entry => `${entry.ticket} (${entry.patch}: ${entry.resumeProblem})`).join(', ')}: make the patch again from its edits and new files, and declare the ticket's moves and deletes; the saved patch keeps all of the work` : '',
    stuck: stuck.length ? `LEFT IN THE WORK TREE: ${stuck.map(kept).join(', ')}. A ticket's work is never committed by hand` : '' };
};

// Each archived batch with its batch record as read, null when it cannot be read.
function archivesOf(instance) {
  let ids = []; try { ids = readdirSync(join(instance, ARCHIVE), { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name); } catch { /* none archived */ }
  return ids.map(id => ({ id, batch: readJSON(join(instance, ARCHIVE, id, 'batch.json')) }));
}

// The archived batch named, or the newest by its opening.
function archivedBatch(all, runId) {
  if (runId !== undefined) {
    const named = all.find(entry => entry.id === runId);
    need(typeof runId === 'string' && RUN_ID.test(runId) && named, `No batch ${plain(String(runId))} is archived in ${ARCHIVE}/`);
    return named;
  }
  const unread = all.filter(({ batch }) => typeof batch?.openedAt !== 'string');
  need(!unread.length, `The batch record of ${plain(unread[0]?.id)} cannot be read, so which batch is the newest is not known; name the batch with --run <run id>`);
  const newest = [...all].sort((a, b) => a.batch.openedAt.localeCompare(b.batch.openedAt) || a.id.localeCompare(b.id)).at(-1);
  need(newest, `No batch is archived in ${ARCHIVE}/`);
  return newest;
}

// What the tickets of the other archived batches left, as left --run would save it there: newest batch first.
function claimsOf(instance, all, id) {
  return all.filter(other => other.id !== id && RUN_ID.test(other.id) && typeof other.batch?.openedAt === 'string').sort((a, b) => b.batch.openedAt.localeCompare(a.batch.openedAt))
    .flatMap(({ id: runId, batch }) => {
      const after = readJSON(join(instance, ARCHIVE, runId, 'after.json')), committed = committedIn(instance, runId);
      return attributable(batch, after) ? after.tickets.filter(entry => TICKET_ID.test(entry?.id ?? '') && !committed.has(entry.id) && Array.isArray(entry.changedPaths))
        .map(entry => ({ runId, ticket: entry.id, paths: entry.changedPaths })) : [];
    });
}

export function saveLeftWork({ teamRoot, instanceRoot, runId }) {
  let lease = null, productRoot;
  try {
    let instance;
    try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
    need(instance, 'An instance root is required');
    const profile = readJSON(join(instance, MODE_FILE)); productRoot = profile?.spec?.project?.productRoot;
    need(profile?.mode === 'router-worker' && profile.status === 'live' && typeof productRoot === 'string', 'The team is not live in Router/Worker mode');
    need(!exists(join(instance, JOURNAL)), 'A mode switch was interrupted; roll it back first with: team-mode.mjs switch recover --instance <instance-root>');
    need(!exists(join(instance, BATCH_FILE)) && !exists(join(instance, AFTER_FILE)), `A batch is open (${BATCH_FILE}): left saves the work of an archived batch. Commit this one, or archive it with: rw-batch.mjs abort --instance <instance-root>, then run left`);
    const boundary = readBoundary(instance);
    if (boundary) need(stateOf(boundary) === 'closed', `The write boundary is in the ${plain(stateOf(boundary))} state: a batch or a review is not over. Finish it first`);
    const all = archivesOf(instance), { id, batch } = archivedBatch(all, runId), at = name => readJSON(join(instance, ARCHIVE, id, name)), after = at('after.json');
    need(attributable(batch, after), `The records of batch ${plain(id)} are not the ones before and after wrote (${ARCHIVE}/${plain(id)}/batch.json, after.json): ${BY_HAND}. Nothing was taken out`);
    // abort releases the lock of a resolve still running and archives its batch: its removals are not raced.
    const resolution = at('resolution.json');
    need(!resolving(resolution), `A resolve of batch ${plain(id)} is still running (process ${resolution?.pid}): abort archived the batch while it ran. Run left again once that process has ended`);
    const taken = acquireLease({ teamRoot: instance, productRoot });
    need(!taken.errors, `The lock on the product repository could not be taken: ${taken.errors?.[0]?.reason}`);
    lease = taken.lease.digest;
    need(git(productRoot, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() === batch.branch, `The product repository is not on the batch's branch (${plain(batch.branch)})`);
    const { head, changed, problem } = productState(productRoot, taken);
    need(!problem, problem);

    const committed = committedIn(instance, id);
    const removed = resolution?.removed, resolved = new Set((Array.isArray(removed) ? removed : []).map(entry => entry?.ticket)), abandoned = at('abandoned.json');
    const byAfter = new Map((Array.isArray(after.setAside) ? after.setAside : []).filter(entry => entry?.state === 'patch').map(entry => [entry.ticket, entry.patch]));
    // abort saved these and could not take all of them out: each patch already holds the whole of its ticket's work.
    const partial = new Map((intact(abandoned, 'batch-archived-without-commit') && Array.isArray(abandoned.held) ? abandoned.held : [])
      .filter(entry => entry?.state === 'in-tree' && typeof entry.patch === 'string' && entry.patch === heldAt(entry.patch.split('/')[2], entry.ticket) && exists(join(instance, entry.patch))).map(entry => [entry.ticket, entry.patch]));
    const tickets = batch.tickets.filter(ticket => TICKET_ID.test(ticket?.id ?? '') && !committed.has(ticket.id))
      .map(ticket => ({ ticket, recorded: after.tickets.find(entry => entry?.id === ticket.id)?.changedPaths ?? [] }));
    const outside = changed.filter(path => !tickets.some(({ recorded }) => recorded.includes(path)));
    // A path no ticket of this batch changed may be what a ticket of another archived batch left.
    const claims = outside.length ? claimsOf(instance, all, id) : [], claimOf = path => claims.find(entry => entry.paths.includes(path));
    const claimed = outside.flatMap(path => { const claim = claimOf(path); return claim ? [{ path, runId: claim.runId, ticket: claim.ticket }] : []; }), unclaimed = outside.filter(path => !claimOf(path));
    const done = tickets.map(({ ticket, recorded }) => {
      const whole = partial.get(ticket.id), inTree = changed.some(path => recorded.includes(path)), found = whole ? [whole] : [heldAt(after.runId, ticket.id), heldAt(id, ticket.id), leftAt(id, ticket.id)];
      const out = whole ? setAside({ instance, productRoot, head, changed, recorded, problem: 'abort saved this ticket\'s patch and could not take all of it out of the work tree', patch: whole, found })
        : setAside({ instance, productRoot, head, changed, recorded, patch: leftAt(id, ticket.id), found });
      if (out.state === 'not-in-tree') return null;
      if (out.state === 'in-tree') return { entry: { ticket: ticket.id, ...out, ...(whole ? { patch: whole } : {}) }, now: false };
      const by = out.patch === byAfter.get(ticket.id) ? 'after' : out.patch.startsWith(`${LEFT}/`) ? 'left' : resolved.has(ticket.id) ? 'resolve' : 'abort', also = [...new Set(found)].filter(path => path && path !== out.patch && exists(join(instance, path)));
      return { entry: { ticket: ticket.id, state: 'patch', patch: out.patch, by, ...(also.length ? { also } : {}), ...resumeOf({ instance, productRoot, ticket, patch: out.patch }) }, now: inTree };
    }).filter(Boolean);

    const entries = done.map(({ entry }) => entry), now = done.filter(({ now: saved }) => saved).map(({ entry }) => entry), stuck = entries.filter(entry => entry.state === 'in-tree');
    const advice = patchAdvice(entries);
    const next = [advice.ready, advice.refused,
      entries.some(entry => entry.also) ? `These tickets also have a patch written before the one named: ${entries.filter(entry => entry.also).map(entry => `${entry.ticket} (${entry.also.join(', ')})`).join(', ')}` : '',
      advice.stuck,
      claimed.length ? `These changed paths are work a ticket of another archived batch left, and were left as they are: ${claimed.slice(0, 10).map(entry => `${plain(entry.path)} (${entry.ticket} of batch ${entry.runId})`).join(', ')}${claimed.length > 10 ? ', ...' : ''}; save it with: ${[...new Set(claimed.map(entry => entry.runId))].map(run => `${LEFT_COMMAND} --run ${run}`).join(', then ')}` : '',
      unclaimed.length ? `These changed paths are no ticket's work and were left as they are: ${listed(unclaimed)}; commit or discard them by hand, or start the next batch as is` : ''].filter(Boolean);
    const savedAt = new Date().toISOString();
    if (now.length || stuck.length) appendFileSync(join(instance, LEDGER), `${savedAt.slice(0, 10)} BATCH ${id} LEFT WORK SAVED by rw-batch.mjs left: ${now.length ? now.map(entry => `${entry.ticket} ${entry.patch}`).join(', ') : 'nothing saved'}${stuck.length ? `; LEFT IN THE WORK TREE: ${stuck.map(kept).join(', ')}` : ''}${unclaimed.length ? `; ${unclaimed.length} path(s) of no ticket left as they are (${listed(unclaimed)})` : ''}${claimed.length ? `; ${claimed.length} path(s) of tickets of other batches left as they are (${listed(claimed.map(entry => entry.path))})` : ''}.\n`);
    return { schemaVersion: 1, stage: 'left-work-saved', runId: id, savedAt, tickets: entries, outside: unclaimed, claimed, next: next.length ? `${next.join('. ')}.` : 'This batch left no work in the product work tree.' };
  } catch (error) {
    return { errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: error instanceof Refusal ? error.message : `The left work could not be saved: ${error?.code ?? error?.message}` }] };
  } finally { if (lease) releaseLease({ productRoot, lease }); }
}
