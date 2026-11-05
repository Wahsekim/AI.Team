import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Exercise actual commits, pushes and fetches against a local bare origin.
// Stub ONLY the hosted API; never read user credentials or contact GitHub.
test('proposal publisher never pushes the base, duplicates a PR, or overwrites a divergent head', t => {
  const tmp = mkdtempSync(join(tmpdir(),'ai-skill-publisher-'));
  t.after(() => rmSync(tmp,{recursive:true,force:true}));
  const work = join(tmp,'work'), remote = join(tmp,'origin'), bin = join(tmp,'bin'), report = join(tmp,'report.md');
  for (const d of [work,bin]) mkdirSync(d);
  const env = {PATH:bin + ':' + process.env.PATH, HOME:tmp, GIT_CONFIG_NOSYSTEM:'1', GH_TOKEN:'fake',
    DEFAULT_BRANCH:'main', GITHUB_REF_NAME:'main', GITHUB_REPOSITORY:'test/kit', OPEN_REF:'', PREVIOUS:'', PR_EXIT:'0'};
  const git = (...args) => execFileSync('git',args,{cwd:work,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','--bare','--template=',remote); git('init','--template=','-b','main');
  git('config','user.name','Test'); git('config','user.email','test@example.invalid'); git('remote','add','origin',remote);
  const lock = join(work,'agents/skill-packs/lock.json');
  mkdirSync(join(work,'agents/skill-packs'),{recursive:true}); writeFileSync(lock,'old'); writeFileSync(report,'test');
  git('add','.'); git('commit','-qm','base'); git('push','origin','main');
  const base = git('rev-parse','HEAD');
  writeFileSync(join(bin,'gh'), `#!/usr/bin/env bash
set -eu
case "$1 $2" in
  "api --method")
    if [[ "$*" == *"--paginate"* ]]; then echo "$OPEN_REF"; else echo "$PREVIOUS"; fi ;;
  "auth setup-git") : ;;
  "pr create")
    [[ "$*" == *"--base main --head codex/skill-updates/main/"* ]]
    echo CREATED
    exit "$PR_EXIT" ;;
  *) exit 99 ;;
esac
`, {mode:0o755});
  const sh = fileURLToPath(new URL('../scripts/propose-role-skills.sh',import.meta.url));
  const run = overrides => spawnSync('bash',[sh,report],{cwd:work,env:{...env,...overrides},encoding:'utf8'});
  const candidate = () => { git('switch','--detach',base); git('restore','--source=HEAD','--staged','--worktree','agents'); writeFileSync(lock,'new'); };
  candidate();
  const failed = run({PR_EXIT:'8'}); assert.equal(failed.status,8,failed.stderr);
  const refs = git('ls-remote','--heads','origin');
  const head = refs.match(/refs\/heads\/(codex\/skill-updates\/main\/\S+)/)[1];
  assert.ok(refs.includes(base+'\trefs/heads/main'));
  candidate();
  const retried = run({}); assert.equal(retried.status,0,retried.stderr); assert.match(retried.stdout,/CREATED/);
  for (const overrides of [{OPEN_REF:head},{PREVIOUS:'123'}]) {
    candidate(); const repeated = run(overrides);
    assert.equal(repeated.status,0,repeated.stderr); assert.doesNotMatch(repeated.stdout,/CREATED/);
  }
  // Simulate a maintainer editing the bot branch after a failed API call.
  git('fetch','origin',head); git('switch','--detach','-f','FETCH_HEAD');
  writeFileSync(join(work,'owner-note'),'retain'); git('add','owner-note'); git('commit','-qm','human change');
  git('push','origin','HEAD:refs/heads/'+head); const ownerSha = git('rev-parse','HEAD');
  candidate(); const collision = run({}); assert.equal(collision.status,2,collision.stderr);
  assert.match(collision.stdout,/manual review required/);
  assert.ok(git('ls-remote','origin',head).startsWith(ownerSha));
  assert.ok(git('ls-remote','origin','main').startsWith(base));
});
