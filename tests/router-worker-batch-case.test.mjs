// before judges a ticket's paths, moves and deletes as after and the hook do, case included, and refuses a path that
// names a file or folder of the product in another case than Git or the file system gives it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { abortBatch, spelledIn, trackedSpellings, BATCH_FILE } from '../src/router-worker/batch.mjs';
import { readLease } from '../src/router-worker/lease.mjs';
import { ticket, live, batchOf } from './fixtures/router-worker/review.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';

const refused = async (f, ...tickets) => {
  const out = await f.before(batchOf(...tickets));
  assert.ok(out.errors, JSON.stringify(out));
  assert.equal(readLease({ productRoot: f.product }).status, 'free'); assert.equal(f.state(), 'closed'); assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  return out.errors[0].reason;
};

const opens = async (f, ...tickets) => {
  const out = await f.before(batchOf(...tickets));
  assert.equal(out.errors, undefined, JSON.stringify(out.errors));
  assert.equal(abortBatch(f.common).errors, undefined);
};
// Where the file system tells case, a name in another case is another file, which before accepts.
const foldsCase = f => existsSync(join(f.product, '.GIT'));
const misspelled = async (f, pattern, ...tickets) => foldsCase(f) ? assert.match(await refused(f, ...tickets), pattern) : opens(f, ...tickets);

test('before refuses a path in another case than the product spells it, and gives the spelling to use; a correctly spelled batch opens', async t => {
  const f = live(t);
  assert.match(await refused(f, ticket('US-01', ['src/**'], { expectedPaths: ['src/app.js'], moves: [{ from: 'src/app.js', to: 'SRC/new.js' }] })),
    /US-01 moves or deletes SRC\/new\.js, which its paths grant only in another case \(src\/\*\*\): write it as src\/new\.js/);
  await misspelled(f, /US-01 names src\/App\.js, which the product spells src\/app\.js/, ticket('US-01', ['src/App.js']));
  await misspelled(f, /US-01 names SRC\/\*\*, which the product spells src\/\*\*/, ticket('US-01', ['SRC/**'], { expectedPaths: ['SRC/new.js'] }));
  assert.match(await refused(f, ticket('US-01', ['src/**'], { expectedPaths: ['src/new.js'], deletes: ['src/APP.js'] })),
    foldsCase(f) ? /US-01 names src\/APP\.js, which the product spells src\/app\.js/ : /US-01 moves or deletes src\/APP\.js, which is not a file tracked at the product's HEAD/);
  await misspelled(f, /US-01 names src\/App\.js, which the product spells src\/app\.js/, ticket('US-01', ['src/**'], { expectedPaths: ['src/App.js'] }));
  assert.match(await refused(f, ticket('US-01', ['src/app.js']), ticket('US-02', ['src/APP.js'])), /Tickets US-01 and US-02 claim the same file/, 'two tickets claiming one file in two cases are refused as before');
  await opens(f, ticket('US-01', ['src/**'], { expectedPaths: ['src/new.js'], moves: [{ from: 'src/app.js', to: 'src/new.js' }] }));
});

test('a folder renamed by case in Git and not on disk is spelled as Git has it, and only so', async t => {
  const f = live(t);
  if (!foldsCase(f)) return t.skip('only a file system that folds case keeps the old folder name on disk');
  mkdirSync(join(f.product, 'Components')); writeFileSync(join(f.product, 'Components/a.js'), 'export const a = 1;\n');
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-qm', 'components');
  git(f.product, 'mv', '-f', 'Components/a.js', 'components/a.js'); git(f.product, 'commit', '-qm', 'rename by case');
  assert.deepEqual([git(f.product, 'ls-files', 'components').trim(), readdirSync(f.product).includes('Components')], ['components/a.js', true], 'Git and the disk disagree');
  assert.match(await refused(f, ticket('US-01', ['Components/**'], { expectedPaths: ['Components/a.js'] })), /US-01 names Components\/\*\*, which the product spells components\/\*\* \(as Git has it\)/);
  await opens(f, ticket('US-01', ['components/**'], { expectedPaths: ['components/a.js', 'components/b.js'] }));
});

test('a path Git does not know is still judged by the disk', async t => {
  const f = live(t);
  if (!foldsCase(f)) return t.skip('where the file system tells case, Build is another folder');
  writeFileSync(join(f.product, '.gitignore'), 'build/\n'); git(f.product, 'add', '.gitignore'); git(f.product, 'commit', '-qm', 'ignore build');
  mkdirSync(join(f.product, 'build')); writeFileSync(join(f.product, 'build/out.js'), '');
  assert.match(await refused(f, ticket('US-01', ['Build/**'], { expectedPaths: ['Build/out.js'] })), /US-01 names Build\/\*\*, which the product spells build\/\*\* \(as the file system has it\)/);
  await opens(f, ticket('US-01', ['build/**'], { expectedPaths: ['build/out.js'] }));
});

test('a move into a folder whose name the file system stores decomposed is accepted', async t => {
  const f = live(t), decomposed = 'café', composed = 'café';
  mkdirSync(join(f.product, 'docs', decomposed), { recursive: true }); writeFileSync(join(f.product, 'docs', decomposed, 'x.md'), '# x\n');
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-qm', 'docs');
  await opens(f, ticket('US-01', ['src/**', 'docs/**'], { expectedPaths: [`docs/${composed}/app.js`], moves: [{ from: 'src/app.js', to: `docs/${composed}/app.js` }] }));
});

// Listings injected: this machine's file system folds case, and the two cases are told apart only by what it does.
const product = (tracked, disk, foldsCase) => ({ tracked: trackedSpellings(tracked), names: folder => disk[folder] ?? null, foldsCase });

test('an exact name always wins over a case-only match, in Git\'s listing and on disk', () => {
  for (const foldsCase of [true, false]) {
    const both = product(['src/Foo.js', 'src/foo.js'], { '': ['src'], src: ['Foo.js', 'foo.js'] }, foldsCase);
    assert.equal(spelledIn('src/foo.js', both), null, `both tracked, folds case: ${foldsCase}`);
    assert.equal(spelledIn('src/Foo.js', both), null, `both tracked, folds case: ${foldsCase}`);
    const onDisk = product([], { '': ['docs'], docs: ['README.md', 'readme.md'] }, foldsCase);
    assert.equal(spelledIn('docs/readme.md', onDisk), null, `both on disk, folds case: ${foldsCase}`);
  }
});

test('a new path beside a case-variant sibling is another file where the file system tells case, the same file where it folds it', () => {
  const tracked = ['docs/README.md'], disk = { '': ['docs'], docs: ['README.md'] };
  assert.equal(spelledIn('docs/readme.md', product(tracked, disk, false)), null);
  assert.deepEqual(spelledIn('docs/readme.md', product(tracked, disk, true)), { spelled: 'docs/README.md', by: 'Git' });
  assert.equal(spelledIn('docs/readme.md', product([], disk, false)), null);
  assert.deepEqual(spelledIn('docs/readme.md', product([], disk, true)), { spelled: 'docs/README.md', by: 'the file system' });
  assert.deepEqual(spelledIn('Components/a.js', product(['components/a.js'], { '': ['Components'], Components: ['a.js'] }, true)), { spelled: 'components/a.js', by: 'Git' }, 'Git decides what it tracks');
  assert.equal(spelledIn('components/new.js', product(['components/a.js'], { '': ['Components'], components: ['a.js'] }, true)), null, 'a new file in a folder Git tracks');
});
