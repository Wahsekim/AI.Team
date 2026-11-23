// ADR 0011, decision 6: a ticket that declares itself sensitive runs in a batch, is always flagged for Security,
// and is never committed without a passed Security verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { abortBatch } from '../src/router-worker/batch.mjs';
import { refusal, ticket, batchOf, live, changed, runBatch, edits, reportOf, failing, transcriptOf } from './fixtures/router-worker/review.mjs';

test('a risk flag or a grant on a sensitive path no longer refuses the ticket; what it declares is frozen in the batch record', async t => {
  const f = live(t);
  const { open, after } = await runBatch(f, [
    ticket('US-01', ['src/list/view.js'], { riskFlags: ['payments'] }),
    ticket('US-02', ['src/plain/**'], { expectedPaths: ['src/plain/a.js'] }),
    ticket('US-03', ['src/other.js']),
    ticket('US-04', ['src/quiet.js'], { riskFlags: ['pii'] })], edits(['src/list/view.js', 'src/plain/a.js', 'src/other.js']), { sensitivePaths: ['src/plain'] });
  assert.deepEqual(open.tickets.map(entry => entry.declared), [['riskFlag:payments'], ['sensitivePath:src/plain'], [], ['riskFlag:pii']]);
  const review = id => after.tickets.find(entry => entry.id === id).review;
  // No trigger matches these paths: Security is required because the ticket declared itself sensitive.
  assert.deepEqual(review('US-01'), { required: ['security'], because: [{ reviewer: 'security', declared: 'riskFlag:payments', path: 'src/list/view.js' }], flaggedFiles: ['src/list/view.js'] });
  assert.deepEqual(review('US-02').because, [{ reviewer: 'security', declared: 'sensitivePath:src/plain', path: 'src/plain/a.js' }]);
  assert.deepEqual(review('US-03').required, []);
  assert.equal(review('US-04'), undefined, 'a ticket that changed nothing is not committed, so it is not flagged');
  assert.deepEqual(after.reviews, { security: { tickets: ['US-01', 'US-02'] } });
  assert.match(f.brief('security').brief, /required \(declared riskFlag:payments on src\/list\/view\.js\)/);
});

test('a grant that covers a sensitive path, or lies under one, is judged against paths, not the plan, and declared', async t => {
  const f = live(t);
  for (const [batch, declared] of [
    [batchOf(ticket('US-01', ['src/**'], { expectedPaths: ['src/a.js'] })), 'sensitivePath:src/auth/**'],
    [batchOf(ticket('US-01', ['src/auth/login.js', 'src/a.js'], { expectedPaths: ['src/a.js'] })), 'sensitivePath:src/auth/**'],
    [{ ...batchOf(ticket('US-01', ['src/auth/login.js'])), sensitivePaths: ['src/auth'] }, 'sensitivePath:src/auth'],
    [{ ...batchOf(ticket('US-01', ['src/auth/**'], { expectedPaths: ['src/auth/x.js'] })), sensitivePaths: ['src/auth'] }, 'sensitivePath:src/auth']]) {
    const open = await f.before({ ...batch, verificationCommands: f.commands });
    assert.equal(open.errors, undefined, JSON.stringify(open.errors));
    assert.deepEqual(open.tickets[0].declared, [declared]);
    assert.equal(abortBatch(f.common).errors, undefined);
  }
});

test('a declared-sensitive ticket is not committed without a passed Security verdict', async t => {
  const f = live(t);
  await runBatch(f, [ticket('US-01', ['src/list/view.js'], { riskFlags: ['payments'] }), ticket('US-02', ['src/other.js'])], edits(['src/list/view.js', 'src/other.js']));
  assert.match(refusal(f.commit()).reason, /review of this batch is not over.*security/);
  const made = f.brief('security'), verdict = f.judge('security', transcriptOf(f, made, { report: failing(reportOf(made), 'US-01', 'kit.sec.access-check') }));
  assert.equal(verdict.outcome, 'accepted', JSON.stringify(verdict));
  assert.equal(f.resolve().errors, undefined);
  const committed = f.commit();
  assert.equal(committed.errors, undefined, JSON.stringify(committed.errors));
  assert.deepEqual(committed.commits.map(commit => commit.ticket), ['US-02']);
  assert.deepEqual(committed.held.map(entry => [entry.ticket, entry.reason]), [['US-01', 'rejected']]);
  assert.deepEqual(changed(f), []);
});

test('riskFlags must be a short list of plain names, each named once', async t => {
  const f = live(t);
  for (const riskFlags of ['auth', [], ['bad flag'], ['auth', 'AUTH'], Array.from({ length: 11 }, (_, i) => `r${i}`)])
    assert.match(refusal(await f.before(batchOf(ticket('US-01', ['src/a.js'], { riskFlags }))))?.reason ?? 'opened', /US-01: riskFlags must list 1 to 10/, JSON.stringify(riskFlags));
});
