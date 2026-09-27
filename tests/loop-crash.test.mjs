import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFixtureAdapter } from '../src/loop/adapters/fixture-process.mjs';

const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Crash fixture requires Node 24+' : false, timeout: 15000 };
const hostScript = fileURLToPath(new URL('./fixtures/fixture-crash-host.mjs', import.meta.url));
async function killAtBoundary(t, boundary) {
  const workspace = mkdtempSync(join(tmpdir(), 'ai-killed-host-')), filename = join(workspace, 'fixture.sqlite');
  const host = spawn(process.execPath, [hostScript, filename, workspace, boundary], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { host.once('error', reject); host.once('exit', (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await exited;
    // No persisted PID is signalled. The orphaned built-in child performs no
    // product work and exits after its short delay or five-second safety guard.
    rmSync(workspace, { recursive: true, force: true });
  });
  let timer;
  const reached = new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    timer = setTimeout(() => reject(new Error(`Boundary ${boundary} was not reached: ${stderr}`)), 5000);
    host.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
    host.stdout.on('data', bytes => {
      stdout += bytes;
      if (stdout.length > 4096) { reject(new Error('Unexpected fixture host output')); return; }
      if (stdout.includes('\n')) try { resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))); } catch (error) { reject(error); }
    });
    host.once('error', reject);
    host.once('exit', (code, signal) => reject(new Error(`Host exited before boundary: ${code}/${signal} ${stderr}`)));
  });
  let event;
  try { event = await reached; } finally { clearTimeout(timer); }
  assert.equal(event.phase, boundary);
  host.kill('SIGKILL'); const exit = await exited; assert.equal(exit.signal, 'SIGKILL');
  return { filename, workspace, event };
}

for (const boundary of ['reservation-committed', 'spawned-before-pid-save', 'result-ready', 'result-stored']) {
  test(`actual killed host at ${boundary} never duplicates a dispatch`, sqlite, async t => {
    const { filename, workspace, event } = await killAtBoundary(t, boundary);
    let newBoundaries = 0;
    const adapter = await openFixtureAdapter({ filename, workspace, runId: 'crash-run', onBoundary: () => { newBoundaries++; } });
    try {
      const handle = adapter.start('d-1', { scenario: 'pass', delayMs: 200, timeoutMs: 2000 });
      const state = adapter.inspect(handle);
      assert.equal(newBoundaries, 0, 'recovery must not spawn or reserve another effect');
      assert.equal(adapter.cancel(handle).cancelled, false, 'new host cannot signal old PID');
      if (boundary === 'result-stored') {
        assert.equal(state.status, 'FINISHED'); assert.equal((await adapter.collectResult(handle)).result, 'pass');
      } else {
        assert.equal(state.status, 'UNKNOWN'); assert.equal(state.recoveryRequired, true);
        await assert.rejects(adapter.collectResult(handle), e => e.code === 'EFFECT_UNKNOWN');
      }
      if (boundary === 'spawned-before-pid-save') { assert.ok(event.pid > 0); assert.equal(state.pid, null); }
      if (boundary === 'reservation-committed') assert.equal(event.pid, null);
    } finally { await adapter.close(); }
  });
}
