import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/loop/contracts.mjs';
import { publishProjection } from '../src/loop/projector.mjs';
import { openStore } from '../src/loop/store.mjs';
import { command, demoBundle, driveDemo } from '../src/loop/demo.mjs';

function fixture(t) { const directory = mkdtempSync(join(tmpdir(), 'loop-projector-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
const effect = { id: 'projection-1', kind: 'projection', payload: { outcome: 'COMPLETED', reason: 'goal_satisfied', candidate: digest('candidate'), usage: { agentCalls: 2, tokens: 0, costMicroUsd: 0 } } };
test('immutable projection reapplies identically after lost acknowledgement', t => {
  const directory = fixture(t); const a = publishProjection({ directory, runId: 'run', effect });
  const b = publishProjection({ directory, runId: 'run', effect }); assert.deepEqual(b, a);
  assert.deepEqual(readdirSync(directory), ['run.projection-1.md']);
  assert.match(readFileSync(join(directory, a.fileName), 'utf8'), /"simulation": true/);
});
test('manual edit, conflicting payload and symlink preserve existing output', t => {
  const directory = fixture(t); const args = { directory, runId: 'run', effect };
  const { fileName } = publishProjection(args); const target = join(directory, fileName);
  assert.throws(() => publishProjection({ ...args, effect: { ...effect, payload: { ...effect.payload, reason: 'different' } } }), e => e.code === 'PROJECTION_CONFLICT');
  writeFileSync(target, 'human edit'); assert.throws(() => publishProjection(args), e => e.code === 'PROJECTION_CONFLICT'); assert.equal(readFileSync(target, 'utf8'), 'human edit');
  rmSync(target); symlinkSync('missing', target); assert.throws(() => publishProjection(args), e => e.code === 'PROJECTION_CONFLICT');
});
test('projection file name cannot escape target directory', t => {
  assert.throws(() => publishProjection({ directory: fixture(t), runId: '../escape', effect }), e => e.code === 'INVALID_SPEC');
});
test('demo closeout resumes a STARTED projection after file-write/ACK boundary', { skip: Number(process.versions.node.split('.')[0]) < 24 }, async t => {
  const directory = fixture(t), store = await openStore(':memory:'); t.after(() => store.close());
  const { spec, artifacts } = demoBundle(); store.create(spec, artifacts, { simulation: true, now: 0 });
  // Exercise reducer to projection boundary using the demo, then reproduce its exact
  // event prefix in a second database (no direct materialized-state mutation).
  driveDemo(store, 'demo', () => 1);
  const replay = await openStore(':memory:'); t.after(() => replay.close()); replay.create(spec, artifacts, { simulation: true, now: 0 });
  for (const e of store.events('demo').slice(1)) {
    if (e.action === 'projected') break;
    replay.apply(e.action, command(replay, 'demo', e.payload), e.at);
  }
  const pending = replay.effects('demo').find(e => e.kind === 'projection');
  const project = e => publishProjection({ directory, runId: 'demo', effect: e });
  project({ id: pending.id, kind: pending.kind, payload: pending.payload }); // file applied, ACK lost
  const result = driveDemo(replay, 'demo', () => 2, project);
  assert.equal(result.state.status, 'COMPLETED'); assert.equal(readdirSync(directory).length, 1); assert.equal(replay.verify('demo').ok, true);
});
