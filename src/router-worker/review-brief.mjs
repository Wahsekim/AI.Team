import { readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { digest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';
import { gitRun } from './lease.mjs';
import { readBoundary, stateOf } from './write-boundary.mjs';
import { runCommands, confirmedOf } from './run-commands.mjs';
import { AFTER_FILE, REVIEW_FILE, contentOf, plain } from './batch.mjs';
import { openBatch, intact, Refusal } from './batch-close.mjs';
import { briefsOf, verdictsOf, finalOf, headingOf, changedSince, madeBefore } from './review-judge.mjs';
import { READ_RULE, readingOf, linksOf } from './read-coverage.mjs';
export { REVIEW_FILE };

// ADR 0011, decisions 11 and 12: the brief a reviewer of a batch in review works from. The kit builds it from what
// it froze and what is in the product, never from a worker's report, the checker's verdict or another reviewer.
// Each brief is recorded, sealed, in rw-batch-review-<reviewer>.json, which the judging of the review reads.
const KIT = fileURLToPath(new URL('../../', import.meta.url));
const PROTOCOL = 'agents/router-worker-review.md', KIT_PROTOCOL = 'config/router-worker/review-protocol.md';
const DIFF_CAP = 60000;
// A fence longer than any backtick run in the text, so the text cannot close it.
export const fenced = (text, info = '') => { const fence = '`'.repeat(Math.max(4, ...(text.match(/`+/g) ?? []).map(run => run.length + 1))); return `${fence}${info}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`; };
const need = (condition, reason) => { if (!condition) throw new Refusal(reason); };
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const sealed = body => ({ ...body, digest: digest(body) });
export const lines = value => (Array.isArray(value) ? value : [value]).map(item => `- ${item}`).join('\n');

// How a reviewer reads a flagged file, in a batch brief and a periodic one alike; the judging applies the same rule.
export const OPEN_RULE = `${READ_RULE}. A file marked below with ranges is read with the limit it gives, at each offset it gives, so that no Read is cut. A file marked as not opened is not read. A line not covered refuses the report`;
// Each flagged path as the reviewer is told to open it, by its kind. `gone`: what a path that is no file any more became.
export const toOpen = (product, item, gone) => lines(item.flaggedFiles.map(path => {
  const file = readingOf(product, item, path), { absolute, kind, limit } = file;
  if (kind === 'link') return `${absolute} (a symbolic link to ${JSON.stringify(plain(file.target))}: not opened; that target is its content)`;
  if (kind === 'deleted') return `${absolute} (${gone}: nothing to open)`;
  if (kind === 'binary') return `${absolute} (a binary file: not opened; the Read tool does not show it)`;
  if (kind === 'misnamed') return `${absolute} (named as an image, a PDF or a notebook, but its bytes are not one: not opened; the Read tool cannot show it)`;
  if (kind === 'large') return `${absolute} (${Math.ceil(file.size / 1024)} KB, too large to read whole: not opened; judge it from its diff where this brief shows one, and report a rule you cannot judge from it as not-checked, naming this file in its note)`;
  if (kind === 'media') return `${absolute} (an image, a PDF or a notebook: one Read of it)`;
  if (!limit) return absolute;
  const count = Math.ceil(file.lines / limit), at = i => 1 + i * limit;
  const offsets = count > 6 ? `${at(0)}, ${at(1)}, ${at(2)} and so on to ${at(count - 1)}` : Array.from({ length: count }, (_, i) => at(i)).join(', ');
  return `${absolute} (${file.lines} lines, ${Math.ceil(file.size / 1024)} KB: read it in ranges, each Read with limit ${limit}, at offsets ${offsets})`;
}));

// The ticket paths' change from the batch's start, untracked files included, through an index of its own; over the cap,
// also each path's own, renames not followed, so a path's removed lines stay with it.
function diffOf(product, head, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'rw-review-')), env = { GIT_INDEX_FILE: join(dir, 'index') };
  const diff = (...options) => gitRun(product, ['--literal-pathspecs', 'diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', ...options], { env });
  try {
    const steps = [gitRun(product, ['read-tree', head], { env }),
      gitRun(product, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: paths.join('\0') })];
    const whole = diff(head), each = fenced(whole.stdout ?? '', 'diff').length > DIFF_CAP ? paths.map(path => diff('--no-renames', head, '--', path)) : [];
    need([...steps, whole, ...each].every(step => step.status === 0 && !step.error), 'The diff of the tickets could not be made');
    return { whole: whole.stdout, files: each.length ? paths.map((path, i) => ({ path, diff: each[i].stdout })) : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// The ways one path's diff can be shown, longest first: whole, its removed lines under their hunk headers, a line naming it.
function blocksOf({ path, diff }) {
  const rows = diff.split('\n'), start = rows.findIndex(row => row.startsWith('@@'));
  if (start === -1 && rows.some(row => row.startsWith('Binary files '))) return [`${path}: a binary file\n${fenced(diff, 'diff')}`, `${path}: a binary file, changed; not shown`];
  const hunks = start === -1 ? [] : rows.slice(start), added = hunks.filter(row => row.startsWith('+')).length, removed = hunks.filter(row => row.startsWith('-')).length;
  const minus = [...(start === -1 ? rows : rows.slice(0, start)), ...hunks.filter(row => row.startsWith('@@') || row.startsWith('-'))].join('\n');
  return [`${path}: its whole diff\n${fenced(diff, 'diff')}`,
    `${path}: its removed lines only, under their hunk headers; its ${added} added lines are not shown${added ? ': open it with your Read tool for them' : ''}\n${fenced(minus, 'diff')}`,
    `${path}: not shown, ${added} lines added and ${removed} removed.${added ? ' Open it with your Read tool for its added lines.' : ''} Its removed lines are not in this brief: report a rule that rests on them as not-checked for this ticket, and do not guess`];
}
// Over the cap, each changed path in ticket order, shown as fully as the room left allows; once not even its line fits, one line
// names the rest while it fits and counts the others. Every character of the section counts against the cap.
function overCap({ whole, files }, resumed) {
  const intro = `The diff is ${whole.length} characters, over the cap of ${DIFF_CAP}. Each changed path follows in ticket order: its whole diff while this section fits in the cap, otherwise its removed lines, otherwise a line naming it.`;
  const rest = (paths, named = 0) => `${paths.length} more changed path(s) of the tickets above are not shown here${named ? `: ${paths.slice(0, named).join(', ')}${named < paths.length ? `, and ${paths.length - named} more` : ''}` : ''}. Open each with your Read tool for its change. Their removed lines are not in this brief: report a rule that rests on them as not-checked, and do not guess.`;
  const reserved = rest(files.map(file => file.path)).length;
  let room = DIFF_CAP - [intro, ...resumed].join('\n\n').length - reserved - 2;
  const shown = [];
  for (const file of files) {
    const block = blocksOf(file).find(text => text.length + 2 <= room);
    if (block === undefined) break;
    shown.push(block); room -= block.length + 2;
  }
  const left = files.slice(shown.length).map(file => file.path);
  let named = 0;
  while (named < left.length && rest(left, named + 1).length <= reserved + room) named++;
  return [intro, ...shown, ...(left.length ? [rest(left, named)] : []), ...resumed].join('\n\n');
}

export const REPORT = (reviewer, briefDigest) => ({ schemaVersion: 1, reviewer, briefDigest,
  filesRead: [{ path: '<flagged path>', read: true }],
  rules: [{ rule: '<rule id>', ticket: '<ticket id>', result: 'pass|fail|not-checked', file: '<path>', line: 1, note: '<what was checked>' }],
  items: [{ ticket: '<ticket id>', verdict: 'GREEN|AMBER|RED', finding: '<finding>', fix: '<fix>', control: { detects: '<what a control would detect>', variation: '<the variation it must also catch>', toolCanDetect: true } }],
  residualRisk: '<what remains>' });

function render({ instance, batch, reviewer, attempt, tickets, diff, rules, adrs, verification, dropped, protocol, retryReason }) {
  const ticketText = tickets.map(({ ticket, frozen, elective, flaggedFiles, content, links, because }) => [
    `### ${ticket.id}: ${frozen.title}`, `Goal: ${frozen.goal}`, 'Acceptance:', lines(frozen.acceptance),
    `Review: ${elective ? 'elective (named by the PM; it binds like a required one)' : `required (${because.map(entry => `${entry.trigger ?? `declared ${plain(entry.declared)}`} on ${plain(entry.path)}`).join(', ')})`}`,
    `Files to open with your Read tool, every one, and to report in filesRead. ${OPEN_RULE}:`,
    toOpen(batch.productRoot, { flaggedFiles, content, links }, 'deleted by the ticket'),
    `Changed paths of the ticket: ${ticket.changedPaths.join(', ')}`].join('\n')).join('\n\n');
  const resumed = tickets.filter(({ frozen }) => frozen.resume).map(({ ticket, frozen }) => `${ticket.id} resumed earlier work: its patch is ${join(instance, frozen.resume.patch)}; read it whole for the change it made, then the changed paths for what this batch added`);
  const diffText = !diff.files ? fenced(diff.whole, 'diff') : overCap(diff, resumed);
  const runs = verification.map(run => `### \`${run.command}\`: exit ${run.exit}${run.timedOut ? ' (stopped at the time limit)' : ''}\n${fenced(run.tail)}`).join('\n\n');
  return [headingOf(reviewer, batch.runId, attempt),
    `You review the tickets below as ${reviewer}. You write nothing in the product and run no shell command: the kit ran the verification commands and gives their output here. Follow the protocol.`,
    ...(retryReason ? ['## Why you are dispatched again', `Your earlier attempt was refused by the kit: ${retryReason}. This attempt is the last one.`] : []),
    '## Protocol', protocol.trim(), '## Tickets', ticketText, `## Diff from ${batch.productHead}`, diffText,
    '## Rules to check, for each ticket: pass, fail or not-checked, with file and line', lines(rules.map(rule => `${rule.id}: ${rule.text}`)),
    '## ADRs to check the change against', adrs.length ? lines(adrs) : 'None listed.',
    '## Verification run by the kit, from the product root', runs || 'No command was run.',
    ...(dropped.length ? [`Frozen in the batch but no longer confirmed for the team, so not run: ${dropped.join(' | ')}`] : []),
    '## Report', 'Return your report as JSON in this shape; return it as the last fenced json block of your final message.',
    fenced(JSON.stringify(REPORT(reviewer, '<the briefDigest below>'), null, 2), 'json')].join('\n\n') + '\n';
}

// The team's own review protocol, or the kit's.
export function protocolOf(instance) {
  try { return readFileSync(join(instance, PROTOCOL), 'utf8'); } catch { return readFileSync(join(KIT, KIT_PROTOCOL), 'utf8'); }
}

export function reviewBrief({ teamRoot, instanceRoot, reviewer, tickets: named = [], run = runCommands }) {
  try {
    let instance;
    try { instance = instanceOf(resolve(teamRoot), instanceRoot); } catch (error) { need(false, `The two-root layout is required (${error.message})`); }
    const boundary = instance ? readBoundary(instance) : null;
    need(boundary && stateOf(boundary) === 'review', 'No batch is in review in this team');
    const { batch } = openBatch(teamRoot, instanceRoot), after = readJSON(join(instance, AFTER_FILE));
    need(boundary.runId === batch.runId && intact(after, 'batch-closed') && after.batchDigest === batch.digest, `The review state, ${AFTER_FILE} and the open batch do not name the same run`);
    need(batch.review.reviewers.includes(reviewer), `${plain(reviewer)} is not a reviewer of the kit (${batch.review.reviewers.join(', ')})`);
    const wrapper = batch.reviewWrappers[reviewer];
    need(boundary.wrappers[wrapper]?.duty === 'review' && boundary.wrappers[wrapper].reviewer === reviewer, `The write boundary does not judge ${reviewer}'s wrapper; it was changed`);
    const entries = briefsOf(instance, reviewer, batch.runId), verdicts = verdictsOf(instance, batch.runId), final = finalOf(verdicts, reviewer), product = batch.productRoot;
    need(!final, `${reviewer}'s review of this batch is over (${final?.outcome}); no further brief is made`);
    // ADR 0011, decision 4: a brief may have been dispatched until a verdict judges it. One whose commands failed, or whose pinned
    // files changed, or one the earlier kit made, may be made again first: its dispatch could not be judged.
    const mine = verdicts.filter(entry => entry.reviewer === reviewer), latest = entries.at(-1);
    need(!latest || mine.some(entry => entry.briefAttempt === latest.attempt) || latest.verification.some(run => run.exit !== 0 || run.timedOut) || changedSince(product, latest).length || madeBefore(latest),
      `${reviewer}'s brief ${latest?.attempt} has no judged transcript and no recorded no-answer; judge it first with: rw-batch.mjs review --reviewer ${reviewer} --transcript <agent-*.jsonl> --instance <instance-root>, or review --no-answer "<reason>" --reviewer ${reviewer} --instance <instance-root> if the dispatch left no transcript`);
    // ADR 0011, decision 17: a reviewer dispatched again after a refused report is told why.
    const refused = mine.at(-1), retryReason = refused ? refused.refusals.map(item => `${item.code}: ${item.detail}`).join('; ') : null;
    const required = after.reviews?.[reviewer]?.tickets ?? [];
    for (const id of named) {
      const outcome = after.tickets.find(entry => entry.id === id);
      need(outcome?.status === 'passed' && outcome.changedPaths.length > 0, `Ticket ${plain(id)} is not a ticket of this batch that passed with changes; there is nothing of it to review`);
    }
    // An elective review, once briefed, stays in every later brief of that reviewer.
    const elective = new Set([...entries.flatMap(entry => entry.tickets.filter(item => item.elective).map(item => item.id)), ...named].filter(id => !required.includes(id)));
    const chosen = after.tickets.filter(entry => required.includes(entry.id) || elective.has(entry.id));
    need(chosen.length, `There is no ticket of this batch for ${reviewer} to review; name one with --ticket for an elective review`);

    // A path the reviewer is told to open goes into the brief as it is: one holding a control character could forge a section of it.
    for (const ticket of chosen) {
      const unsafe = ticket.changedPaths.filter(path => plain(path) !== path);
      need(!unsafe.length, `Ticket ${ticket.id} changed ${unsafe.slice(0, 5).map(path => JSON.stringify(path)).join(', ')}, a path holding a control character; it cannot be put in a brief. Rename it, or abort the batch`);
    }
    // What the reviewer reads is what after saw: a briefed path that changed since then is not reviewed.
    const recorded = Object.assign({}, ...chosen.map(entry => entry.content ?? {})), briefed = [...new Set(chosen.flatMap(ticket => ticket.changedPaths))];
    const unchanged = () => { const now = contentOf(product, briefed); return briefed.filter(path => !Object.hasOwn(recorded, path) || now[path] !== recorded[path]); };
    const moved = unchanged();
    need(!moved.length, `${moved.slice(0, 5).map(plain).join(', ')} changed since after; the review would not see what is committed. Restore it, or abort the batch`);
    const tickets = chosen.map(ticket => {
      const because = elective.has(ticket.id) ? [] : ticket.review.because.filter(entry => entry.reviewer === reviewer);
      const flaggedFiles = elective.has(ticket.id) ? ticket.changedPaths : [...new Set(because.map(entry => entry.path))];
      return { ticket, frozen: batch.tickets.find(entry => entry.id === ticket.id), elective: elective.has(ticket.id), because, flaggedFiles,
        content: Object.fromEntries(flaggedFiles.map(path => [path, recorded[path]])), links: linksOf(product, flaggedFiles) };
    });

    const { allowed, commands, dropped } = confirmedOf(instance, batch.verificationCommands);
    const verification = run({ productRoot: product, commands, frozen: batch.verificationCommands, allowed });
    need(!verification.errors, verification.errors?.[0]?.reason);
    const touched = unchanged();
    need(!touched.length, `A verification command changed ${touched.slice(0, 5).map(plain).join(', ')}; the review would not see what is committed. Restore it, or abort the batch`);

    const rules = batch.review.rules.filter(rule => rule.reviewer === reviewer), adrs = batch.review.adrs.map(path => join(instance, path));
    const protocol = protocolOf(instance);
    const attempt = entries.length + 1, diff = diffOf(product, batch.productHead, briefed);
    const body = render({ instance, batch, reviewer, attempt, tickets, diff, rules, adrs, verification, dropped, protocol, retryReason }), briefDigest = digest(body);
    const brief = `${body}\nbriefDigest: ${briefDigest}\n`;
    // The briefs of a batch are numbered across its reviewers, so resolve can tell which run of the commands came last.
    const seq = 1 + Math.max(0, ...batch.review.reviewers.flatMap(name => briefsOf(instance, name, batch.runId)).map(entry => entry.seq ?? 0));
    const record = sealed({ schemaVersion: 1, stage: 'review-brief', runId: batch.runId, reviewer, wrapper, attempt, seq, briefDigest, madeAt: new Date().toISOString(),
      tickets: tickets.map(({ ticket, frozen, elective: chosenElectively, flaggedFiles, content, links }) => ({ id: ticket.id, elective: chosenElectively, goal: frozen.goal, acceptance: frozen.acceptance, changedPaths: ticket.changedPaths, flaggedFiles, content, links })),
      ruleIds: rules.map(rule => rule.id), adrs: batch.review.adrs, verification: verification.map(({ tail, ...kept }) => kept), dropped, ...(retryReason ? { retryReason } : {}) });
    const path = join(instance, REVIEW_FILE(reviewer));
    writeFileSync(`${path}.tmp`, JSON.stringify({ schemaVersion: 1, runId: batch.runId, reviewer, entries: [...entries, record] }, null, 2) + '\n'); renameSync(`${path}.tmp`, path);
    // resolve holds the batch on a failure here while it is the latest brief of the batch, so the PM hears of it now.
    const failed = verification.filter(entry => entry.exit !== 0 || entry.timedOut).map(entry => `${plain(entry.command)} (${entry.timedOut ? 'timed out' : `exit ${entry.exit}`})`);
    const notice = failed.length ? `A verification command failed or timed out when this brief was made: ${failed.join(', ')}. If it is flaky or its cause is gone, brief again with: rw-batch.mjs review-brief --reviewer ${reviewer} --instance <instance-root> before dispatching the reviewer; resolve reads the latest brief of any reviewer.` : undefined;
    return { brief, record, ...(notice ? { notice } : {}) };
  } catch (error) {
    return { errors: [{ code: 'REVIEW_REFUSED', field: 'review', reason: error instanceof Refusal ? error.message : `The brief could not be made: ${error?.code ?? error?.message}` }] };
  }
}
