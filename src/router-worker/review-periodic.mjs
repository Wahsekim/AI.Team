import { readFileSync, writeFileSync, renameSync, appendFileSync, lstatSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, bytesDigest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { git } from './lease.mjs';
import { readBoundary, reviewBoundary, closeBoundary, stateOf } from './write-boundary.mjs';
import { BATCH_FILE, AFTER_FILE, ARCHIVE, contentOf, plain } from './batch.mjs';
import { intact, Refusal } from './batch-close.mjs';
import { loadReview } from './review-triggers.mjs';
import { rosterWrapper } from './switch.mjs';
import { finalOf, evidenceOf, derive, said, projectsOf, judgeFirst, changedSince } from './review-judge.mjs';
import { fenced, lines, REPORT, protocolOf, OPEN_RULE, toOpen } from './review-brief.mjs';
import { linksOf } from './read-coverage.mjs';

// ADR 0011, decision 7: every HARDENING_INTERVAL committed tickets, Security once and Architect once read what was
// committed since their last periodic review and that no triggered review of theirs passed, under the evidence rules
// of a batch review. The count is derived from the batch archives and reviews/periodic.jsonl, never stored. A periodic
// review holds no commit: its findings go to the PM as tickets. Owner answer of 2026-11-20: one not obtained twice is
// recorded and reported, and does not stop the next batch.
const KIT = fileURLToPath(new URL('../../', import.meta.url));
export const PERIODIC_FILE = 'reviews/periodic.jsonl';
const BRIEF_FILE = reviewer => `rw-periodic-review-${reviewer}.json`;
const LEDGER = 'pm-decisions.md', MODE_FILE = 'profiles/team-mode.json', ATTEMPTS = 2, DEFAULT_INTERVAL = 25, MAX_INTERVAL = 100;
const FINAL = ['accepted', 'not-obtained', 'nothing-to-review'];
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const sealed = body => ({ ...body, digest: digest(body) });
const refuse = error => ({ errors: [{ code: 'REVIEW_REFUSED', field: 'review', reason: error instanceof Refusal ? error.message : `The periodic review could not be recorded: ${error?.code ?? error?.message}` }] });
const heading = (reviewer, id, attempt) => `# Periodic review brief: ${reviewer}, period ${id}, attempt ${attempt}`;
const COMMANDS = 'rw-batch.mjs periodic-brief --reviewer <reviewer> --instance <instance-root>, dispatch the reviewer with that brief, then rw-batch.mjs periodic --reviewer <reviewer> --transcript <agent-*.jsonl> --instance <instance-root> (or periodic --no-answer "<reason>" --reviewer <reviewer> --instance <instance-root>)';

// The charter's hardening interval, which the PM can edit: trusted from 1 to MAX_INTERVAL, clamped above, the kit's
// default otherwise. `source` is charter, clamped or default; `note` says why, for the refusal and the brief.
export function hardeningInterval(instance, kit = KIT) {
  let text; try { text = readFileSync(join(instance, 'charter.md'), 'utf8'); } catch { text = readFileSync(join(kit, 'charter.template.md'), 'utf8'); }
  const raw = /At counter = `([^`\n]*)`/.exec(text)?.[1], placeholder = /^\{\{HARDENING_INTERVAL \| default:(\d+)\}\}$/.exec(raw ?? '')?.[1];
  const digits = placeholder ?? (/^\d+$/.test(raw ?? '') ? raw : null), value = digits === null ? NaN : Number(digits);
  if (value > MAX_INTERVAL) return { value: MAX_INTERVAL, source: 'clamped', note: `charter.md gives ${digits}; the kit trusts at most ${MAX_INTERVAL}` };
  if (value >= 1) return placeholder ? { value, source: 'default', note: "the placeholder's default in charter.md" } : { value, source: 'charter', note: 'set in charter.md' };
  return { value: DEFAULT_INTERVAL, source: 'default', note: raw === undefined ? "charter.md names no interval; the kit's default" : `charter.md gives ${JSON.stringify(plain(raw))}, not a whole number from 1 to ${MAX_INTERVAL}; the kit's default` };
}

// The commits of one archived batch: its sealed commit record, or, for a batch archived without commit, the commits the
// kit made before it stopped, each named in the sealed abandon note.
function archivedCommits(instance, id) {
  const committed = readJSON(join(instance, ARCHIVE, id, 'commit.json'));
  if (intact(committed, 'batch-committed') && committed.runId === id && Array.isArray(committed.commits)) return { at: committed.committedAt, commits: committed.commits };
  const note = readJSON(join(instance, ARCHIVE, id, 'abandoned.json')), made = readJSON(join(instance, ARCHIVE, id, 'commits.json'));
  if (!intact(note, 'batch-archived-without-commit') || note.runId !== id || made?.runId !== id || !Array.isArray(made.commits) || !Array.isArray(note.commitsMade)) return null;
  return { at: note.archivedAt, commits: made.commits.filter(commit => typeof commit?.sha === 'string' && note.commitsMade.includes(`${commit.ticket} ${commit.sha.slice(0, 8)}`)) };
}
// Every ticket the kit committed, oldest batch first, each commit once.
function committedOf(instance) {
  let ids; try { ids = readdirSync(join(instance, ARCHIVE)).filter(id => !id.startsWith('.')); } catch { ids = []; }
  const seen = new Set();
  return ids.map(id => ({ id, record: archivedCommits(instance, id) })).filter(({ record }) => record)
    .sort((a, b) => a.record.at.localeCompare(b.record.at))
    .flatMap(({ id, record }) => record.commits.map(commit => ({ ticket: commit.ticket, sha: commit.sha, runId: id })))
    .filter(entry => !seen.has(entry.sha) && seen.add(entry.sha));
}
// The tickets of an archived batch that this reviewer's triggered review passed.
function passedOf(instance, runId, reviewer) {
  const entries = (readJSON(join(instance, ARCHIVE, runId, 'reviews.json'))?.entries ?? []).filter(entry => intact(entry, 'review-verdict') && entry.runId === runId);
  return new Set((finalOf(entries, reviewer)?.tickets ?? []).filter(item => item.verdict === 'passed').map(item => item.id));
}
function periodicLines(instance) {
  let text; try { text = readFileSync(join(instance, PERIODIC_FILE), 'utf8'); } catch { return []; }
  const kept = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  need(kept.at(-1) !== null || kept.slice(0, -1).some(line => !intact(line, 'periodic-review')),
    `The last line of ${PERIODIC_FILE} is incomplete, a write that did not finish; remove that line (the review it was recording becomes due again)`);
  need(kept.every(line => intact(line, 'periodic-review')), `${PERIODIC_FILE} was changed; the periodic count cannot be derived. Restore it`);
  return kept;
}
// The committed tickets that no final periodic review of this reviewer counted.
function pendingOf(committed, kept, reviewer) {
  const counted = new Set(kept.filter(line => line.reviewer === reviewer && FINAL.includes(line.outcome)).flatMap(line => line.counted));
  return committed.filter(entry => !counted.has(entry.sha));
}
// This reviewer's refused attempts at the same pending commits, whatever period id an abort gave them.
const sameShas = (a, b) => a.length === b.length && a.every(sha => b.includes(sha));
const triedOf = (kept, reviewer, counted) => kept.filter(line => line.reviewer === reviewer && line.outcome === 'refused' && sameShas(line.counted, counted));
export function periodicDue({ instance, reviewers, kit = KIT }) {
  const interval = hardeningInterval(instance, kit), committed = committedOf(instance), kept = periodicLines(instance);
  return { interval, due: reviewers.map(reviewer => ({ reviewer, pending: pendingOf(committed, kept, reviewer).length })).filter(entry => entry.pending >= interval.value) };
}
export const periodicDueReason = ({ interval, due }) => `A periodic review is due, every ${interval.value} committed tickets (${interval.note}; ADR 0011, decision 7): ${due.map(entry => `${entry.reviewer} (${entry.pending} committed tickets since its last)`).join(', ')}. No batch opens until each is recorded: ${COMMANDS}. A review not obtained twice is recorded, reported to the owner, and stops nothing`;

// The team between batches, the reviewer, and the periodic review open in the boundary, if any.
function periodOf({ teamRoot, instanceRoot, reviewer }) {
  let instance;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
  need(instance, 'An instance root is required');
  need(!exists(join(instance, BATCH_FILE)) && !exists(join(instance, AFTER_FILE)), 'A batch is open; the periodic review runs between batches, once the batch is committed or aborted');
  const boundary = readBoundary(instance), state = boundary ? stateOf(boundary) : null;
  need(state === 'closed' || (state === 'review' && boundary.periodic === true), 'The write boundary is missing, was changed, or a batch is in review');
  let review; try { review = loadReview({ instance }); } catch (error) { need(false, error.message); }
  need(review.reviewers.includes(reviewer), `${plain(reviewer)} is not a reviewer of the kit (${review.reviewers.join(', ')})`);
  const staffed = review.reviewers.map(name => [name, rosterWrapper(instance, name)]), unstaffed = staffed.find(([, found]) => !found.name);
  need(!unstaffed, `The reviewer ${unstaffed?.[0]} is not staffed (${unstaffed?.[1].gap})`);
  const id = state === 'review' ? boundary.runId : null, kept = periodicLines(instance), mine = id ? kept.filter(line => line.id === id && line.reviewer === reviewer) : [];
  const final = mine.find(line => FINAL.includes(line.outcome));
  need(!final, `${reviewer}'s periodic review of ${id} is over (${final?.outcome})`);
  return { instance, review, product: boundary.productRoot, wrappers: Object.fromEntries(staffed.map(([name, found]) => [name, found.name])), id, kept, mine };
}
function briefsOf(instance, reviewer, id) {
  const kept = id ? readJSON(join(instance, BRIEF_FILE(reviewer))) : null;
  if (!kept || kept.id !== id) return [];
  need(kept.reviewer === reviewer && Array.isArray(kept.entries) && kept.entries.every((entry, i) => intact(entry, 'periodic-brief') && entry.id === id && entry.attempt === i + 1),
    `${BRIEF_FILE(reviewer)} was changed; nothing was appended`);
  return kept.entries;
}

function render({ reviewer, id, attempt, interval, tickets, product, rules, adrs, protocol, retryReason }) {
  const ticketText = tickets.map(item => [`### ${item.id}: ${plain(item.title)}`, `Committed as ${item.shas.join(', ')} (run ${item.runs.join(', ')})`,
    `Goal: ${plain(item.goal)}`, 'Acceptance:', lines(item.acceptance.map(plain)),
    `Files to open with your Read tool, every one, as they stand now, and to report in filesRead. ${OPEN_RULE}:`, toOpen(product, item, 'deleted since')].join('\n')).join('\n\n');
  return [heading(reviewer, id, attempt),
    `You review as ${reviewer} what the team committed since your last periodic review (one every ${interval} committed tickets), less what a triggered review of yours passed. This brief holds no diff and no verification output: open the files. You write nothing in the product and run no shell command. Follow the protocol.`,
    ...(retryReason ? ['## Why you are dispatched again', `Your earlier attempt was refused by the kit: ${retryReason}. This attempt is the last one.`] : []),
    '## Protocol', protocol.trim(), '## Committed tickets', ticketText,
    '## Rules to check, for each ticket: pass, fail or not-checked, with file and line', lines(rules.map(rule => `${rule.id}: ${rule.text}`)),
    '## ADRs to check the change against', adrs.length ? lines(adrs) : 'None listed.',
    '## Report', 'Return your report as JSON in this shape; return it as the last fenced json block of your final message.',
    fenced(JSON.stringify(REPORT(reviewer, '<the briefDigest below>'), null, 2), 'json')].join('\n\n') + '\n';
}

function append(instance, line, words) {
  mkdirSync(join(instance, 'reviews'), { recursive: true });
  appendFileSync(join(instance, PERIODIC_FILE), JSON.stringify(line) + '\n');
  appendFileSync(join(instance, LEDGER), `${line.at.slice(0, 10)} PERIODIC REVIEW ${line.id} ${line.reviewer} ${words}.\n`);
}
// Once no reviewer is due any more, the periodic review is over and the boundary closes.
function closeIfOver(instance, reviewers) {
  const { due } = periodicDue({ instance, reviewers }), boundary = readBoundary(instance);
  if (!due.length && boundary?.periodic) closeBoundary({ teamRoot: instance });
  return due;
}
const afterwards = due => due.length ? `Still due: ${due.map(entry => entry.reviewer).join(', ')}; brief with: rw-batch.mjs periodic-brief --reviewer <reviewer> --instance <instance-root>` : 'The periodic review is over; the next batch may open';

export function periodicBrief({ teamRoot, instanceRoot, reviewer }) {
  try {
    const period = periodOf({ teamRoot, instanceRoot, reviewer }), { instance, review, product, kept } = period;
    const { value: interval, source: intervalSource, note } = hardeningInterval(instance), pending = pendingOf(committedOf(instance), kept, reviewer);
    need(pending.length >= interval, `No periodic review by ${reviewer} is due: ${pending.length} committed ticket(s) since its last, of ${interval} (${note})`);
    const id = period.id ?? `periodic-${new Date().toISOString().replace(/[:.]/g, '-')}`, at = new Date().toISOString(), counted = pending.map(entry => entry.sha);
    const passed = new Map(), scope = pending.filter(entry => { if (!passed.has(entry.runId)) passed.set(entry.runId, passedOf(instance, entry.runId, reviewer)); return !passed.get(entry.runId).has(entry.ticket); });
    if (!scope.length) {
      const line = sealed({ schemaVersion: 1, stage: 'periodic-review', id, reviewer, attempt: 1, briefAttempt: null, briefDigest: null, interval, intervalSource, outcome: 'nothing-to-review', counted, scope: [],
        refusals: [], transcript: null, reportDigest: null, tokens: null, authorizedTokens: null, overrun: null, findings: [], at });
      append(instance, line, `NOTHING TO REVIEW: the ${counted.length} committed ticket(s) since its last were passed by its triggered reviews`);
      return { ...line, next: afterwards(closeIfOver(instance, review.reviewers)) };
    }
    // One entry per ticket id; a ticket committed in two batches is read once, with both commits.
    const byTicket = new Map();
    for (const entry of scope) {
      const changedPaths = (git(product, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', entry.sha) ?? '').split('\0').filter(Boolean);
      need(changedPaths.length, `The commit ${entry.sha.slice(0, 8)} of ticket ${plain(entry.ticket)} cannot be read in the product repository`);
      const unsafe = changedPaths.filter(path => plain(path) !== path);
      need(!unsafe.length, `Ticket ${plain(entry.ticket)} changed ${unsafe.slice(0, 5).map(path => JSON.stringify(path)).join(', ')}, a path holding a control character; it cannot be put in a brief`);
      const frozen = readJSON(join(instance, ARCHIVE, entry.runId, 'batch.json')), ticket = intact(frozen, 'batch-open') ? frozen.tickets.find(item => item.id === entry.ticket) : null;
      const item = byTicket.get(entry.ticket) ?? { id: entry.ticket, title: ticket?.title ?? '(the batch record cannot be read)', goal: ticket?.goal ?? '', acceptance: ticket?.acceptance ?? [], runs: [], shas: [], changedPaths: [] };
      byTicket.set(entry.ticket, { ...item, runs: [...item.runs, entry.runId], shas: [...item.shas, entry.sha], changedPaths: [...new Set([...item.changedPaths, ...changedPaths])] });
    }
    const tickets = [...byTicket.values()].map(item => ({ ...item, flaggedFiles: item.changedPaths, content: contentOf(product, item.changedPaths), links: linksOf(product, item.changedPaths) }));
    if (!period.id) reviewBoundary({ teamRoot: instance, runId: id, reviewers: period.wrappers, periodic: true });
    const refused = triedOf(kept, reviewer, counted).at(-1), retryReason = refused ? refused.refusals.map(item => `${item.code}: ${item.detail}`).join('; ') : null;
    const briefs = briefsOf(instance, reviewer, period.id), latest = briefs.at(-1), attempt = briefs.length + 1, rules = review.rules.filter(rule => rule.reviewer === reviewer);
    // ADR 0011, decision 4, as in a batch review: a brief whose pinned files changed may be made again, since its dispatch could not be judged.
    need(!latest || period.mine.some(line => line.briefAttempt === latest.attempt) || changedSince(product, latest).length,
      `${reviewer}'s periodic brief ${latest?.attempt} has no judged transcript and no recorded no-answer; judge it first with: rw-batch.mjs periodic --reviewer ${reviewer} --transcript <agent-*.jsonl> --instance <instance-root>, or periodic --no-answer "<reason>" --reviewer ${reviewer} --instance <instance-root> if the dispatch left no transcript`);
    const body = render({ reviewer, id, attempt, interval, tickets, product, rules, adrs: review.adrs.map(path => join(instance, path)), protocol: protocolOf(instance), retryReason }), briefDigest = digest(body);
    const record = sealed({ schemaVersion: 1, stage: 'periodic-brief', id, reviewer, wrapper: period.wrappers[reviewer], attempt, briefDigest, madeAt: at, interval, intervalSource, counted,
      tickets: tickets.map(({ id: ticket, runs, shas, changedPaths, flaggedFiles, content, links }) => ({ id: ticket, runs, shas, changedPaths, flaggedFiles, content, links })),
      ruleIds: rules.map(rule => rule.id), adrs: review.adrs, ...(retryReason ? { retryReason } : {}) });
    const path = join(instance, BRIEF_FILE(reviewer));
    writeFileSync(`${path}.tmp`, JSON.stringify({ schemaVersion: 1, id, reviewer, entries: [...briefs, record] }, null, 2) + '\n'); renameSync(`${path}.tmp`, path);
    return { brief: `${body}\nbriefDigest: ${briefDigest}\n`, record };
  } catch (error) { return refuse(error); }
}

// The open periodic review and this reviewer's latest brief, which no line has judged yet.
function judging(options) {
  const period = periodOf(options), { reviewer } = options;
  need(period.id, `No periodic review is open; make ${reviewer}'s brief first with: rw-batch.mjs periodic-brief --reviewer ${reviewer} --instance <instance-root>`);
  const brief = briefsOf(period.instance, reviewer, period.id).at(-1);
  need(brief, `${reviewer} has no brief for ${period.id}; make one with: rw-batch.mjs periodic-brief --reviewer ${reviewer} --instance <instance-root>`);
  need(brief.attempt > (period.mine.at(-1)?.briefAttempt ?? 0), `${reviewer}'s last periodic brief was already judged; brief again with: rw-batch.mjs periodic-brief --reviewer ${reviewer} --instance <instance-root>, and dispatch the reviewer once more`);
  return { ...period, brief };
}

// Records one judgment; the second failed attempt is final, not obtained. `meter` is measure-spawn.mjs --json, or absent.
function record({ instance, review, id, kept, brief }, reviewer, judged, meter) {
  const attempt = triedOf(kept, reviewer, brief.counted).length + 1, outcome = !judged.refusals.length ? 'accepted' : attempt >= ATTEMPTS ? 'not-obtained' : 'refused', at = new Date().toISOString();
  const real = file => { try { return realpathSync(file); } catch { return null; } };
  const row = judged.transcript && Array.isArray(meter?.subagents) ? meter.subagents.find(candidate => !candidate?.workflowRunId && candidate?.agentType === brief.wrapper
    && typeof candidate.file === 'string' && real(candidate.file) === judged.transcript.file && Number.isSafeInteger(candidate.harnessEq)) : null;
  const limit = readJSON(join(instance, MODE_FILE))?.limits?.authorizationPerReviewerCall, authorizedTokens = Number.isSafeInteger(limit) ? limit : null, tokens = row?.harnessEq ?? null;
  const shasOf = ticket => brief.tickets.find(item => item.id === ticket)?.shas ?? [];
  const findings = outcome !== 'accepted' ? [] : judged.tickets.filter(item => item.verdict === 'rejected' || item.item === 'AMBER')
    .map(item => ({ ticket: item.id, shas: shasOf(item.id), verdict: item.item, fails: item.fails, finding: item.finding, ...(item.fix !== undefined ? { fix: item.fix, control: item.control } : {}) }));
  const line = sealed({ schemaVersion: 1, stage: 'periodic-review', id, reviewer, attempt, briefAttempt: brief.attempt, briefDigest: brief.briefDigest, interval: brief.interval, intervalSource: brief.intervalSource, outcome,
    counted: brief.counted, scope: brief.tickets.map(item => ({ ticket: item.id, runs: item.runs, shas: item.shas })), refusals: judged.refusals, transcript: judged.transcript ?? null,
    reportDigest: judged.reportDigest ?? null, tokens, authorizedTokens, overrun: tokens === null || authorizedTokens === null ? null : tokens > authorizedTokens, findings, at });
  const codes = judged.refusals.map(item => item.code).join(', '), cost = tokens === null ? '' : `; ${tokens} token(s) of ${authorizedTokens ?? 'no'} authorized${line.overrun ? ', over' : ''}`;
  append(instance, line, { accepted: `ACCEPTED (attempt ${line.attempt}): ${brief.tickets.length} committed ticket(s) reviewed, ${findings.length ? `${findings.length} finding(s) for the PM to file as tickets: ${findings.map(item => `${item.ticket} ${item.verdict}${item.fails.length ? ` (${item.fails.join(', ')})` : ''}`).join(', ')}` : 'no finding'}${cost}; nothing is held`,
    refused: `REFUSED (attempt ${line.attempt}): ${codes}${cost}`,
    'not-obtained': `NOT OBTAINED (attempt ${line.attempt}): ${codes}${cost}; reported to the owner; the next batch is not stopped` }[outcome]);
  const reason = judged.refusals.map(item => `${item.code}: ${item.detail}`).join('; ');
  if (outcome === 'refused') return { ...line, next: `The report was refused (${reason}). Brief ${reviewer} again with: rw-batch.mjs periodic-brief --reviewer ${reviewer} --instance <instance-root>, and dispatch it once more with that brief` };
  const due = closeIfOver(instance, review.reviewers);
  return { ...line, next: `${outcome === 'not-obtained' ? `The periodic review by ${reviewer} was not obtained: report it to the owner. ` : findings.length ? 'File each finding as a ticket. ' : ''}${afterwards(due)}` };
}

export function judgePeriodic({ teamRoot, instanceRoot, reviewer, transcript, report: given, meter, projectsRoot = projectsOf() }) {
  try {
    const context = judging({ teamRoot, instanceRoot, reviewer }), { brief, product, id, kept } = context;
    let text, file; try { text = readFileSync(transcript, 'utf8'); file = realpathSync(transcript); } catch { need(false, `${plain(transcript)} cannot be read; nothing was recorded`); }
    const fileDigest = bytesDigest(text);
    need(!kept.some(line => line.id === id && line.transcript?.digest === fileDigest), 'This transcript was already judged; nothing was recorded');
    judgeFirst({ projectsRoot, wrapper: brief.wrapper, heading: heading(reviewer, id, brief.attempt), since: brief.madeAt, file, reviewer, command: 'periodic' });
    const moved = changedSince(product, brief);
    need(!moved.length, `${moved.slice(0, 5).map(plain).join(', ')} changed since the brief; brief again with: rw-batch.mjs periodic-brief --reviewer ${reviewer} --instance <instance-root>`);
    const evidence = evidenceOf({ transcript, text, projectsRoot, wrapper: brief.wrapper, reviewer, heading: heading(reviewer, id, brief.attempt), brief, product });
    const refusals = [...evidence.refusals];
    if (evidence.report && given !== undefined && digest(given) !== digest(evidence.report)) refusals.push({ code: 'REVIEW_REPORT_MISMATCH', detail: 'The report file given is not the report the transcript ends with' });
    const derived = evidence.report ? derive(evidence.report, brief, reviewer, product) : { refusals: [], tickets: [] };
    return record(context, reviewer, { refusals: [...refusals, ...derived.refusals], tickets: derived.tickets,
      transcript: { file: evidence.file, digest: fileDigest, agentType: evidence.agentType }, reportDigest: evidence.report ? digest(evidence.report) : null }, meter);
  } catch (error) { return refuse(error); }
}

export function recordPeriodicNoAnswer({ teamRoot, instanceRoot, reviewer, reason, projectsRoot = projectsOf() }) {
  try {
    need(said(reason), 'Give the reason there is no answer');
    const context = judging({ teamRoot, instanceRoot, reviewer }), { brief, id } = context;
    judgeFirst({ projectsRoot, wrapper: brief.wrapper, heading: heading(reviewer, id, brief.attempt), since: brief.madeAt, reviewer, command: 'periodic' });
    return record(context, reviewer, { refusals: [{ code: 'REVIEW_NO_ANSWER', detail: said(reason) }], tickets: [] });
  } catch (error) { return refuse(error); }
}
