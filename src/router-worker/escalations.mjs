import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { overlap, plain } from './batch.mjs';
import { byPerson, AT_TERMINAL } from './switch.mjs';
import { resumedFrom } from './earlier-runs.mjs';

// ADR 0011, decisions 16 and 17, with the owner's rule of 2026-11-20: a ticket rejected, or whose review was not
// obtained, in a second batch goes to the owner; one of each counts too. It is blocked, and so is every ticket related to it;
// the rest of the plan goes on. The owner lifts a block at an interactive terminal.
export const TICKETS = 'reviews/tickets.jsonl', ESCALATIONS = 'reviews/escalations.jsonl', ACKNOWLEDGED = 'reviews/acknowledged.jsonl';
const LEDGER = 'pm-decisions.md', KIND = { rejected: 'second-rejection', 'not-obtained': 'review-not-obtained-again' }, MIXED = 'repeated-adverse';
const SAID = { [KIND.rejected]: 'was rejected', [KIND['not-obtained']]: 'could not be reviewed', [MIXED]: 'was rejected or could not be reviewed' };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// A line that is not JSON is skipped: these files only grow, and one broken line must not hide the others.
const linesOf = path => { let text; try { text = readFileSync(path, 'utf8'); } catch { return []; } return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); };
const append = (path, rows) => { if (rows.length) appendFileSync(path, rows.map(row => JSON.stringify(row) + '\n').join('')); };

// Appends a reviewer's final outcome for each ticket of a run, with the saved work it resumed, and returns the escalations it
// raised. A line already there is not written again, so a judgment that died half-way is judged again without counting twice.
// `outcomes`: [{ ticket, outcome: 'rejected'|'not-obtained', finding }]; `tickets`: [{ id, paths, resume }], the paths each
// changed and the resume its batch record froze.
export function recordOutcomes({ instance, runId, reviewer, outcomes, tickets, at }) {
  mkdirSync(join(instance, 'reviews'), { recursive: true });
  const seen = linesOf(join(instance, TICKETS)), entryOf = ticket => tickets.find(entry => same(entry.id, ticket));
  const fresh = outcomes.filter(entry => !seen.some(line => same(line.ticket, entry.ticket) && line.runId === runId && line.reviewer === reviewer))
    .map(({ ticket, outcome, finding }) => { const from = resumedFrom(instance, entryOf(ticket)?.resume); return { ticket, runId, reviewer, outcome, finding, ...(from ? { resumedFrom: from } : {}), at }; });
  append(join(instance, TICKETS), fresh);
  const all = [...seen, ...fresh], known = linesOf(join(instance, ESCALATIONS)), raised = [];
  for (const { ticket } of outcomes) {
    // A ticket's lines are those under its id and under every id whose saved work it resumed, followed down the chain.
    const ids = [ticket];
    for (let i = 0; i < ids.length; i++) for (const line of all) {
      const from = line.resumedFrom?.ticket;
      if (same(line.ticket, ids[i]) && typeof from === 'string' && !ids.some(id => same(id, from))) ids.push(from);
    }
    // A second time is a second batch: two reviewers rejecting the same ticket in one batch is one rejection.
    const adverse = all.filter(line => ids.some(id => same(line.ticket, id))), runIds = [...new Set(adverse.map(line => line.runId))], kinds = new Set(adverse.map(line => line.outcome));
    const id = `ESC-${ticket}-${runId}`;
    if (runIds.length < 2 || [...known, ...raised].some(entry => same(entry.id, id))) continue;
    raised.push({ id, kind: kinds.size > 1 ? MIXED : KIND[[...kinds][0]], ticket, reviewer, runIds, paths: entryOf(ticket)?.paths ?? [],
      findings: adverse.map(line => ({ ticket: line.ticket, runId: line.runId, reviewer: line.reviewer, outcome: line.outcome, finding: line.finding })), at });
  }
  append(join(instance, ESCALATIONS), raised);
  const before = entry => [...new Set(entry.findings.map(item => item.ticket).filter(other => !same(other, entry.ticket)).map(other => plain(String(other))))];
  if (raised.length) appendFileSync(join(instance, LEDGER), raised.map(entry => `${at.slice(0, 10)} ESCALATED ${entry.id}: ticket ${entry.ticket}${before(entry).length ? ` (resuming the work of ${before(entry).join(', ')})` : ''} ${SAID[entry.kind]} in batches ${entry.runIds.join(' and ')}; it and every ticket related to it are blocked until the owner reviews it and runs: team-mode.mjs acknowledge ${entry.id} --instance <instance-root>. Unrelated tickets are replanned and go on.\n`).join(''));
  return raised;
}

export const outcomesOf = (instance, runId) => linesOf(join(instance, TICKETS)).filter(line => line.runId === runId);
export const escalationsOf = (instance, runId) => linesOf(join(instance, ESCALATIONS)).filter(entry => entry.runIds?.includes(runId));
// Only a line written at a terminal for the escalation as it stands lifts it; the kit cannot tell such a line from a forged one.
const liftedIn = instance => {
  const acks = linesOf(join(instance, ACKNOWLEDGED)).filter(ack => ack.atTerminal === true);
  return entry => acks.some(ack => same(ack.id, entry.id) && ack.escalationDigest === digest(entry));
};
const openEscalations = instance => { const lifted = liftedIn(instance); return linesOf(join(instance, ESCALATIONS)).filter(entry => !lifted(entry)); };

// decisions/0008: a ticket runs at most three times, the initial run and two retries.
const MAX_FAILED_RUNS = 3;
const EXHAUSTED = 'attempts-exhausted';
// ADR 0010, amendment of 2026-11-27: a ticket whose failed runs reach the cap goes to the owner. The escalation is told by
// the latest failed run and the ticket's id in it, so a new id that resumes that run's patch meets the same one. It names no
// paths: a ticket that only shares a file is not blocked. The owner's acknowledgement lets the ticket run again; its next
// failed run escalates it again. `failed`: the ticket's failed runs, oldest first. Returns the open escalation, written once, or null.
export function exhaustion({ instance, failed, at }) {
  const last = failed.at(-1), runIds = failed.map(run => run.runId);
  if (runIds.length < MAX_FAILED_RUNS) return null;
  const known = linesOf(join(instance, ESCALATIONS)), id = `ESC-${last.ticket}-exhausted-${last.runId}`, raised = known.find(entry => same(entry.id, id));
  if (raised) return liftedIn(instance)(raised) ? null : raised;
  const entry = { id, kind: EXHAUSTED, ticket: last.ticket, runIds, paths: [], at };
  mkdirSync(join(instance, 'reviews'), { recursive: true });
  append(join(instance, ESCALATIONS), [entry]);
  appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} ESCALATED ${id}: ticket ${entry.ticket} failed in ${runIds.length} runs by the engine (${runIds.join(', ')}): the initial run and two retries are spent; it, a ticket that resumes its saved work and every ticket that depends on it are blocked until the owner reviews it and runs: team-mode.mjs acknowledge ${id} --instance <instance-root>. Then it may be filed again with a replan, and a further failed run escalates it again. Other tickets go on.\n`);
  return entry;
}

// The tickets of a batch an open escalation blocks: the escalated ticket itself, a ticket whose paths overlap its
// paths, and a ticket that depends on a blocked one, directly or through others, here or in an archived batch.
export function blockedTickets({ instance, tickets, archived }) {
  const open = openEscalations(instance), blocked = new Map();
  for (const entry of open) blocked.set(entry.ticket.toLowerCase(), entry);
  for (const ticket of tickets) {
    const entry = open.find(item => ticket.paths.some(path => item.paths.some(other => overlap(path, other))));
    if (entry && !blocked.has(ticket.id.toLowerCase())) blocked.set(ticket.id.toLowerCase(), entry);
  }
  const graph = [...archived, ...tickets];
  for (let grew = true; grew;) {
    grew = false;
    for (const ticket of graph) {
      const on = (ticket.dependsOn ?? []).find(id => blocked.has(String(id).toLowerCase()));
      if (on && !blocked.has(ticket.id.toLowerCase())) { blocked.set(ticket.id.toLowerCase(), blocked.get(String(on).toLowerCase())); grew = true; }
    }
  }
  return tickets.filter(ticket => blocked.has(ticket.id.toLowerCase())).map(ticket => ({ ticket: ticket.id, escalation: blocked.get(ticket.id.toLowerCase()).id }));
}

class Refusal extends Error {}
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const refuse = error => ({ errors: [{ code: 'ACKNOWLEDGE_REFUSED', field: 'escalation', reason: error instanceof Refusal ? error.message : `The escalation could not be acknowledged: ${error?.code ?? error?.message}` }] });
function proposal({ teamRoot, instanceRoot, id }) {
  let instance;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
  need(instance, 'An instance root is required');
  const escalation = openEscalations(instance).find(entry => same(entry.id, id));
  need(escalation, `No open escalation is named ${plain(id)}; the open ones are in ${ESCALATIONS}, less those in ${ACKNOWLEDGED}`);
  const body = { schemaVersion: 1, stage: 'escalation-acknowledgement', escalation, escalationDigest: digest(escalation) };
  return { instance, body: { ...body, digest: digest(body) } };
}
export function proposeAcknowledge(options) { try { return proposal(options).body; } catch (error) { return refuse(error); } }

// The owner has read the escalation: its ticket and the tickets related to it may be planned again.
export function acknowledgeEscalation({ confirm, atTerminal, ...options }) {
  try {
    const { instance, body } = proposal(options);
    need(confirm === body.digest, 'The code does not confirm this escalation; nothing was changed');
    need(byPerson(atTerminal), 'An escalation is lifted only when the owner types its code at an interactive terminal, with: node kit/scripts/team-mode.mjs acknowledge; nothing was changed');
    const at = new Date().toISOString(), line = { id: body.escalation.id, escalationDigest: body.escalationDigest, acknowledgedAt: at, atTerminal: true };
    append(join(instance, ACKNOWLEDGED), [line]);
    appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} ESCALATION ${body.escalation.id} ACKNOWLEDGED: ticket ${body.escalation.ticket} may be planned again; confirmed ${AT_TERMINAL}.\n`);
    return { ...line, stage: 'escalation-acknowledged', digest: digest(line) };
  } catch (error) { return refuse(error); }
}
