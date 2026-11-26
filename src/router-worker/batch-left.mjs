import { readFileSync, appendFileSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { instanceOf } from './roots.mjs';
import { git, acquireLease, releaseLease } from './lease.mjs';
import { readBoundary, stateOf } from './write-boundary.mjs';
import { BATCH_FILE, AFTER_FILE, ARCHIVE, RUN_ID, TICKET_ID, plain } from './batch.mjs';
import { Refusal, intact } from './batch-close.mjs';
import { setAside, heldAt, savedWhole, productState } from './review-resolve.mjs';
import { resumePlan } from './batch-resume.mjs';

// ADR 0010, amendment of 2026-11-26: the work an archived batch left in the product work tree is saved as one patch per
// ticket in the team folder and taken out of the tree, so that it comes back only as the resume of a later ticket. A patch
// carries the run id in its path (left/<run id>/<ticket>.patch): a ticket's work from two runs never shares one file.
export const LEFT = 'left';
const MODE_FILE = 'profiles/team-mode.json', JOURNAL = 'holiday/.switch-in-progress.json', LEDGER = 'pm-decisions.md';
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const leftAt = (runId, ticket) => `${LEFT}/${runId}/${ticket}.patch`;
const listed = paths => `${paths.slice(0, 10).map(plain).join(', ')}${paths.length > 10 ? ', ...' : ''}`;

// The archived batch named, or the newest by its opening.
function archivedBatch(instance, runId) {
  const read = id => ({ id, batch: readJSON(join(instance, ARCHIVE, id, 'batch.json')) });
  if (runId !== undefined) {
    need(typeof runId === 'string' && RUN_ID.test(runId) && exists(join(instance, ARCHIVE, runId)), `No batch ${plain(String(runId))} is archived in ${ARCHIVE}/`);
    return read(runId);
  }
  let ids = []; try { ids = readdirSync(join(instance, ARCHIVE), { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name); } catch { /* none archived */ }
  const all = ids.map(read), unread = all.filter(({ batch }) => typeof batch?.openedAt !== 'string');
  need(!unread.length, `The batch record of ${plain(unread[0]?.id)} cannot be read, so which batch is the newest is not known; name the batch with --run <run id>`);
  const newest = all.sort((a, b) => a.batch.openedAt.localeCompare(b.batch.openedAt) || a.id.localeCompare(b.id)).at(-1);
  need(newest, `No batch is archived in ${ARCHIVE}/`);
  return newest;
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
    const { id, batch } = archivedBatch(instance, runId), at = name => readJSON(join(instance, ARCHIVE, id, name)), after = at('after.json');
    need(intact(batch, 'batch-open') && intact(after, 'batch-closed') && after.batchDigest === batch.digest && Array.isArray(batch.tickets) && Array.isArray(after.tickets),
      `The records of batch ${plain(id)} are not the ones before and after wrote (${ARCHIVE}/${plain(id)}/batch.json, after.json): which paths are each ticket's work cannot be told. Nothing was taken out`);
    const taken = acquireLease({ teamRoot: instance, productRoot });
    need(!taken.errors, `The lock on the product repository could not be taken: ${taken.errors?.[0]?.reason}`);
    lease = taken.lease.digest;
    need(git(productRoot, 'symbolic-ref', '--short', '-q', 'HEAD')?.trim() === batch.branch, `The product repository is not on the batch's branch (${plain(batch.branch)})`);
    const { head, changed, problem } = productState(productRoot, taken);
    need(!problem, problem);

    const committed = new Set([at('commit.json')?.commits, at('commits.json')?.commits].flatMap(list => Array.isArray(list) ? list.map(commit => commit?.ticket) : []));
    const removed = at('resolution.json')?.removed, resolved = new Set((Array.isArray(removed) ? removed : []).map(entry => entry?.ticket)), abandoned = at('abandoned.json');
    // abort saved these and could not take all of them out: each patch already holds the whole of its ticket's work.
    const partial = new Map((intact(abandoned, 'batch-archived-without-commit') && Array.isArray(abandoned.held) ? abandoned.held : [])
      .filter(entry => entry?.state === 'in-tree' && typeof entry.patch === 'string' && entry.patch === heldAt(entry.patch.split('/')[2], entry.ticket) && exists(join(instance, entry.patch))).map(entry => [entry.ticket, entry.patch]));
    const tickets = batch.tickets.filter(ticket => TICKET_ID.test(ticket?.id ?? '') && !committed.has(ticket.id))
      .map(ticket => ({ ticket, recorded: after.tickets.find(entry => entry?.id === ticket.id)?.changedPaths ?? [] }));
    const outside = changed.filter(path => !tickets.some(({ recorded }) => recorded.includes(path)));
    const resumeOf = (ticket, patch) => {
      let checked; try { checked = resumePlan({ instance, productRoot, ticket: { id: ticket.id, resume: patch, paths: ticket.paths } }); } catch (error) { checked = { problem: plain(error?.message ?? error) }; }
      return checked.plan ? { resume: patch } : { resume: null, resumeProblem: checked.problem };
    };
    const done = tickets.map(({ ticket, recorded }) => {
      const whole = partial.get(ticket.id), inTree = changed.some(path => recorded.includes(path));
      const out = whole ? setAside({ instance, productRoot, head, changed, recorded, problem: 'abort saved this ticket\'s patch and could not take all of it out of the work tree', patch: whole, found: [whole] })
        : setAside({ instance, productRoot, head, changed, recorded, patch: leftAt(id, ticket.id), found: [heldAt(after.runId, ticket.id), heldAt(id, ticket.id), leftAt(id, ticket.id)] });
      if (out.state === 'not-in-tree') return null;
      if (out.state === 'in-tree') return { entry: { ticket: ticket.id, ...out, ...(whole ? { patch: whole } : {}) }, now: false };
      const by = out.patch.startsWith(`${LEFT}/`) ? 'left' : resolved.has(ticket.id) ? 'resolve' : 'abort';
      return { entry: { ticket: ticket.id, state: 'patch', patch: out.patch, by, ...resumeOf(ticket, out.patch) }, now: inTree };
    }).filter(Boolean);

    const entries = done.map(({ entry }) => entry), now = done.filter(({ now: saved }) => saved).map(({ entry }) => entry);
    const ready = entries.filter(entry => entry.resume), refused = entries.filter(entry => entry.state === 'patch' && !entry.resume), stuck = entries.filter(entry => entry.state === 'in-tree');
    const kept = entry => `${entry.ticket} (${entry.problem}; ${entry.patch ? savedWhole(entry.patch) : 'nothing of it was removed: run left again once that is fixed'})`;
    const next = [ready.length ? `Name each patch as the "resume" of a ticket of the next batch whose paths cover what it changes: ${ready.map(entry => `${entry.ticket} "resume": "${entry.resume}"`).join(', ')}` : '',
      refused.length ? `before would refuse as a resume, as it stands, ${refused.map(entry => `${entry.ticket} (${entry.patch}: ${entry.resumeProblem})`).join(', ')}: make the patch again from its edits and new files, and declare the ticket's moves and deletes; the saved patch keeps all of the work` : '',
      stuck.length ? `LEFT IN THE WORK TREE: ${stuck.map(kept).join(', ')}. A ticket's work is never committed by hand` : '',
      outside.length ? `These changed paths are no ticket's work and were left as they are: ${listed(outside)}; commit or discard them by hand, or start the next batch as is` : ''].filter(Boolean);
    const savedAt = new Date().toISOString();
    if (now.length || stuck.length) appendFileSync(join(instance, LEDGER), `${savedAt.slice(0, 10)} BATCH ${id} LEFT WORK SAVED by rw-batch.mjs left: ${now.length ? now.map(entry => `${entry.ticket} ${entry.patch}`).join(', ') : 'nothing saved'}${stuck.length ? `; LEFT IN THE WORK TREE: ${stuck.map(kept).join(', ')}` : ''}${outside.length ? `; ${outside.length} path(s) of no ticket left as they are (${listed(outside)})` : ''}.\n`);
    return { schemaVersion: 1, stage: 'left-work-saved', runId: id, savedAt, tickets: entries, outside, next: next.length ? `${next.join('. ')}.` : 'This batch left no work in the product work tree.' };
  } catch (error) {
    return { errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: error instanceof Refusal ? error.message : `The left work could not be saved: ${error?.code ?? error?.message}` }] };
  } finally { if (lease) releaseLease({ productRoot, lease }); }
}
