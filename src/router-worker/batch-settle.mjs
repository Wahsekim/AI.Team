import { readFileSync, writeFileSync, appendFileSync, lstatSync, linkSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { settleEngineRun, Refusal as SettlementRefusal } from './launch-settle.mjs';
import { readBoundary, stateOf } from './write-boundary.mjs';
import { BATCH_FILE, AFTER_FILE, RETURN_FILE, SETTLE_FILE, VERDICTS_FILE, ARCHIVE, RUN_ID, oneLine, plain, proposedTokens } from './batch.mjs';

// ADR 0010, decision 12: usage settled per ticket. The agents the runtime metered are matched to the calls
// of the batch, each call's transcript is checked for its frozen brief, and each ticket's measured usage is
// set against its authorization. It judges cost, not work: a batch over its authorization is reported, and
// its commits are not undone.
const LEDGER = 'pm-decisions.md';
class Refusal extends Error {}
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const intact = (value, stage) => { if (!value || typeof value !== 'object') return false; const { digest: recorded, ...body } = value; return recorded === digest(body) && value.stage === stage; };

// The batch to settle: the one that after closed and commit has not archived yet, or an archived one by its id.
// A batch whose archive exists is settled there: what is still in the root is a clearing that did not finish.
const ARCHIVED = { batch: 'batch.json', after: 'after.json', result: 'return.json', settlement: 'settlement.json', reviews: 'reviews.json' };
function recordsOf(instance, runId) {
  // The folder's own name, letter for letter: a file system that ignores case does not make two ids one.
  let folders; try { folders = readdirSync(join(instance, ARCHIVE)); } catch { folders = []; }
  const known = id => typeof id === 'string' && RUN_ID.test(id) && folders.includes(id), archived = id => ({ names: ARCHIVED, folder: join(instance, ARCHIVE, id), id });
  if (runId !== undefined) { need(known(runId), 'No archived batch of that id'); return archived(runId); }
  need(exists(join(instance, AFTER_FILE)), 'No closed batch is waiting in this team; name an archived one with --run <run id>');
  const id = readJSON(join(instance, AFTER_FILE))?.runId;
  return known(id) ? archived(id) : { names: { batch: BATCH_FILE, after: AFTER_FILE, result: RETURN_FILE, settlement: SETTLE_FILE, reviews: VERDICTS_FILE }, folder: instance, id: typeof id === 'string' && RUN_ID.test(id) ? id : null };
}
const instanceRootOf = (teamRoot, instanceRoot) => {
  let instance;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
  need(instance, 'An instance root is required');
  return instance;
};
// Whole or not at all, and never over an earlier record. A commit or an abort that archived the batch while it
// was being settled did not take the record: it follows the batch.
function keep({ instance, folder, target, record, runId }) {
  const place = (draft, to) => { try { linkSync(draft, to); return true; } catch (error) { if (error?.code === 'EEXIST') return false; throw error; } finally { rmSync(draft, { force: true }); } };
  const draft = `${target}.${process.pid}.tmp`;
  writeFileSync(draft, JSON.stringify(record, null, 2) + '\n');
  need(place(draft, target), 'This batch was already settled');
  const home = join(instance, ARCHIVE, runId);
  if (folder === instance && exists(home)) place(target, join(home, 'settlement.json'));
}
// ADR 0011, decision 23: each judged reviewer call is set against the authorization frozen with the batch. Its meter row
// is the main-session agent of the reviewer's wrapper whose transcript is the one the verdict was judged from.
function reviewCalls({ batch, after, kept, meter }) {
  const flagged = Object.keys(after.reviews ?? {}).length > 0;
  need(!flagged || kept, `The batch was reviewed, and its verdicts (${VERDICTS_FILE}) are missing; it cannot be settled`);
  const verdicts = kept?.entries ?? [];
  need(!kept || (kept.runId === batch.runId && Array.isArray(verdicts) && verdicts.every(entry => intact(entry, 'review-verdict') && entry.runId === batch.runId)), `${VERDICTS_FILE} was changed, or belongs to another batch`);
  const judged = verdicts.filter(entry => entry.transcript);
  if (!judged.length) return { reviews: [], findings: [] };
  const authorizedTokens = batch.limits?.authorizationPerReviewerCall;
  need(Number.isSafeInteger(authorizedTokens), 'The batch record carries no authorization per reviewer call');
  const real = file => { try { return realpathSync(file); } catch { return null; } };
  const rows = (Array.isArray(meter?.subagents) ? meter.subagents : []).filter(row => !row?.workflowRunId && typeof row.file === 'string' && Number.isSafeInteger(row.harnessEq));
  // A resumed reviewer keeps one transcript across attempts: its row is the whole of that agent's usage, counted once, on the last attempt.
  const lastOf = file => judged.findLastIndex(entry => entry.transcript.file === file);
  const findings = [], reviews = judged.map(({ reviewer, attempt, transcript }, index) => {
    if (lastOf(transcript.file) !== index) return { reviewer, attempt, transcript: transcript.file, spentTokens: null, countedWith: judged[lastOf(transcript.file)].attempt, authorizedTokens, overrun: null };
    const row = rows.find(candidate => candidate.agentType === batch.reviewWrappers?.[reviewer] && real(candidate.file) === transcript.file);
    if (!row) findings.push({ code: 'REVIEW_NOT_METERED', reviewer, attempt, transcript: transcript.file });
    return { reviewer, attempt, transcript: transcript.file, spentTokens: row?.harnessEq ?? null, authorizedTokens, overrun: row ? row.harnessEq > authorizedTokens : null };
  });
  return { reviews, findings };
}
const refused = error => ({ errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason: error instanceof Refusal || error instanceof SettlementRefusal ? error.message : `Settlement failed: ${error?.code ?? 'the return, the meter or a transcript could not be read'}` }] });

export function settleBatch({ teamRoot, instanceRoot, meter, rules, runId }) {
  try {
    const instance = instanceRootOf(teamRoot, instanceRoot), { names, folder } = recordsOf(instance, runId), at = name => join(folder, names[name]);
    const batch = readJSON(at('batch')), after = readJSON(at('after')), result = readJSON(at('result'));
    need(intact(batch, 'batch-open') && intact(after, 'batch-closed') && after.batchDigest === batch.digest, 'The batch has not been closed by after, or its records were changed');
    // The run id reaches the ledger and a path: it is checked again here, whatever the digests say. It is the id
    // the engine was given, the id the batch was closed under and the name of its archive.
    need(typeof batch.runId === 'string' && RUN_ID.test(batch.runId) && batch.args?.runId === batch.runId && after.runId === batch.runId && (folder === instance || folder === join(instance, ARCHIVE, batch.runId)),
      'The batch record does not hold the plain run id it was run, closed and archived under');
    need(result && digest(result) === after.returnDigest, 'The engine return kept for this batch is missing or was changed; it cannot be settled');
    need(!exists(at('settlement')), 'This batch was already settled');
    const boundary = folder === instance ? readBoundary(instance) : null;
    need(!(boundary && stateOf(boundary) === 'review' && !boundary.periodic), 'A batch of this team is in review; it is settled once its review is over: rw-batch.mjs resolve --instance <instance-root>');
    need(batch.runRecord.items.every(item => Number.isSafeInteger(item.authorizedTokens)), 'The batch record carries no ticket authorizations');
    // What the run left, named for the settlement: the commit it started from and every path it changed.
    const changedPaths = [...new Set([...after.tickets.flatMap(ticket => ticket.changedPaths), ...after.left])].sort();
    const settled = settleEngineRun({ launch: { digest: batch.digest, productHead: batch.productHead, args: batch.args, runRecord: batch.runRecord },
      close: { digest: after.digest, account: after.account, productHead: batch.productHead, changedPaths }, result, meter, rules });
    const tickets = settled.ticketRecords.map(({ settlement }) => ({ ticket: settlement.ticketId, authorizedTokens: settlement.authorizedTokens, spentTokens: settlement.spentTokens, remainingTokens: settlement.remainingTokens, budgetGate: settlement.budgetGate }));
    // Reported for the owner, who decides: tickets over, or above 80% of, their authorization.
    const near = tickets.filter(entry => 5 * entry.spentTokens > 4 * entry.authorizedTokens), most = Math.max(0, ...near.map(entry => entry.spentTokens));
    const limits = near.length ? [{ limit: 'authorizationPerTicket', observed: most, current: near[0].authorizedTokens, proposal: { authorizationPerTicket: proposedTokens(most) }, tickets: near.map(entry => entry.ticket) }] : [];
    // A worker call that used every turn its staffing allows stopped there; staffing is not a limit, so it is named here.
    const staffing = readJSON(join(instance, 'profiles/team-mode.json'))?.staffing ?? {}, turnsOf = call => (meter?.subagents ?? []).find(row => row?.agentId === call.agentId)?.uniqueMessages;
    for (const duty of ['exec', 'check', 'guard']) {
      const cap = staffing[duty]?.maxTurns, stopped = Number.isSafeInteger(cap) ? settled.calls.filter(call => call.duty === duty && Number.isSafeInteger(turnsOf(call)) && turnsOf(call) >= cap) : [];
      if (stopped.length) limits.push({ limit: `staffing.${duty}.maxTurns`, observed: Math.max(...stopped.map(turnsOf)), current: cap, proposal: null, tickets: [...new Set(stopped.map(call => call.ticket).filter(Boolean))],
        note: 'the call used every turn its staffing allows and stopped there; staffing changes with a mode switch whose request raises it' });
    }
    // A reviewer call over its authorization is reported; the turn limit was its brake, and no ticket is held for it.
    const { reviews, findings: reviewFindings } = reviewCalls({ batch, after, kept: readJSON(at('reviews')), meter }), over = reviews.filter(entry => entry.overrun);
    const reviewCost = reviews.reduce((total, entry) => total + (entry.spentTokens ?? 0), 0), findings = [...settled.findings, ...reviewFindings];
    if (over.length) { const observed = Math.max(...over.map(entry => entry.spentTokens)); limits.push({ limit: 'authorizationPerReviewerCall', observed, current: over[0].authorizedTokens, proposal: { authorizationPerReviewerCall: proposedTokens(observed) }, reviews: over.map(({ reviewer, attempt }) => ({ reviewer, attempt })) }); }
    const body = { schemaVersion: 1, stage: 'batch-settled', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, settledAt: new Date().toISOString(), status: settled.status === 'clear' && !findings.length && !over.length ? 'clear' : 'review',
      tickets, limits, calls: settled.calls, reviews, reviewCost, mainSessionTokens: Number.isSafeInteger(meter?.session?.harnessEq) ? meter.session.harnessEq : null,
      findings, run: settled.run, ticketRecords: settled.ticketRecords, journalSource: 'reconstructed-after-run' };
    const record = { ...body, digest: digest(body) };
    keep({ instance, folder, target: at('settlement'), record, runId: batch.runId });
    // Tickets that never ran are not in the comparison: the authorization named is that of the tickets settled.
    const authorized = tickets.reduce((total, entry) => total + entry.authorizedTokens, 0);
    try { appendFileSync(join(instance, LEDGER), `${body.settledAt.slice(0, 10)} BATCH ${batch.runId} SETTLED (${record.status}): ${settled.run.ticketTokens} token(s) on ${tickets.length} ticket(s) of ${authorized} authorized, Guardian ${settled.run.guardianTokens ?? 'not metered'}; ${reviews.length ? `review ${reviewCost} token(s) on ${reviews.length} reviewer call(s) of ${reviews[0].authorizedTokens} authorized each${over.length ? `, over: ${over.map(entry => `${entry.reviewer} attempt ${entry.attempt}`).join(', ')}` : ''}` : 'no review'}; run gate ${settled.run.runGate}${findings.length ? `; findings: ${findings.map(finding => finding.code).join(', ')}` : ''}.\n`); }
    catch { /* the record is written; the line is the PM's to add */ }
    return record;
  } catch (error) { return refused(error); }
}

// ADR 0010, amendment of 2026-11-18: the next batch does not open until the last one is settled. A batch whose
// usage cannot be measured (its transcripts are gone, its records are damaged) is marked so, with the reason, in
// the place of its settlement. Nothing of the batch's records is trusted for that except where it lies.
export function markNotMetered({ teamRoot, instanceRoot, reason, runId }) {
  try {
    const instance = instanceRootOf(teamRoot, instanceRoot), { names, folder, id } = recordsOf(instance, runId), target = join(folder, names.settlement);
    need(id, 'The closed batch in this team has no readable run id; abort it, then mark its archive with --run <run id>');
    // Without --run the id comes from the closed batch in the root: it must be the id of the batch record, and the
    // record of after in the root must be the archive's own when it names one.
    need(runId !== undefined || (readJSON(join(folder, names.batch))?.runId === id && (folder === instance || readJSON(join(folder, names.after))?.digest === readJSON(join(instance, AFTER_FILE))?.digest)),
      'The records of the closed batch do not agree on its run id; abort it, then mark its archive with --run <run id>');
    need(oneLine(reason), 'A batch is marked as not metered with a reason: one line, at most 200 characters');
    need(!exists(target), 'This batch was already settled');
    const body = { schemaVersion: 1, stage: 'batch-not-metered', runId: id, reason, markedAt: new Date().toISOString() }, record = { ...body, digest: digest(body) };
    // The ledger line goes first: a batch is never passed over without its line.
    appendFileSync(join(instance, LEDGER), `${body.markedAt.slice(0, 10)} BATCH ${id} NOT METERED by rw-batch.mjs settle --not-metered: ${plain(reason)}. Its usage was not set against its authorization.\n`);
    keep({ instance, folder, target, record, runId: id });
    return record;
  } catch (error) { return refused(error); }
}
