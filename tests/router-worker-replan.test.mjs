// ADR 0010, amendment of 2026-11-27: a ticket that ran before and was not committed is replanned before it runs again, and
// a ticket runs at most three times (the initial run and two retries) before it goes to the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { abortBatch, BATCH_FILE } from '../src/router-worker/batch.mjs';
import { markNotMetered } from '../src/router-worker/batch-settle.mjs';
import { saveLeftWork } from '../src/router-worker/batch-left.mjs';
import { proposeAcknowledge, acknowledgeEscalation } from '../src/router-worker/escalations.mjs';
import { compile } from '../src/router-worker/compile.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';
import { ticket, live, runBatch, batchOf, edits, checker, refusal } from './fixtures/router-worker/review.mjs';

const taskData = brief => JSON.parse(brief.split('\n').find(line => line.startsWith('{"assignmentId"')));
const replan = n => ({ cause: `The checker failed run ${n}: a test fails`, feasible: 'The goal fits the paths as written', change: `Attempt ${n + 1}: the plan names the failing test first` });
const again = f => f.ledger().split('\n').filter(line => / RUNS \S+ AGAIN /.test(line));
// A batch run by the engine, closed by after and commit, the work it left saved by left, and its usage settled.
async function ran(f, tickets, paths, failing = [1]) {
  const { open, after } = await runBatch(f, tickets, edits(paths), {}, checker(...failing));
  assert.equal(f.commit().errors, undefined); assert.equal(saveLeftWork(f.common).errors, undefined);
  assert.equal(markNotMetered({ ...f.common, reason: 'not measured in this test', runId: open.runId }).errors, undefined);
  return { open, after };
}

test('a ticket that failed before is refused without a replan, with the evidence of that run; with one it opens, frozen, logged for the owner and in both briefs', async t => {
  const f = live(t), one = await ran(f, [ticket('US-01', ['src/list/a.js'])], ['src/list/a.js']), r1 = one.open.runId;
  assert.deepEqual(one.after.tickets.map(entry => entry.status), ['not-passed']);

  const bare = refusal(await f.before(batchOf(ticket('US-01', ['src/list/a.js']))));
  assert.equal(bare?.code, 'BATCH_REFUSED');
  for (const evidence of [`batches/${r1}/after.json`, `batches/${r1}/return.json`, `left/${r1}/US-01.patch`]) assert.ok(bare.reason.includes(evidence), `the refusal names ${evidence}: ${bare.reason}`);
  assert.match(bare.reason, /"replan": \{"cause".*"feasible".*"change"/); assert.match(bare.reason, /owner/);
  assert.equal(existsSync(join(f.root, BATCH_FILE)), false);

  const stray = refusal(await f.before(batchOf(ticket('US-01', ['src/list/a.js'], { replan: replan(1) }), ticket('US-05', ['src/list/e.js'], { replan: replan(1) }))));
  assert.equal(stray?.code, 'BATCH_REFUSED'); assert.match(stray.reason, /US-05 carries a replan.*never ran/);
  const odd = refusal(await f.before(batchOf(ticket('US-01', ['src/list/a.js'], { replan: { ...replan(1), cause: 'two\nlines' } }))));
  assert.match(odd?.reason, /US-01: replan must carry exactly cause, feasible and change/);

  // The second run fails too: its replan is frozen in the archive.
  const two = await ran(f, [ticket('US-01', ['src/list/a.js'], { replan: replan(1) }), ticket('US-05', ['src/list/e.js'])], ['src/list/a.js', 'src/list/e.js']), r2 = two.open.runId;
  const runs = [{ runId: r1, ticket: 'US-01', status: 'not-passed' }];
  assert.deepEqual(two.open.tickets.map(entry => [entry.replan, entry.earlierRuns]), [[replan(1), { runs, count: 1 }], [undefined, { runs: [], count: 0 }]]);
  assert.deepEqual(two.open.runsAgain, [{ ticket: 'US-01', count: 1, replan: replan(1) }], 'before\'s output lists the ticket that runs again, for the PM to relay');
  assert.deepEqual(again(f), [`${two.open.openedAt.slice(0, 10)} BATCH ${r2} RUNS US-01 AGAIN (owner spot review): 1 earlier run(s) by the engine that the kit did not commit: ${r1} as US-01 (not-passed). Replanned by the PM: cause: ${replan(1).cause}; feasible: ${replan(1).feasible}; change: ${replan(1).change}.`]);
  const [exec, other] = two.open.args.plan;
  for (const brief of [exec.brief, exec.verifierBrief]) {
    assert.deepEqual(taskData(brief).ranBefore, { runs, count: 1, replan: replan(1) });
    assert.match(brief, /ranBefore names the earlier runs of this ticket/);
  }
  for (const brief of [other.brief, other.verifierBrief]) { assert.equal(taskData(brief).ranBefore, undefined); assert.doesNotMatch(brief, /ranBefore|replan/); }

  const same = refusal(await f.before(batchOf(ticket('US-01', ['src/list/a.js'], { replan: replan(1) }))));
  assert.equal(same?.code, 'BATCH_REFUSED'); assert.match(same.reason, new RegExp(`US-01: its replan is the one batch ${r2} froze for it`));
  assert.ok(same.reason.includes(`batches/${r2}/after.json`), same.reason);
  const changed = await f.before(batchOf(ticket('US-01', ['src/list/a.js'], { replan: replan(2) })));
  assert.equal(changed.errors, undefined, JSON.stringify(changed.errors));
  assert.deepEqual(changed.tickets[0].earlierRuns, { runs: [...runs, { runId: r2, ticket: 'US-01', status: 'not-passed' }], count: 2 });
  assert.equal(abortBatch(f.common).errors, undefined);
});

test('a ticket runs at most three times: a run that passed and was held does not count; the fourth filing escalates, and after the owner\'s acknowledgement one more failure escalates again', async t => {
  const f = live(t), file = (n, extra = {}) => ticket('US-01', ['src/list/a.js'], { ...(n ? { replan: replan(n) } : {}), ...extra });
  // Run 0 passes and its batch is archived without commit, as a held batch is.
  const held = await runBatch(f, [file(0)], edits(['src/list/a.js']));
  assert.equal(abortBatch(f.common).errors, undefined); git(f.product, 'checkout', '-q', '--', '.'); git(f.product, 'clean', '-fdq');
  assert.equal(markNotMetered({ ...f.common, reason: 'not measured in this test', runId: held.open.runId }).errors, undefined);
  assert.match(refusal(await f.before(batchOf(file(0))))?.reason, /US-01 ran before/, 'a run that passed and was not committed still needs a replan');

  const failed = [];
  for (const n of [1, 2]) failed.push((await ran(f, [file(n)], ['src/list/a.js'])).open.runId);
  // Three earlier runs, two of them failed: it opens.
  const third = await ran(f, [file(3)], ['src/list/a.js']); failed.push(third.open.runId);
  assert.equal(third.open.tickets[0].earlierRuns.count, 3);

  const exhausted = refusal(await f.before(batchOf(file(4), ticket('US-05', ['src/list/e.js']))));
  assert.equal(exhausted?.code, 'TICKET_ATTEMPTS_EXHAUSTED');
  for (const runId of failed) assert.ok(exhausted.reason.includes(runId), `the refusal names ${runId}`);
  assert.doesNotMatch(exhausted.reason, new RegExp(held.open.runId));
  const [escalation] = f.lines('reviews/escalations.jsonl');
  assert.deepEqual([escalation.kind, escalation.ticket, escalation.runIds, escalation.paths], ['attempts-exhausted', 'US-01', failed, ['src/list/a.js']]);
  assert.ok(exhausted.reason.includes(escalation.id));
  assert.match(f.ledger(), new RegExp(`ESCALATED ${escalation.id}: ticket US-01 failed in 3 runs by the engine \\(${failed.join(', ')}\\).*team-mode\\.mjs acknowledge ${escalation.id}`));
  const blocked = refusal(await f.before(batchOf(file(4))));
  assert.equal(blocked?.code, 'TICKET_ESCALATED'); assert.match(blocked.reason, new RegExp(escalation.id));
  assert.equal(f.lines('reviews/escalations.jsonl').length, 1);
  const unrelated = await f.before(batchOf(ticket('US-05', ['src/list/e.js'])));
  assert.equal(unrelated.errors, undefined, 'an unrelated ticket goes on'); assert.equal(abortBatch(f.common).errors, undefined);

  const proposal = proposeAcknowledge({ ...f.common, id: escalation.id });
  assert.equal(acknowledgeEscalation({ ...f.common, id: escalation.id, confirm: proposal.digest, atTerminal: true }).errors, undefined);
  assert.equal((await f.before(batchOf(file(0))))?.errors?.[0]?.code, 'BATCH_REFUSED', 'acknowledged, it still needs a replan');
  const fourth = await ran(f, [file(4)], ['src/list/a.js']);
  const again = refusal(await f.before(batchOf(file(5))));
  assert.equal(again?.code, 'TICKET_ATTEMPTS_EXHAUSTED');
  const second = f.lines('reviews/escalations.jsonl')[1];
  assert.notEqual(second?.id, escalation.id); assert.deepEqual(second.runIds, [...failed, fourth.open.runId]); assert.ok(again.reason.includes(second.id));
});

test('a new id that resumes the saved patch of a failed ticket, at its place, as a copy or through a chain, continues its count; tickets that share a file and resume nothing do not', async t => {
  const f = live(t), table = 'src/table.json';
  const one = await ran(f, [ticket('US-01', ['src/list/a.js', table])], ['src/list/a.js', table]), r1 = one.open.runId, patch = `left/${r1}/US-01.patch`;
  assert.ok(existsSync(join(f.root, patch)), 'left saved the failed ticket\'s work');
  const runs = [{ runId: r1, ticket: 'US-01', status: 'not-passed' }];

  const shared = await f.before(batchOf(ticket('US-02', [table, 'src/list/b.js'])));
  assert.equal(shared.errors, undefined, 'a ticket on the shared file with no resume needs no replan'); assert.deepEqual(shared.tickets[0].earlierRuns, { runs: [], count: 0 });
  assert.equal(abortBatch(f.common).errors, undefined);

  const resumed = refusal(await f.before(batchOf(ticket('US-11', ['src/list/a.js', table], { resume: patch }))));
  assert.match(resumed?.reason, new RegExp(`US-11 ran before.*${r1} as US-01`));
  mkdirSync(join(f.root, 'handoff'), { recursive: true }); copyFileSync(join(f.root, patch), join(f.root, 'handoff/copy.patch'));
  const copied = await f.before(batchOf(ticket('US-12', ['src/list/a.js', table], { resume: 'handoff/copy.patch', replan: replan(1) })));
  assert.equal(copied.errors, undefined, JSON.stringify(copied.errors)); assert.deepEqual(copied.tickets[0].earlierRuns, { runs, count: 1 }, 'a copy is told by its bytes');
  assert.equal(abortBatch(f.common).errors, undefined); git(f.product, 'checkout', '-q', '--', '.'); git(f.product, 'clean', '-fdq');

  const two = await ran(f, [ticket('US-11', ['src/list/a.js', table], { resume: patch, replan: replan(1) })], ['src/list/a.js']), r2 = two.open.runId;
  assert.deepEqual(two.open.tickets[0].earlierRuns, { runs, count: 1 });
  const chained = await f.before(batchOf(ticket('US-13', ['src/list/a.js', table], { resume: `left/${r2}/US-11.patch`, replan: replan(2) })));
  assert.equal(chained.errors, undefined, JSON.stringify(chained.errors));
  assert.deepEqual(chained.tickets[0].earlierRuns, { runs: [...runs, { runId: r2, ticket: 'US-11', status: 'not-passed' }], count: 2 }, 'the chain of resumes is followed');
  assert.deepEqual(again(f).map(line => line.match(/ RUNS (\S+) AGAIN/)[1]), ['US-12', 'US-11', 'US-13']);
});

test('the briefs of a ticket that never ran are the briefs the kit wrote before replans existed', () => {
  const { renderedBriefs } = compile(inputFixture(), { standingBatch: true });
  assert.deepEqual(compile(inputFixture(), { standingBatch: true }).manifest.briefDigests, {
    exec: 'sha256:433af0ff3f90dd9b56e6b3385c043840a60027f0d2bf4a56d6e4f8b29e46be28', check: 'sha256:5f3c6ee4fb2d5f56bde3f87dc1d0f19d24382ff8ab22a72f365fe403899d2cec' });
  for (const brief of Object.values(renderedBriefs)) assert.doesNotMatch(brief, /ranBefore|replan/);
});
