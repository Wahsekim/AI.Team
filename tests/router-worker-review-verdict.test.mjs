// ADR 0011, decisions 13, 16, 17 and 19: the kit judges a reviewer's report from its transcript, gates the commit
// on the verdicts, and escalates a ticket that keeps failing review to the owner without stopping unrelated work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, appendFileSync, existsSync, utimesSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../src/loop/contracts.mjs';
import { spawnSync, spawn } from 'node:child_process';
import { abortBatch } from '../src/router-worker/batch.mjs';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { VERDICTS_FILE } from '../src/router-worker/review-judge.mjs';
import { REVIEW_FILE } from '../src/router-worker/review-brief.mjs';
import { proposeAcknowledge, acknowledgeEscalation, recordOutcomes, blockedTickets } from '../src/router-worker/escalations.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { refusal, ticket, batchOf, live, changed, runBatch, edits, reportOf, failing, transcriptOf } from './fixtures/router-worker/review.mjs';

// Security's review as before its first brief: no brief, no verdict, no dispatch.
const fresh = f => { for (const path of [join(f.root, VERDICTS_FILE), join(f.root, REVIEW_FILE('security')), f.projectsRoot]) rmSync(path, { recursive: true, force: true }); };
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a passed review lets the flagged ticket commit and resolve ends the review state; commit waits for the review and the resolution', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js']), ticket('US-02', ['src/list/view.js'])], edits(['src/authz.js', 'src/list/view.js']));
  assert.match(refusal(f.commit()).reason, /review of this batch is not over.*security/);
  const made = f.brief('security'), path = transcriptOf(f, made), report = join(f.base, 'REPORT.json');
  writeFileSync(report, JSON.stringify(reportOf(made)));
  const cli = (...argv) => spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'review', ...argv], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: f.base } });
  assert.equal(cli('--reviewer', 'security', '--instance', f.root).status, 1, 'usage: no transcript');
  const run = cli('--reviewer', 'security', '--transcript', path, '--instance', f.root, report);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const verdict = JSON.parse(run.stdout);
  assert.equal(verdict.outcome, 'accepted'); assert.deepEqual(verdict.tickets.map(item => [item.id, item.verdict]), [['US-01', 'passed']]);
  assert.deepEqual(verdict.transcript.agentType, made.record.wrapper);
  assert.match(f.ledger(), /REVIEW \S+ security ACCEPTED/);
  assert.match(refusal(f.judge('security', path)).reason, /already accepted/, 'a reviewer is judged once');
  assert.match(refusal(f.commit()).reason, /rw-batch\.mjs resolve/, 'a flagged batch commits only after its resolution');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors)); assert.deepEqual(resolved.removed, []); assert.equal(resolved.verification.ran, false);
  assert.equal(f.state(), 'closed', 'resolve ends the review state');
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01', 'US-02']); assert.deepEqual(committed.held, []);
  assert.ok(existsSync(join(f.root, 'batches', committed.runId, 'reviews.json')), 'the verdicts are archived with the batch');
});

test('a failed rule rejects its ticket: it is held as a patch, the other tickets commit once the commands pass again, an AMBER concern does not reject', async t => {
  const f = live(t), paths = ['src/session.js', 'src/list/a.js', 'src/authz.js', 'src/list/b.js'];
  const { open } = await runBatch(f, paths.map((path, i) => ticket(`US-0${i + 1}`, [path])), edits(paths));
  const made = f.brief('security'), base = reportOf(made);
  const report = failing({ ...base, items: base.items.map(item => item.ticket === 'US-01' ? { ...item, verdict: 'AMBER', finding: 'the session lifetime is long' } : item) }, 'US-03', 'kit.sec.secret-in-code');
  const rejecting = transcriptOf(f, made, { report }), verdict = f.judge('security', rejecting);
  assert.equal(verdict.outcome, 'accepted', JSON.stringify(verdict));
  assert.deepEqual(verdict.tickets.map(item => [item.id, item.verdict, item.fails]), [['US-01', 'passed', []], ['US-03', 'rejected', ['kit.sec.secret-in-code']]]);
  assert.equal(verdict.tickets[0].finding, 'the session lifetime is long', 'the AMBER concern is kept for the PM\'s backlog');
  assert.deepEqual(f.lines('reviews/tickets.jsonl').map(line => [line.ticket, line.runId, line.reviewer, line.outcome, line.finding]), [['US-03', open.runId, 'security', 'rejected', 'a token is written in code']]);
  // Deleting the verdicts and the judged transcript lets the reviewer be judged again; the lines across batches still hold the rejection.
  const kept = f.read(VERDICTS_FILE);
  rmSync(join(f.root, VERDICTS_FILE)); rmSync(rejecting); assert.equal(f.judge('security', transcriptOf(f, made)).outcome, 'accepted');
  assert.match(refusal(f.commit()).reason, /US-03.*rejected.*reviews\/tickets\.jsonl/);
  writeFileSync(join(f.root, VERDICTS_FILE), kept);
  assert.equal(f.resolve().errors, undefined);
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01', 'US-02', 'US-04']);
  assert.deepEqual(committed.held.map(entry => [entry.ticket, entry.reason]), [['US-03', 'rejected']]);
  assert.deepEqual(changed(f), [], 'the rejected ticket is a patch, not a change left in the work tree');
  assert.match(f.ledger(), /COMMITTED.*held: US-03 \(rejected\)/);
});

test('the kit refuses a report that does not show the work, and a transcript that is not the reviewer\'s own session', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  const check = (why, code, shape) => {
    fresh(f);
    const made = f.brief('security'), verdict = f.judge('security', ...shape(made));
    assert.equal(verdict.errors, undefined, `${why}: ${JSON.stringify(verdict.errors)}`);
    assert.equal(verdict.outcome, 'refused', why); assert.ok(verdict.refusals.some(item => item.code === code), `${why}: ${JSON.stringify(verdict.refusals)}`);
    assert.match(verdict.next, /review-brief --reviewer security.*once more/, why);
  };
  check('a flagged file not listed as read', 'REVIEW_FILE_NOT_READ', made => [transcriptOf(f, made, { report: { ...reportOf(made), filesRead: [] } })]);
  check('every rule not checked', 'REVIEW_ALL_NOT_CHECKED', made => [transcriptOf(f, made, { report: { ...reportOf(made), rules: reportOf(made).rules.map(row => ({ ...row, result: 'not-checked' })) } })]);
  check('rule rows that are results alone', 'REVIEW_RULE_NO_EVIDENCE', made => [transcriptOf(f, made, { report: { ...reportOf(made), rules: reportOf(made).rules.map(({ rule, ticket, result }) => ({ rule, ticket, result })) } })]);
  check('a rule row with the template placeholder as note', 'REVIEW_RULE_NO_EVIDENCE', made => [transcriptOf(f, made, { report: { ...reportOf(made), rules: reportOf(made).rules.map(row => ({ ...row, note: '<what was checked>' })) } })]);
  check('a rule of the frozen list missing', 'REVIEW_RULE_MISSING', made => [transcriptOf(f, made, { report: { ...reportOf(made), rules: reportOf(made).rules.slice(1) } })]);
  check('no Read of the flagged file in the transcript', 'REVIEW_TRANSCRIPT_NO_OPEN', made => [transcriptOf(f, made, { reads: [] })]);
  check('a relative Read does not count', 'REVIEW_TRANSCRIPT_NO_OPEN', made => [transcriptOf(f, made, { reads: ['src/authz.js'] })]);
  check('an engine workflow transcript', 'REVIEW_TRANSCRIPT_PLACE', made => [transcriptOf(f, made, { workflow: true })]);
  check('a transcript relayed by the workflow harness', 'REVIEW_WORKFLOW_AGENT', made => [transcriptOf(f, made, { prompt: `[Workflow harness — computed task] The task text follows:\n${made.brief}` })]);
  check('a transcript of another wrapper', 'REVIEW_NOT_REVIEWER', made => [transcriptOf(f, made, { agentType: 'tag-list-fixture-architect' })]);
  check('a brief that was edited', 'REVIEW_BRIEF_NOT_FOUND', made => [transcriptOf(f, made, { prompt: made.brief.replace('Goal of US-01', 'Goal of nothing') })]);
  check('RED with no failed rule', 'REVIEW_VERDICT_MISMATCH', made => [transcriptOf(f, made, { report: { ...reportOf(made), items: reportOf(made).items.map(item => ({ ...item, verdict: 'RED' })) } })]);
  check('a failed rule with no proposed control', 'REVIEW_CONTROL_MISSING', made => [transcriptOf(f, made, { report: failing(reportOf(made), 'US-01', 'kit.sec.access-check', { control: null }) })]);
  check('a rule reported twice with different results', 'REVIEW_RULE_CONFLICT', made => [transcriptOf(f, made, { report: { ...reportOf(made), rules: [...reportOf(made).rules, { ...reportOf(made).rules[0], result: 'fail' }] } })]);
  check('a ticket given two verdicts', 'REVIEW_ITEM_CONFLICT', made => [transcriptOf(f, made, { report: { ...reportOf(made), items: [...reportOf(made).items, { ...reportOf(made).items[0], verdict: 'AMBER' }] } })]);
  const flagged = join(f.product, 'src/authz.js');
  check('a Read that failed', 'REVIEW_TRANSCRIPT_NO_OPEN', made => [transcriptOf(f, made, { reads: [{ path: flagged, error: true }] })]);
  check('a Read that starts past the first line', 'REVIEW_TRANSCRIPT_NO_OPEN', made => [transcriptOf(f, made, { reads: [{ path: flagged, input: { offset: 5 } }] })]);
  check('a REPORT.json that is not the transcript\'s report', 'REVIEW_REPORT_MISMATCH', made => [transcriptOf(f, made), { ...reportOf(made), residualRisk: 'other' }]);
  // A single rule not checked is allowed and recorded in the ledger.
  fresh(f);
  const made = f.brief('security'), one = reportOf(made);
  assert.match(refusal(f.judge('security', join(f.base, 'missing.jsonl'))).reason, /cannot be read/, 'a file that is not there is not an attempt');
  const reads = [{ path: flagged, input: { limit: 3 } }, { path: flagged, input: { offset: 1 } }];
  const verdict = f.judge('security', transcriptOf(f, made, { reads, report: { ...one, rules: one.rules.map((row, i) => i === 0 ? { ...row, result: 'not-checked' } : row) } }));
  assert.equal(verdict.outcome, 'accepted'); assert.deepEqual(verdict.tickets[0].notChecked, [made.record.ruleIds[0]]);
  assert.match(f.ledger(), new RegExp(`not checked: ${made.record.ruleIds[0]} on US-01`));
});

test('the successful Reads of a flagged file evidence it when together they cover each of its lines, however long it is', async t => {
  const f = live(t), numbered = count => Array.from({ length: count }, (_, i) => `export const line${i + 1} = ${i + 1};\n`).join('');
  await runBatch(f, [ticket('US-01', ['src/authz.js']), ticket('US-02', ['src/session.js'])], { 'src/authz.js': numbered(4500), 'src/session.js': numbered(10) });
  const long = join(f.product, 'src/authz.js'), short = join(f.product, 'src/session.js');
  const ranged = (...pairs) => pairs.map(([offset, limit]) => ({ path: long, input: { offset, limit } }));
  const judged = reads => { fresh(f); const made = f.brief('security'); return { made, verdict: f.judge('security', transcriptOf(f, made, { reads })) }; };
  const uncovered = (why, reads, file, line) => {
    const { verdict } = judged(reads), gap = verdict.refusals?.find(item => item.code === 'REVIEW_TRANSCRIPT_NO_OPEN');
    assert.equal(verdict.outcome, 'refused', why); assert.ok(gap?.detail.includes(`${file} from line ${line} `), `${why}: ${JSON.stringify(verdict.refusals)}`);
  };
  const covered = judged([...ranged([1, 2000], [2001, 2000], [4001, 2000]), short]);
  assert.equal(covered.verdict.outcome, 'accepted', `three consecutive ranges, and one plain Read of a short file: ${JSON.stringify(covered.verdict.refusals)}`);
  const limit = Math.floor(4500 * 40 * 1024 / Buffer.byteLength(numbered(4500))), offsets = Array.from({ length: Math.ceil(4500 / limit) }, (_, i) => 1 + i * limit);
  assert.match(covered.made.brief, new RegExp(`${escaped(long)} \\(4500 lines, \\d+ KB: read it in ranges, each Read with limit ${limit}, at offsets ${offsets.join(', ')}\\)`), 'the brief marks the file that takes ranged Reads with its ranges');
  assert.ok(!covered.made.brief.includes(`${short} (`), 'a short file is not marked');
  uncovered('one plain Read of a 4,500-line file', [long, short], long, 2001);
  uncovered('ranges with a gap', [...ranged([1, 2000], [2002, 3000]), short], long, 2001);
  uncovered('a Read whose result is an error covers nothing', [...ranged([1, 2000], [2001, 2000]), { path: long, input: { offset: 4001, limit: 2000 }, error: true }, short], long, 4001);
  uncovered('a short file read only in part', [...ranged([1, 4500]), { path: short, input: { limit: 5 } }], short, 6);
});

test('the brief says how each flagged file is read and the judging asks for that: text in ranges sized by its bytes, an image or a PDF once, a binary file not at all', async t => {
  const f = live(t), names = ['wide.js', 'logo.png', 'spec.pdf', 'blob.bin'];
  // 800 lines of about 300 bytes; an image of half a megabyte with more newlines than one Read returns lines; a PDF; bytes with NULs.
  const wide = Array.from({ length: 800 }, (_, i) => `// ${String(i).padStart(4, '0')} ${'x'.repeat(290)}\n`).join('');
  const image = Buffer.from(`\u0089PNG\r\n\u001a\n${'\u0000ÿ\n'.repeat(130000)}`, 'latin1'), pdf = `%PDF-1.4\n${'stream\n'.repeat(3000)}`, blob = `\u0000\u0001${'x'.repeat(100)}\n`.repeat(20);
  await runBatch(f, [ticket('US-01', names.map(name => `src/auth/${name}`))], Object.fromEntries(names.map((name, i) => [`src/auth/${name}`, [wide, image, pdf, blob][i]])));
  const [text, png, spec, bin] = names.map(name => join(f.product, 'src/auth', name));
  const lines = 800, limit = Math.floor(lines * 40 * 1024 / Buffer.byteLength(wide)), offsets = Array.from({ length: Math.ceil(lines / limit) }, (_, i) => 1 + i * limit);
  assert.ok(limit < lines, `a range of ${limit} lines`);
  const ranged = offsets.map(offset => ({ path: text, input: { offset, limit } })), pages = { path: spec, input: { pages: '1-5' } };
  const first = f.brief('security');
  assert.deepEqual(first.record.tickets[0].flaggedFiles, names.map(name => `src/auth/${name}`).sort());
  assert.match(first.brief, new RegExp(`${escaped(text)} \\(800 lines, \\d+ KB: read it in ranges, each Read with limit ${limit}, at offsets ${offsets.join(', ')}\\)`));
  assert.ok(first.brief.includes(`${bin} (a binary file`), 'the binary file is named, not to be read');
  const unread = f.judge('security', transcriptOf(f, first, { reads: [...ranged, pages] }));
  assert.equal(unread.outcome, 'refused');
  assert.deepEqual(unread.refusals.map(item => item.code), ['REVIEW_TRANSCRIPT_NO_OPEN']);
  assert.ok(unread.refusals[0].detail.includes(png) && !unread.refusals[0].detail.includes(text) && !unread.refusals[0].detail.includes(bin), unread.refusals[0].detail);
  const verdict = f.judge('security', transcriptOf(f, f.brief('security'), { reads: [...ranged, png, pages] }));
  assert.equal(verdict.outcome, 'accepted', `one Read of the image and of the PDF, none of the binary file: ${JSON.stringify(verdict.refusals)}`);
});

test('one plain Read evidences a text file of 2,000 lines, and not one of 2,001', async t => {
  const f = live(t), rows = count => Array.from({ length: count }, (_, i) => `// ${i + 1}\n`).join('');
  await runBatch(f, [ticket('US-01', ['src/auth/fits.js', 'src/auth/over.js'])], { 'src/auth/fits.js': rows(2000), 'src/auth/over.js': rows(2001) });
  const [fits, over] = ['fits.js', 'over.js'].map(name => join(f.product, 'src/auth', name));
  const verdict = f.judge('security', transcriptOf(f, f.brief('security'), { reads: [fits, over] }));
  const gap = verdict.refusals?.find(item => item.code === 'REVIEW_TRANSCRIPT_NO_OPEN');
  assert.equal(verdict.outcome, 'refused');
  assert.ok(gap?.detail.includes(`${over} from line 2001 of 2001`) && !gap.detail.includes(fits), JSON.stringify(verdict.refusals));
});

test('a reviewer that stopped without a report is judged from its transcript, not recorded as no answer, and the healthy second dispatch is accepted', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  const stopped = transcriptOf(f, f.brief('security'), { report: null });
  const silenced = refusal(f.noAnswer('security', 'the reviewer stopped without a report'));
  assert.equal(silenced?.code, 'REVIEW_REFUSED', 'no answer is refused while a transcript carries the latest brief');
  assert.ok(silenced.reason.includes(realpathSync(stopped)) && /review --reviewer security --transcript/.test(silenced.reason), silenced.reason);
  assert.equal(existsSync(join(f.root, VERDICTS_FILE)), false, 'nothing is recorded');
  const judged = f.judge('security', stopped);
  assert.deepEqual([judged.outcome, judged.attempt, judged.refusals.map(item => item.code)], ['refused', 1, ['REVIEW_NO_REPORT']]);
  const healthy = f.judge('security', transcriptOf(f, f.brief('security')));
  assert.deepEqual([healthy.outcome, healthy.attempt], ['accepted', 2], JSON.stringify(healthy));
});

test('of two dispatches with one brief the earlier is judged first; one with an earlier brief or another run\'s, and a judged transcript that grew, are not waited for', async t => {
  const f = live(t);
  const { open } = await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  const made = f.brief('security');
  transcriptOf(f, made, { prompt: made.brief.replace(`run ${open.runId}`, 'run rw-another-run'), session: 'session-0' });
  // The later dispatch lies on the smaller path: the order is the dispatch time, not the path.
  const first = transcriptOf(f, made, { reads: [], session: 'session-9' }), second = transcriptOf(f, made, { session: 'session-2' });
  const refused = refusal(f.judge('security', second));
  assert.equal(refused?.code, 'REVIEW_REFUSED'); assert.ok(refused.reason.includes(realpathSync(first)), refused.reason);
  assert.ok(!refused.reason.includes('session-0'), 'a dispatch with another batch\'s brief is not one of this review');
  assert.equal(existsSync(join(f.root, VERDICTS_FILE)), false, 'nothing is recorded');
  assert.deepEqual([f.judge('security', first).outcome], ['refused'], 'the earlier dispatch uses the first attempt');
  const again = f.brief('security');
  assert.equal(again.record.attempt, 2);
  // The first reviewer was resumed with the new brief after its judgment: its transcript grew, and still begins with the first brief.
  appendFileSync(first, JSON.stringify({ type: 'user', message: { role: 'user', content: again.brief } }) + '\n');
  const last = f.judge('security', transcriptOf(f, again, { session: 'session-3' }));
  assert.deepEqual([last.outcome, last.attempt], ['accepted', 2], `neither the second dispatch nor the grown first one carries the latest brief, so neither is waited for: ${JSON.stringify(last)}`);
  assert.deepEqual(JSON.parse(f.read(VERDICTS_FILE)).entries.map(entry => [entry.attempt, entry.outcome]), [[1, 'refused'], [2, 'accepted']]);
});

test('the scan for an unjudged dispatch reads only transcripts of the reviewer\'s wrapper modified since the brief was made, two seconds of clock allowed', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  const made = f.brief('security'), at = Date.parse(made.record.madeAt) / 1000, touched = (path, seconds) => { utimesSync(path, seconds, seconds); return path; };
  const architect = transcriptOf(f, made, { agentType: 'tag-list-fixture-architect', session: 'session-a' });
  const stale = touched(transcriptOf(f, made, { session: 'session-b' }), at - 60), near = touched(transcriptOf(f, made, { session: 'session-c' }), at - 1);
  const refused = refusal(f.noAnswer('security', 'the dispatch left no transcript'));
  assert.ok(refused?.reason.includes(realpathSync(near)), `a transcript modified a second before the brief is within the clock allowance: ${refused?.reason}`);
  assert.ok(!refused.reason.includes(realpathSync(architect)), 'another wrapper\'s transcript with the same heading is not this reviewer\'s dispatch');
  assert.ok(!refused.reason.includes(realpathSync(stale)), 'a transcript last modified a minute before the brief cannot carry it');
});

test('no answer to the first brief uses the first attempt, and the healthy dispatch with the second brief is accepted', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  f.brief('security');
  const lost = f.noAnswer('security', 'the dispatch left no transcript');
  assert.deepEqual([lost.outcome, lost.attempt], ['refused', 1], JSON.stringify(lost));
  const second = f.brief('security');
  assert.equal(second.record.attempt, 2); assert.match(second.brief, /earlier attempt was refused by the kit: REVIEW_NO_ANSWER/);
  const healthy = f.judge('security', transcriptOf(f, second));
  assert.deepEqual([healthy.outcome, healthy.attempt], ['accepted', 2], JSON.stringify(healthy));
});

test('a file that does not carry the latest brief is not judged while a transcript carries it, and uses no attempt; the rejecting report is judged', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  const made = f.brief('security'), rejecting = transcriptOf(f, made, { report: failing(reportOf(made), 'US-01', 'kit.sec.secret-in-code') });
  const decoy = join(f.base, 'decoy.jsonl');
  writeFileSync(decoy, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
  for (const file of [decoy, transcriptOf(f, made, { prompt: 'Review something else.', session: 'session-2' })]) {
    const refused = refusal(f.judge('security', file));
    assert.equal(refused?.code, 'REVIEW_REFUSED', file);
    assert.ok(refused.reason.includes(realpathSync(rejecting)) && /the transcript given does not carry/.test(refused.reason), refused.reason);
  }
  assert.equal(existsSync(join(f.root, VERDICTS_FILE)), false, 'no attempt is used');
  assert.match(refusal(f.brief('security')).reason, /brief 1 has no judged transcript/, 'no new brief either');
  const judged = f.judge('security', rejecting);
  assert.deepEqual([judged.outcome, judged.attempt, judged.tickets.map(item => [item.id, item.verdict])], ['accepted', 1, [['US-01', 'rejected']]]);
});

test('after a refused report the reviewer is dispatched as a new agent: a resumed one still carries its first brief, waits for a new agent with the latest, and alone is refused REVIEW_BRIEF_NOT_FOUND', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  // The first dispatch is refused, the PM briefs again and resumes that reviewer with the new brief instead of dispatching a new one.
  const resumed = () => {
    fresh(f);
    const first = f.brief('security'), dispatched = transcriptOf(f, first, { reads: [] }), refused = f.judge('security', dispatched);
    assert.equal(refused.outcome, 'refused');
    assert.match(refused.next, /review-brief --reviewer security.*as a new agent, never by resuming or messaging the earlier one/);
    const again = f.brief('security');
    appendFileSync(dispatched, [{ type: 'user', message: { role: 'user', content: again.brief } },
      { type: 'assistant', message: { id: 'msg_again', role: 'assistant', content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(reportOf(again))}\n\`\`\`` }] } }].map(row => JSON.stringify(row)).join('\n') + '\n');
    return { again, dispatched };
  };
  let { again, dispatched } = resumed();
  const added = transcriptOf(f, again, { session: 'session-2' });
  const waiting = refusal(f.judge('security', dispatched));
  assert.ok(waiting?.reason.includes(realpathSync(added)), waiting?.reason);
  assert.deepEqual([f.judge('security', added).outcome], ['accepted']);
  ({ again, dispatched } = resumed());
  const alone = f.judge('security', dispatched);
  assert.deepEqual([alone.outcome, alone.attempt], ['not-obtained', 2], JSON.stringify(alone));
  assert.ok(alone.refusals.some(item => item.code === 'REVIEW_BRIEF_NOT_FOUND'), JSON.stringify(alone.refusals));
});

test('a flagged link whose target changed lets its brief be made again, and the dispatch with the new brief is judged', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/auth-link.js'])], { 'src/auth-link.js': { link: 'authz.js' } });
  const first = f.brief('security'), link = join(f.product, 'src/auth-link.js');
  transcriptOf(f, first, { reads: [] });
  rmSync(link); symlinkSync('session.js', link);
  const again = f.brief('security');
  assert.equal(again.errors, undefined, JSON.stringify(again.errors)); assert.equal(again.record.attempt, 2);
  assert.ok(again.brief.includes(`${link} (a symbolic link to "session.js"`));
  const judged = f.judge('security', transcriptOf(f, again, { reads: [] }));
  assert.deepEqual([judged.outcome, judged.attempt], ['accepted', 1], JSON.stringify(judged));
});

test('a text file over 256 KB is judged from its diff and not read, a 100 KB one is read in its ranges, and a .png that holds no PNG is not opened', async t => {
  const f = live(t), names = ['deps.lock', 'mid.js', 'logo.png'];
  const lock = Array.from({ length: 6000 }, (_, i) => `"pkg-${String(i).padStart(5, '0')}": "${'1'.repeat(34)}",\n`).join('');
  const mid = Array.from({ length: 2500 }, (_, i) => `// ${String(i).padStart(4, '0')} ${'x'.repeat(32)}\n`).join('');
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123456\n`;
  assert.ok(Buffer.byteLength(lock) > 256 * 1024 && Buffer.byteLength(mid) > 100000 && Buffer.byteLength(mid) < 256 * 1024);
  await runBatch(f, [ticket('US-01', names.map(name => `src/auth/${name}`))], Object.fromEntries(names.map((name, i) => [`src/auth/${name}`, [lock, mid, pointer][i]])));
  const [big, text, png] = names.map(name => join(f.product, 'src/auth', name));
  const limit = Math.floor(2500 * 40 * 1024 / Buffer.byteLength(mid)), offsets = Array.from({ length: Math.ceil(2500 / limit) }, (_, i) => 1 + i * limit);
  const first = f.brief('security');
  assert.match(first.brief, new RegExp(`${escaped(big)} \\(\\d+ KB, too large to read whole: not opened; judge it from its diff`));
  assert.match(first.brief, new RegExp(`${escaped(png)} \\(named as an image, a PDF or a notebook, but its bytes are not one: not opened`));
  assert.match(first.brief, new RegExp(`${escaped(text)} \\(2500 lines, \\d+ KB: read it in ranges, each Read with limit ${limit}, at offsets ${offsets.join(', ')}\\)`));
  const plain = f.judge('security', transcriptOf(f, first, { reads: [text] })), gap = plain.refusals?.find(item => item.code === 'REVIEW_TRANSCRIPT_NO_OPEN');
  assert.equal(plain.outcome, 'refused');
  assert.ok(gap?.detail.includes(`${text} from line 2001 of 2500`) && !gap.detail.includes(big) && !gap.detail.includes(png), JSON.stringify(plain.refusals));
  const second = f.brief('security');
  const healthy = f.judge('security', transcriptOf(f, second, { reads: offsets.map(offset => ({ path: text, input: { offset, limit } })) }));
  assert.deepEqual([healthy.outcome, healthy.attempt], ['accepted', 2], `neither the large file nor the misnamed image is read: ${JSON.stringify(healthy.refusals)}`);
});

test('a report refused twice, or no answer, means review not obtained: the flagged ticket is held, the others commit', async t => {
  const f = live(t), paths = ['src/list/a.js', 'src/authz.js', 'src/list/b.js'];
  const { open } = await runBatch(f, paths.map((path, i) => ticket(`US-0${i + 1}`, [path])), edits(paths));
  const first = f.brief('security'), refused = f.judge('security', transcriptOf(f, first, { reads: [] }));
  assert.equal(refused.outcome, 'refused');
  // The reviewer is told the rule it is judged by, and the refusal says how to meet it.
  assert.match(first.brief, /Your Reads of a file must together cover every line of it/);
  assert.match(JSON.stringify(refused), /do not cover \S+\/src\/authz\.js from line 1 .*must together cover every line/);
  assert.match(refusal(f.judge('security', transcriptOf(f, first))).reason, /brief again/, 'the next attempt needs a new brief');
  const second = f.brief('security');
  assert.match(second.record.retryReason, /REVIEW_TRANSCRIPT_NO_OPEN/); assert.match(second.brief, /earlier attempt was refused.*REVIEW_TRANSCRIPT_NO_OPEN/s);
  const lost = f.noAnswer('security', 'the dispatch left no transcript');
  assert.equal(lost.outcome, 'not-obtained', JSON.stringify(lost)); assert.deepEqual(lost.tickets.map(item => [item.id, item.verdict]), [['US-02', 'not-obtained']]);
  assert.match(refusal(f.brief('security')).reason, /review of this batch is over \(not-obtained\)/);
  assert.deepEqual(f.lines('reviews/tickets.jsonl').map(line => [line.ticket, line.runId, line.outcome]), [['US-02', open.runId, 'not-obtained']]);
  assert.match(f.ledger(), /REVIEW \S+ security NOT OBTAINED/);
  assert.equal(f.resolve().errors, undefined);
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01', 'US-03']);
  assert.deepEqual(committed.held.map(entry => [entry.ticket, entry.reason]), [['US-02', 'review-not-obtained']]);
  assert.deepEqual(changed(f), []);
});

test('an elective review binds: the commit waits for it and its failed rule rejects the ticket', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js']), ticket('US-02', ['src/list/view.js'])], edits(['src/authz.js', 'src/list/view.js']));
  const sec = f.brief('security'); assert.equal(f.judge('security', transcriptOf(f, sec)).outcome, 'accepted');
  const arch = f.brief('architect', ['US-02']);
  assert.match(refusal(f.commit()).reason, /not over.*architect/);
  const verdict = f.judge('architect', transcriptOf(f, arch, { report: failing(reportOf(arch), 'US-02', 'kit.arch.boundaries') }));
  assert.deepEqual(verdict.tickets.map(item => [item.id, item.verdict]), [['US-02', 'rejected']]);
  assert.equal(f.resolve().errors, undefined);
  const committed = f.commit();
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01']); assert.deepEqual(committed.held.map(entry => [entry.ticket, entry.reason]), [['US-02', 'rejected']]);
});

test('two judgments at once each keep their verdict', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  const made = { security: f.brief('security'), architect: f.brief('architect', ['US-01']) };
  const transcripts = Object.fromEntries(Object.entries(made).map(([reviewer, brief]) => [reviewer, transcriptOf(f, brief)]));
  // Before writing the verdicts each judgment waits up to three seconds for the other to reach that point, and the Architect
  // then writes after Security: two judgments that both read the verdicts before either wrote would keep only the last.
  const shim = join(f.base, 'verdict-barrier.mjs');
  writeFileSync(shim, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const base = process.env.BARRIER_BASE, role = process.env.BARRIER_ROLE, other = role === 'security' ? 'architect' : 'security', write = fs.writeFileSync, rename = fs.renameSync;
const until = (file, ms) => { const end = Date.now() + ms; while (!fs.existsSync(file)) { if (Date.now() > end) return false; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } return true; };
fs.writeFileSync = function (path, ...args) {
  if (String(path).endsWith('/${VERDICTS_FILE}.tmp')) { write(join(base, role + '.ready'), ''); if (until(join(base, other + '.ready'), 3000) && role === 'architect') until(join(base, 'security.saved'), 10000); }
  return write(path, ...args);
};
fs.renameSync = function (from, to) { const result = rename(from, to); if (role === 'security' && String(to).endsWith('/${VERDICTS_FILE}')) write(join(base, 'security.saved'), ''); return result; };
syncBuiltinESMExports();
`);
  const module = new URL('../src/router-worker/review-judge.mjs', import.meta.url).href;
  const judge = reviewer => new Promise((resolve, reject) => {
    const args = { ...f.common, reviewer, transcript: transcripts[reviewer], projectsRoot: f.projectsRoot };
    const child = spawn(process.execPath, ['--import', shim, '--input-type=module', '-e', `import { judgeReview } from ${JSON.stringify(module)}; console.log(JSON.stringify(judgeReview(${JSON.stringify(args)})));`],
      { env: { ...process.env, BARRIER_BASE: f.base, BARRIER_ROLE: reviewer } });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('close', code => { try { assert.equal(code, 0, err); resolve(JSON.parse(out)); } catch (error) { reject(error); } });
  });
  const results = await Promise.all(['security', 'architect'].map(judge));
  assert.deepEqual(results.map(result => result.outcome), ['accepted', 'accepted'], JSON.stringify(results));
  assert.deepEqual(JSON.parse(f.read(VERDICTS_FILE)).entries.map(entry => entry.reviewer).sort(), ['architect', 'security']);
  assert.equal(f.resolve().errors, undefined);
  assert.deepEqual(f.commit().commits.map(commit => commit.ticket), ['US-01']);
});

test('a rejection whose verdict was lost is recovered by judging the same transcript again, as the refusal says', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js'])], edits(['src/authz.js']));
  const made = f.brief('security'), path = transcriptOf(f, made, { report: failing(reportOf(made), 'US-01', 'kit.sec.secret-in-code') });
  // The claim of a judgment that died two minutes ago is taken over.
  const lock = join(f.root, `${VERDICTS_FILE}.lock`), past = new Date(Date.now() - 120000);
  writeFileSync(lock, 'died'); utimesSync(lock, past, past);
  assert.equal(f.judge('security', path).outcome, 'accepted');
  assert.equal(existsSync(lock), false, 'the judgment releases its claim');
  rmSync(join(f.root, VERDICTS_FILE));
  assert.match(refusal(f.resolve()).reason, /US-01 \(rejected by security\).*Judge that reviewer's transcript again with: rw-batch\.mjs review --reviewer/);
  assert.equal(f.judge('security', path).outcome, 'accepted');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors)); assert.deepEqual(resolved.removed.map(entry => [entry.ticket, entry.reason]), [['US-01', 'rejected']]);
});

test('a ticket rejected in a second batch is escalated: only a batch with it or a related ticket is refused, until the owner acknowledges it', async t => {
  const f = live(t), discard = () => { git(f.product, 'checkout', '-q', '--', '.'); git(f.product, 'clean', '-fdq'); };
  const rejectOnce = async () => {
    const { open } = await runBatch(f, [ticket('US-02', ['src/authz.js'])], edits(['src/authz.js']));
    const made = f.brief('security'), verdict = f.judge('security', transcriptOf(f, made, { report: failing(reportOf(made), 'US-02', 'kit.sec.secret-in-code') }));
    assert.equal(f.resolve().errors, undefined);
    const committed = f.commit();
    assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
    discard(); assert.equal(markNotMetered({ ...f.common, reason: 'not measured in this test', runId: open.runId }).errors, undefined);
    return { open, verdict, committed };
  };
  const one = await rejectOnce();
  assert.deepEqual(one.verdict.escalated, [], 'a first rejection goes back to the backlog');
  const two = await rejectOnce(), [escalation] = two.verdict.escalated;
  assert.equal(escalation.kind, 'second-rejection'); assert.equal(escalation.ticket, 'US-02');
  assert.deepEqual(f.lines('reviews/tickets.jsonl').map(line => [line.ticket, line.paths]), [['US-02', ['src/authz.js']], ['US-02', ['src/authz.js']]], 'each row carries the paths the ticket changed');
  assert.deepEqual(escalation.runIds, [one.open.runId, two.open.runId]); assert.deepEqual(escalation.paths, ['src/authz.js']);
  assert.deepEqual(f.lines('reviews/escalations.jsonl').map(line => line.id), [escalation.id]);
  assert.deepEqual(two.committed.escalations.map(item => item.id), [escalation.id], 'the commit record reports it for the human');
  assert.match(f.ledger(), new RegExp(`ESCALATED ${escalation.id}: ticket US-02`));

  const blocked = async (why, ...tickets) => { const refused = refusal(await f.before(batchOf(...tickets))); assert.equal(refused?.code, 'TICKET_ESCALATED', why); assert.match(refused.reason, new RegExp(escalation.id), why); return refused.reason; };
  await blocked('the escalated ticket, its id in another case', ticket('us-02', ['src/other.js']));
  await blocked('a ticket whose paths overlap it', ticket('US-06', ['lib/x.js']), ticket('US-07', ['src/authz.js']));
  await blocked('a ticket that depends on it', ticket('US-08', ['lib/y.js'], { dependsOn: ['US-02'] }));
  assert.match(await blocked('a ticket that depends on it through another', ticket('US-08', ['lib/y.js'], { dependsOn: ['US-02'] }), ticket('US-09', ['lib/z.js'], { dependsOn: ['US-08'] })), /US-09/);
  const unrelated = await f.before(batchOf(ticket('US-10', ['src/list/y.js'])));
  assert.equal(unrelated.errors, undefined, 'an unrelated ticket goes on: the plan is replanned around the block');
  assert.equal(abortBatch(f.common).errors, undefined);

  const cli = spawnSync(process.execPath, [join(f.kit, 'scripts/team-mode.mjs'), 'acknowledge', escalation.id, '--instance', f.root], { encoding: 'utf8', input: '' });
  assert.equal(cli.status, 2, 'confirmed only at an interactive terminal'); assert.equal(f.lines('reviews/acknowledged.jsonl').length, 0);
  assert.match(refusal(acknowledgeEscalation({ ...f.common, id: escalation.id, confirm: 'sha256:0' })).reason, /code/);
  const proposal = proposeAcknowledge({ ...f.common, id: escalation.id });
  assert.equal(proposal.errors, undefined, JSON.stringify(proposal.errors));
  assert.match(refusal(acknowledgeEscalation({ ...f.common, id: escalation.id, confirm: proposal.digest })).reason, /interactive terminal/, 'a program that calls it confirms nothing');
  const { NODE_TEST_CONTEXT, ...outsideTests } = process.env;
  const program = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acknowledgeEscalation } from ${JSON.stringify(new URL('../src/router-worker/escalations.mjs', import.meta.url).href)};
process.stdout.write(JSON.stringify(acknowledgeEscalation(${JSON.stringify({ ...f.common, id: escalation.id, confirm: proposal.digest, atTerminal: true })})));`], { encoding: 'utf8', env: outsideTests });
  assert.match(refusal(JSON.parse(program.stdout)).reason, /interactive terminal/, `even one that says it runs at a terminal: ${program.stderr}`);
  assert.equal(f.lines('reviews/acknowledged.jsonl').length, 0);
  assert.equal(acknowledgeEscalation({ ...f.common, id: escalation.id, confirm: proposal.digest, atTerminal: true }).errors, undefined);
  assert.deepEqual(f.lines('reviews/acknowledged.jsonl').map(line => [line.id, line.atTerminal]), [[escalation.id, true]]);
  assert.match(f.ledger(), new RegExp(`ESCALATION ${escalation.id} ACKNOWLEDGED: .*typed at an interactive terminal`));
  assert.equal((await f.before(batchOf(ticket('US-02', ['src/authz.js'])))).errors, undefined, 'the owner lifted the block');
});

const escalationsIn = () => { const instance = mkdtempSync(join(tmpdir(), 'rw-escalations-')); return { instance, at: new Date().toISOString(),
  outcome: (runId, ticket, outcome, paths = ['src/a.js']) => recordOutcomes({ instance, runId, reviewer: 'security', outcomes: [{ ticket, outcome, finding: 'x' }], tickets: [{ id: ticket, paths }], at: new Date().toISOString() }) }; };

test('only an acknowledgement typed at a terminal, for the escalation as it stands, lifts its block', t => {
  const { instance, outcome } = escalationsIn(); t.after(() => rmSync(instance, { recursive: true, force: true }));
  outcome('r1', 'T-1', 'rejected'); const [escalation] = outcome('r2', 't-1', 'rejected');
  const next = [{ id: 'T-1', paths: ['src/a.js'] }, { id: 'U-1', paths: ['src/b.js'] }, { id: 'V-1', paths: ['src/c.js'], dependsOn: ['W-1'] }];
  // W-1 was committed after its own review: a ticket built on it is not blocked although W-1's paths overlap.
  const archived = [{ id: 'W-1', paths: ['src/a.js'], dependsOn: [] }];
  const blocked = () => blockedTickets({ instance, tickets: next, archived }).map(entry => entry.ticket);
  assert.deepEqual(blocked(), ['T-1']);
  const forge = line => appendFileSync(join(instance, 'reviews/acknowledged.jsonl'), JSON.stringify(line) + '\n');
  forge({ id: escalation.id });
  forge({ id: escalation.id, atTerminal: true });
  forge({ id: escalation.id, atTerminal: true, escalationDigest: 'sha256:' + '0'.repeat(64) });
  forge({ id: escalation.id, atTerminal: false, escalationDigest: digest(escalation) });
  assert.deepEqual(blocked(), ['T-1'], 'a line not typed at a terminal, or for another escalation, lifts nothing');
  forge({ id: escalation.id, atTerminal: true, escalationDigest: digest(escalation) });
  assert.deepEqual(blocked(), [], 'a forged line with the right digest is the stated gap');
});

test('two adverse outcomes of one ticket in two batches escalate, mixed or not', t => {
  const { instance, outcome } = escalationsIn(); t.after(() => rmSync(instance, { recursive: true, force: true }));
  assert.deepEqual(outcome('r1', 'T-2', 'rejected'), []);
  const [mixed] = outcome('r2', 'T-2', 'not-obtained');
  assert.equal(mixed?.kind, 'repeated-adverse'); assert.deepEqual(mixed.runIds, ['r1', 'r2']);
  outcome('r1', 'T-3', 'not-obtained', ['src/b.js']); assert.equal(outcome('r3', 'T-3', 'not-obtained', ['src/b.js'])[0]?.kind, 'review-not-obtained-again');
  assert.match(readFileSync(join(instance, 'pm-decisions.md'), 'utf8'), /ESCALATED ESC-T-2-r2: ticket T-2 was rejected or could not be reviewed in batches r1 and r2/);
});

test('a ticket filed again under another id on the same paths is escalated at its second rejection; another id on other paths is not; a row with no paths counts by id', t => {
  const { instance, outcome } = escalationsIn(); t.after(() => rmSync(instance, { recursive: true, force: true }));
  const rows = () => readFileSync(join(instance, 'reviews/tickets.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(outcome('r1', 'T-1', 'rejected', ['src/a.js']), []);
  assert.deepEqual(outcome('r2', 'T-9', 'rejected', ['src/b.js']), [], 'another id on other paths is other work');
  const [again] = outcome('r3', 'T-5', 'rejected', ['src/A.js', 'src/c.js']);
  assert.equal(again?.kind, 'second-rejection'); assert.equal(again.ticket, 'T-5'); assert.deepEqual(again.runIds, ['r1', 'r3']);
  assert.deepEqual(again.findings.map(item => [item.ticket, item.runId]), [['T-1', 'r1'], ['T-5', 'r3']]);
  assert.deepEqual(rows().map(row => [row.ticket, row.paths]), [['T-1', ['src/a.js']], ['T-9', ['src/b.js']], ['T-5', ['src/A.js', 'src/c.js']]], 'each row carries the paths its ticket changed');
  assert.match(readFileSync(join(instance, 'pm-decisions.md'), 'utf8'), /ESCALATED ESC-T-5-r3: ticket T-5 \(on the paths of T-1\) was rejected in batches r1 and r3/);
  // A row written before rows carried paths is matched by its id alone.
  appendFileSync(join(instance, 'reviews/tickets.jsonl'), JSON.stringify({ ticket: 'T-7', runId: 'r0', reviewer: 'security', outcome: 'rejected', finding: 'x', at: '2026-11-20T00:00:00.000Z' }) + '\n');
  assert.deepEqual(outcome('r4', 'T-6', 'rejected', ['src/old.js']), [], 'a row with no paths overlaps nothing');
  assert.deepEqual(outcome('r5', 't-7', 'rejected', ['src/new.js'])[0]?.runIds, ['r0', 'r5']);
});
