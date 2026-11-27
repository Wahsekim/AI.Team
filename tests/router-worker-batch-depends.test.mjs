// Inside one batch dependsOn is a delivery dependency: a ticket is committed only when every ticket of the batch it builds on,
// directly or through others, is delivered. resolve holds the dependents of a ticket a review held, before the commands run again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../src/loop/contracts.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { refusal, ticket, live, runBatch, reportOf, failing, transcriptOf, checker } from './fixtures/router-worker/review.mjs';

const RESOLUTION = 'rw-batch-resolution.json';

// US-01 builds nothing on; US-02 builds on US-01 and US-03 on US-02; US-04 is unrelated.
const chain = first => [ticket('US-01', [first]), ticket('US-02', ['src/list/b.js'], { dependsOn: ['US-01'] }), ticket('US-03', ['src/list/c.js'], { dependsOn: ['US-02'] }), ticket('US-04', ['src/list/d.js'])];
const work = first => ({ [first]: 'export const one = 1;\n', 'src/list/b.js': '// b\n', 'src/list/c.js': '// c\n', 'src/list/d.js': '// d\n' });
const log = (f, open) => git(f.product, 'log', '--format=%s', `${open.productHead}..HEAD`).trim().split('\n').filter(Boolean).reverse();

// after needs no dependency rule of its own while this holds: a dependent never runs once a ticket before it did not pass.
test('the engine halts a batch at its first ticket that does not pass: no later ticket runs, so after plans none that depends on it', async t => {
  const f = live(t), { after } = await runBatch(f, chain('src/list/a.js'), { 'src/list/a.js': '// a\n' }, {}, checker(1));
  assert.deepEqual(after.tickets.map(entry => [entry.id, entry.status]), [['US-01', 'not-passed'], ['US-02', 'not-run'], ['US-03', 'not-run'], ['US-04', 'not-run']]);
  assert.deepEqual(after.commits, []);
});

async function reviewed(t, tickets, edits, commands) {
  const f = live(t, { commands }), ran = await runBatch(f, tickets, edits);
  const made = f.brief('security');
  assert.equal(made.errors, undefined, JSON.stringify(made.errors));
  assert.equal(f.judge('security', transcriptOf(f, made, { report: failing(reportOf(made), 'US-01', 'kit.sec.secret-in-code') })).outcome, 'accepted');
  return { f, ...ran };
}

test('the reviewer\'s case: a ticket that depends on one Security rejected is held with it, and commit commits nothing', async t => {
  const { f, open, after } = await reviewed(t, chain('src/authz.js').slice(0, 2),{ 'src/authz.js': 'export const token = "x";\n', 'src/list/b.js': '// b\n' }, ['pwd']);
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.removed.map(entry => [entry.ticket, entry.reason, entry.waitsOn]), [['US-01', 'rejected', undefined], ['US-02', 'dependency-held', ['US-01']]]);
  assert.deepEqual(resolved.commits, []);
  assert.ok(existsSync(join(f.root, `reviews/held/${open.runId}/US-02.patch`)));
  // A resolution rewritten to commit the dependent, sealed again, with its work applied back, is refused.
  const { digest: sealed, ...body } = resolved, forged = { ...body, removed: body.removed.slice(0, 1), commits: after.commits.filter(commit => commit.ticket === 'US-02') };
  writeFileSync(join(f.root, RESOLUTION), JSON.stringify({ ...forged, digest: digest(forged) }));
  git(f.product, 'apply', join(f.root, `reviews/held/${open.runId}/US-02.patch`));
  assert.match(refusal(f.commit()).reason, /less the tickets a review held and those that depend on them/);
  rmSync(join(f.product, 'src/list/b.js')); writeFileSync(join(f.root, RESOLUTION), JSON.stringify({ ...body, digest: sealed }));
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors));
  assert.deepEqual(done.commits, []); assert.deepEqual(log(f, open), []);
});

test('resolve holds the dependents of a rejected ticket, transitively, before the commands run again, so they judge the tree that is committed; an unrelated ticket lands; the hold is no rejection', async t => {
  // The commands fail while US-03's file is in the tree, once the marker exists: the brief runs them on what after left.
  const { f, open } = await reviewed(t, chain('src/authz.js'), work('src/authz.js'), base => [`test ! -e ${base}/edit || test ! -e src/list/c.js`]);
  writeFileSync(join(f.base, 'edit'), '');
  const resolved = f.resolve();
  assert.equal(resolved.errors, undefined, JSON.stringify(resolved.errors));
  assert.deepEqual(resolved.removed.map(entry => [entry.ticket, entry.reason]), [['US-01', 'rejected'], ['US-02', 'dependency-held'], ['US-03', 'dependency-held']]);
  assert.equal(resolved.verification.ran, true); assert.equal(resolved.verification.failed, false, 'the rerun judged a tree without the held dependents');
  assert.deepEqual(resolved.commits.map(commit => commit.ticket), ['US-04']);
  for (const id of ['US-02', 'US-03']) git(f.product, 'apply', '--check', join(f.root, `reviews/held/${open.runId}/${id}.patch`));
  assert.match(f.ledger(), /RESOLVED: held US-01 \(rejected\), US-02 \(dependency-held on US-01\), US-03 \(dependency-held on US-02\)/);
  const done = f.commit();
  assert.equal(done.errors, undefined, JSON.stringify(done.errors));
  assert.deepEqual(log(f, open), ['US-04: Ticket US-04']);
  assert.deepEqual(f.lines('reviews/tickets.jsonl').map(line => [line.ticket, line.outcome]), [['US-01', 'rejected']], 'only the review\'s own outcome counts toward a second rejection');
});
