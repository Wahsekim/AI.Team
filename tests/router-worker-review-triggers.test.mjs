// ADR 0011, decisions 1, 3 and 8 to 10: the kit flags, per ticket, which reviewer a batch's changes require.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeBatch, abortBatch, BATCH_FILE } from '../src/router-worker/batch.mjs';
import { afterBatch } from '../src/router-worker/batch-close.mjs';
import { runWorkflow, makeAgentImpl } from '../scripts/lib/workflow-harness.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { fixture, git } from './fixtures/router-worker/standing-team.mjs';

const refusal = result => result.errors?.[0];
const ticket = (id, paths, extra = {}) => ({ id, title: `Ticket ${id}`, goal: `Do ${id}`, acceptance: [`${id} works`], paths, estimate: { execTokens: 12000, checkTokens: 6000, reworkTokens: 6000 }, ...extra });
const batchOf = (...tickets) => ({ tickets, verificationCommands: ['npm test'], sensitivePaths: ['src/auth/**'], nextLifecycleNumber: 1 });
const PROJECT = 'profiles/review.json';

function live(t) {
  const f = fixture(t); assert.equal(f.apply('router-worker', { spec: f.spec, limits: { allowedCommands: ['npm test'] } }).errors, undefined); git(f.product, 'checkout', '-q', '-b', 'work');
  const before = batch => beforeBatch({ teamRoot: f.kit, instanceRoot: f.root, batch }), abort = () => assert.equal(abortBatch({ teamRoot: f.kit, instanceRoot: f.root }).errors, undefined);
  const project = review => writeFileSync(join(f.root, PROJECT), JSON.stringify(review, null, 2));
  return { ...f, before, abort, project };
}
// A batch run by the real engine with mock agents; `edits` is what the workers leave in the product.
async function closed(t, tickets, edits) {
  const f = live(t), open = await f.before(batchOf(...tickets));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const { result } = await runWorkflow({ scriptPath: join(f.root, '.claude/workflows/run-n-rounds.js'), args: open.args, agentImpl: makeAgentImpl({}) });
  for (const [path, text] of Object.entries(edits)) { mkdirSync(join(f.product, path, '..'), { recursive: true }); writeFileSync(join(f.product, path), text); }
  appendFileSync(join(f.root, '.claude/rw-write-boundary.log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'Edit', agentType: 'tag-list-fixture-worker-exec', judged: true, decision: 'allow' }) + '\n');
  const after = afterBatch({ teamRoot: f.kit, instanceRoot: f.root, result });
  assert.equal(after.errors, undefined, JSON.stringify(after.errors));
  return after;
}

test('after flags a dependency manifest for both reviewers and a path naming auth for Security, and commits as before', async t => {
  const after = await closed(t, [ticket('US-01', ['package.json']), ticket('US-02', ['src/authz.js']), ticket('US-03', ['src/list/view.js'])],
    { 'package.json': '{"dependencies":{"x":"1"}}\n', 'src/authz.js': 'export const can = () => true;\n', 'src/list/view.js': 'view\n' });
  const [manifest, auth, plain] = after.tickets;
  assert.deepEqual(manifest.review.required, ['security', 'architect']);
  assert.deepEqual(manifest.review.because, [{ reviewer: 'security', trigger: 'kit.dependency-manifest', path: 'package.json' }, { reviewer: 'architect', trigger: 'kit.dependency-manifest', path: 'package.json' }]);
  assert.deepEqual(manifest.review.flaggedFiles, ['package.json']); assert.match(manifest.review.content['package.json'], /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(auth.review.required, ['security']); assert.deepEqual(auth.review.because, [{ reviewer: 'security', trigger: 'kit.sensitive-word', path: 'src/authz.js' }]);
  assert.deepEqual(plain.review, { required: [], because: [], flaggedFiles: [], content: {} });
  assert.deepEqual(after.reviews, { security: { tickets: ['US-01', 'US-02'] }, architect: { tickets: ['US-01'] } });
  assert.deepEqual(after.commits.map(commit => commit.ticket), ['US-01', 'US-02', 'US-03'], 'the flags do not gate a commit yet');
});

test('a batch whose changes match no trigger flags no reviewer; a ticket that changed nothing carries no review', async t => {
  const after = await closed(t, [ticket('US-01', ['src/list/view.js']), ticket('US-02', ['src/api/tags.js'])], { 'src/list/view.js': 'view\n' });
  assert.deepEqual(after.tickets[0].review.required, []); assert.equal(after.tickets[1].review, undefined);
  assert.deepEqual(after.reviews, {}); assert.equal(after.status, 'clean');
});

test('before freezes the merged trigger list and logs each trigger or rule added, and each removed for the owner\'s spot review', async t => {
  const f = live(t), one = batchOf(ticket('US-01', ['src/a.js'])), ledger = () => f.read('pm-decisions.md');
  const project = { schemaVersion: 1, triggers: [{ id: 'billing', reviewers: ['security'], match: { glob: ['src/billing/**'] } }], rules: [{ id: 'no-raw-sql', reviewer: 'security', text: 'Queries go through the repository layer.' }], adrs: ['decisions/0003-auth.md'] };
  f.project(project);
  const first = await f.before(one);
  assert.equal(first.errors, undefined, JSON.stringify(first.errors));
  assert.deepEqual(first.review.triggers.map(trigger => trigger.id).slice(-1), ['billing']); assert.ok(first.review.triggers.some(trigger => trigger.id === 'kit.dependency-manifest'));
  assert.deepEqual(first.review.reviewers, ['security', 'architect']); assert.deepEqual(first.review.adrs, ['decisions/0003-auth.md']); assert.match(first.review.digest, /^sha256:/);
  assert.deepEqual(JSON.parse(f.read(BATCH_FILE)).review, first.review, 'frozen in the batch record');
  assert.equal(first.triggerChanges.previous, null); assert.match(ledger(), /REVIEW TRIGGERS FROZEN.*no earlier list.*owner spot review/);
  f.abort();
  const same = await f.before(one); assert.deepEqual([same.triggerChanges.added, same.triggerChanges.removed], [[], []]); f.abort();
  const lines = ledger().split('\n').length;
  f.project({ ...project, triggers: [], rules: [...project.rules, { id: 'layers', reviewer: 'architect', text: 'UI code does not import the database.' }] });
  const narrowed = await f.before(one);
  assert.deepEqual(narrowed.triggerChanges.removed, ['trigger billing security glob:src/billing/**']); assert.deepEqual(narrowed.triggerChanges.added, ['rule layers architect']);
  assert.match(ledger(), /REVIEW TRIGGERS REMOVED \(owner spot review\): trigger billing security glob:src\/billing\/\*\*\./);
  assert.match(ledger(), /REVIEW TRIGGERS ADDED: rule layers architect\./); assert.equal(ledger().split('\n').length, lines + 2);
  f.abort(); f.project({ ...project, triggers: [{ ...project.triggers[0], match: { glob: ['src/billing/**', 'src/pay/**'] } }] });
  const widened = await f.before(one);
  assert.deepEqual(widened.triggerChanges.added, ['trigger billing security glob:src/billing/**', 'trigger billing security glob:src/pay/**']);
  assert.deepEqual(widened.triggerChanges.removed, ['rule layers architect']);
});

test('before refuses a team with no valid project trigger list, and names the fix', async t => {
  const f = live(t), one = batchOf(ticket('US-01', ['src/a.js']));
  const untouched = () => { assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false); };
  assert.deepEqual(JSON.parse(f.read(PROJECT)), JSON.parse(readFileSync(join(f.kit, 'profiles/review.template.json'), 'utf8')), 'bootstrap instantiates the seed');
  rmSync(join(f.root, PROJECT));
  assert.match(refusal(await f.before(one)).reason, /profiles\/review\.json is missing.*cp kit\/profiles\/review\.template\.json profiles\/review\.json/); untouched();
  for (const [bad, why] of [[{ schemaVersion: 1, triggers: [{ id: 'x', reviewers: ['coach'], match: { glob: ['a'] } }], rules: [], adrs: [] }, /reviewer coach/],
    [{ schemaVersion: 1, triggers: [{ id: 'kit.mine', reviewers: ['security'], match: { contains: ['pay'] } }], rules: [], adrs: [] }, /kit\./],
    [{ schemaVersion: 1, triggers: [{ id: 'x', reviewers: ['security'], match: {} }], rules: [], adrs: [] }, /match/],
    [{ schemaVersion: 1, triggers: [], rules: [], adrs: ['../outside.md'] }, /adrs/]]) {
    f.project(bad); assert.match(refusal(await f.before(one)).reason, new RegExp(`profiles/review\\.json is not valid.*${why.source}`)); untouched();
  }
  writeFileSync(join(f.root, PROJECT), '{'); assert.match(refusal(await f.before(one)).reason, /profiles\/review\.json is not valid/); untouched();
});

test('dependsOn names tickets that come earlier in the batch or in an archived batch, and is frozen', async t => {
  const f = live(t);
  assert.match(refusal(await f.before(batchOf(ticket('US-01', ['src/a.js'], { dependsOn: ['US-99'] })))).reason, /US-01 depends on US-99, which is not a ticket of this batch or of an archived batch/);
  assert.match(refusal(await f.before(batchOf(ticket('US-01', ['src/a.js'], { dependsOn: ['US-02'] }), ticket('US-02', ['src/b.js'])))).reason, /US-01 depends on US-02, which does not run before it in this batch/);
  assert.match(refusal(await f.before(batchOf(ticket('US-01', ['src/a.js'], { dependsOn: 'US-02' })))).reason, /dependsOn must be a list of ticket ids/);
  mkdirSync(join(f.root, 'batches/rw-earlier'), { recursive: true }); writeFileSync(join(f.root, 'batches/rw-earlier/batch.json'), JSON.stringify({ tickets: [{ id: 'US-50' }] }));
  const open = await f.before(batchOf(ticket('US-01', ['src/a.js']), ticket('US-02', ['src/b.js'], { dependsOn: ['US-01', 'US-50'] })));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  assert.deepEqual(open.tickets.map(entry => entry.dependsOn), [[], ['US-01', 'US-50']]);
});
