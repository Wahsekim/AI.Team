import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixtureAdapter } from '../src/loop/adapters/fixture-process.mjs';
const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Fixture adapter requires Node 24+' : false };
const request = (scenario, delayMs = 0, timeoutMs = 1000) => ({ scenario, delayMs, timeoutMs });
async function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'ai-fixture-adapter-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, filename: join(workspace, 'fixture.sqlite'), runId: 'run' };
}
test('fixture supports bounded structured success/failure, not partial or crashed success', sqlite, async t => {
  const config = await fixture(t), adapter = await openFixtureAdapter(config);
  try {
    assert.equal(adapter.probeCapabilities().liveProvider, false);
    for (const [scenario, expected] of [['pass', 'pass'], ['fail', 'fail'], ['partial', 'error'], ['crash', 'error']]) {
      const handle = adapter.start(scenario, request(scenario));
      assert.equal(adapter.inspect(handle).status, 'RUNNING');
      assert.equal((await adapter.collectResult(handle)).result, expected);
      assert.equal(adapter.inspect(handle).status, 'FINISHED'); assert.equal(adapter.cancel(handle).cancelled, false);
    }
  } finally { await adapter.close(); }
});
test('fixture duplicate starts preserve process identity and durable results', sqlite, async t => {
  const config = await fixture(t); let adapter = await openFixtureAdapter(config);
  try {
    const handle = adapter.start('d-1', request('pass', 100)); const pid = adapter.inspect(handle).pid;
    assert.deepEqual(adapter.start('d-1', request('pass', 100)), handle); assert.equal(adapter.inspect(handle).pid, pid);
    assert.throws(() => adapter.start('d-1', request('fail')), e => e.code === 'IDEMPOTENCY_CONFLICT');
    const receipt = await adapter.collectResult(handle); await adapter.close(); adapter = await openFixtureAdapter(config);
    assert.deepEqual(await adapter.collectResult(adapter.start('d-1', request('pass', 100))), receipt);
  } finally { await adapter.close(); }
});
test('another host treats an unfinished dispatch as UNKNOWN and cannot kill or respawn it', sqlite, async t => {
  const config = await fixture(t), owner = await openFixtureAdapter(config), other = await openFixtureAdapter(config);
  try {
    const handle = owner.start('d-1', request('hang'));
    assert.deepEqual(other.start('d-1', request('hang')), handle);
    assert.equal(other.inspect(handle).status, 'UNKNOWN'); assert.equal(other.cancel(handle).cancelled, false);
    await assert.rejects(other.collectResult(handle), e => e.code === 'EFFECT_UNKNOWN');
    assert.equal(owner.cancel(handle).cancelled, true);
    assert.equal((await owner.collectResult(handle)).result, 'cancelled');
    assert.equal((await other.collectResult(handle)).result, 'cancelled');
  } finally { await owner.close(); await other.close(); }
});
test('fixture timeout and close cancel owned processes without claiming a product result', sqlite, async t => {
  const adapter = await openFixtureAdapter(await fixture(t));
  const timed = adapter.start('timeout', request('hang', 0, 50));
  assert.equal((await adapter.collectResult(timed)).result, 'timeout');
  const pending = adapter.start('close', request('hang')); const collected = adapter.collectResult(pending);
  await adapter.close(); assert.equal((await collected).result, 'cancelled');
  assert.throws(() => adapter.start('late', request('pass')), e => e.code === 'INVALID_TRANSITION');
});
