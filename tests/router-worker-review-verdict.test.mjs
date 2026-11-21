// ADR 0011, decisions 13, 16, 17 and 19: the kit judges a reviewer's report from its transcript, gates the commit
// on the verdicts, and escalates a ticket that keeps failing review to the owner without stopping unrelated work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeBatch, abortBatch } from '../src/router-worker/batch.mjs';
import { afterBatch, commitBatch } from '../src/router-worker/batch-close.mjs';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { reviewBrief } from '../src/router-worker/review-brief.mjs';
import { judgeReview, recordNoAnswer, VERDICTS_FILE } from '../src/router-worker/review-judge.mjs';
import { proposeAcknowledge, acknowledgeEscalation } from '../src/router-worker/escalations.mjs';
import { readBoundary } from '../src/router-worker/write-boundary.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { fixture, git } from './fixtures/router-worker/standing-team.mjs';

const refusal = result => result.errors?.[0];
const ticket = (id, paths, extra = {}) => ({ id, title: `Ticket ${id}`, goal: `Goal of ${id}`, acceptance: [`${id} acceptance holds`], paths, estimate: { execTokens: 12000, checkTokens: 6000, reworkTokens: 6000 }, ...extra });
const COMMANDS = ['echo verified-by-kit', 'pwd'];
const batchOf = (...tickets) => ({ tickets, verificationCommands: COMMANDS, sensitivePaths: ['src/auth/**'], nextLifecycleNumber: 1 });
const WORKER = 'tag-list-fixture-worker-exec';
const agents = { worker: () => ({ outcome: 'done', progress: true, filesTouched: [], decisionsCount: 1, selfReportTokens: 100, blocked: false, terminalStop: false, notes: 'done' }),
  verifier: () => ({ pass: true, staticPass: true, e2ePass: true, summary: 'ok', commandsRun: COMMANDS.map(command => ({ command, exitCode: 0 })), failures: [] }) };

function live(t) {
  const f = fixture(t); assert.equal(f.apply('router-worker', { spec: f.spec, limits: { allowedCommands: COMMANDS } }).errors, undefined); git(f.product, 'checkout', '-q', '-b', 'work');
  writeFileSync(join(f.root, 'profiles/review.json'), JSON.stringify({ schemaVersion: 1, triggers: [], rules: [], adrs: [] }));
  const common = { teamRoot: f.kit, instanceRoot: f.root }, projectsRoot = join(f.base, 'projects');
  return { ...f, common, projectsRoot,
    before: batch => beforeBatch({ ...common, batch }),
    brief: (reviewer, tickets) => reviewBrief({ ...common, reviewer, ...(tickets ? { tickets } : {}) }),
    judge: (reviewer, transcript, report) => judgeReview({ ...common, reviewer, transcript, projectsRoot, ...(report ? { report } : {}) }),
    commit: () => commitBatch(common), state: () => readBoundary(f.root)?.state, ledger: () => f.read('pm-decisions.md'),
    lines: file => existsSync(join(f.root, file)) ? f.read(file).split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] };
}
const changed = f => git(f.product, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map(line => line.slice(3)).sort();
// A batch run by the real engine with mock agents; `edits` is what the workers leave in the product.
async function runBatch(f, tickets, edits) {
  const open = await f.before(batchOf(...tickets));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl(agents) });
  for (const [path, text] of Object.entries(edits)) { mkdirSync(join(f.product, path, '..'), { recursive: true }); writeFileSync(join(f.product, path), text); }
  appendFileSync(join(f.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Edit', agentType: WORKER, judged: true, decision: 'allow' }) + '\n');
  const after = afterBatch({ ...f.common, result });
  assert.equal(after.errors, undefined, JSON.stringify(after.errors));
  return { open, after };
}
const edits = paths => Object.fromEntries(paths.map(path => [path, `// ${path}\n`]));

// The report a reviewer returns when every flagged file was read and every rule passes.
function reportOf(made) {
  const r = made.record;
  return { schemaVersion: 1, reviewer: r.reviewer, briefDigest: r.briefDigest,
    filesRead: r.tickets.flatMap(item => item.flaggedFiles.map(path => ({ path, read: true }))),
    rules: r.tickets.flatMap(item => r.ruleIds.map(rule => ({ rule, ticket: item.id, result: 'pass', file: item.flaggedFiles[0], line: 1, note: 'checked' }))),
    items: r.tickets.map(item => ({ ticket: item.id, verdict: 'GREEN', finding: 'nothing found', fix: '', control: null })), residualRisk: 'none' };
}
const CONTROL = { detects: 'a string literal assigned to a token variable', variation: 'the same literal in a test fixture', toolCanDetect: true };
const failing = (report, id, rule, item = {}) => ({ ...report,
  rules: report.rules.map(row => row.ticket === id && row.rule === rule ? { ...row, result: 'fail', note: 'a token is written in code' } : row),
  items: report.items.map(entry => entry.ticket === id ? { ...entry, verdict: 'RED', finding: 'a token is written in code', fix: 'read it from the environment', control: CONTROL, ...item } : entry) });

let agentSeq = 0;
// A reviewer's transcript as Claude Code writes it for an Agent-tool subagent: the brief as the prompt, one Read per
// flagged file, the report as the last fenced json block of the final message, and the meta file naming the wrapper.
function transcriptOf(f, made, { report = reportOf(made), reads, agentType = made.record.wrapper, workflow = false, prompt = `Review this batch.\n\n${made.brief}` } = {}) {
  const folder = join(f.projectsRoot, '-fixture-team', 'session-1', 'subagents', ...(workflow ? ['workflows', 'wf_1'] : [])), id = `agent-a${++agentSeq}`;
  const opened = reads ?? made.record.tickets.flatMap(item => item.flaggedFiles.filter(path => item.content[path] !== null).map(path => join(f.product, path)));
  const rows = [{ type: 'user', isSidechain: true, message: { role: 'user', content: prompt } },
    { type: 'attachment', attachment: {} },
    ...opened.map((path, i) => ({ type: 'assistant', message: { id: 'msg_reads', role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: path } }] } })),
    { type: 'assistant', message: { id: 'msg_report', role: 'assistant', content: [{ type: 'text', text: `Review done.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n` }] } }];
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(folder, `${id}.meta.json`), JSON.stringify({ agentType, description: 'review' }));
  return join(folder, `${id}.jsonl`);
}

test('a passed review lets the flagged ticket commit and the commit ends the review state; commit waits for the review', async t => {
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
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01', 'US-02']); assert.deepEqual(committed.held, []);
  assert.equal(f.state(), 'closed', 'the commit ends the review state');
  assert.ok(existsSync(join(f.root, 'batches', committed.runId, 'reviews.json')), 'the verdicts are archived with the batch');
});

test('a failed rule rejects its ticket: it and every later ticket stay uncommitted, earlier tickets commit, an AMBER concern does not reject', async t => {
  const f = live(t), paths = ['src/session.js', 'src/list/a.js', 'src/authz.js', 'src/list/b.js'];
  const { open } = await runBatch(f, paths.map((path, i) => ticket(`US-0${i + 1}`, [path])), edits(paths));
  const made = f.brief('security'), base = reportOf(made);
  const report = failing({ ...base, items: base.items.map(item => item.ticket === 'US-01' ? { ...item, verdict: 'AMBER', finding: 'the session lifetime is long' } : item) }, 'US-03', 'kit.sec.secret-in-code');
  const verdict = f.judge('security', transcriptOf(f, made, { report }));
  assert.equal(verdict.outcome, 'accepted', JSON.stringify(verdict));
  assert.deepEqual(verdict.tickets.map(item => [item.id, item.verdict, item.fails]), [['US-01', 'passed', []], ['US-03', 'rejected', ['kit.sec.secret-in-code']]]);
  assert.equal(verdict.tickets[0].finding, 'the session lifetime is long', 'the AMBER concern is kept for the PM\'s backlog');
  assert.deepEqual(f.lines('reviews/tickets.jsonl').map(line => [line.ticket, line.runId, line.reviewer, line.outcome, line.finding]), [['US-03', open.runId, 'security', 'rejected', 'a token is written in code']]);
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01', 'US-02']);
  assert.deepEqual(committed.held, [{ ticket: 'US-03', reason: 'rejected' }, { ticket: 'US-04', reason: 'after-held-ticket' }]);
  assert.deepEqual(changed(f), ['src/authz.js', 'src/list/b.js'], 'the rejected and later tickets stay in the work tree');
  assert.match(f.ledger(), /COMMITTED.*held: US-03 \(rejected\), US-04 \(after-held-ticket\)/);
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
  check('a REPORT.json that is not the transcript\'s report', 'REVIEW_REPORT_MISMATCH', made => [transcriptOf(f, made), { ...reportOf(made), residualRisk: 'other' }]);
  // A single rule not checked is allowed and recorded in the ledger.
  rmSync(join(f.root, VERDICTS_FILE), { force: true });
  assert.match(refusal(f.judge('security', join(f.base, 'missing.jsonl'))).reason, /cannot be read/, 'a file that is not there is not an attempt');
  const made = f.brief('security'), one = reportOf(made);
  const verdict = f.judge('security', transcriptOf(f, made, { report: { ...one, rules: one.rules.map((row, i) => i === 0 ? { ...row, result: 'not-checked' } : row) } }));
  assert.equal(verdict.outcome, 'accepted'); assert.deepEqual(verdict.tickets[0].notChecked, [made.record.ruleIds[0]]);
  assert.match(f.ledger(), new RegExp(`not checked: ${made.record.ruleIds[0]} on US-01`));
});

test('a report refused twice, or no answer, means review not obtained: the flagged ticket and later ones stay, earlier ones commit', async t => {
  const f = live(t), paths = ['src/list/a.js', 'src/authz.js', 'src/list/b.js'];
  const { open } = await runBatch(f, paths.map((path, i) => ticket(`US-0${i + 1}`, [path])), edits(paths));
  const first = f.brief('security'), refused = f.judge('security', transcriptOf(f, first, { reads: [] }));
  assert.equal(refused.outcome, 'refused');
  assert.match(refusal(f.judge('security', transcriptOf(f, first))).reason, /brief again/, 'the next attempt needs a new brief');
  const second = f.brief('security');
  assert.match(second.record.retryReason, /REVIEW_TRANSCRIPT_NO_OPEN/); assert.match(second.brief, /earlier attempt was refused.*REVIEW_TRANSCRIPT_NO_OPEN/s);
  const lost = recordNoAnswer({ ...f.common, reviewer: 'security', reason: 'the reviewer stopped without a report' });
  assert.equal(lost.outcome, 'not-obtained', JSON.stringify(lost)); assert.deepEqual(lost.tickets.map(item => [item.id, item.verdict]), [['US-02', 'not-obtained']]);
  assert.match(refusal(f.brief('security')).reason, /review of this batch is over \(not-obtained\)/);
  assert.deepEqual(f.lines('reviews/tickets.jsonl').map(line => [line.ticket, line.runId, line.outcome]), [['US-02', open.runId, 'not-obtained']]);
  assert.match(f.ledger(), /REVIEW \S+ security NOT OBTAINED/);
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01']);
  assert.deepEqual(committed.held, [{ ticket: 'US-02', reason: 'review-not-obtained' }, { ticket: 'US-03', reason: 'after-held-ticket' }]);
  assert.deepEqual(changed(f), ['src/authz.js', 'src/list/b.js']);
});

test('an elective review binds: the commit waits for it and its failed rule rejects the ticket', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/authz.js']), ticket('US-02', ['src/list/view.js'])], edits(['src/authz.js', 'src/list/view.js']));
  const sec = f.brief('security'); assert.equal(f.judge('security', transcriptOf(f, sec)).outcome, 'accepted');
  const arch = f.brief('architect', ['US-02']);
  assert.match(refusal(f.commit()).reason, /not over.*architect/);
  const verdict = f.judge('architect', transcriptOf(f, arch, { report: failing(reportOf(arch), 'US-02', 'kit.arch.boundaries') }));
  assert.deepEqual(verdict.tickets.map(item => [item.id, item.verdict]), [['US-02', 'rejected']]);
  const committed = f.commit();
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01']); assert.deepEqual(committed.held, [{ ticket: 'US-02', reason: 'rejected' }]);
});

test('a ticket rejected in a second batch is escalated: only a batch with it or a related ticket is refused, until the owner acknowledges it', async t => {
  const f = live(t), discard = () => { git(f.product, 'checkout', '-q', '--', '.'); git(f.product, 'clean', '-fdq'); };
  const rejectOnce = async () => {
    const { open } = await runBatch(f, [ticket('US-02', ['src/authz.js'])], edits(['src/authz.js']));
    const made = f.brief('security'), verdict = f.judge('security', transcriptOf(f, made, { report: failing(reportOf(made), 'US-02', 'kit.sec.secret-in-code') }));
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
  assert.equal(acknowledgeEscalation({ ...f.common, id: escalation.id, confirm: proposal.digest }).errors, undefined);
  assert.deepEqual(f.lines('reviews/acknowledged.jsonl').map(line => line.id), [escalation.id]);
  assert.match(f.ledger(), new RegExp(`ESCALATION ${escalation.id} ACKNOWLEDGED`));
  assert.equal((await f.before(batchOf(ticket('US-02', ['src/authz.js'])))).errors, undefined, 'the owner lifted the block');
});
