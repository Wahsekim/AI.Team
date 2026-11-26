// before judges a ticket's paths, moves and deletes as after and the hook do, case included, and refuses a path that
// names a file or folder of the product in another case than Git or the file system gives it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { abortBatch, BATCH_FILE } from '../src/router-worker/batch.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { ticket, live, batchOf } from './fixtures/router-worker/review.mjs';

const refused = async (f, ...tickets) => {
  const out = await f.before(batchOf(...tickets));
  assert.ok(out.errors, JSON.stringify(out));
  assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(f.state(), 'closed'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  return out.errors[0].reason;
};

test('before refuses a path in another case than the product spells it, and gives the spelling to use; a correctly spelled batch opens', async t => {
  const f = live(t);
  assert.match(await refused(f, ticket('US-01', ['src/**'], { expectedPaths: ['src/app.js'], moves: [{ from: 'src/app.js', to: 'SRC/new.js' }] })),
    /US-01 moves or deletes SRC\/new\.js, which its paths grant only in another case \(src\/\*\*\): write it as src\/new\.js/);
  assert.match(await refused(f, ticket('US-01', ['src/App.js'])), /US-01 names src\/App\.js, which the product spells src\/app\.js/);
  assert.match(await refused(f, ticket('US-01', ['SRC/**'], { expectedPaths: ['SRC/new.js'] })), /US-01 names SRC\/\*\*, which the product spells src\/\*\*/);
  assert.match(await refused(f, ticket('US-01', ['src/**'], { expectedPaths: ['src/new.js'], deletes: ['src/APP.js'] })), /US-01 names src\/APP\.js, which the product spells src\/app\.js/);
  assert.match(await refused(f, ticket('US-01', ['src/**'], { expectedPaths: ['src/App.js'] })), /US-01 names src\/App\.js, which the product spells src\/app\.js/);
  assert.match(await refused(f, ticket('US-01', ['src/app.js']), ticket('US-02', ['src/APP.js'])), /Tickets US-01 and US-02 claim the same file/, 'two tickets claiming one file in two cases are refused as before');
  const opened = await f.before(batchOf(ticket('US-01', ['src/**'], { expectedPaths: ['src/new.js'], moves: [{ from: 'src/app.js', to: 'src/new.js' }] })));
  assert.equal(opened.errors, undefined, JSON.stringify(opened.errors));
  assert.equal(abortBatch(f.common).errors, undefined);
});
