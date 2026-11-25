// ADR 0011, decisions 13, 16, 17 and 19: the kit judges a reviewer's report from its transcript, gates the commit
// on the verdicts, and escalates a ticket that keeps failing review to the owner without stopping unrelated work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, appendFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../src/loop/contracts.mjs';
import { spawnSync, spawn } from 'node:child_process';
import { abortBatch } from '../src/router-worker/batch.mjs';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { recordNoAnswer, VERDICTS_FILE } from '../src/router-worker/review-judge.mjs';
import { proposeAcknowledge, acknowledgeEscalation, recordOutcomes, blockedTickets } from '../src/router-worker/escalations.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { refusal, ticket, batchOf, live, changed, runBatch, edits, reportOf, failing, transcriptOf } from './fixtures/router-worker/review.mjs';

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
  const verdict = f.judge('security', transcriptOf(f, made, { report }));
  assert.equal(verdict.outcome, 'accepted', JSON.stringify(verdict));
  assert.deepEqual(verdict.tickets.map(item => [item.id, item.verdict, item.fails]), [['US-01', 'passed', []], ['US-03', 'rejected', ['kit.sec.secret-in-code']]]);
  assert.equal(verdict.tickets[0].finding, 'the session lifetime is long', 'the AMBER concern is kept for the PM\'s backlog');
  assert.deepEqual(f.lines('reviews/tickets.jsonl').map(line => [line.ticket, line.runId, line.reviewer, line.outcome, line.finding]), [['US-03', open.runId, 'security', 'rejected', 'a token is written in code']]);
  // Deleting the verdicts lets the reviewer be judged again; the lines across batches still hold the rejection.
  const kept = f.read(VERDICTS_FILE);
  rmSync(join(f.root, VERDICTS_FILE)); assert.equal(f.judge('security', transcriptOf(f, made)).outcome, 'accepted');
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
    rmSync(join(f.root, VERDICTS_FILE), { force: true });
    const made = f.brief('security'), verdict = f.judge('security', ...shape(made));
    assert.equal(verdict.errors, undefined, `${why}: ${JSON.stringify(verdict.errors)}`);
    assert.equal(verdict.outcome, 'refused', why); assert.ok(verdict.refusals.some(item => item.code === code), `${why}: ${JSON.stringify(verdict.refusals)}`);
    assert.match(verdict.next, /review-brief --reviewer security.*once more/, why);
  };
  check('a flagged file not listed as read', 'REVIEW_FILE_NOT_READ', made => [transcriptOf(f, made, { report: { ...reportOf(made), filesRead: [] } })]);
  check('every rule not checked', 'REVIEW_ALL_NOT_CHECKED', made => [transcriptOf(f, made, { report: { ...reportOf(made), rules: reportOf(made).rules.map(row => ({ ...row, result: 'not-checked' })) } })]);
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
  check('a Read with a limit', 'REVIEW_TRANSCRIPT_NO_OPEN', made => [transcriptOf(f, made, { reads: [{ path: flagged, input: { limit: 3 } }] })]);
  check('a REPORT.json that is not the transcript\'s report', 'REVIEW_REPORT_MISMATCH', made => [transcriptOf(f, made), { ...reportOf(made), residualRisk: 'other' }]);
  // A single rule not checked is allowed and recorded in the ledger.
  rmSync(join(f.root, VERDICTS_FILE), { force: true });
  assert.match(refusal(f.judge('security', join(f.base, 'missing.jsonl'))).reason, /cannot be read/, 'a file that is not there is not an attempt');
  const made = f.brief('security'), one = reportOf(made);
  const reads = [{ path: flagged, input: { limit: 3 } }, { path: flagged, input: { offset: 1 } }];
  const verdict = f.judge('security', transcriptOf(f, made, { reads, report: { ...one, rules: one.rules.map((row, i) => i === 0 ? { ...row, result: 'not-checked' } : row) } }));
  assert.equal(verdict.outcome, 'accepted'); assert.deepEqual(verdict.tickets[0].notChecked, [made.record.ruleIds[0]]);
  assert.match(f.ledger(), new RegExp(`not checked: ${made.record.ruleIds[0]} on US-01`));
});

test('a report refused twice, or no answer, means review not obtained: the flagged ticket is held, the others commit', async t => {
  const f = live(t), paths = ['src/list/a.js', 'src/authz.js', 'src/list/b.js'];
  const { open } = await runBatch(f, paths.map((path, i) => ticket(`US-0${i + 1}`, [path])), edits(paths));
  const first = f.brief('security'), refused = f.judge('security', transcriptOf(f, first, { reads: [] }));
  assert.equal(refused.outcome, 'refused');
  // The reviewer is told the rule it is judged by, and the refusal says how to meet it.
  assert.match(first.brief, /Read each whole: one Read with no offset and no limit\. A Read of a part of a file is not counted/);
  assert.match(JSON.stringify(refused), /a Read counts only with no offset and no limit, so read each of these whole/);
  assert.match(refusal(f.judge('security', transcriptOf(f, first))).reason, /brief again/, 'the next attempt needs a new brief');
  const second = f.brief('security');
  assert.match(second.record.retryReason, /REVIEW_TRANSCRIPT_NO_OPEN/); assert.match(second.brief, /earlier attempt was refused.*REVIEW_TRANSCRIPT_NO_OPEN/s);
  const lost = recordNoAnswer({ ...f.common, reviewer: 'security', reason: 'the reviewer stopped without a report' });
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
  outcome: (runId, ticket, outcome) => recordOutcomes({ instance, runId, reviewer: 'security', outcomes: [{ ticket, outcome, finding: 'x' }], tickets: [{ id: ticket, paths: ['src/a.js'] }], at: new Date().toISOString() }) }; };

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
  outcome('r1', 'T-3', 'not-obtained'); assert.equal(outcome('r3', 'T-3', 'not-obtained')[0]?.kind, 'review-not-obtained-again');
  assert.match(readFileSync(join(instance, 'pm-decisions.md'), 'utf8'), /ESCALATED ESC-T-2-r2: ticket T-2 was rejected or could not be reviewed in batches r1 and r2/);
});
