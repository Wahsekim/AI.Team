import test from 'node:test';
import assert from 'node:assert/strict';
import { startBoundedProcess } from '../src/loop/process-runner.mjs';

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
