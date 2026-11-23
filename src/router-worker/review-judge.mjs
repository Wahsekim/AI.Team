import { readFileSync, writeFileSync, renameSync, lstatSync, realpathSync, appendFileSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { digest, bytesDigest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { readBoundary, stateOf } from './write-boundary.mjs';
import { AFTER_FILE, REVIEW_FILE, VERDICTS_FILE, contentOf, plain } from './batch.mjs';
import { openBatch, intact, Refusal } from './batch-close.mjs';
import { recordOutcomes, outcomesOf, TICKETS } from './escalations.mjs';

// ADR 0011, decisions 13, 17 and 19: the kit judges a reviewer's report from the reviewer's own session transcript
// and derives the verdict itself. Each judgment is appended, sealed, to rw-batch-reviews.json; commit reads it.
// The kit checks where the transcript lies, its shape and that it carries the brief; it cannot prove who wrote it.
export { VERDICTS_FILE };
const LEDGER = 'pm-decisions.md', ATTEMPTS = 2, FINAL = ['accepted', 'not-obtained'], RESULTS = ['pass', 'fail', 'not-checked'], VERDICTS = ['GREEN', 'AMBER', 'RED'];
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const exists = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const sealed = body => ({ ...body, digest: digest(body) });
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === String(b).toLowerCase();
export const said = (text, max = 300) => typeof text === 'string' ? plain(text.trim()).slice(0, max) : '';
const refuse = error => ({ errors: [{ code: 'REVIEW_REFUSED', field: 'review', reason: error instanceof Refusal ? error.message : `The review could not be judged: ${error?.code ?? error?.message}` }] });
export const projectsOf = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

// This reviewer's briefs for the run, each still as it was sealed.
export function briefsOf(instance, reviewer, runId) {
  const path = join(instance, REVIEW_FILE(reviewer));
  if (!exists(path)) return [];
  const kept = readJSON(path);
  need(kept?.runId === runId && kept.reviewer === reviewer && Array.isArray(kept.entries) && kept.entries.every((entry, i) => intact(entry, 'review-brief') && entry.attempt === i + 1),
    `${REVIEW_FILE(reviewer)} was changed, or belongs to another batch; nothing was appended`);
  return kept.entries;
}
export function verdictsOf(instance, runId) {
  const path = join(instance, VERDICTS_FILE);
  if (!exists(path)) return [];
  const kept = readJSON(path);
  need(kept?.runId === runId && Array.isArray(kept.entries) && kept.entries.every(entry => intact(entry, 'review-verdict') && entry.runId === runId),
    `${VERDICTS_FILE} was changed, or belongs to another batch`);
  return kept.entries;
}
export const finalOf = (verdicts, reviewer) => verdicts.find(entry => entry.reviewer === reviewer && FINAL.includes(entry.outcome)) ?? null;

// The batch in review and this reviewer's latest brief, which no verdict has judged yet.
function inReview({ teamRoot, instanceRoot, reviewer }) {
  let instance;
  try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
  const boundary = instance ? readBoundary(instance) : null;
  need(boundary && stateOf(boundary) === 'review', 'No batch is in review in this team');
  const { batch } = openBatch(teamRoot, instanceRoot), after = readJSON(join(instance, AFTER_FILE));
  need(boundary.runId === batch.runId && intact(after, 'batch-closed') && after.batchDigest === batch.digest, `The review state, ${AFTER_FILE} and the open batch do not name the same run`);
  need(batch.review.reviewers.includes(reviewer), `${plain(reviewer)} is not a reviewer of the kit (${batch.review.reviewers.join(', ')})`);
  const verdicts = verdictsOf(instance, batch.runId), final = finalOf(verdicts, reviewer);
  need(!final, `${reviewer}'s review of this batch is already ${final?.outcome}; it is judged once`);
  const brief = briefsOf(instance, reviewer, batch.runId).at(-1), mine = verdicts.filter(entry => entry.reviewer === reviewer);
  need(brief, `${reviewer} has no brief for this batch; make one with: rw-batch.mjs review-brief --reviewer ${reviewer} --instance <instance-root>`);
  need(brief.attempt > (mine.at(-1)?.briefAttempt ?? 0), `${reviewer}'s last brief was already judged; brief again with: rw-batch.mjs review-brief --reviewer ${reviewer} --instance <instance-root>, which carries the reason, and dispatch the reviewer once more`);
  return { instance, batch, after, brief, verdicts, mine };
}

// The text of a transcript entry's content, whether a string or a list of blocks.
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
const flaggedOf = (brief, product) => brief.tickets.flatMap(item => item.flaggedFiles.filter(path => item.content[path] !== null).map(path => ({ ticket: item.id, path, absolute: join(product, path) })));

// What the transcript shows, and the report it ends with. Each gap is a refusal of the report.
// `heading`: the first line of the brief, as the kit printed it.
export function evidenceOf({ transcript, text, projectsRoot, wrapper, reviewer, heading, brief, product }) {
  const refusals = [], gap = (code, detail) => refusals.push({ code, detail });
  let real = null, root = null;
  try { real = realpathSync(transcript); root = realpathSync(projectsRoot); } catch { /* judged below */ }
  const parts = real && root ? relative(root, real).split(sep) : [];
  // An Agent-tool subagent's file: <projects>/<project>/<session>/subagents/agent-<id>.jsonl. An engine run's lies under workflows/.
  if (!(parts.length === 4 && parts[0] !== '..' && !isAbsolute(parts[0]) && parts[2] === 'subagents' && /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(parts[3])))
    gap('REVIEW_TRANSCRIPT_PLACE', `The transcript is not a subagent transcript of a session under ${projectsRoot}/<project>/<session>/subagents/; an engine workflow's agent is not a reviewer`);
  const meta = real ? readJSON(join(dirname(real), basename(real).replace(/\.jsonl$/, '.meta.json'))) : null, agentType = typeof meta?.agentType === 'string' ? meta.agentType : null;
  if (agentType !== wrapper) gap('REVIEW_NOT_REVIEWER', `The transcript's agent is ${plain(agentType ?? 'not named')}, not ${reviewer}'s wrapper ${wrapper}`);
  const entries = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(entry => entry && typeof entry === 'object');
  const prompt = textOf(entries.find(entry => entry.type === 'user')?.message?.content);
  if (prompt.trimStart().startsWith('[Workflow harness')) gap('REVIEW_WORKFLOW_AGENT', 'The transcript starts with a task relayed by the workflow harness: the reviewer was not dispatched by the PM');
  // The brief is in the prompt as it was printed: its body has the digest the brief record holds.
  const start = prompt.indexOf(`${heading}\n`), end = start === -1 ? -1 : prompt.indexOf(`\nbriefDigest: ${brief.briefDigest}`, start);
  if (end === -1 || digest(prompt.slice(start, end)) !== brief.briefDigest) gap('REVIEW_BRIEF_NOT_FOUND', `The transcript's prompt does not carry brief attempt ${brief.attempt} (${brief.briefDigest}) unchanged`);
  const assistant = entries.filter(entry => entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content));
  // A Read counts when its result is not an error and it read the file from its first line with no limit.
  const succeeded = new Set(entries.filter(entry => entry.type === 'user' && Array.isArray(entry.message?.content))
    .flatMap(entry => entry.message.content.filter(block => block?.type === 'tool_result' && block.is_error !== true).map(block => block.tool_use_id)));
  const whole = input => input.limit === undefined && (input.offset === undefined || input.offset <= 1);
  const opened = new Set(assistant.flatMap(entry => entry.message.content.filter(block => block?.type === 'tool_use' && block.name === 'Read' && typeof block.input?.file_path === 'string'
    && succeeded.has(block.id) && whole(block.input)).map(block => block.input.file_path)));
  const unopened = flaggedOf(brief, product).filter(item => !opened.has(item.absolute));
  if (unopened.length) gap('REVIEW_TRANSCRIPT_NO_OPEN', `The transcript shows no Read of ${unopened.slice(0, 5).map(item => plain(item.absolute)).join(', ')}`);
  // A message streamed in several entries shares one id; the report is the last fenced json block of the last one.
  const lastId = assistant.at(-1)?.message.id, last = assistant.filter(entry => lastId !== undefined && entry.message.id === lastId).map(entry => textOf(entry.message.content)).join('\n');
  const blocks = [...last.matchAll(/(`{3,})json[ \t]*\n([\s\S]*?)\n\1[ \t]*(?=\n|$)/g)];
  let report = null; try { report = blocks.length ? JSON.parse(blocks.at(-1)[2]) : null; } catch { /* judged below */ }
  if (!report || typeof report !== 'object' || Array.isArray(report)) gap('REVIEW_NO_REPORT', 'The last message of the transcript holds no fenced json block that is a report');
  return { refusals, agentType, report, file: real ?? resolve(transcript) };
}

// ADR 0011, decision 13, with the owner's answer of 2026-11-20: only a failed rule rejects a ticket, a RED verdict
// must coincide with one, and decision 19: each failed rule comes with a fix and a proposed control.
export function derive(report, brief, reviewer, product) {
  const refusals = [], gap = (code, detail) => refusals.push({ code, detail });
  if (report.schemaVersion !== 1 || report.reviewer !== reviewer || report.briefDigest !== brief.briefDigest || !['filesRead', 'rules', 'items'].every(key => Array.isArray(report[key])))
    return { refusals: [{ code: 'REVIEW_REPORT_SHAPE', detail: `The report must be schemaVersion 1, reviewer ${reviewer}, briefDigest ${brief.briefDigest}, with the lists filesRead, rules and items` }], tickets: [] };
  const read = new Set(report.filesRead.filter(entry => entry?.read === true && typeof entry.path === 'string').map(entry => entry.path));
  const unread = flaggedOf(brief, product).filter(item => !read.has(item.path) && !read.has(item.absolute));
  if (unread.length) gap('REVIEW_FILE_NOT_READ', `The report does not list as read: ${unread.slice(0, 5).map(item => plain(item.path)).join(', ')}`);
  const tickets = brief.tickets.map(({ id }) => {
    const conflicts = brief.ruleIds.filter(rule => new Set(report.rules.filter(row => row?.rule === rule && same(row.ticket, id)).map(row => row.result)).size > 1);
    if (conflicts.length) gap('REVIEW_RULE_CONFLICT', `Ticket ${id}: ${conflicts.join(', ')} reported more than once with different results`);
    const rows = brief.ruleIds.map(rule => report.rules.find(row => row?.rule === rule && same(row.ticket, id) && RESULTS.includes(row.result)));
    const missing = brief.ruleIds.filter((_, i) => !rows[i]);
    if (missing.length) gap('REVIEW_RULE_MISSING', `Ticket ${id}: no pass, fail or not-checked for ${missing.join(', ')}`);
    const fails = brief.ruleIds.filter((_, i) => rows[i]?.result === 'fail'), notChecked = brief.ruleIds.filter((_, i) => rows[i]?.result === 'not-checked');
    if (brief.ruleIds.length && notChecked.length === brief.ruleIds.length) gap('REVIEW_ALL_NOT_CHECKED', `Ticket ${id}: every rule is not-checked`);
    if (new Set(report.items.filter(entry => same(entry?.ticket, id)).map(entry => entry.verdict)).size > 1) gap('REVIEW_ITEM_CONFLICT', `Ticket ${id}: listed more than once with different verdicts`);
    const item = report.items.find(entry => same(entry?.ticket, id) && VERDICTS.includes(entry.verdict));
    if (!item) gap('REVIEW_ITEM_MISSING', `Ticket ${id}: no GREEN, AMBER or RED verdict`);
    else if ((item.verdict === 'RED') !== (fails.length > 0)) gap('REVIEW_VERDICT_MISMATCH', `Ticket ${id}: ${item.verdict} with ${fails.length ? `the failed rule(s) ${fails.join(', ')}` : 'no failed rule'}; RED goes with a failed rule and only with one`);
    const control = item?.control;
    if (fails.length && !(said(item?.fix) && said(control?.detects) && said(control?.variation) && typeof control?.toolCanDetect === 'boolean'))
      gap('REVIEW_CONTROL_MISSING', `Ticket ${id}: a failed rule needs a fix and a proposed control (detects, variation, toolCanDetect)`);
    return { id, verdict: fails.length ? 'rejected' : 'passed', item: item?.verdict ?? null, fails, notChecked, finding: said(item?.finding),
      ...(fails.length ? { fix: said(item?.fix), control: { detects: said(control?.detects), variation: said(control?.variation), toolCanDetect: control?.toolCanDetect === true } } : {}) };
  });
  return { refusals, tickets };
}

// Records one judgment. The second failed attempt is final: the review was not obtained.
function record({ instance, batch, after, brief, verdicts, mine }, reviewer, judged) {
  const outcome = !judged.refusals.length ? 'accepted' : mine.length + 1 >= ATTEMPTS ? 'not-obtained' : 'refused', at = new Date().toISOString();
  const reason = judged.refusals.map(item => `${item.code}: ${item.detail}`).join('; ');
  const tickets = outcome === 'accepted' ? judged.tickets : outcome === 'not-obtained' ? brief.tickets.map(item => ({ id: item.id, verdict: 'not-obtained' })) : [];
  const entry = sealed({ schemaVersion: 1, stage: 'review-verdict', runId: batch.runId, reviewer, attempt: mine.length + 1, briefAttempt: brief.attempt, briefDigest: brief.briefDigest,
    outcome, refusals: judged.refusals, transcript: judged.transcript ?? null, reportDigest: judged.reportDigest ?? null, tickets, judgedAt: at });
  // The lines across batches go first: they are written once, so a judgment that died before its verdict is judged again.
  const outcomes = tickets.filter(item => item.verdict !== 'passed').map(item => ({ ticket: item.id, outcome: item.verdict, finding: item.verdict === 'rejected' ? item.finding : said(reason) }));
  // An escalation carries the paths the ticket changed, which are the paths of its held patch, not its grants.
  const changed = batch.tickets.map(ticket => ({ id: ticket.id, paths: after.tickets.find(entry => entry.id === ticket.id)?.changedPaths ?? ticket.paths }));
  const escalated = outcomes.length ? recordOutcomes({ instance, runId: batch.runId, reviewer, outcomes, tickets: changed, at }) : [];
  const path = join(instance, VERDICTS_FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify({ schemaVersion: 1, runId: batch.runId, entries: [...verdicts, entry] }, null, 2) + '\n'); renameSync(`${path}.tmp`, path);
  const passed = tickets.filter(item => item.verdict === 'passed').map(item => item.id), rejected = tickets.filter(item => item.verdict === 'rejected');
  const unchecked = tickets.flatMap(item => (item.notChecked ?? []).map(rule => `${rule} on ${item.id}`));
  const words = { accepted: 'ACCEPTED', refused: 'REFUSED', 'not-obtained': 'NOT OBTAINED' }[outcome];
  appendFileSync(join(instance, LEDGER), `${at.slice(0, 10)} REVIEW ${batch.runId} ${reviewer} ${words} (attempt ${entry.attempt})${outcome === 'accepted'
    ? `: passed ${passed.join(', ') || 'none'}; rejected ${rejected.map(item => `${item.id} (${item.fails.join(', ')})`).join(', ') || 'none'}${unchecked.length ? `; not checked: ${unchecked.join(', ')}` : ''}`
    : `: ${judged.refusals.map(item => item.code).join(', ')}${outcome === 'not-obtained' ? `; held: ${tickets.map(item => item.id).join(', ')}` : ''}`}.\n`);
  const next = outcome === 'refused' ? `The report was refused (${reason}). Brief ${reviewer} again with: rw-batch.mjs review-brief --reviewer ${reviewer} --instance <instance-root>, and dispatch it once more with that brief`
    : outcome === 'not-obtained' ? `The review by ${reviewer} was not obtained; its tickets are not committed. Once every reviewer is judged, run: rw-batch.mjs resolve --instance <instance-root>, then rw-batch.mjs commit --instance <instance-root>`
    : 'The verdict is recorded; once every reviewer is judged, run: rw-batch.mjs resolve --instance <instance-root>, then rw-batch.mjs commit --instance <instance-root>';
  return { ...entry, escalated, next };
}

export function judgeReview({ teamRoot, instanceRoot, reviewer, transcript, report: given, projectsRoot = projectsOf() }) {
  try {
    const context = inReview({ teamRoot, instanceRoot, reviewer }), { batch, brief, verdicts } = context, product = batch.productRoot;
    let text; try { text = readFileSync(transcript, 'utf8'); } catch { need(false, `${plain(transcript)} cannot be read; nothing was recorded`); }
    const fileDigest = bytesDigest(text);
    need(!verdicts.some(entry => entry.transcript?.digest === fileDigest), 'This transcript was already judged; nothing was recorded');
    // What the reviewer read must still be what is committed; a change since the brief is the PM's to undo, not the reviewer's attempt.
    const recorded = Object.assign({}, ...brief.tickets.map(item => item.content)), now = contentOf(product, Object.keys(recorded));
    const moved = Object.keys(recorded).filter(path => now[path] !== recorded[path]);
    need(!moved.length, `${moved.slice(0, 5).map(plain).join(', ')} changed since the brief; the review would not judge what is committed. Restore it, or abort the batch`);
    const evidence = evidenceOf({ transcript, text, projectsRoot, wrapper: brief.wrapper, reviewer, heading: `# Batch review brief: ${reviewer}, run ${batch.runId}, attempt ${brief.attempt}`, brief, product });
    const refusals = [...evidence.refusals];
    if (evidence.report && given !== undefined && digest(given) !== digest(evidence.report)) refusals.push({ code: 'REVIEW_REPORT_MISMATCH', detail: 'The report file given is not the report the transcript ends with' });
    const derived = evidence.report ? derive(evidence.report, brief, reviewer, product) : { refusals: [], tickets: [] };
    return record(context, reviewer, { refusals: [...refusals, ...derived.refusals], tickets: derived.tickets,
      transcript: { file: evidence.file, digest: fileDigest, agentType: evidence.agentType }, reportDigest: evidence.report ? digest(evidence.report) : null });
  } catch (error) { return refuse(error); }
}

// The reviewer gave no answer: an attempt with no report.
export function recordNoAnswer({ teamRoot, instanceRoot, reviewer, reason }) {
  try {
    need(said(reason), 'Give the reason there is no answer');
    return record(inReview({ teamRoot, instanceRoot, reviewer }), reviewer, { refusals: [{ code: 'REVIEW_NO_ANSWER', detail: said(reason) }], tickets: [] });
  } catch (error) { return refuse(error); }
}

// Why a review holds each planned commit once the reviews are over: null, "rejected" or "review-not-obtained". A
// flagged ticket, by a trigger or an elective brief, needs a passed verdict from each of its reviewers.
export function reviewGate(instance, batch, after) {
  const needs = new Map((after.tickets ?? []).filter(ticket => ticket.review?.required.length).map(ticket => [ticket.id, new Set(ticket.review.required)]));
  for (const reviewer of batch.review.reviewers) for (const brief of briefsOf(instance, reviewer, batch.runId))
    for (const item of brief.tickets.filter(entry => entry.elective)) needs.set(item.id, new Set([...(needs.get(item.id) ?? []), reviewer]));
  const verdicts = verdictsOf(instance, batch.runId);
  // The lines across batches are written before the verdict: one the verdicts do not show means they were changed or removed.
  const lost = outcomesOf(instance, batch.runId).filter(line => finalOf(verdicts, line.reviewer)?.tickets.find(item => same(item.id, line.ticket))?.verdict !== line.outcome);
  need(!lost.length, `${lost.slice(0, 5).map(line => `${plain(String(line.ticket))} (${plain(String(line.outcome))} by ${plain(String(line.reviewer))})`).join(', ')} ${lost.length > 1 ? 'are' : 'is'} recorded in ${TICKETS} for this batch, but ${VERDICTS_FILE} does not show it: the verdicts were changed or removed. Restore them, or abort the batch`);
  const open = new Set(), reasons = after.commits.map(commit => {
    const outcomes = [...(needs.get(commit.ticket) ?? [])].map(reviewer => {
      const final = finalOf(verdicts, reviewer);
      if (!final) { open.add(reviewer); return null; }
      const verdict = final.tickets.find(item => item.id === commit.ticket)?.verdict;
      return verdict === 'passed' ? null : verdict === 'rejected' ? 'rejected' : 'review-not-obtained';
    });
    return outcomes.find(reason => reason === 'rejected') ?? outcomes.find(Boolean) ?? null;
  });
  need(!open.size, `The review of this batch is not over: ${[...open].join(', ')} ${open.size > 1 ? 'have' : 'has'} no verdict. Brief, dispatch and judge with: rw-batch.mjs review-brief --reviewer <reviewer> --instance <instance-root>, then rw-batch.mjs review --reviewer <reviewer> --transcript <agent-*.jsonl> --instance <instance-root> (or review --no-answer "<reason>"), or abort the batch`);
  return { reasons, flagged: needs.size > 0 };
}
