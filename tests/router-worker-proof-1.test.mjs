// ADR 0010, proof of readiness 1, with ADR 0011's addition: with no model, a blank project is bootstrapped in
// Router/Worker mode, a batch runs on stand-in agents through the after-run checks and the review (one flagged ticket
// passes, one is rejected, one's review is not obtained), the team switches to specialist mode and back, and the same
// team and ledgers are found and still work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../src/loop/contracts.mjs';
import { RETURN_FILE } from '../src/router-worker/batch.mjs';
import { recordNoAnswer } from '../src/router-worker/review-judge.mjs';
import { settleBatch } from '../src/router-worker/batch-settle.mjs';
import { loadRetryRules } from '../src/router-worker/retries.mjs';
import { boundLimits } from '../src/router-worker/switch.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { meterOf } from './fixtures/router-worker/meter.mjs';
import { refusal, ticket, live, changed, runBatch, reportOf, failing, transcriptOf } from './fixtures/router-worker/review.mjs';

// US-02 is flagged for Security by the CI trigger and passes; US-03 for Security by the word "auth" and is rejected;
// US-04 for the Architect only, by the lint and test configuration trigger, and its review is not obtained.
// US-01 and US-05 are not flagged; US-05 comes after the first held ticket, so the re-verification decides it.
const TICKETS = [ticket('US-01', ['src/list/a.js']), ticket('US-02', ['.github/workflows/ci.yml']), ticket('US-03', ['src/authz.js']),
  ticket('US-04', ['tsconfig.json']), ticket('US-05', ['src/list/b.js'])];
const EDITS = { 'src/list/a.js': '// a\n', '.github/workflows/ci.yml': 'on: push\n', 'src/authz.js': 'export const token = "x";\n',
  'tsconfig.json': '{"compilerOptions":{"strict":false}}\n', 'src/list/b.js': '// b\n' };
const COMMITTED = ['US-01', 'US-02', 'US-05'];
const REVIEW_TOKENS = 40000;
const OWN_RW = ['agents/roster.md', 'agents/worker-exec.md', 'agents/worker-check.md', 'agents/worker-guard.md', 'profiles/team-mode.json'];

const validate = f => spawnSync('bash', [join(f.kit, 'scripts/validate-team.sh'), '--mode', 'deployment', f.root], { encoding: 'utf8' });
const tokensOf = count => [...Array.from({ length: count }, () => [12000, 6000]).flat(), 5000];
const withReviewer = (meter, row) => ({ ...meter, subagents: [...meter.subagents, { agentId: 'a-review', workflowRunId: null, finished: true, ...row }] });
const settle = (f, meter, runId) => settleBatch({ ...f.common, meter, runId, rules: loadRetryRules({ teamRoot: f.kit, instanceRoot: f.root }) });
const commitsSince = (f, start) => git(f.product, 'rev-list', '--reverse', `${start}..HEAD`).trim().split('\n').map(sha => {
  const [subject, ...paths] = git(f.product, 'show', '--format=%s', '--name-only', sha).trim().split('\n').filter(Boolean);
  return [subject.split(':')[0], paths.sort()];
});
const listing = (dir, sub) => existsSync(join(dir, sub)) ? readdirSync(join(dir, sub), { recursive: true }).map(String).sort() : [];
// Every file of the instance, kit and switch backups apart, with its digest.
const snapshot = f => f.tree().split('\n').filter(line => line && !line.includes('./holiday/.switch-backup-'));

function blankTeam(t) {
  const f = live(t, { blank: true });
  assert.deepEqual(git(f.product, 'ls-files').trim().split('\n').sort(), ['README.md', 'docs/USAGE.md', 'docs/functional.md', 'docs/technical.md'], 'a blank product: the PM\'s README and docs, no code');
  const profile = JSON.parse(f.read('profiles/team-mode.json'));
  assert.deepEqual([profile.mode, profile.status, profile.dispatch, profile.gatePath], ['router-worker', 'live', 'engine', false]);
  assert.match(f.ledger(), /MODE SWITCH: from specialist to router-worker; .*confirmed by its code, typed at an interactive terminal/);
  assert.equal(boundLimits(f.root), digest(profile.limits), 'the limits in force are the ones the switch line binds');
  const checked = validate(f);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  return f;
}

async function batchOne(f) {
  const start = git(f.product, 'rev-parse', 'HEAD').trim(), ran = await runBatch(f, TICKETS, EDITS), { open, after } = ran, run = open.runId;
  assert.equal(after.status, 'review');
  assert.deepEqual(after.reviews, { security: { tickets: ['US-02', 'US-03'] }, architect: { tickets: ['US-04'] } }, 'the kit triggers flag three tickets');
  assert.deepEqual(after.tickets.filter(entry => entry.review?.required.length).map(entry => [entry.id, entry.review.because.map(why => why.trigger)]),
    [['US-02', ['kit.ci-deploy']], ['US-03', ['kit.sensitive-word']], ['US-04', ['kit.lint-test-config']]]);
  writeFileSync(join(f.base, 'result.json'), f.read(RETURN_FILE));
  const reconciled = spawnSync(process.execPath, [join(f.kit, 'scripts/reconcile-run.mjs'), join(f.base, 'result.json'), f.root], { encoding: 'utf8' });
  assert.equal(reconciled.status, 0, reconciled.stdout + reconciled.stderr);
  assert.ok(f.read('agents/lifecycle.md').includes(run), 'the lifecycle holds the run');

  const security = f.brief('security');
  assert.equal(security.errors, undefined, JSON.stringify(security.errors));
  const transcript = transcriptOf(f, security, { report: failing(reportOf(security), 'US-03', 'kit.sec.secret-in-code') });
  assert.equal(f.judge('security', transcript).outcome, 'accepted');
  for (const attempt of [1, 2]) {
    assert.equal(f.brief('architect').errors, undefined);
    recordNoAnswer({ ...f.common, reviewer: 'architect', reason: `no answer ${attempt}` });
  }
  assert.match(refusal(f.commit()).reason, /resolve/, 'commit waits for the resolution');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.removed.map(entry => [entry.ticket, entry.reason]), [['US-03', 'rejected'], ['US-04', 'review-not-obtained']]);
  assert.deepEqual([resolved.verification.ran, resolved.verification.failed], [true, false], 'US-05 follows a held ticket: the commands run again and pass');
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), COMMITTED);
  assert.deepEqual(committed.held.map(entry => [entry.ticket, entry.reason]), [['US-03', 'rejected'], ['US-04', 'review-not-obtained']]);
  return { ...ran, start, run, transcript, resolved, committed, wrapper: security.record.wrapper };
}

function checkBatchOne(f, one) {
  const { start, run } = one;
  assert.deepEqual(commitsSince(f, start), [['US-01', ['src/list/a.js']], ['US-02', ['.github/workflows/ci.yml']], ['US-05', ['src/list/b.js']]],
    'the working branch holds one commit per committed ticket, with only its paths');
  assert.deepEqual(changed(f), [], 'the held tickets are not left in the work tree');
  const worktree = join(f.base, 'start'); git(f.product, 'worktree', 'add', '-q', '--detach', worktree, start);
  for (const [id, path] of [['US-03', 'src/authz.js'], ['US-04', 'tsconfig.json']]) {
    const patch = join(f.root, `reviews/held/${run}/${id}.patch`);
    assert.ok(existsSync(patch), `${id} is held as a patch`);
    const check = spawnSync('git', ['-C', worktree, 'apply', '--check', '--numstat', patch], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${id}'s patch applies on the start commit. ${check.stderr}`);
    assert.equal(check.stdout.trim().split('\t')[2], path);
  }
  git(f.product, 'worktree', 'remove', '--force', worktree);

  const meter = withReviewer(meterOf({ ...f, open: one.open, guardianBrief: one.guardianBrief }, tokensOf(TICKETS.length)), { agentType: one.wrapper, file: one.transcript, harnessEq: REVIEW_TOKENS });
  const settled = settle(f, meter, run);
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors));
  assert.equal(settled.status, 'clear'); assert.deepEqual(settled.findings, []);
  assert.equal(settled.reviewCost, REVIEW_TOKENS); assert.deepEqual(settled.reviews.map(entry => [entry.reviewer, entry.spentTokens, entry.overrun]), [['security', REVIEW_TOKENS, false]]);
  assert.equal(settled.run.ticketTokens, settled.tickets.reduce((sum, entry) => sum + entry.spentTokens, 0), 'the reviewer is not charged to a ticket');

  const ledger = f.ledger();
  for (const line of [`BATCH ${run} REVIEW TRIGGERS FROZEN`, `BATCH ${run} CLOSED \\(review\\)`, `REVIEW ${run} security ACCEPTED`, `REVIEW ${run} architect NOT OBTAINED`,
    `BATCH ${run} RESOLVED: held US-03 \\(rejected\\)`, `BATCH ${run} COMMITTED`, `BATCH ${run} SETTLED \\(clear\\): .*; review ${REVIEW_TOKENS} token\\(s\\) on 1 reviewer call`])
    assert.match(ledger, new RegExp(line), line);
  assert.deepEqual(listing(f.root, `batches/${run}`).filter(name => name.endsWith('.json')).sort(),
    ['after.json', 'batch.json', 'commit.json', 'commits.json', 'resolution.json', 'return.json', 'review-architect.json', 'review-security.json', 'reviews.json', 'settlement.json']);
  assert.deepEqual(f.lines('reviews/tickets.jsonl').map(line => [line.ticket, line.reviewer, line.outcome]), [['US-03', 'security', 'rejected'], ['US-04', 'architect', 'not-obtained']]);
}

function roundTrip(f) {
  const before = snapshot(f), ledger = f.ledger(), own = f.digests(OWN_RW), wrappers = f.wrappers();
  const away = f.apply('specialist', {});
  assert.equal(away.errors, undefined, JSON.stringify(away.errors)); assert.equal(away.mode, 'specialist');
  assert.deepEqual(f.wrappers(), ['tag-list-fixture-backend.md'], 'the specialist wrapper is live, the Router/Worker ones on holiday');
  assert.equal(existsSync(join(f.root, 'profiles/team-mode.json')), false);
  const back = f.apply('router-worker', {});
  assert.equal(back.errors, undefined, JSON.stringify(back.errors)); assert.equal(back.mode, 'router-worker');
  assert.deepEqual(f.digests(OWN_RW), own, 'roster, worker roles and mode profile come back byte for byte');
  assert.deepEqual(f.wrappers(), wrappers);
  const profile = JSON.parse(f.read('profiles/team-mode.json'));
  assert.equal(profile.gatePath, false); assert.equal(boundLimits(f.root), digest(profile.limits), 'the limits are still the bound ones');
  const now = f.ledger(), added = now.slice(ledger.length).split('\n').filter(Boolean);
  assert.ok(now.startsWith(ledger), 'the ledger up to the switch is unchanged');
  assert.equal(added.length, 2); assert.ok(added.every(line => / MODE SWITCH: from (router-worker|specialist) to /.test(line)), added.join('\n'));
  const sansLedger = lines => lines.filter(line => !line.endsWith('./pm-decisions.md'));
  assert.deepEqual(sansLedger(snapshot(f)), sansLedger(before), 'every other file of the team, lifecycle, archives and reviews included, is the same');
  const checked = validate(f);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
}

async function batchTwo(f) {
  const tickets = [ticket('US-06', ['src/list/c.js'])], denied = await f.before({ tickets, verificationCommands: ['echo not-confirmed'], sensitivePaths: ['src/auth/**'], nextLifecycleNumber: 20 });
  assert.match(refusal(denied).reason, /echo not-confirmed/, 'a command the owner did not confirm is refused');
  const { open, after, guardianBrief } = await runBatch(f, tickets, { 'src/list/c.js': '// c\n' }, { nextLifecycleNumber: 20 });
  assert.equal(after.status, 'clean'); assert.deepEqual(open.limits, JSON.parse(f.read('profiles/team-mode.json')).limits, 'the batch freezes the bound limits');
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors)); assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-06']);
  assert.match(refusal(await f.before({ tickets: [ticket('US-07', ['src/list/d.js'])], verificationCommands: f.commands, sensitivePaths: ['src/auth/**'], nextLifecycleNumber: 30 })).reason,
    new RegExp(`${open.runId}.*settle`), 'the next batch waits for the settlement');
  const meter = meterOf({ ...f, open, guardianBrief }, tokensOf(1), { session: 'sess-2' });
  const settled = settle(f, meter, open.runId);
  assert.equal(settled.errors, undefined, JSON.stringify(settled.errors)); assert.equal(settled.status, 'clear');
}

test('proof 1: a blank project in Router/Worker mode runs a reviewed batch, switches to specialist and back, and finds the same team', async t => {
  const f = blankTeam(t);
  const one = await batchOne(f);
  checkBatchOne(f, one);
  roundTrip(f);
  await batchTwo(f);
});
