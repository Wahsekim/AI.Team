// ADR 0009 decision 8: Router/Worker reads project authority from the instance root
// and universal sources from the kit at <instance>/kit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadRetryRules, createRetryJournal } from '../src/router-worker/retries.mjs';
import { loadCoverage } from '../src/router-worker/coverage.mjs';
import { draftTeam, verifyDraft } from '../src/router-worker/draft.mjs';
import { preflight } from '../src/router-worker/preflight.mjs';
import { bytesDigest, digest } from '../src/loop/contracts.mjs';
import { draftSpecFixture } from './fixtures/router-worker/draft-spec.mjs';
import { inputFixture } from './fixtures/router-worker/input.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const teamMode = join(ROOT, 'scripts/team-mode.mjs');
const snapshot = dir => execFileSync('bash', ['-c', 'cd "$1" && find . -type f -exec shasum -a 256 {} + | sort', 'sh', dir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

// A real bootstrapped instance: kit/ is a copy of this checkout's kit data files.
function instance(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-two-root-'))), kit = join(root, 'kit');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n')
    .filter(path => path && !/^(tests|src|docs\/design|\.github)\//.test(path));
  for (const path of tracked) { mkdirSync(dirname(join(kit, path)), { recursive: true }); cpSync(join(ROOT, path), join(kit, path)); }
  const run = spawnSync('bash', [join(kit, 'scripts/bootstrap-team.sh'), '--project-name', 'Tag List Fixture', '--product-repo', '/fixture-product-not-created', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return { root, kit, roots: { teamRoot: kit, instanceRoot: root } };
}
const edit = (file, change) => writeFileSync(file, change(readFileSync(file, 'utf8')));

test('retry rules bind the instance charter.md, not the kit seed', t => {
  const f = instance(t), rules = loadRetryRules(f.roots);
  assert.deepEqual(Object.keys(rules.sourceDigests).sort(), ['agents/pm.md', 'charter.md', 'decisions/0008-router-worker-topology.md']);
  assert.equal(rules.sourceDigests['charter.md'], bytesDigest(readFileSync(join(f.root, 'charter.md'))));
  assert.notEqual(rules.sourceDigests['charter.md'], bytesDigest(readFileSync(join(f.kit, 'charter.template.md'))), 'instantiated charter differs from the seed');
  assert.equal(createRetryJournal({ ticketId: 'T-1', rules }).events.length, 0);
  assert.deepEqual(Object.keys(loadRetryRules({ teamRoot: f.kit }).sourceDigests).sort(),
    ['agents/pm.md', 'charter.template.md', 'decisions/0008-router-worker-topology.md'], 'kit mode is unchanged');
  edit(join(f.root, 'charter.md'), text => text.replace('at most twice', 'at most five times'));
  assert.throws(() => loadRetryRules(f.roots), error => error.code === 'RETRY_RULE_REVIEW_REQUIRED');
  assert.doesNotThrow(() => loadRetryRules({ teamRoot: f.kit }), 'the kit seed is still intact');
});

test('an instance root must be canonical, carry kit.lock and charter.md, and own this kit', t => {
  const f = instance(t), other = instance(t);
  assert.throws(() => loadRetryRules({ teamRoot: f.kit, instanceRoot: other.root }), /kit/);
  const link = join(other.root, 'link-to-instance'); symlinkSync(f.root, link);
  assert.throws(() => loadRetryRules({ teamRoot: f.kit, instanceRoot: link }), /Canonical/);
  rmSync(join(other.root, 'kit.lock'));
  assert.throws(() => loadRetryRules(other.roots), /kit\.lock/);
  rmSync(join(f.root, 'charter.md'));
  assert.throws(() => loadRetryRules(f.roots));
  assert.ok(draftTeam(draftSpecFixture(), f.roots).errors);
});

test('coverage inventories the harness rules of the instance charter', t => {
  const f = instance(t), kitOnly = loadCoverage(f.kit), loaded = loadCoverage(f.kit, { instanceRoot: f.root });
  assert.equal(loaded.invariantSourceDigests.charter, bytesDigest(readFileSync(join(f.root, 'charter.md'))));
  assert.notEqual(loaded.invariantSourceDigests.charter, kitOnly.invariantSourceDigests.charter);
  assert.equal(loaded.digest, kitOnly.digest);
  edit(join(f.root, 'charter.md'), text => { const [head, tail] = text.split('## Harness Rules\n'); return head + '## Harness Rules\n' + tail.replace(/^8\. .*$/m, ''); });
  assert.throws(() => loadCoverage(f.kit, { instanceRoot: f.root }), /inventory changed/);
});

test('an instance draft is an overlay on the existing instance and writes nothing', t => {
  const f = instance(t), spec = draftSpecFixture(), before = snapshot(f.root);
  const { draft, errors } = draftTeam(spec, f.roots);
  assert.equal(errors, undefined, JSON.stringify(errors));
  assert.equal(snapshot(f.root), before, 'drafting must not write to the instance or the kit');
  assert.equal(draft.launchable, false); assert.equal(draft.requiresFreshBaseKit, false);
  for (const path of ['charter.md', 'profiles/project.md', 'profiles/stack.md', 'CLAUDE.md', 'agents/_shared/verify-discipline.md'])
    assert.equal(draft.files[path], undefined, `${path} belongs to the instance and must not be re-instantiated`);
  for (const path of ['agents/roster.md', 'agents/router-worker-contract.md', 'agents/worker-exec.md', 'profiles/team-mode.json', '.claude/agents/tag-list-fixture-worker-check.md'])
    assert.equal(typeof draft.files[path], 'string', path);
  assert.match(draft.files['.claude/agents/tag-list-fixture-worker-exec.md'], /does not exist there is read under kit\//);
  assert.deepEqual(draft.instance.authority.map(a => a.path), ['charter.md', 'kit.lock', 'profiles/project.md', 'profiles/stack.md']);
  assert.equal(draft.instance.authority[0].sha256, bytesDigest(readFileSync(join(f.root, 'charter.md'))));
  assert.equal(draft.bootstrap.verdict, 'existing-instance');
  assert.equal(draft.coverage.invariantSourceDigests.charter, bytesDigest(readFileSync(join(f.root, 'charter.md'))));
  assert.equal(verifyDraft(spec, draft, f.roots).errors, undefined);
  assert.ok(verifyDraft(spec, draft, { teamRoot: f.kit }).errors, 'an instance draft does not verify as a fresh-kit draft');
  assert.ok(verifyDraft(spec, draftTeam(spec, { teamRoot: f.kit }).draft, f.roots).errors, 'and the reverse');
  edit(join(f.root, 'profiles/project.md'), text => text + '\nowner edit\n');
  assert.match(verifyDraft(spec, draft, f.roots).errors[0].reason, /differs from current source inputs/);
});

test('team-mode CLI: --instance previews, drafts and verifies against the instance', t => {
  const f = instance(t), spec = join(f.root, 'spec.json'), out = join(f.root, 'demo.rw-draft.json');
  writeFileSync(spec, JSON.stringify(draftSpecFixture()));
  const cli = (...args) => spawnSync(process.execPath, [join(f.kit, 'scripts/team-mode.mjs'), ...args], { encoding: 'utf8' });
  cpSync(join(ROOT, 'src'), join(f.kit, 'src'), { recursive: true });
  const preview = cli('preview', spec, '--instance', f.root);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).draft.requiresFreshBaseKit, false);
  assert.equal(cli('draft', spec, out, '--instance', f.root).status, 0);
  assert.equal(cli('verify', spec, out, '--instance', f.root).status, 0);
  assert.equal(cli('verify', spec, out).status, 2, 'without --instance the artifact is not a fresh-kit draft');
  assert.equal(cli('preview', spec, '--instance').status, 1);
  assert.equal(spawnSync(process.execPath, [teamMode, 'preview', spec, '--instance', f.root], { encoding: 'utf8' }).status, 2,
    'a kit that is not this instance\'s kit/ is refused');
});

test('preflight resolves the read graph in the instance first, then in kit/', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-two-root-pf-'))), kit = join(root, 'kit');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const DUTIES = ['exec', 'check', 'guard'], input = inputFixture(), sources = [], nodes = [];
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  write('kit.lock', 'instance_schema=1\nkit_commit=unversioned\n'); write('charter.md', '# Charter\n');
  const addSource = (field, value) => {
    const keys = field.split('.'), parent = keys.slice(0, -1).reduce((v, k) => v[k], input), key = keys.at(-1);
    const id = parent[key].id; parent[key] = { id, digest: digest(value) };
    write(`sources/${id}.json`, JSON.stringify({ id, value })); sources.push({ field, path: `sources/${id}.json` });
  };
  addSource('policy.approvalRef', { note: 'synthetic' }); addSource('policy.stackRef', { verificationCommands: input.policy.verificationCommands });
  addSource('policy.runtimeRef', { runtime: 'mock-only' });
  addSource('policy.rosterRef', { wrappers: Object.fromEntries(DUTIES.map(d => [d, input.policy.profiles[d].wrapper])) });
  for (const duty of DUTIES) addSource(`policy.profiles.${duty}.permissionRef`, { duty, fixtureOnly: true });
  addSource('mandate.approvalRef', { note: 'synthetic' }); input.mandate.policyDigest = digest(input.policy);
  const addNode = (path, content, reads) => { write(path, content); nodes.push({ path, sha256: bytesDigest(content), reads }); };
  addNode('kit/agents/_shared/meta-rules.md', 'Kit rule.\n', []); nodes.at(-1).path = 'agents/_shared/meta-rules.md';
  addNode('profiles/stack.md', 'Instance stack.\n', []);
  const roots = {};
  for (const duty of DUTIES) {
    const path = `.claude/agents/${input.policy.profiles[duty].wrapper}.md`;
    addNode(path, `Fixture ${duty}\n`, ['agents/_shared/meta-rules.md', 'profiles/stack.md']); roots[duty] = [path];
  }
  const approval = JSON.stringify({ schemaVersion: 1, purpose: 'offline-preflight', status: 'approved', inputDigest: digest(input), sources,
    context: { metric: 'ceil-utf8-bytes/4', roots, limits: { exec: 10000, check: 10000, guard: 10000 }, nodes } });
  write('approval.json', approval);
  const options = { input, teamRoot: kit, instanceRoot: root, approvalPath: 'approval.json', expectedApprovalDigest: bytesDigest(approval) };
  const output = preflight(options);
  assert.equal(output.errors, undefined, JSON.stringify(output.errors));
  const byPath = Object.fromEntries(output.preflight.files.map(file => [file.path, file.root]));
  assert.equal(byPath['agents/_shared/meta-rules.md'], 'kit'); assert.equal(byPath['profiles/stack.md'], 'instance');
  assert.equal(byPath['approval.json'], 'instance');
  assert.equal(preflight({ ...options, instanceRoot: undefined }).errors.length, 1, 'kit alone does not hold the approval');
  write('agents/_shared/meta-rules.md', 'Shadow copy.\n');
  assert.equal(preflight(options).errors[0].code, 'CONTEXT_SOURCE_CHANGED', 'an instance file wins over the kit file of the same path');
  assert.ok(existsSync(join(kit, 'agents/_shared/meta-rules.md')));
});
