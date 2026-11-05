import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brief } from '../scripts/role-skills.mjs';

test('weekly skill monitor is read-only and has no branch publisher', () => {
  const workflow = readFileSync(new URL('../.github/workflows/role-skills-upstream.yml',import.meta.url),'utf8');
  assert.match(workflow,/^permissions:\n  contents: read$/m);
  assert.match(workflow,/persist-credentials: false/);
  assert.doesNotMatch(workflow,/^\s*push:|:\s*write(?:-all)?\s*$|gh pr create|git (?:commit|push)\b|propose-role-skills\.sh/m);
  assert.equal(existsSync(new URL('../scripts/propose-role-skills.sh',import.meta.url)),false);
});

test('only exact role and task pairs receive a pinned method', () => {
  for (const [role, task, skill] of [['pm','spec','to-spec'], ['pm','tickets','to-tickets'],
    ['backend','debug','diagnosing-bugs'], ['frontend','debug','diagnosing-bugs'],
    ['architect','interface-design','architect'], ...['qa','reviewer','verifier'].map(r => [r,'impact-review','blast-radius'])]) {
    assert.match(brief(role, task), new RegExp('/' + skill + '@[0-9a-f]{40}'));
  }
  for (const pair of [['backend','tickets'],['pm','debug'],['qa','interface-design'],['frontend','copy-edit'],['../pm','spec']])
    assert.equal(brief(...pair), '');
});

test('rendered methods do not delegate to unbundled skills or publish tickets', () => {
  assert.doesNotMatch(brief('pm','tickets'), /### 5\. Publish/);
  assert.doesNotMatch(brief('architect','interface-design'), /Run the \*\*arena|arena runners|grok-4/);
  assert.doesNotMatch(brief('qa','impact-review'), /run it as an `arena`|`why`/);
});

test('offline integrity failure produces no partial brief', t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'ai-role-skill-test-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const kit = join(dir,'AI.Team');
  mkdirSync(join(kit,'scripts'),{recursive:true}); mkdirSync(join(kit,'agents'));
  cpSync(join(root,'scripts/role-skills.mjs'), join(kit,'scripts/role-skills.mjs'));
  cpSync(join(root,'agents/skill-packs'), join(kit,'agents/skill-packs'), { recursive:true });
  const run = args => spawnSync(process.execPath, ['AI.Team/scripts/role-skills.mjs', ...args], {cwd:dir, encoding:'utf8'});
  assert.equal(run(['verify']).status, 0);
  const debug = run(['brief','frontend','debug']);
  const helper = join(kit,'agents/skill-packs/matt/skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh');
  assert.equal(debug.status,0); assert.ok(debug.stdout.includes(helper)); assert.ok(existsSync(helper));
  writeFileSync(join(kit,'agents/skill-packs/pstack/skills/architect/references/design-red-flags.md'), 'changed');
  const failed = run(['brief','architect','interface-design']);
  assert.equal(failed.status, 2); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /Unverified skill file/);
  assert.equal(run(['verify']).status, 2);
});

test('upstream changes are detected without adoption; explicit refresh imports only allowed Git blobs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-role-skill-update-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const path of ['scripts/role-skills.mjs','agents/skill-packs'])
    cpSync(join(root,path), join(dir,'kit',path), {recursive:true});
  // Isolate Git configuration and rewrite BOTH upstream URLs to disposable repos.
  const env = { PATH:process.env.PATH, HOME:dir, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_COUNT:'2' };
  const git = (repo, ...args) => execFileSync('git', ['-C',repo,...args], {env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  for (const [index, source, slug, prefix] of [[0,'matt','mattpocock/skills',''],[1,'pstack','cursor/plugins','pstack']]) {
    const repo = join(dir,source), remote = 'https://github.com/' + slug + '.git';
    mkdirSync(repo); cpSync(join(root,'agents/skill-packs',source), join(repo,prefix), {recursive:true});
    env['GIT_CONFIG_KEY_' + index] = 'url.' + pathToFileURL(repo).href + '.insteadOf';
    env['GIT_CONFIG_VALUE_' + index] = remote;
  }
  const commit = (repo, message) => {
    git(repo,'add','.'); git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm',message);
  };
  for (const source of ['matt','pstack']) {
    git(join(dir,source),'init','-q','--template='); commit(join(dir,source),'fixture');
  }
  const cli = (...args) => spawnSync(process.execPath, ['scripts/role-skills.mjs', ...args], {cwd:join(dir,'kit'),env,encoding:'utf8'});
  assert.equal(cli('check-upstream').status, 0, 'unrelated upstream commits must not count as drift');
  const lock = join(dir,'kit/agents/skill-packs/lock.json'), before = readFileSync(lock);
  const report = join(dir,'proposal.md');
  assert.equal(cli('prepare-update',report).status,0); assert.equal(existsSync(report),false);
  const matt = join(dir,'matt'), skill = 'skills/engineering/diagnosing-bugs/SKILL.md';
  appendFileSync(join(matt,skill), '\nEXAMPLE_UPSTREAM_REVISION\n'); commit(matt,'new method');
  const drift = cli('check-upstream'); assert.equal(drift.status,1); assert.ok(drift.stdout.includes(skill));
  assert.deepEqual(readFileSync(lock),before); assert.doesNotMatch(cli('brief','backend','debug').stdout,/EXAMPLE_UPSTREAM_REVISION/);
  assert.equal(cli('refresh','matt','HEAD').status,2);
  const proposal = cli('prepare-update',report);
  assert.equal(proposal.status,0,proposal.stderr);
  const body = readFileSync(report,'utf8');
  assert.match(body,/backend \/ frontend · debug/);
  assert.match(body,/    \+EXAMPLE_UPSTREAM_REVISION/);
  assert.match(body,/pm · spec\*\* — method text unchanged/);
  assert.doesNotMatch(body,/### pstack/);
  assert.match(cli('brief','frontend','debug').stdout,/EXAMPLE_UPSTREAM_REVISION/);
  assert.equal(cli('prepare-update',report).status,2,'do not overwrite an existing report');
  // Independently verify explicit manual refresh from the original pinned state.
  cpSync(join(root,'agents/skill-packs'),join(dir,'kit/agents/skill-packs'),{recursive:true});
  const rev = git(matt,'rev-parse','HEAD');
  for (const url of ['git@github.com:mattpocock/skills.git','ssh://git@github.com/mattpocock/skills','https://github.com/mattpocock/skills.git']) {
    git(matt,'config','remote.origin.url',url);
    const updated = cli('refresh','matt',rev,matt); assert.equal(updated.status,0,updated.stderr);
  }
  git(matt,'config','remote.origin.url','git@github.com:other/skills.git');
  assert.equal(cli('refresh','matt',rev,matt).status,2);
  assert.equal(cli('verify').status,0);
  assert.match(cli('brief','frontend','debug').stdout,/EXAMPLE_UPSTREAM_REVISION/);
  assert.equal(cli('check-upstream').status,0);
});
