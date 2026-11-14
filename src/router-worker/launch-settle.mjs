import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { digest, bytesDigest } from '../loop/contracts.mjs';
import { accountRun } from './run-args.mjs';
import { createRetryJournal, advanceRetryJournal } from './retries.mjs';
import { createSettlementLedger, advanceSettlementLedger, usageEventFromMeterRow, settleAgainstJournal } from './settlement.mjs';
import { settleRun } from './run-settlement.mjs';
import { LAUNCH_FILE, CLOSE_FILE } from './launch.mjs';

// Launch host, after close: the metered agents of the session are matched to the calls of
// the run, each call's transcript is checked for its frozen brief, and tickets and run are settled.
export const SETTLE_FILE = 'rw-settlement.json';
const GATES = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const UNRESOLVED = ['retry-journal-kept-live', 'meter-read-authenticity', 'governance-usage', 'main-session-usage-not-estimated'];

class Refusal extends Error {}
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const selfDigested = (value, stage) => {
  if (!value || typeof value !== 'object') return false;
  const { digest: recorded, ...body } = value;
  return recorded === digest(body) && value.stage === stage;
};
const readRecord = (teamRoot, file) => { try { return JSON.parse(readFileSync(join(teamRoot, file), 'utf8')); } catch { return null; } };

// The runtime relays a brief with every line indented by two spaces.
function carriesBrief(transcript, brief) {
  const relayed = brief.split('\n').map(line => '  ' + line).join('\n');
  return transcript.split('\n').some(line => {
    let entry;
    try { entry = JSON.parse(line); } catch { return false; }
    if (entry?.type !== 'user') return false;
    const content = entry.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('\n') : '';
    return text.includes(relayed);
  });
}

// The engine starts its agents one after another; the workflow journal keeps that order.
function metered(meter, wrappers) {
  const rows = (Array.isArray(meter?.subagents) ? meter.subagents : []).filter(row => row?.workflowRunId && wrappers.includes(row.agentType) && typeof row.file === 'string');
  need(rows.length && rows.every(row => row.workflowRunId === rows[0].workflowRunId), 'The meter does not hold the agents of exactly one engine run');
  let order;
  try {
    order = readFileSync(join(dirname(rows[0].file), 'journal.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(entry => entry?.type === 'started').map(entry => entry.agentId);
  } catch { order = null; }
  need(order && rows.every(row => order.includes(row.agentId)), 'The workflow journal of the metered run does not list its agents');
  return [...rows].sort((a, b) => order.indexOf(a.agentId) - order.indexOf(b.agentId));
}

function settleTicket({ item, planItem, outcome, exec, check, launch, close, rules, findings }) {
  const ticket = item.ticket, ref = (id, value) => ({ id, digest: digest(value) });
  const admission = { sourceRef: { id: 'rw-launch', digest: launch.digest }, gates: Object.fromEntries(GATES.map(gate => [gate, 'clear'])) };
  const receiptRef = { id: 'rw-close', digest: close.digest }, candidate = ref(`${ticket}-candidate`, { head: close.productHead, paths: close.changedPaths });
  const call = row => ({ sessionRef: ref(`agent-${row.agentId}`, row.agentId), callRef: { id: `transcript-${row.agentId}`, digest: bytesDigest(readFileSync(row.file)) } });
  let journal = createRetryJournal({ ticketId: ticket, rules }), count = 0;
  const send = event => { journal = advanceRetryJournal({ journal, rules, expectedDigest: journal.digest, event: { eventId: `event-${++count}`, ...event } }).journal; };
  const run = (duty, row, candidateRef, closing) => {
    const assignmentId = `${ticket}.${duty}.1`;
    send({ type: 'prepare', assignmentId, duty, planRef: { id: `${ticket}-${duty}-plan`, digest: item.previewDigest }, candidateRef, continuationOf: null, resumeSessionRef: null, divergence: null, admission });
    send({ type: 'start', assignmentId, ...call(row), admission });
    send({ type: 'close', assignmentId, receiptRef, ...closing });
  };
  const blocked = outcome.worker?.blocked === true, progress = outcome.worker?.progress === true;
  run('exec', exec, ref('launch-product-head', launch.productHead),
    { outcome: blocked ? 'blocked' : 'candidate', progress, outcomeKey: `exec-1-${blocked ? 'blocked' : 'candidate'}`, candidateRef: blocked && !check ? null : candidate });
  if (check) {
    const pass = outcome.verifier?.pass === true;
    run('check', check, candidate, { outcome: pass ? 'pass' : 'fail', progress: true, outcomeKey: `check-1-${pass ? 'pass' : 'fail'}`, candidateRef: candidate });
  }
  let ledger = createSettlementLedger({ ticketId: ticket, authorizedTokens: item.authorizedTokens });
  for (const [index, row] of [exec, check].filter(Boolean).entries())
    ledger = advanceSettlementLedger({ ledger, expectedDigest: ledger.digest, event: usageEventFromMeterRow({ row, callRef: call(row).callRef, eventId: `usage-${index + 1}` }) }).ledger;
  for (const [duty, row, brief] of [['exec', exec, planItem.brief], ['check', check, planItem.verifierBrief]])
    if (row && typeof brief === 'string' && !carriesBrief(readFileSync(row.file, 'utf8'), brief)) findings.push({ code: 'BRIEF_NOT_FOUND', ticket, duty });
  return { ticketId: ticket, journal, ledger, settlement: settleAgainstJournal({ ledger, retryJournal: journal, rules }) };
}

export function settleLaunch({ teamRoot, result, meter, rules }) {
  try {
    need(typeof teamRoot === 'string', 'The team root is required');
    const launch = readRecord(teamRoot, LAUNCH_FILE), close = readRecord(teamRoot, CLOSE_FILE);
    need(selfDigested(launch, 'launch-prepared') && launch.teamRoot === teamRoot, 'This copy has no intact launch record');
    need(selfDigested(close, 'launch-closed') && close.launchDigest === launch.digest, 'This launch has not been closed');
    const path = join(teamRoot, SETTLE_FILE);
    need(!lstatSync(path, { throwIfNoEntry: false }), 'This launch was already settled');
    const account = accountRun({ args: launch.args, record: launch.runRecord, result });
    need(account.status === 'accounted' && digest(account) === digest(close.account), 'The engine return is not the return this launch was closed with');
    need(launch.runRecord.items.every(item => Number.isSafeInteger(item.authorizedTokens)), 'The launch record carries no ticket authorizations; it was frozen by an older kit');

    const plan = launch.args.plan, guardType = launch.args.guardianAgentType;
    const rows = metered(meter, [...new Set([guardType, ...plan.flatMap(item => [item.agentType, item.verifierAgentType])])].filter(Boolean));
    const expected = [];
    for (let i = 0; i < account.calls.exec; i++) {
      expected.push({ index: i, duty: 'exec', agentType: plan[i].agentType });
      if (result.results[i].estimates.verifier !== null) expected.push({ index: i, duty: 'check', agentType: plan[i].verifierAgentType });
    }
    expected.push({ index: null, duty: 'guard', agentType: guardType });
    need(rows.length === expected.length && rows.every((row, i) => row.agentType === expected[i].agentType), 'The metered agents are not the calls of this run, in order');

    const findings = [], row = (index, duty) => rows[expected.findIndex(call => call.index === index && call.duty === duty)];
    const ticketRecords = launch.runRecord.items.slice(0, account.calls.exec).map((item, index) => settleTicket({ item, planItem: plan[index],
      outcome: result.results[index], exec: row(index, 'exec'), check: row(index, 'check'), launch, close, rules, findings }));
    const guard = rows.at(-1), run = settleRun({ record: launch.runRecord, account, tickets: ticketRecords.map(entry => entry.settlement), guardian: guard });
    const body = { schemaVersion: 1, stage: 'launch-settled', runId: launch.runId, launchDigest: launch.digest, closeDigest: close.digest,
      status: run.runGate === 'clear' && !findings.length ? 'clear' : 'review',
      calls: expected.map((call, i) => ({ ticket: call.index === null ? null : plan[call.index].ticket, duty: call.duty, agentId: rows[i].agentId, tokens: rows[i].harnessEq, finished: rows[i].finished })),
      mainSessionTokens: Number.isSafeInteger(meter.session?.harnessEq) ? meter.session.harnessEq : null,
      findings, run, ticketRecords, journalSource: 'reconstructed-after-run', unresolved: UNRESOLVED };
    const record = { ...body, digest: digest(body) };
    try { writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { need(false, `The settlement record could not be written: ${error.code ?? 'unknown error'}`); }
    return record;
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : `Settlement failed: ${error?.code ?? 'the return, the meter or a transcript could not be read'}`;
    return { errors: [{ code: 'LAUNCH_REFUSED', field: 'launch', reason }] };
  }
}
