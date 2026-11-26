import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE, RUN_ID, TICKET_ID, overlap } from './batch.mjs';

// ADR 0010, amendment of 2026-11-26: the earlier runs of a ticket are the archived batches in which the engine ran a
// ticket of the same id, or one whose paths overlap its paths, and the kit did not commit it. They are counted for the
// owner; nothing is refused on them.
const RAN = ['passed', 'not-passed'];
const EARLIER_KEPT = 20;
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
// The ids of the tickets the kit committed in an archived batch.
export const committedIn = (instance, id) => new Set([readJSON(join(instance, ARCHIVE, id, 'commit.json'))?.commits, readJSON(join(instance, ARCHIVE, id, 'commits.json'))?.commits]
  .flatMap(list => Array.isArray(list) ? list.map(commit => commit?.ticket) : []));

// `archived`: [{ id, record }], the archives' batch records as before read them. Each archive's after record and commits
// are read once and Git is not called, so the scan stays small however many batches a team archived. A ticket's `runs`
// are the newest EARLIER_KEPT, oldest first, and `count` is how many there are.
export function earlierRuns(instance, archived) {
  const runs = archived.filter(({ id, record }) => RUN_ID.test(id) && typeof record?.openedAt === 'string' && Array.isArray(record.tickets))
    .sort((a, b) => a.record.openedAt.localeCompare(b.record.openedAt) || a.id.localeCompare(b.id))
    .flatMap(({ id, record }) => {
      const after = readJSON(join(instance, ARCHIVE, id, 'after.json')), committed = committedIn(instance, id);
      return (Array.isArray(after?.tickets) ? after.tickets : []).filter(entry => RAN.includes(entry?.status) && typeof entry.id === 'string' && TICKET_ID.test(entry.id) && !committed.has(entry.id))
        .map(entry => ({ runId: id, ticket: entry.id, status: entry.status, paths: record.tickets.find(ticket => ticket?.id === entry.id)?.paths }))
        .filter(run => Array.isArray(run.paths) && run.paths.every(path => typeof path === 'string'));
    });
  return ticket => {
    const mine = runs.filter(run => run.ticket.toLowerCase() === ticket.id.toLowerCase() || run.paths.some(path => ticket.paths.some(other => overlap(path, other))));
    return { runs: mine.slice(-EARLIER_KEPT).map(({ runId, ticket: id, status }) => ({ runId, ticket: id, status })), count: mine.length };
  };
}
