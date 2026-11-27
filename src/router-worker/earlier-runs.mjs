import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bytesDigest } from '../loop/contracts.mjs';
import { ARCHIVE, RUN_ID, TICKET_ID } from './batch.mjs';
import { HELD } from './review-resolve.mjs';
import { LEFT } from './batch-left.mjs';

// ADR 0010, amendments of 2026-11-26 and 2026-11-27: the earlier runs of a ticket are the archived batches in which the engine
// ran a ticket of the same id, or the ticket whose saved patch it resumes, followed through a chain of resumes, and the kit did
// not commit it. Tickets that only share a file are not one piece of work.
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
// resume it applies: `runs`, the newest EARLIER_KEPT, oldest first; `count`, how many there are; `failed`, every run it did
// not pass, oldest first; `replan`, the one its latest run froze.
export function earlierRuns(instance, archived) {
  const records = new Map(archived.map(({ id, record }) => [id, record]));
  const runs = archived.filter(({ id, record }) => RUN_ID.test(id) && typeof record?.openedAt === 'string' && Array.isArray(record.tickets))
    .sort((a, b) => a.record.openedAt.localeCompare(b.record.openedAt) || a.id.localeCompare(b.id))
    .flatMap(({ id, record }) => {
      const after = readJSON(join(instance, ARCHIVE, id, 'after.json')), committed = committedIn(instance, id);
      return (Array.isArray(after?.tickets) ? after.tickets : []).filter(entry => RAN.includes(entry?.status) && typeof entry.id === 'string' && TICKET_ID.test(entry.id) && !committed.has(entry.id))
        .map(entry => ({ runId: id, ticket: entry.id, status: entry.status, replan: record.tickets.find(ticket => ticket?.id === entry.id)?.replan }));
    });
  return (ticket, resume) => {
    const ids = [ticket.id];
    let from = resumedFrom(instance, resume);
    while (from && !ids.some(id => same(id, from.ticket))) {
      ids.push(from.ticket);
      from = resumedFrom(instance, records.get(from.runId)?.tickets?.find(entry => entry?.id === from.ticket)?.resume);
    }
    const mine = runs.filter(run => ids.some(id => same(id, run.ticket))), plainRun = ({ runId, ticket: id, status }) => ({ runId, ticket: id, status });
    return { runs: mine.slice(-EARLIER_KEPT).map(plainRun), count: mine.length, failed: mine.filter(run => run.status !== 'passed').map(plainRun), replan: mine.at(-1)?.replan };
  };
}
