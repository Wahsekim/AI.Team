import { readFileSync, writeFileSync, appendFileSync, lstatSync, linkSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { settleEngineRun, Refusal as SettlementRefusal } from './launch-settle.mjs';
import { BATCH_FILE, AFTER_FILE, RETURN_FILE, SETTLE_FILE, ARCHIVE, RUN_ID, oneLine, plain } from './batch.mjs';

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
const ARCHIVED = { batch: 'batch.json', after: 'after.json', result: 'return.json', settlement: 'settlement.json' };
function recordsOf(instance, runId) {
  // The folder's own name, letter for letter: a file system that ignores case does not make two ids one.
  let folders; try { folders = readdirSync(join(instance, ARCHIVE)); } catch { folders = []; }
  const known = id => typeof id === 'string' && RUN_ID.test(id) && folders.includes(id), archived = id => ({ names: ARCHIVED, folder: join(instance, ARCHIVE, id), id });
  if (runId !== undefined) { need(known(runId), 'No archived batch of that id'); return archived(runId); }
  need(exists(join(instance, AFTER_FILE)), 'No closed batch is waiting in this team; name an archived one with --run <run id>');
  const id = readJSON(join(instance, AFTER_FILE))?.runId;
  return known(id) ? archived(id) : { names: { batch: BATCH_FILE, after: AFTER_FILE, result: RETURN_FILE, settlement: SETTLE_FILE }, folder: instance, id: typeof id === 'string' && RUN_ID.test(id) ? id : null };
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
    need(batch.runRecord.items.every(item => Number.isSafeInteger(item.authorizedTokens)), 'The batch record carries no ticket authorizations');
    // What the run left, named for the settlement: the commit it started from and every path it changed.
    const changedPaths = [...new Set([...after.tickets.flatMap(ticket => ticket.changedPaths), ...after.left])].sort();
    const settled = settleEngineRun({ launch: { digest: batch.digest, productHead: batch.productHead, args: batch.args, runRecord: batch.runRecord },
      close: { digest: after.digest, account: after.account, productHead: batch.productHead, changedPaths }, result, meter, rules });
    const tickets = settled.ticketRecords.map(({ settlement }) => ({ ticket: settlement.ticketId, authorizedTokens: settlement.authorizedTokens, spentTokens: settlement.spentTokens, remainingTokens: settlement.remainingTokens, budgetGate: settlement.budgetGate }));
    const body = { schemaVersion: 1, stage: 'batch-settled', runId: batch.runId, batchDigest: batch.digest, afterDigest: after.digest, settledAt: new Date().toISOString(), status: settled.status,
      tickets, calls: settled.calls, mainSessionTokens: Number.isSafeInteger(meter?.session?.harnessEq) ? meter.session.harnessEq : null,
      findings: settled.findings, run: settled.run, ticketRecords: settled.ticketRecords, journalSource: 'reconstructed-after-run' };
    const record = { ...body, digest: digest(body) };
    keep({ instance, folder, target: at('settlement'), record, runId: batch.runId });
    // Tickets that never ran are not in the comparison: the authorization named is that of the tickets settled.
    const authorized = tickets.reduce((total, entry) => total + entry.authorizedTokens, 0);
    try { appendFileSync(join(instance, LEDGER), `${body.settledAt.slice(0, 10)} BATCH ${batch.runId} SETTLED (${record.status}): ${settled.run.ticketTokens} token(s) on ${tickets.length} ticket(s) of ${authorized} authorized, Guardian ${settled.run.guardianTokens ?? 'not metered'}; run gate ${settled.run.runGate}${settled.findings.length ? `; findings: ${settled.findings.map(finding => finding.code).join(', ')}` : ''}.\n`); }
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
