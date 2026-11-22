// ADR 0011, decision 7: a periodic review every HARDENING_INTERVAL committed tickets, Security once and Architect once,
// over what no triggered review of that reviewer passed. "before" waits for it; it holds no commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { periodicBrief, judgePeriodic, recordPeriodicNoAnswer, hardeningInterval } from '../src/router-worker/review-periodic.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { refusal, ticket, batchOf, live, runBatch, edits, transcriptOf, reportOf, failing, changed } from './fixtures/router-worker/review.mjs';

// A live team whose charter sets the interval to `interval` committed tickets.
function team(t, interval = 2) {
  const f = live(t);
  writeFileSync(join(f.root, 'charter.md'), f.read('charter.md').replace(/At counter = `[^`]*`/, `At counter = \`${interval}\``));
  return { ...f,
    periodicBrief: reviewer => periodicBrief({ ...f.common, reviewer }),
    periodic: (reviewer, transcript, extra = {}) => judgePeriodic({ ...f.common, reviewer, transcript, projectsRoot: f.projectsRoot, ...extra }),
    silent: (reviewer, reason) => recordPeriodicNoAnswer({ ...f.common, reviewer, reason }),
    periodicLines: () => f.lines('reviews/periodic.jsonl') };
}
const settled = (f, runId) => assert.equal(markNotMetered({ ...f.common, reason: 'fixture', runId }).errors, undefined);
// A batch run, reviewed and passed by Security when flagged, committed and marked as not metered.
async function committed(f, tickets) {
  const { open, after } = await runBatch(f, tickets, edits(tickets.flatMap(entry => entry.paths)));
  if (after.reviews?.security) {
    assert.equal(f.judge('security', transcriptOf(f, f.brief('security'))).outcome, 'accepted');
    assert.equal(f.resolve().errors, undefined);
  }
  const done = f.commit(); assert.equal(done.errors, undefined, JSON.stringify(done.errors));
  settled(f, open.runId);
  return done;
}
const next = f => f.before(batchOf(ticket('US-99', ['src/next.js'])));
// Two committed tickets: US-01 flagged for Security by the kit's sensitive-word trigger and passed, US-02 flagged by none.
async function due(t) {
  const f = team(t);
  const done = await committed(f, [ticket('US-01', ['src/authz.js']), ticket('US-02', ['src/list/view.js'])]);
  return { f, shas: Object.fromEntries(done.commits.map(commit => [commit.ticket, commit.sha])) };
}

test('the interval comes from the instance charter, the template default when unset', t => {
  const f = team(t, 3);
  assert.equal(hardeningInterval(f.root, f.kit), 3);
  writeFileSync(join(f.root, 'charter.md'), f.read('charter.md').replace('At counter = `3`', 'At counter = `{{HARDENING_INTERVAL | default:25}}`'));
  assert.equal(hardeningInterval(f.root, f.kit), 25);
});

test('the committed ticket that reaches the interval makes before refuse, naming the periodic commands; no brief while a batch is open', async t => {
  const f = team(t);
  await committed(f, [ticket('US-01', ['src/one.js'])]);
  const second = await runBatch(f, [ticket('US-02', ['src/two.js'])], edits(['src/two.js']));
  assert.match(refusal(f.periodicBrief('security')).reason, /batch is open/);
  assert.equal(f.commit().errors, undefined); settled(f, second.open.runId);
  const refused = refusal(await next(f));
  assert.equal(refused.code, 'PERIODIC_REVIEW_DUE');
  assert.match(refused.reason, /security \(2 committed tickets since its last\), architect \(2/);
  assert.match(refused.reason, /rw-batch\.mjs periodic-brief --reviewer <reviewer> --instance <instance-root>/);
  assert.match(refused.reason, /periodic --no-answer/);
});

test('a ticket a reviewer passed in a triggered review is outside that reviewer\'s periodic scope, and only that reviewer\'s', async t => {
  const { f, shas } = await due(t);
  const security = f.periodicBrief('security'), architect = f.periodicBrief('architect');
  assert.equal(security.errors, undefined, JSON.stringify(security.errors));
  assert.deepEqual(security.record.tickets.map(item => [item.id, item.shas]), [['US-02', [shas['US-02']]]]);
  assert.deepEqual(security.record.counted, [shas['US-01'], shas['US-02']], 'both are counted');
  assert.deepEqual(architect.record.tickets.map(item => item.id), ['US-01', 'US-02']);
  assert.deepEqual(security.record.tickets[0].flaggedFiles, ['src/list/view.js']);
  assert.ok(security.brief.includes(join(f.product, 'src/list/view.js')) && !security.brief.includes(join(f.product, 'src/authz.js')), 'the brief names only the files in scope');
  assert.ok(security.brief.includes(shas['US-02']), 'the brief names the commit');
  assert.equal(f.state(), 'review', 'the periodic review runs under the review state');
});

test('a recorded periodic review of each reviewer unblocks before; the meter row gives its tokens', async t => {
  const { f } = await due(t);
  const made = f.periodicBrief('security'), transcript = transcriptOf(f, made);
  const meter = { subagents: [{ agentId: 'a-review', workflowRunId: null, agentType: made.record.wrapper, file: transcript, harnessEq: 120000, finished: true }] };
  const judged = f.periodic('security', transcript, { meter });
  assert.equal(judged.errors, undefined, JSON.stringify(judged.errors));
  assert.deepEqual([judged.outcome, judged.tokens, judged.authorizedTokens, judged.overrun, judged.transcript.file], ['accepted', 120000, 300000, false, realpathSync(transcript)]);
  assert.equal(refusal(await next(f)).code, 'BATCH_REFUSED', 'architect is still due: the review state stays');
  assert.equal(f.state(), 'review');
  const architect = f.periodicBrief('architect'), judgedArchitect = f.periodic('architect', transcriptOf(f, architect));
  assert.deepEqual([judgedArchitect.outcome, judgedArchitect.tokens, judgedArchitect.overrun], ['accepted', null, null], 'no meter, no tokens');
  assert.equal(f.state(), 'closed', 'both reviewers have an outcome: the review state closes');
  assert.match(f.ledger(), /PERIODIC REVIEW periodic-\S+ security ACCEPTED \(attempt 1\): 1 committed ticket\(s\) reviewed, no finding/);
  const opened = await next(f);
  assert.equal(opened.errors, undefined, JSON.stringify(opened.errors));
});

test('a periodic review not obtained twice is recorded, reported to the human and does not stall before', async t => {
  const { f } = await due(t);
  const made = f.periodicBrief('security'), bad = transcriptOf(f, made, { reads: [] });
  const first = f.periodic('security', bad);
  assert.equal(first.outcome, 'refused'); assert.match(first.next, /periodic-brief --reviewer security/);
  assert.match(refusal(f.periodic('security', transcriptOf(f, made))).reason, /already judged; brief again/);
  assert.equal(f.periodicBrief('security').record.attempt, 2);
  const cli = spawnSync(process.execPath, [join(f.kit, 'scripts/rw-batch.mjs'), 'periodic', '--no-answer', 'the reviewer stopped at its turn limit', '--reviewer', 'security', '--instance', f.root], { encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).outcome, 'not-obtained');
  assert.match(f.ledger(), /PERIODIC REVIEW periodic-\S+ security NOT OBTAINED \(attempt 2\).*reported to the owner; the next batch is not stopped/);
  assert.equal(f.periodic('architect', transcriptOf(f, f.periodicBrief('architect'))).outcome, 'accepted');
  assert.deepEqual(f.periodicLines().map(line => [line.reviewer, line.outcome]), [['security', 'refused'], ['security', 'not-obtained'], ['architect', 'accepted']]);
  const opened = await next(f);
  assert.equal(opened.errors, undefined, JSON.stringify(opened.errors));
});

test('a failed rule in a periodic review is a finding with its control; no commit is touched', async t => {
  const { f, shas } = await due(t);
  const head = git(f.product, 'rev-parse', 'HEAD').trim(), made = f.periodicBrief('security');
  const report = failing(reportOf(made), 'US-02', made.record.ruleIds[0]);
  const judged = f.periodic('security', transcriptOf(f, made, { report }));
  assert.equal(judged.outcome, 'accepted');
  assert.deepEqual(judged.findings.map(item => [item.ticket, item.verdict, item.fails, item.shas]), [['US-02', 'RED', [made.record.ruleIds[0]], [shas['US-02']]]]);
  assert.equal(judged.findings[0].control.toolCanDetect, true);
  assert.equal(git(f.product, 'rev-parse', 'HEAD').trim(), head); assert.deepEqual(changed(f), []);
  assert.match(f.ledger(), /security ACCEPTED \(attempt 1\): 1 committed ticket\(s\) reviewed, 1 finding\(s\) for the PM to file as tickets: US-02 RED/);
});
