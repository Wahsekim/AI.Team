// ADR 0011, decision 23: each reviewer call is set against its own authorization at settlement, from the measured usage.
// An overrun is reported and holds nothing; the review cost is stated apart from the tickets'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../src/loop/contracts.mjs';
import { abortBatch } from '../src/router-worker/batch.mjs';
import { settleBatch } from '../src/router-worker/batch-settle.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { proposeLimits, changeLimits, DEFAULT_LIMITS } from '../src/router-worker/switch.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { meterOf } from './fixtures/router-worker/meter.mjs';
import { refusal, ticket, batchOf, live, runBatch, edits, transcriptOf } from './fixtures/router-worker/review.mjs';

const ENGINE = [12000, 6000, 12000, 6000, 5000];
// A batch whose first ticket Security reviews and passes; the review state is still open.
async function reviewed(t) {
  const f = live(t), paths = ['src/authz.js', 'src/list/view.js'];
  const { open, guardianBrief } = await runBatch(f, paths.map((path, i) => ticket(`US-0${i + 1}`, [path])), edits(paths));
  const made = f.brief('security'), transcript = transcriptOf(f, made);
  assert.equal(f.judge('security', transcript).outcome, 'accepted');
  const settle = (meter, extra = {}) => settleBatch({ ...f.common, meter, rules: loadRetryRules({ teamRoot: f.kit, instanceRoot: f.root }), ...extra });
  return { f, open, transcript, wrapper: made.record.wrapper, settle, engine: () => meterOf({ ...f, open, guardianBrief }, ENGINE) };
}
// The reviewer's row as scripts/measure-spawn.mjs writes it for an Agent-tool subagent of the main session.
const withReviewer = (meter, { transcript, wrapper }, tokens) => ({ ...meter, subagents: [...meter.subagents, { agentId: 'a-review', workflowRunId: null, agentType: wrapper, file: transcript, harnessEq: tokens, finished: true }] });

test('a reviewer call over its authorization is recorded and puts the batch in review; the commits stand and the review cost is stated apart', async t => {
  const r = await reviewed(t), { f } = r, meter = withReviewer(r.engine(), r, 350000);
  assert.match(refusal(r.settle(meter)).reason, /in review/, 'settle waits for the review to end');
  assert.equal(f.resolve().errors, undefined);
  const committed = f.commit(); assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  const head = git(f.product, 'rev-parse', 'HEAD').trim();
  const settled = r.settle(meter, { runId: r.open.runId });
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors));
  assert.deepEqual(settled.reviews, [{ reviewer: 'security', attempt: 1, transcript: realpathSync(r.transcript), spentTokens: 350000, authorizedTokens: DEFAULT_LIMITS.authorizationPerReviewerCall, overrun: true }]);
  assert.equal(settled.reviewCost, 350000); assert.equal(settled.run.ticketTokens, 36040, 'the reviewer is not charged to a ticket');
  assert.deepEqual(settled.findings, []); assert.ok(settled.tickets.every(entry => entry.budgetGate === 'clear'));
  assert.equal(settled.status, 'review', 'the overrun alone puts the batch in review');
  assert.deepEqual(settled.limits, [{ limit: 'authorizationPerReviewerCall', observed: 350000, current: 300000, proposal: { authorizationPerReviewerCall: 438000 }, reviews: [{ reviewer: 'security', attempt: 1 }] }]);
  assert.match(f.ledger(), /SETTLED \(review\): 36040 token\(s\) on 2 ticket\(s\) of 400000 authorized, Guardian 5010; review 350000 token\(s\) on 1 reviewer call\(s\) of 300000 authorized each, over: security attempt 1;/);
  assert.equal(git(f.product, 'rev-parse', 'HEAD').trim(), head, 'nothing is undone'); assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-01', 'US-02']);
});

test('a judged reviewer call the meter does not hold is a finding, REVIEW_NOT_METERED', async t => {
  const r = await reviewed(t), { f } = r;
  assert.equal(f.resolve().errors, undefined);
  const settled = r.settle(r.engine());
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors));
  assert.deepEqual(settled.findings.map(finding => [finding.code, finding.reviewer, finding.attempt]), [['REVIEW_NOT_METERED', 'security', 1]]);
  assert.deepEqual(settled.reviews.map(entry => [entry.reviewer, entry.spentTokens, entry.overrun]), [['security', null, null]]);
  assert.equal(settled.reviewCost, 0); assert.equal(settled.status, 'review'); assert.deepEqual(settled.limits, []);
  assert.match(f.ledger(), /SETTLED \(review\): .*; review 0 token\(s\) on 1 reviewer call\(s\) of 300000 authorized each; .*findings: REVIEW_NOT_METERED/);
});

test('a team whose bound limits lack the authorization per reviewer call is stopped by before until the owner adds it with limits', async t => {
  const f = live(t), profilePath = join(f.root, 'profiles/team-mode.json'), profile = JSON.parse(f.read('profiles/team-mode.json'));
  const { authorizationPerReviewerCall, ...older } = profile.limits, common = { teamRoot: f.kit, instanceRoot: f.root }, one = batchOf(ticket('US-01', ['src/a.js']));
  assert.equal(authorizationPerReviewerCall, 300000, 'the switch sets it with the other limits');
  // A team that went live before the limit existed: its limits are bound as they were.
  writeFileSync(profilePath, JSON.stringify({ ...profile, limits: older }));
  appendFileSync(join(f.root, 'pm-decisions.md'), `2026-11-21 LIMITS CHANGED: none, the limits in force re-confirmed as they stand; proposal sha256:${'1'.repeat(64)} was confirmed by its code, typed at an interactive terminal; limits ${digest(older)}.\n`);
  const stopped = refusal(await f.before(one));
  assert.equal(stopped.code, 'LIMITS_NOT_BOUND'); assert.match(stopped.reason, /authorizationPerReviewerCall.*team-mode\.mjs limits <LIMITS\.json> --instance <instance-root>/);
  const proposal = proposeLimits({ ...common, limits: {} });
  assert.equal(proposal.errors, undefined, JSON.stringify(proposal.errors)); assert.equal(proposal.unbound, undefined);
  assert.equal(Object.hasOwn(proposal.from, 'authorizationPerReviewerCall'), false); assert.equal(proposal.to.authorizationPerReviewerCall, 300000);
  assert.equal(changeLimits({ ...common, limits: {}, confirm: proposal.digest, atTerminal: true }).errors, undefined);
  assert.match(f.ledger(), new RegExp(`LIMITS CHANGED: authorizationPerReviewerCall unset -> 300000; .*; limits ${digest(proposal.to)}\\.\\n`));
  const opened = await f.before(one); assert.equal(opened.errors, undefined, JSON.stringify(opened.errors)); assert.equal(opened.limits.authorizationPerReviewerCall, 300000);
  assert.equal(abortBatch(common).errors, undefined);
  assert.match(refusal(proposeLimits({ ...common, limits: { authorizationPerReviewerCall: 0 } })).reason, /positive integers/);
});
