import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { digest, bytesDigest } from '../loop/contracts.mjs';
import { accountRun } from './run-args.mjs';
import { createRetryJournal, advanceRetryJournal } from './retries.mjs';
import { createSettlementLedger, advanceSettlementLedger, usageEventFromMeterRow, settleAgainstJournal } from './settlement.mjs';
import { settleRun } from './run-settlement.mjs';
import { LAUNCH_FILE, CLOSE_FILE, dispatchEvents } from './launch.mjs';
import { runSummary } from './dispatch.mjs';

// Launch host, after close: the metered agents of the session are matched to the calls of
// the run, each call's transcript is checked for its frozen brief, and tickets and run are settled.
export const SETTLE_FILE = 'rw-settlement.json';
const GATES = ['owner', 'budget', 'security', 'global-progress', 'round-trip', 'governance', 'lifecycle', 'count-guardian', 'runtime-isolation'];
const UNRESOLVED = ['retry-journal-kept-live', 'meter-read-authenticity', 'governance-usage', 'main-session-usage-not-estimated'];

export class Refusal extends Error {}
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
    // The engine relays a brief indented; the Agent tool passes the prompt as it is.
    return text.includes(relayed) || text.includes(brief);
  });
}

// The engine starts its agents one after another; the workflow journal keeps that order. One session can
// hold several engine runs: each is returned on its own, in the order of its journal.
function meteredRuns(meter, wrappers) {
  const rows = (Array.isArray(meter?.subagents) ? meter.subagents : []).filter(row => row?.workflowRunId && wrappers.includes(row.agentType) && typeof row.file === 'string');
  need(rows.length, 'The meter holds no agents of an engine run');
  const runs = [...new Set(rows.map(row => row.workflowRunId))].map(id => {
    const own = rows.filter(row => row.workflowRunId === id);
    let order;
    try {
      order = readFileSync(join(dirname(own[0].file), 'journal.jsonl'), 'utf8').split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(entry => entry?.type === 'started').map(entry => entry.agentId);
    } catch { order = null; }
    return order && own.every(row => order.includes(row.agentId)) ? [...own].sort((a, b) => order.indexOf(a.agentId) - order.indexOf(b.agentId)) : null;
  }).filter(Boolean);
  need(runs.length, 'The workflow journal of the metered run does not list its agents');
  return runs;
}

// `attempts` is one {exec, check} pair of meter rows per attempt; `check` is null when the engine dispatched none.
// Every attempt before the last ended in a failed verification, otherwise the engine would not have retried.
function settleTicket({ item, planItem, outcome, attempts, launch, close, rules, findings }) {
  const ticket = item.ticket, ref = (id, value) => ({ id, digest: digest(value) }), last = attempts.length;
  const admission = { sourceRef: { id: 'rw-launch', digest: launch.digest }, gates: Object.fromEntries(GATES.map(gate => [gate, 'clear'])) };
  const receiptRef = { id: 'rw-close', digest: close.digest };
  const closed = close.candidate ?? ref(`${ticket}-candidate`, { head: close.productHead, paths: close.changedPaths });
  // Only the state the run ended in was observed; an earlier attempt's candidate is named, not snapshotted.
  const candidate = k => k === last ? closed : ref(`${ticket}-candidate-${k}`, { attempt: k, before: closed.digest });
  const plan = (duty, k) => ({ id: `${ticket}-${duty}-plan-${k}`, digest: k === 1 ? item.previewDigest : digest({ preview: item.previewDigest, duty, attempt: k }) });
  const call = row => ({ sessionRef: ref(`agent-${row.agentId}`, row.agentId), callRef: { id: `transcript-${row.agentId}`, digest: bytesDigest(readFileSync(row.file)) } });
  let journal = createRetryJournal({ ticketId: ticket, rules }), count = 0;
  const send = event => { journal = advanceRetryJournal({ journal, rules, expectedDigest: journal.digest, event: { eventId: `event-${++count}`, ...event } }).journal; };
  const run = (duty, k, row, candidateRef, closing) => {
    const assignmentId = `${ticket}.${duty}.${k}`;
    send({ type: 'prepare', assignmentId, duty, planRef: plan(duty, k), candidateRef, admission, resumeSessionRef: null,
      continuationOf: k === 1 ? null : `${ticket}.${duty}.${k - 1}`,
      divergence: k === 1 ? null : { previousPlanDigest: plan(duty, k - 1).digest, reason: 'The verifier rejected the previous attempt; the engine retried with a fresh agent', evidenceRef: receiptRef } });
    send({ type: 'start', assignmentId, ...call(row), admission });
    send({ type: 'close', assignmentId, receiptRef, ...closing });
  };
  let ledger = createSettlementLedger({ ticketId: ticket, authorizedTokens: item.authorizedTokens }), usage = 0;
  const meter = row => { ledger = advanceSettlementLedger({ ledger, expectedDigest: ledger.digest, event: usageEventFromMeterRow({ row, callRef: call(row).callRef, eventId: `usage-${++usage}` }) }).ledger; };
  attempts.forEach(({ exec, check }, index) => {
    const k = index + 1, final = k === last;
    const blocked = final && outcome.worker?.blocked === true, progress = final ? outcome.worker?.progress === true : true;
    run('exec', k, exec, k === 1 ? ref('launch-product-head', launch.productHead) : candidate(k - 1),
      { outcome: blocked ? 'blocked' : 'candidate', progress, outcomeKey: `exec-${k}-${blocked ? 'blocked' : 'candidate'}`, candidateRef: blocked && !check ? null : candidate(k) });
    meter(exec);
    if (check) {
      const pass = final && outcome.verifier?.pass === true;
      run('check', k, check, candidate(k), { outcome: pass ? 'pass' : 'fail', progress: true, outcomeKey: `check-${k}-${pass ? 'pass' : 'fail'}`, candidateRef: candidate(k) });
      meter(check);
    }
    for (const [duty, row, brief] of [['exec', exec, planItem.brief], ['check', check, planItem.verifierBrief]])
      if (row && typeof brief === 'string' && !carriesBrief(readFileSync(row.file, 'utf8'), brief)) findings.push({ code: 'BRIEF_NOT_FOUND', ticket, duty, ...(last > 1 ? { attempt: k } : {}) });
  });
  return { ticketId: ticket, journal, ledger, settlement: settleAgainstJournal({ ledger, retryJournal: journal, rules }) };
}

// A main-session run. Each agent is bound by the id the gate recorded, and it has ONE transcript for
// all its attempts: the meter read after the run is charged to the agent's first call, later calls of
// the same agent add nothing, so usage is known per ticket and duty, not per attempt.
function settleDispatched({ launch, close, meter, rules, events }) {
  const summary = runSummary({ launch, events });
  need(summary, 'The dispatch log of this launch cannot be read');
  const dispatched = summary.tickets.filter(ticket => ticket.attempts > 0);
  need(digest(dispatched.map(({ ticket, status, attempts }) => ({ ticket, status, attempts }))) === digest(close.account.tickets ?? null), 'The dispatch log changed after this launch was closed');
  const rows = (Array.isArray(meter?.subagents) ? meter.subagents : []).filter(row => !row?.workflowRunId && typeof row.file === 'string');
  const rowOf = agentId => { const row = rows.find(candidate => candidate.agentId === agentId); need(row, `The meter holds no agent ${agentId}; it is not the session of this run`); return row; };
  const ref = (id, value) => ({ id, digest: digest(value) }), findings = [], calls = [];
  const admission = { sourceRef: { id: 'rw-launch', digest: launch.digest }, gates: Object.fromEntries(GATES.map(gate => [gate, 'clear'])) };
  const receiptRef = { id: 'rw-close', digest: close.digest };
  const ticketRecords = dispatched.map(entry => {
    const index = launch.args.plan.findIndex(item => item.ticket === entry.ticket), item = launch.runRecord.items[index], planItem = launch.args.plan[index], ticket = entry.ticket;
    const own = summary.calls.filter(call => call.ticket === ticket), lastOf = duty => own.filter(call => call.duty === duty).at(-1);
    const closed = close.candidate ?? ref(`${ticket}-candidate`, { head: close.productHead, paths: close.changedPaths });
    const candidate = k => k === entry.attempts ? closed : ref(`${ticket}-candidate-${k}`, { attempt: k, before: closed.digest });
    const plan = (duty, k) => ({ id: `${ticket}-${duty}-plan-${k}`, digest: k === 1 ? item.previewDigest : digest({ preview: item.previewDigest, duty, attempt: k }) });
    let journal = createRetryJournal({ ticketId: ticket, rules }), ledger = createSettlementLedger({ ticketId: ticket, authorizedTokens: item.authorizedTokens }), count = 0, usage = 0;
    const send = event => { journal = advanceRetryJournal({ journal, rules, expectedDigest: journal.digest, event: { eventId: `event-${++count}`, ...event } }).journal; };
    for (const call of own) {
      if (!call.returned) break;
      const row = rowOf(call.agentId), k = call.attempt, duty = call.duty, assignmentId = `${ticket}.${duty}.${k}`, sessionRef = ref(`agent-${call.agentId}`, call.agentId);
      const callRef = { id: `transcript-${call.agentId}-call-${k}`, digest: digest({ transcript: bytesDigest(readFileSync(row.file)), call: k }) };
      send({ type: 'prepare', assignmentId, duty, planRef: plan(duty, k), admission, continuationOf: k === 1 ? null : `${ticket}.${duty}.${k - 1}`, resumeSessionRef: k === 1 ? null : sessionRef,
        candidateRef: duty === 'check' ? candidate(k) : k === 1 ? ref('launch-product-head', launch.productHead) : candidate(k - 1),
        divergence: k === 1 ? null : { previousPlanDigest: plan(duty, k - 1).digest, reason: 'The check rejected the previous attempt; the same agent was resumed', evidenceRef: receiptRef } });
      send({ type: 'start', assignmentId, sessionRef, callRef, admission });
      const final = call === lastOf(duty), stoppedAtExec = final && duty === 'exec' && entry.status.startsWith('exec-'), pass = final && duty === 'check' && entry.status === 'passed';
      send({ type: 'close', assignmentId, receiptRef, progress: !stoppedAtExec || entry.status === 'exec-blocked', outcomeKey: `${duty}-${k}-${stoppedAtExec ? 'blocked' : duty === 'exec' ? 'candidate' : pass ? 'pass' : 'fail'}`,
        outcome: stoppedAtExec ? 'blocked' : duty === 'exec' ? 'candidate' : pass ? 'pass' : 'fail', candidateRef: stoppedAtExec ? null : candidate(k) });
      ledger = advanceSettlementLedger({ ledger, expectedDigest: ledger.digest, event: usageEventFromMeterRow({ row, callRef, eventId: `usage-${++usage}` }) }).ledger;
    }
    for (const [duty, agentId, brief] of [['exec', entry.execAgentId, planItem.brief], ['check', entry.checkAgentId, planItem.verifierBrief]]) {
      if (!agentId) continue;
      const row = rowOf(agentId);
      calls.push({ ticket, duty, attempts: own.filter(call => call.duty === duty && call.returned).length, agentId, tokens: row.harnessEq, finished: row.finished });
      if (typeof brief === 'string' && !carriesBrief(readFileSync(row.file, 'utf8'), brief)) findings.push({ code: 'BRIEF_NOT_FOUND', ticket, duty });
    }
    return { ticketId: ticket, journal, ledger, settlement: settleAgainstJournal({ ledger, retryJournal: journal, rules }) };
  });
  return { calls, findings, ticketRecords, run: settleRun({ record: launch.runRecord, account: close.account, tickets: ticketRecords.map(entry => entry.settlement), guardian: null }) };
}

// An engine run, settled: the metered agents are matched to the calls of the run in order, each call's
// transcript is checked for its frozen brief, and the tickets and the run are settled. `launch` carries
// {digest, productHead, args, runRecord}; `close` carries {digest, account, productHead, changedPaths, candidate?}.
// Throws a Refusal when the return or the meter is not this run's.
export function settleEngineRun({ launch, close, result, meter, rules }) {
  const account = accountRun({ args: launch.args, record: launch.runRecord, result });
  need(account.status === 'accounted' && digest(account) === digest(close.account), 'The engine return is not the return this run was closed with');

  const plan = launch.args.plan, guardType = launch.args.guardianAgentType;
  const runs = meteredRuns(meter, [...new Set([guardType, ...plan.flatMap(item => [item.agentType, item.verifierAgentType])])].filter(Boolean));
  const expected = [];
  for (let i = 0; i < account.calls.tickets; i++) for (let k = 1; k <= account.attempts[i]; k++) {
    expected.push({ index: i, attempt: k, duty: 'exec', agentType: plan[i].agentType });
    if (k < account.attempts[i] || result.results[i].estimates.verifier !== null) expected.push({ index: i, attempt: k, duty: 'check', agentType: plan[i].verifierAgentType });
  }
  expected.push({ index: null, attempt: null, duty: 'guard', agentType: guardType });
  const fits = runs.filter(run => run.length === expected.length && run.every((row, i) => row.agentType === expected[i].agentType));
  need(fits.length, 'The metered agents are not the calls of this run, in order');
  // Among the runs of the session that have this shape, this run is the one whose transcripts carry its frozen briefs.
  const briefs = expected.map(call => call.duty === 'exec' ? plan[call.index].brief : call.duty === 'check' ? plan[call.index].verifierBrief : null);
  let rows = fits[0];
  if (briefs.some(brief => typeof brief === 'string')) {
    const carried = fits.map(run => run.filter((row, i) => typeof briefs[i] === 'string' && carriesBrief(readFileSync(row.file, 'utf8'), briefs[i])).length), most = Math.max(...carried);
    need(most > 0, 'No metered run carries a brief of this run; the meter is not of its session');
    need(carried.filter(count => count === most).length === 1, 'More than one metered run carries the briefs of this run; they cannot be told apart');
    rows = fits[carried.indexOf(most)];
  } else need(fits.length === 1, 'More than one metered run has the calls of this run; they cannot be told apart');

  const findings = [], row = (index, attempt, duty) => rows[expected.findIndex(call => call.index === index && call.attempt === attempt && call.duty === duty)] ?? null;
  const ticketRecords = launch.runRecord.items.slice(0, account.calls.tickets).map((item, index) => settleTicket({ item, planItem: plan[index], outcome: result.results[index],
    attempts: Array.from({ length: account.attempts[index] }, (_, at) => ({ exec: row(index, at + 1, 'exec'), check: row(index, at + 1, 'check') })), launch, close, rules, findings }));
  const guard = rows.at(-1), run = settleRun({ record: launch.runRecord, account, tickets: ticketRecords.map(entry => entry.settlement), guardian: guard });
  return { status: run.runGate === 'clear' && !findings.length ? 'clear' : 'review',
    calls: expected.map((call, i) => ({ ticket: call.index === null ? null : plan[call.index].ticket, duty: call.duty, attempt: call.attempt, agentId: rows[i].agentId, tokens: rows[i].harnessEq, finished: rows[i].finished })),
    findings, run, ticketRecords };
}

export function settleLaunch({ teamRoot, result, meter, rules }) {
  try {
    need(typeof teamRoot === 'string', 'The team root is required');
    const launch = readRecord(teamRoot, LAUNCH_FILE), close = readRecord(teamRoot, CLOSE_FILE);
    need(selfDigested(launch, 'launch-prepared') && launch.teamRoot === teamRoot, 'This copy has no intact launch record');
    need(selfDigested(close, 'launch-closed') && close.launchDigest === launch.digest, 'This launch has not been closed');
    const path = join(teamRoot, SETTLE_FILE);
    need(!lstatSync(path, { throwIfNoEntry: false }), 'This launch was already settled');
    need(launch.runRecord.items.every(item => Number.isSafeInteger(item.authorizedTokens)), 'The launch record carries no ticket authorizations; it was frozen by an older kit');
    const write = body => {
      const record = { ...body, digest: digest(body) };
      try { writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
      catch (error) { need(false, `The settlement record could not be written: ${error.code ?? 'unknown error'}`); }
      return record;
    };
    const head = { schemaVersion: 1, stage: 'launch-settled', runId: launch.runId, launchDigest: launch.digest, closeDigest: close.digest };
    const mainSessionTokens = Number.isSafeInteger(meter?.session?.harnessEq) ? meter.session.harnessEq : null;
    if (launch.dispatch === 'main-session') {
      const events = dispatchEvents(teamRoot);
      need(events, 'The dispatch log of this launch cannot be read');
      const settled = settleDispatched({ launch, close, meter, rules, events });
      return write({ ...head, status: settled.run.runGate === 'clear' && !settled.findings.length ? 'clear' : 'review', calls: settled.calls, mainSessionTokens,
        findings: settled.findings, run: settled.run, ticketRecords: settled.ticketRecords, journalSource: 'reconstructed-after-run', unresolved: UNRESOLVED });
    }
    const settled = settleEngineRun({ launch, close, result, meter, rules });
    return write({ ...head, status: settled.status, calls: settled.calls, mainSessionTokens, findings: settled.findings, run: settled.run, ticketRecords: settled.ticketRecords,
      journalSource: 'reconstructed-after-run', unresolved: UNRESOLVED });
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : `Settlement failed: ${error?.code ?? 'the return, the meter or a transcript could not be read'}`;
    return { errors: [{ code: 'LAUNCH_REFUSED', field: 'launch', reason }] };
  }
}
