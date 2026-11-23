import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { overlap, plain } from './batch.mjs';
import { byPerson, AT_TERMINAL } from './switch.mjs';

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

// Appends a reviewer's final outcome for each ticket of a run and returns the escalations it raised. A line already
// there is not written again, so a judgment that died half-way is judged again without counting twice.
// `outcomes`: [{ ticket, outcome: 'rejected'|'not-obtained', finding }]; `tickets`: the batch's frozen tickets.
export function recordOutcomes({ instance, runId, reviewer, outcomes, tickets, at }) {
  mkdirSync(join(instance, 'reviews'), { recursive: true });
  const seen = linesOf(join(instance, TICKETS));
  const fresh = outcomes.filter(entry => !seen.some(line => same(line.ticket, entry.ticket) && line.runId === runId && line.reviewer === reviewer))
    .map(({ ticket, outcome, finding }) => ({ ticket, runId, reviewer, outcome, finding, at }));
  append(join(instance, TICKETS), fresh);
  const all = [...seen, ...fresh], known = linesOf(join(instance, ESCALATIONS)), raised = [];
  for (const { ticket } of outcomes) {
    // A second time is a second batch: two reviewers rejecting the same ticket in one batch is one rejection.
    const adverse = all.filter(line => same(line.ticket, ticket)), runIds = [...new Set(adverse.map(line => line.runId))], kinds = new Set(adverse.map(line => line.outcome));
    const id = `ESC-${ticket}-${runId}`;
    if (runIds.length < 2 || [...known, ...raised].some(entry => same(entry.id, id))) continue;
    raised.push({ id, kind: kinds.size > 1 ? MIXED : KIND[[...kinds][0]], ticket, reviewer, runIds, paths: tickets.find(entry => same(entry.id, ticket))?.paths ?? [],
      findings: all.filter(line => same(line.ticket, ticket)).map(line => ({ runId: line.runId, reviewer: line.reviewer, outcome: line.outcome, finding: line.finding })), at });
  }
  append(join(instance, ESCALATIONS), raised);
  if (raised.length) appendFileSync(join(instance, LEDGER), raised.map(entry => `${at.slice(0, 10)} ESCALATED ${entry.id}: ticket ${entry.ticket} ${SAID[entry.kind]} in batches ${entry.runIds.join(' and ')}; it and every ticket related to it are blocked until the owner reviews it and runs: team-mode.mjs acknowledge ${entry.id} --instance <instance-root>. Unrelated tickets are replanned and go on.\n`).join(''));
  return raised;
}

export const outcomesOf = (instance, runId) => linesOf(join(instance, TICKETS)).filter(line => line.runId === runId);
export const escalationsOf = (instance, runId) => linesOf(join(instance, ESCALATIONS)).filter(entry => entry.runIds?.includes(runId));
// Only a line written at a terminal for the escalation as it stands lifts it; the kit cannot tell such a line from a forged one.
const openEscalations = instance => {
  const lifted = linesOf(join(instance, ACKNOWLEDGED)).filter(ack => ack.atTerminal === true);
  return linesOf(join(instance, ESCALATIONS)).filter(entry => !lifted.some(ack => same(ack.id, entry.id) && ack.escalationDigest === digest(entry)));
};

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
