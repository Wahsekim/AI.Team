import test from 'node:test';
import assert from 'node:assert/strict';
import { startBoundedProcess } from '../src/loop/process-runner.mjs';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { survivingDescendantSource } from './fixtures/surviving-descendant.mjs';

const config = source => ({ executable: process.execPath, argv: ['-e', source], cwd: process.cwd(), env: {}, timeoutMs: 1000, maxOutputBytes: 1024 });
test('bounded process exposes owned inspect/cancel/collect lifecycle', async () => {
  const handle = startBoundedProcess(config('setInterval(() => {}, 1000)'));
  assert.equal(handle.inspect().status, 'RUNNING'); assert.ok(handle.pid > 0);
  assert.equal(handle.cancel(), true);
  const result = await handle.completion;
  assert.equal(result.reason, 'cancelled'); assert.equal(handle.inspect().status, 'EXITED');
  assert.equal(handle.cancel(), false, 'a completed handle must never signal a reused PID');
  result.stdout = 'external mutation'; assert.notEqual(handle.inspect().result.stdout, result.stdout);
});
test('process configuration rejects unbounded/implicit inputs before spawn', () => {
  for (const override of [{ timeoutMs: 0 }, { maxOutputBytes: 0 }, { env: undefined }, { executable: 'node' }, { argv: ['\0'] }]) {
    assert.throws(() => startBoundedProcess({ ...config(''), ...override }), e => e.code === 'INVALID_SPEC');
  }
  const controller = new AbortController(); controller.abort();
  assert.throws(() => startBoundedProcess({ ...config(''), signal: controller.signal }), e => e.code === 'CANCELLED');
});
test('process spawn errors settle and do not leak a cancellable handle', async () => {
  const handle = startBoundedProcess({ ...config(''), executable: '/nonexistent-ai-team-test-executable' });
  const result = await handle.completion;
  assert.equal(result.exitCode, null); assert.match(result.error, /ENOENT/);
  assert.equal(handle.cancel(), false); assert.equal(handle.inspect().status, 'EXITED');
});

for (const trigger of ['timeout', 'cancelled', 'output_limit']) {
  test(`surviving descendants require recovery after ${trigger}`, { timeout: 10000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-descendant-')), readyFile = join(dir, 'ready');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const handle = startBoundedProcess({ ...config(survivingDescendantSource({ readyFile, overflow: trigger === 'output_limit' })),
      timeoutMs: trigger === 'timeout' ? 1000 : 3000 });
    t.after(async () => { handle.cancel(); await handle.completion; });
    if (trigger === 'cancelled') {
      const deadline = Date.now() + 2000;
      while (!existsSync(readyFile) && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(readyFile), 'child must install its handler before cancellation');
      assert.equal(handle.cancel(), true);
    }
    const result = await handle.completion;
    assert.ok(existsSync(readyFile), 'reproduction must actually start the descendant');
    assert.equal(result.reason, 'orphaned_process_group');
    assert.equal(handle.cancel(), false, 'finished handles cannot signal an unowned/reused PID');
  });
}
