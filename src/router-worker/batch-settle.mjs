import { readFileSync, writeFileSync, appendFileSync, lstatSync, linkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { settleEngineRun, Refusal as SettlementRefusal } from './launch-settle.mjs';
import { BATCH_FILE, AFTER_FILE, RETURN_FILE, SETTLE_FILE, ARCHIVE, RUN_ID } from './batch.mjs';

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
function recordsOf(instance, runId) {
  const archived = id => ({ names: { batch: 'batch.json', after: 'after.json', result: 'return.json', settlement: 'settlement.json' }, folder: join(instance, ARCHIVE, id) });
  const known = id => typeof id === 'string' && RUN_ID.test(id) && exists(join(instance, ARCHIVE, id));
  if (runId !== undefined) { need(known(runId), 'No archived batch of that id'); return archived(runId); }
  need(exists(join(instance, AFTER_FILE)), 'No closed batch is waiting in this team; name an archived one with --run <run id>');
  const id = readJSON(join(instance, AFTER_FILE))?.runId;
  return known(id) ? archived(id) : { names: { batch: BATCH_FILE, after: AFTER_FILE, result: RETURN_FILE, settlement: SETTLE_FILE }, folder: instance };
}

export function settleBatch({ teamRoot, instanceRoot, meter, rules, runId }) {
  try {
    let instance;
    try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
    need(instance, 'An instance root is required');
    const { names, folder } = recordsOf(instance, runId), at = name => join(folder, names[name]);
    const batch = readJSON(at('batch')), after = readJSON(at('after')), result = readJSON(at('result'));
    need(intact(batch, 'batch-open') && intact(after, 'batch-closed') && after.batchDigest === batch.digest, 'The batch has not been closed by after, or its records were changed');
    // The run id reaches the ledger and a path: it is checked again here, whatever the digests say.
    need(typeof batch.runId === 'string' && RUN_ID.test(batch.runId) && after.runId === batch.runId && (folder === instance || folder === join(instance, ARCHIVE, batch.runId)),
      'The batch record does not hold the plain run id it was closed and archived under');
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
    // Whole or not at all, and never over an earlier settlement.
    const place = (draft, target) => { try { linkSync(draft, target); return true; } catch (error) { if (error?.code === 'EEXIST') return false; throw error; } finally { rmSync(draft, { force: true }); } };
    const target = at('settlement'), draft = `${target}.${process.pid}.tmp`;
    writeFileSync(draft, JSON.stringify(record, null, 2) + '\n');
    need(place(draft, target), 'This batch was already settled');
    // A commit or an abort that archived the batch while it was being settled did not take this record: it follows the batch.
    const home = join(instance, ARCHIVE, batch.runId);
    if (folder === instance && exists(home)) place(target, join(home, 'settlement.json'));
    // Tickets that never ran are not in the comparison: the authorization named is that of the tickets settled.
    const authorized = tickets.reduce((total, entry) => total + entry.authorizedTokens, 0);
    try { appendFileSync(join(instance, LEDGER), `${body.settledAt.slice(0, 10)} BATCH ${batch.runId} SETTLED (${record.status}): ${settled.run.ticketTokens} token(s) on ${tickets.length} ticket(s) of ${authorized} authorized, Guardian ${settled.run.guardianTokens ?? 'not metered'}; run gate ${settled.run.runGate}${settled.findings.length ? `; findings: ${settled.findings.map(finding => finding.code).join(', ')}` : ''}.\n`); }
    catch { /* the record is written; the line is the PM's to add */ }
    return record;
  } catch (error) {
    const reason = error instanceof Refusal || error instanceof SettlementRefusal ? error.message : `Settlement failed: ${error?.code ?? 'the return, the meter or a transcript could not be read'}`;
    return { errors: [{ code: 'BATCH_REFUSED', field: 'batch', reason }] };
  }
}
