// ADR 0010, decisions 14 and 15: the gate path is a setting of the team, stored with its mode, off by default,
// changed only by the switch, and turning it on in a standing team is refused until the gate path is completed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeBatch, abortBatch, BATCH_FILE } from '../src/router-worker/batch.mjs';
import { proposeLimits } from '../src/router-worker/switch.mjs';
import { fixture, git } from './fixtures/router-worker/standing-team.mjs';

const refusal = result => result.errors?.[0];
const passes = () => ({ ok: true, verdict: 'DEPLOYMENT-STRUCTURALLY-COMPLETE (injected)' });
const NOT_COMPLETED = /gate path is not completed.*ADR 0010, decision 15/;
const profileOf = f => JSON.parse(f.read('profiles/team-mode.json'));

test('the switch proposes and writes the gate path off; a request that turns it on is refused; it survives holiday and back', t => {
  const f = fixture(t), apply = (to, request) => f.apply(to, request, undefined, { validate: passes });
  assert.equal(f.propose().gatePath, false, 'shown in the proposal the owner confirms');
  assert.equal(f.propose('router-worker', { spec: f.spec, gatePath: false }).gatePath, false);
  for (const value of [true, 'false', 1, null]) {
    const before = f.tree();
    assert.match(refusal(f.propose('router-worker', { spec: f.spec, gatePath: value })).reason, NOT_COMPLETED, JSON.stringify(value));
    assert.match(refusal(f.apply('router-worker', { spec: f.spec, gatePath: value }, 'sha256:' + '0'.repeat(64), { validate: passes })).reason, NOT_COMPLETED);
    assert.equal(f.tree(), before, 'nothing moved');
  }
  assert.equal(apply('router-worker', { spec: f.spec }).errors, undefined);
  assert.equal(profileOf(f).gatePath, false, 'stored with the mode');
  // No other command changes it: limits know only the limits.
  assert.match(refusal(proposeLimits({ teamRoot: f.kit, instanceRoot: f.root, limits: { gatePath: false } })).reason, /limits may only set the known limits/);

  assert.equal(apply('specialist', {}).errors, undefined);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'holiday/router-worker/profiles/team-mode.json'), 'utf8')).gatePath, false, 'packed with the mode');
  assert.match(refusal(f.propose('router-worker', { gatePath: true })).reason, NOT_COMPLETED, 'a restore cannot turn it on');
  assert.equal(f.propose('router-worker', {}).gatePath, false, 'the restore proposal shows it');
  assert.equal(apply('router-worker', {}).errors, undefined);
  assert.equal(profileOf(f).gatePath, false, 'restored with the mode');
});

test('before refuses a team whose profile turns the gate path on; a profile without the setting is off and opens', async t => {
  const f = fixture(t);
  assert.equal(f.apply('router-worker', { spec: f.spec, limits: { allowedCommands: ['npm test'] } }, undefined, { validate: passes }).errors, undefined);
  git(f.product, 'checkout', '-q', '-b', 'work');
  const before = batch => beforeBatch({ teamRoot: f.kit, instanceRoot: f.root, batch });
  const batch = { tickets: [{ id: 'US-01', title: 'Ticket US-01', goal: 'Do US-01', acceptance: ['US-01 works'], paths: ['src/a.js'], estimate: { execTokens: 12000, checkTokens: 6000, reworkTokens: 6000 } }],
    verificationCommands: ['npm test'], sensitivePaths: ['src/auth/**'], nextLifecycleNumber: 1 };
  const { gatePath, ...withoutFlag } = profileOf(f), write = profile => writeFileSync(join(f.root, 'profiles/team-mode.json'), JSON.stringify(profile, null, 2) + '\n');
  assert.equal(gatePath, false);
  // A batch cannot carry the setting either: an unknown BATCH.json field is refused.
  assert.match(refusal(await before({ ...batch, gatePath: false })).reason, /The batch must carry/);
  for (const value of [true, 'off']) {
    write({ ...withoutFlag, gatePath: value });
    const refused = refusal(await before(batch));
    assert.equal(refused?.code, 'GATE_PATH_REFUSED', JSON.stringify(refused)); assert.match(refused.reason, NOT_COMPLETED);
    assert.equal(existsSync(join(f.root, BATCH_FILE)), false);
  }
  // A team switched before the setting existed lacks the key: read as off, the default.
  write(withoutFlag);
  const opened = await before(batch);
  assert.equal(opened.errors, undefined, JSON.stringify(opened.errors));
  assert.equal(abortBatch({ teamRoot: f.kit, instanceRoot: f.root }).errors, undefined);
});
