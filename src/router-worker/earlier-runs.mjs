import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bytesDigest } from '../loop/contracts.mjs';
import { ARCHIVE, RUN_ID, TICKET_ID } from './batch.mjs';
import { HELD } from './review-resolve.mjs';
import { LEFT } from './batch-left.mjs';

// ADR 0010, amendments of 2026-11-26 and 2026-11-27: the earlier runs of a ticket are the archived batches in which the engine
// ran a ticket of the same id, the ticket it names in `continues` or the ticket whose saved patch it resumes, followed through
// every such link the archives froze, and the kit did not commit it, since the kit last committed it. Tickets that only share a
// file are not one piece of work.
const RAN = ['passed', 'not-passed'];
const EARLIER_KEPT = 20;
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// The ids of the tickets the kit committed in an archived batch.
export const committedIn = (instance, id) => new Set([readJSON(join(instance, ARCHIVE, id, 'commit.json'))?.commits, readJSON(join(instance, ARCHIVE, id, 'commits.json'))?.commits]
  .flatMap(list => Array.isArray(list) ? list.map(commit => commit?.ticket) : []));

const origin = (runId, file) => RUN_ID.test(runId) && file.endsWith('.patch') && TICKET_ID.test(file.slice(0, -'.patch'.length)) ? { runId, ticket: file.slice(0, -'.patch'.length) } : null;
// The ticket whose saved patch a `resume` ({ patch, digest }) names: told by the patch's place, reviews/held/<run id>/<ticket>.patch
// or left/<run id>/<ticket>.patch, or by its bytes when a copy of it was resumed from elsewhere in the team folder.
export function resumedFrom(instance, resume) {
  if (typeof resume?.patch !== 'string') return null;
  // Read here, not at load: these modules import each other.
  const saved = [HELD, LEFT];
  for (const folder of saved) {
    const rest = resume.patch.startsWith(`${folder}/`) ? resume.patch.slice(folder.length + 1).split('/') : [], found = rest.length === 2 && origin(...rest);
    if (found) return found;
  }
  const listed = dir => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  for (const folder of saved) for (const run of listed(join(instance, folder)).filter(entry => entry.isDirectory()).map(entry => entry.name).sort())
    for (const name of listed(join(instance, folder, run)).filter(entry => entry.isFile()).map(entry => entry.name).sort()) {
      const found = origin(run, name);
      if (found && bytesDigest(readFileSync(join(instance, folder, run, name))) === resume.digest) return found;
    }
  return null;
}

// `archived`: [{ id, record }], the archives' batch records as before read them. Each archive's after record and commits
// are read once and Git is not called, so the scan stays small however many batches a team archived. For a ticket and the
// resume it applies: `runs`, the newest EARLIER_KEPT, oldest first; `count`, how many there are; `every`, all of them with
// the findings of their batch; `replan`, the one its latest run froze; `stranger`, its `continues` when no archive holds that id.
export function earlierRuns(instance, archived) {
  const filed = archived.flatMap(({ record }) => Array.isArray(record?.tickets) ? record.tickets.filter(entry => typeof entry?.id === 'string') : []);
  const batches = archived.filter(({ id, record }) => RUN_ID.test(id) && typeof record?.openedAt === 'string' && Array.isArray(record.tickets))
    .sort((a, b) => a.record.openedAt.localeCompare(b.record.openedAt) || a.id.localeCompare(b.id))
    .map(({ id, record }) => {
      const after = readJSON(join(instance, ARCHIVE, id, 'after.json')), committed = committedIn(instance, id);
      const findings = (Array.isArray(after?.findings) ? after.findings : []).map(finding => finding?.code).filter(code => typeof code === 'string');
      return { committed: [...committed].filter(ticket => typeof ticket === 'string'), ran: (Array.isArray(after?.tickets) ? after.tickets : []).filter(entry => RAN.includes(entry?.status) && typeof entry.id === 'string' && TICKET_ID.test(entry.id) && !committed.has(entry.id))
        .map(entry => ({ runId: id, ticket: entry.id, status: entry.status, findings, replan: record.tickets.find(ticket => ticket?.id === entry.id)?.replan })) };
    });
  return (ticket, resume) => {
    const ids = [ticket.id], isMine = other => ids.some(id => same(id, other));
    const linked = (entry, patch) => [entry.continues, resumedFrom(instance, patch)?.ticket].filter(id => typeof id === 'string' && TICKET_ID.test(id) && !isMine(id));
    ids.push(...linked(ticket, resume));
    for (let i = 1; i < ids.length; i++) for (const entry of filed.filter(other => same(other.id, ids[i]))) ids.push(...linked(entry, entry.resume));
    // Committed work is done: the id filed again is new work, and the runs before that commit are not its runs.
    const since = batches.findLastIndex(batch => batch.committed.some(isMine));
    const mine = batches.slice(since + 1).flatMap(batch => batch.ran).filter(run => isMine(run.ticket)), plainRun = ({ runId, ticket: id, status }) => ({ runId, ticket: id, status });
    return { runs: mine.slice(-EARLIER_KEPT).map(plainRun), count: mine.length, every: mine.map(({ replan, ...run }) => run), replan: mine.at(-1)?.replan,
      stranger: typeof ticket.continues === 'string' && !filed.some(entry => same(entry.id, ticket.continues)) ? ticket.continues : null };
  };
}
