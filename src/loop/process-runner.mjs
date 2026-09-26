import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { requireThat } from './contracts.mjs';

// Trusted local host primitive, not a sandbox. No shell and no inherited env.
// The in-memory handle owns cancellation; a saved PID alone is not authority.
export function startBoundedProcess({ executable, argv, cwd, env, timeoutMs, maxOutputBytes, signal }) {
  requireThat(process.platform !== 'win32', 'CAPABILITY_MISSING', 'POSIX process groups required');
  requireThat(!signal?.aborted, 'CANCELLED', 'Process cancelled before start');
  requireThat(typeof executable === 'string' && isAbsolute(executable) && typeof cwd === 'string' && isAbsolute(cwd), 'INVALID_SPEC', 'Absolute executable/cwd required');
  requireThat(Array.isArray(argv) && argv.length <= 100 && argv.every(v => typeof v === 'string' && !v.includes('\0') && Buffer.byteLength(v) <= 200 * 1024), 'INVALID_SPEC', 'Invalid argv');
  requireThat(env && typeof env === 'object' && !Array.isArray(env) && Object.entries(env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && !v.includes('\0')), 'INVALID_SPEC', 'Explicit environment required');
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000
    && Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 16 * 1024 * 1024, 'INVALID_SPEC', 'Invalid process bounds');
  let pid = null, cancelOwned, result = null;
  const completion = new Promise(resolve => {
    const chunks = { stdout: [], stderr: [] }; let bytes = 0, reason = null, done = false, escalation;
    const startedAt = new Date().toISOString();
    const child = spawn(executable, [...argv], { cwd, env: { ...env }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    pid = child.pid ?? null;
    const kill = sig => {
      if (!child.pid) return;
      try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') reason = 'cancel_error'; }
    };
    const cancel = why => {
      if (done || reason) return false;
      reason = why; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 100); return true;
    };
    cancelOwned = () => cancel('cancelled');
    const abort = () => cancel('cancelled');
    const timer = setTimeout(() => cancel('timeout'), timeoutMs);
    const drainDeadline = setTimeout(() => {
      reason = 'cleanup_unknown'; child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish(null, null, new Error('Process cleanup could not be confirmed'));
    }, timeoutMs + 1000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const finish = (exitCode, exitSignal, error) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(drainDeadline); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
      let descendants = false;
      if (child.pid) try { process.kill(-child.pid, 0); descendants = true; } catch (e) { if (e.code !== 'ESRCH') descendants = true; }
      if (descendants) { kill('SIGKILL'); reason ??= 'orphaned_process_group'; }
      result = { exitCode, signal: exitSignal, error: error?.message ?? null, reason,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        startedAt, finishedAt: new Date().toISOString() };
      resolve(structuredClone(result));
    };
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      const remaining = Math.max(0, maxOutputBytes - bytes); if (remaining) chunks[stream].push(chunk.subarray(0, remaining)); bytes += Math.min(remaining, chunk.length);
      if (chunk.length > remaining) cancel('output_limit');
    });
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, exitSignal) => finish(code, exitSignal, null));
  });
  return Object.freeze({ pid, completion,
    inspect: () => ({ pid, status: result ? 'EXITED' : 'RUNNING', result: result ? structuredClone(result) : null }),
    cancel: () => cancelOwned?.() ?? false });
}
