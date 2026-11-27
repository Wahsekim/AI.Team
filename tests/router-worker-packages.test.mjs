// ADR 0010, amendment of 2026-11-27: the packages of one product repository. A ticket names its package; before scopes it to the
// package's folder and inlines that package's conventions in its briefs; after names each interface file a ticket changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { abortBatch, BATCH_FILE } from '../src/router-worker/batch.mjs';
import { bytesDigest, digest } from '../src/loop/contracts.mjs';
import { compile } from '../src/router-worker/compile.mjs';
import { git } from './fixtures/router-worker/standing-team.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';
import { ticket, live, runBatch, batchOf, edits, refusal } from './fixtures/router-worker/review.mjs';

const PACKAGES = 'profiles/packages.json';
const taskData = brief => JSON.parse(brief.split('\n').find(line => line.startsWith('{"assignmentId"')));
const briefsOf = open => open.args.plan.flatMap(item => [item.brief, item.verifierBrief]);
// What varies from one fixture to the next: the temporary folders, the product's commit and every digest that holds them.
const normalized = (f, brief) => brief.replaceAll(f.product, '<product>').replaceAll(f.root, '<team>').replace(/sha256:[a-f0-9]{64}/g, 'sha256:<d>').replace(/\b[a-f0-9]{40}\b/g, '<sha>');
// The briefs and the record entry of a ticket without package, as the kit built them before packages existed.
const PINNED_BRIEFS = 'sha256:7af82353b70541fb5db63a9743fffdb843a735409d6dd45e9a9f9b6b458ca0e2';
const PINNED_ENTRY = ['id', 'title', 'goal', 'acceptance', 'commitMessage', 'paths', 'expectedPaths', 'dependsOn', 'moves', 'deletes', 'declared', 'earlierRuns'];

// The packages file, each package's folder committed in the product, and the team's files (conventions) as given.
function packaged(f, packages, files = {}) {
  for (const { dir } of packages) { mkdirSync(join(f.product, dir), { recursive: true }); writeFileSync(join(f.product, dir, 'README.md'), `# ${dir}\n`); }
  git(f.product, 'add', '-A'); git(f.product, 'commit', '-q', '-m', 'packages');
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), text); }
  writeFileSync(join(f.root, PACKAGES), JSON.stringify({ schemaVersion: 1, packages }));
}
const CONVENTIONS = { 'profiles/stack/quarry.md': '# quarry\nQUARRY-MARK: tabs, never spaces.\n', 'profiles/stack/lantern.md': '# lantern\nLANTERN-MARK: two spaces.\n' };
const THREE = [
  { name: 'quarry', dir: 'quarry', conventions: 'profiles/stack/quarry.md', verificationCommands: ['pwd'] },
  { name: 'lantern', dir: 'lantern', conventions: 'profiles/stack/lantern.md', interfaces: ['quarry/api/**'] },
  { name: 'tundra.db', dir: 'tundra', interfaces: ['quarry/api/**', 'lantern/*.sql'] }];

test('a ticket without package, with no packages file or with one, gets the briefs and the record entry it got before packages existed', async t => {
  const f = live(t), batch = batchOf(ticket('T-01', ['src/list/a.js']));
  const bare = await f.before(batch);
  assert.equal(bare.errors, undefined, JSON.stringify(bare.errors));
  assert.equal(digest(briefsOf(bare).map(brief => normalized(f, brief))), PINNED_BRIEFS);
  assert.deepEqual(Object.keys(bare.tickets[0]), PINNED_ENTRY);
  assert.equal(Object.hasOwn(bare, 'packages'), false);
  assert.equal(abortBatch(f.common).errors, undefined);

  // A packages file whose folders hold none of the ticket's paths: the ticket is repository-wide work.
  writeFileSync(join(f.root, PACKAGES), JSON.stringify({ schemaVersion: 1, packages: [{ name: 'web', dir: 'src/list/web', conventions: 'profiles/stack/web.md' }] }));
  mkdirSync(join(f.product, 'src/list/web'), { recursive: true }); mkdirSync(join(f.root, 'profiles/stack'), { recursive: true });
  writeFileSync(join(f.root, 'profiles/stack/web.md'), 'WEB-MARK\n');
  const beside = await f.before(batch);
  assert.equal(beside.errors, undefined, JSON.stringify(beside.errors));
  assert.deepEqual(briefsOf(beside), briefsOf(bare), 'byte-identical briefs');
  assert.deepEqual(beside.tickets[0], bare.tickets[0]);
  assert.equal(abortBatch(f.common).errors, undefined);
  // A ticket that stays inside one package must name it, or it would run without that package's conventions.
  assert.match(refusal(await f.before(batchOf(ticket('T-02', ['src/list/web/a.js']))))?.reason, /T-02 writes only inside the folder of package web \(src\/list\/web\/\) and does not name it: add "package": "web"/);
});

test('before refuses a package the team does not have, a path outside the package\'s folder, and a package command the batch does not list', async t => {
  const f = live(t);
  assert.match(refusal(await f.before(batchOf(ticket('T-01', ['src/a.js'], { package: 'quarry' }))))?.reason, /T-01 names package quarry.*no packages file.*profiles\/packages\.json/);
  packaged(f, THREE, CONVENTIONS);
  const unknown = refusal(await f.before(batchOf(ticket('T-01', ['src/a.js'], { package: 'gravel' }))));
  assert.match(unknown?.reason, /T-01 names package gravel.*profiles\/packages\.json.*quarry, lantern, tundra\.db/);
  const outside = refusal(await f.before(batchOf(ticket('T-01', ['quarry/a.js', 'lantern/b.js'], { package: 'quarry' }))));
  assert.match(outside?.reason, /T-01 writes lantern\/b\.js, outside the folder of its package quarry \(quarry\/\)/);
  assert.match(outside.reason, /one ticket per package/); assert.match(outside.reason, /interface file with a ticket of its own and dependsOn/);
  const command = refusal(await f.before({ ...batchOf(ticket('T-01', ['quarry/a.js'], { package: 'quarry' })), verificationCommands: ['echo verified-by-kit'] }));
  assert.match(command?.reason, /package quarry verifies with pwd, which is not one of the batch's verificationCommands/);
  assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  // The ticket's own commands win over its package's.
  const own = await f.before({ ...batchOf(ticket('T-01', ['quarry/a.js'], { package: 'quarry', verificationCommands: ['echo verified-by-kit'] })), verificationCommands: ['echo verified-by-kit'] });
  assert.equal(own.errors, undefined, JSON.stringify(own.errors));
  assert.deepEqual(own.tickets[0].verificationCommands, ['echo verified-by-kit']);
  assert.equal(abortBatch(f.common).errors, undefined);
});

test('before refuses a packages file that is malformed, and conventions that are missing, too large, under kit/ or a link', async t => {
  const f = live(t);
  packaged(f, THREE, CONVENTIONS);
  const open = () => f.before(batchOf(ticket('T-01', ['quarry/a.js'], { package: 'quarry' })));
  const withFile = async packages => { writeFileSync(join(f.root, PACKAGES), JSON.stringify({ schemaVersion: 1, packages })); return refusal(await open())?.reason; };
  const quarry = THREE[0];
  writeFileSync(join(f.root, PACKAGES), '{ not json');
  assert.match(refusal(await open())?.reason, /profiles\/packages\.json is not valid \(not JSON\)/);
  assert.match(await withFile([quarry, { ...quarry, name: 'QUARRY', dir: 'lantern' }]), /profiles\/packages\.json is not valid: the name QUARRY is used twice/);
  mkdirSync(join(f.product, 'quarry/api'));
  assert.match(await withFile([quarry, { name: 'inner', dir: 'quarry/api' }]), /profiles\/packages\.json is not valid: the folders of quarry and inner contain one another/);
  assert.match(await withFile([{ ...quarry, dir: '../quarry' }]), /profiles\/packages\.json is not valid: package quarry: dir/);
  assert.match(await withFile([{ ...quarry, dir: 'absent' }]), /package quarry: dir absent is not a folder of the product repository/);
  assert.match(await withFile([{ ...quarry, extra: 1 }]), /profiles\/packages\.json is not valid/);
  assert.match(await withFile([{ ...quarry, conventions: 'profiles/stack/absent.md' }]), /package quarry: the conventions file profiles\/stack\/absent\.md is missing/);
  writeFileSync(join(f.root, 'profiles/stack/large.md'), 'x'.repeat(8193));
  assert.match(await withFile([{ ...quarry, conventions: 'profiles/stack/large.md' }]), /package quarry: the conventions file profiles\/stack\/large\.md holds 8193 bytes, more than 8192/);
  mkdirSync(join(f.kit, 'profiles/stack'), { recursive: true }); writeFileSync(join(f.kit, 'profiles/stack/quarry.md'), 'kit\n');
  assert.match(await withFile([{ ...quarry, conventions: 'kit/profiles/stack/quarry.md' }]), /package quarry: conventions must be a path in the team's own folder, not under kit\//);
  symlinkSync(join(f.root, 'profiles/stack/quarry.md'), join(f.root, 'profiles/stack/linked.md'));
  assert.match(await withFile([{ ...quarry, conventions: 'profiles/stack/linked.md' }]), /package quarry: the conventions file profiles\/stack\/linked\.md is not a regular file/);
  assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
});

test('two packages in one batch: each ticket\'s briefs carry its own package and conventions, not the other\'s, and the record freezes them', async t => {
  const f = live(t);
  packaged(f, THREE, CONVENTIONS);
  const open = await f.before(batchOf(ticket('T-01', ['quarry/a.js'], { package: 'quarry' }), ticket('T-02', ['lantern/b.js'], { package: 'lantern' })));
  assert.equal(open.errors, undefined, JSON.stringify(open.errors));
  const [own, other] = [['quarry', 'QUARRY-MARK', 'LANTERN-MARK'], ['lantern', 'LANTERN-MARK', 'QUARRY-MARK']];
  open.args.plan.forEach((item, i) => {
    const [name, mine, theirs] = [own, other][i], path = `profiles/stack/${name}.md`, conventions = { path, digest: bytesDigest(CONVENTIONS[path]) };
    for (const brief of [item.brief, item.verifierBrief]) {
      assert.deepEqual(taskData(brief).package, { name, dir: name, interfaces: THREE.find(entry => entry.name === name).interfaces ?? [] });
      assert.match(taskData(brief).packageNote, /work inside package\.dir/);
      assert.ok(brief.includes(`Package conventions: ${path} (${conventions.digest})`), brief);
      assert.ok(brief.includes(CONVENTIONS[path]));
      assert.ok(brief.includes(mine)); assert.ok(!brief.includes(theirs)); assert.ok(!brief.includes(`profiles/stack/${name === 'quarry' ? 'lantern' : 'quarry'}.md`));
    }
    assert.deepEqual(open.tickets[i].package, { name, dir: name, interfaces: THREE.find(entry => entry.name === name).interfaces ?? [], conventions });
  });
  // The quarry ticket verifies with its package's command; lantern lists none, so its ticket keeps the batch's.
  assert.deepEqual(open.tickets.map(entry => entry.verificationCommands), [['pwd'], undefined]);
  assert.deepEqual(taskData(open.args.plan[0].verifierBrief).verificationCommands, ['pwd']);
  assert.deepEqual(open.packages, { file: PACKAGES, digest: bytesDigest(JSON.stringify({ schemaVersion: 1, packages: THREE })), packages: THREE.map(({ name, dir, interfaces }) => ({ name, dir, interfaces: interfaces ?? [] })) });
  assert.equal(abortBatch(f.common).errors, undefined);
});

test('after names each interface file a ticket changed and the packages that read it, in its record, its next steps and the ledger; a change to no interface is not named', async t => {
  const f = live(t);
  packaged(f, THREE, CONVENTIONS);
  const { open, after } = await runBatch(f, [ticket('T-01', ['quarry/api/**', 'quarry/a.js'], { package: 'quarry' }), ticket('T-02', ['lantern/b.js'], { package: 'lantern' })],
    edits(['quarry/api/types.json', 'quarry/a.js', 'lantern/b.js']));
  assert.deepEqual(after.tickets.map(entry => entry.status), ['passed', 'passed']);
  assert.deepEqual(after.interfaceChanges, [{ ticket: 'T-01', path: 'quarry/api/types.json', readBy: ['lantern', 'tundra.db'] }]);
  assert.ok(after.next.some(line => /T-01 changed quarry\/api\/types\.json, which lantern, tundra\.db read/.test(line) && /dependsOn/.test(line)), after.next.join('\n'));
  const lines = f.ledger().split('\n').filter(line => / CHANGED AN INTERFACE /.test(line));
  assert.deepEqual(lines, [`${after.closedAt.slice(0, 10)} BATCH ${open.runId} CHANGED AN INTERFACE (owner spot review): quarry/api/types.json by T-01; read by lantern, tundra.db: file a ticket for each package that must follow, with dependsOn, or record why none is needed.`]);
  assert.equal(after.status, 'clean', 'it holds nothing');
  assert.equal(f.commit().errors, undefined);

  const g = live(t);
  packaged(g, THREE, CONVENTIONS);
  const quiet = await runBatch(g, [ticket('T-03', ['tundra/c.js'], { package: 'tundra.db' })], edits(['tundra/c.js']));
  assert.equal(Object.hasOwn(quiet.after, 'interfaceChanges'), false);
  assert.doesNotMatch(g.ledger(), / CHANGED AN INTERFACE /);
});

test('the compiler takes a package only from a standing batch, with every write path inside its folder and conventions that match their digest', () => {
  const text = 'FIXTURE-MARK\n', conventions = { path: 'profiles/stack/web.md', digest: bytesDigest(text), text };
  const of = pkg => { const input = inputFixture(); input.mandate.allowedWritePaths = ['src/tag-list/**', 'src/api/tags.ts']; input.proposal.expectedPaths = ['src/tag-list/view.ts', 'src/api/tags.ts']; input.mandate.package = pkg; return input; };
  const good = { name: 'web', dir: 'src', interfaces: ['schema/*.sql'], conventions };
  assert.equal(compile(of(good)).errors?.[0].field, 'mandate.package');
  const { renderedBriefs } = compile(of(good), { standingBatch: true });
  for (const brief of Object.values(renderedBriefs)) { assert.deepEqual(taskData(brief).package, { name: 'web', dir: 'src', interfaces: ['schema/*.sql'] }); assert.ok(brief.includes(`Package conventions: profiles/stack/web.md (${conventions.digest})`) && brief.includes(text)); }
  assert.equal(compile(of({ ...good, conventions: { ...conventions, text: 'OTHER\n' } }), { standingBatch: true }).errors?.[0].code, 'DIGEST_MISMATCH');
  assert.equal(compile(of({ ...good, dir: 'src/tag-list' }), { standingBatch: true }).errors?.[0].field, 'mandate.package.dir');
  assert.equal(compile(of({ ...good, extra: 1 }), { standingBatch: true }).errors?.[0].field, 'mandate.package');
  const large = 'x'.repeat(8193);
  assert.equal(compile(of({ ...good, conventions: { ...conventions, text: large, digest: bytesDigest(large) } }), { standingBatch: true }).errors?.[0].field, 'mandate.package.conventions.text');
});
