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
    // The runner's clock is mocked so the timeout fires only after the descendant is observably ready.
    if (trigger === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const handle = startBoundedProcess({ ...config(survivingDescendantSource({ readyFile, overflow: trigger === 'output_limit' })),
      timeoutMs: trigger === 'timeout' ? 1000 : 3000 });
    t.after(async () => { handle.cancel(); await handle.completion; });
    if (trigger !== 'output_limit') {
      const deadline = Date.now() + 2000;
      while (!existsSync(readyFile) && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(readyFile), `child must install its handler before ${trigger}`);
    }
    if (trigger === 'cancelled') assert.equal(handle.cancel(), true);
    if (trigger === 'timeout') t.mock.timers.tick(1000);
    const result = await handle.completion;
    assert.ok(existsSync(readyFile), 'reproduction must actually start the descendant');
    assert.equal(result.reason, 'orphaned_process_group');
    assert.equal(handle.cancel(), false, 'finished handles cannot signal an unowned/reused PID');
  });
}

const RECOVERY_REASONS = ['cleanup_unknown', 'cancel_error', 'orphaned_process_group'];
const eperm = () => Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' });
// The runner's group signals go through process.kill, so a mock injects EPERM deterministically
// instead of depending on the macOS zombie window (FLAKE-1 logs/zombie-eperm-probe.txt).
async function startWithKill(t, { ignoreTerm, groupKill }) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-eperm-')), readyFile = join(dir, 'ready');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const realKill = process.kill.bind(process);
  const handle = startBoundedProcess(config(`${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    require('fs').writeFileSync(${JSON.stringify(readyFile)}, ''); setInterval(() => {}, 1000)`));
  t.after(async () => { try { realKill(handle.pid, 'SIGKILL'); } catch {} });
  const deadline = Date.now() + 5000;
  while (!existsSync(readyFile) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(readyFile), 'child must be running before the injected signal failure');
  t.mock.method(process, 'kill', (pid, sig) => pid === -handle.pid ? groupKill(realKill, pid, sig) : realKill(pid, sig));
  return handle;
}

for (const trigger of ['cancelled', 'timeout']) {
  test(`zombie-window EPERM on the SIGKILL escalation keeps reason ${trigger} once exit is confirmed`, { timeout: 10000 }, async t => {
    // SIGKILL reaches the group, but the call reports EPERM as macOS does for a zombie-only group.
    const handle = await startWithKill(t, { ignoreTerm: true,
      groupKill: (realKill, pid, sig) => { realKill(pid, sig); if (sig === 'SIGKILL') throw eperm(); return true; } });
    if (trigger === 'cancelled') assert.equal(handle.cancel(), true); else t.mock.timers.tick(1000);
    t.mock.timers.tick(100);
    const result = await handle.completion;
    assert.equal(result.signal, 'SIGKILL', 'the escalation must be what ended the child');
    assert.equal(result.reason, trigger);
  });
}
test('EPERM on the escalation with no observed exit stays recovery-required', { timeout: 10000 }, async t => {
  const handle = await startWithKill(t, { ignoreTerm: true,
    groupKill: (realKill, pid, sig) => { if (sig === 'SIGKILL') throw eperm(); return realKill(pid, sig); } });
  assert.equal(handle.cancel(), true);
  t.mock.timers.tick(100);
  t.mock.timers.tick(1900);
  const result = await handle.completion;
  assert.ok(RECOVERY_REASONS.includes(result.reason), `got ${result.reason}`);
});
test('EPERM from the group probe after exit stays recovery-required', { timeout: 10000 }, async t => {
  // The child exits on SIGTERM, but the group still holds a member we cannot signal.
  const handle = await startWithKill(t, { ignoreTerm: false,
    groupKill: (realKill, pid, sig) => { if (sig === 0 || sig === 'SIGKILL') throw eperm(); return realKill(pid, sig); } });
  assert.equal(handle.cancel(), true);
  const result = await handle.completion;
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(RECOVERY_REASONS.includes(result.reason), `got ${result.reason}`);
});
