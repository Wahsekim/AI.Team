import { readFileSync, realpathSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { bytesDigest, digest, fields, id, pathRef, ref, requireThat } from './contracts.mjs';
import { resolveContained, snapshotRepository } from './snapshots.mjs';

export function gateDigest(spec) { const { specDigest, ...body } = spec; return digest(body); }
export function validateGate(spec) {
  fields(spec, ['id', 'specDigest', 'repoId', 'executableRef', 'argv', 'cwd', 'envProfileId', 'timeoutMs', 'successExitCodes', 'oracleBundleRef', 'networkPolicyId'], 'GateSpec');
  id(spec.id); ref(spec.executableRef); ref(spec.oracleBundleRef); id(spec.envProfileId);
  pathRef(spec.cwd);
  requireThat(['team', 'product'].includes(spec.repoId) && spec.cwd.repoId === spec.repoId, 'INVALID_SPEC', 'Gate repo/cwd mismatch');
  requireThat(Array.isArray(spec.argv) && spec.argv.length <= 100 && spec.argv.every(v => typeof v === 'string' && !v.includes('\0') && Buffer.byteLength(v) <= 200 * 1024), 'INVALID_SPEC', 'Invalid gate argv');
  requireThat(Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs > 0 && spec.timeoutMs <= 3600000, 'INVALID_SPEC', 'Gate timeout must be 1..3600000 ms');
  requireThat(Array.isArray(spec.successExitCodes) && spec.successExitCodes.length > 0
    && spec.successExitCodes.every(v => Number.isInteger(v) && v >= 0 && v <= 255), 'INVALID_SPEC', 'Invalid success exit codes');
  requireThat(spec.specDigest === gateDigest(spec), 'INVALID_SPEC', 'Gate digest mismatch');
  requireThat(spec.networkPolicyId === 'local-attended-inherit', 'CAPABILITY_MISSING', 'This runner does not enforce network isolation');
  return spec.specDigest;
}

function execute(executable, argv, cwd, env, timeoutMs, maxOutputBytes, signal) {
  return new Promise(resolve => {
    const chunks = { stdout: [], stderr: [] }; let bytes = 0, reason = null, done = false, escalation;
    const startedAt = new Date().toISOString();
    const child = spawn(executable, argv, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = sig => {
      if (!child.pid) return;
      try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') reason = 'cancel_error'; }
    };
    const cancel = why => { if (reason) return; reason = why; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 100); };
    const abort = () => cancel('cancelled');
    const timer = setTimeout(() => cancel('timeout'), timeoutMs);
    // A descendant may escape the process group yet retain our pipes. Bound the
    // host wait; report UNKNOWN cleanup, never pretend that all processes exited.
    const drainDeadline = setTimeout(() => {
      reason = 'cleanup_unknown'; child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish(null, null, new Error('Process cleanup could not be confirmed'));
    }, timeoutMs + 1000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const finish = (exitCode, exitSignal, error) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(drainDeadline); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
      // A successful parent may have left detached-in-group background children.
      let descendants = false;
      if (child.pid) try { process.kill(-child.pid, 0); descendants = true; } catch (e) { if (e.code !== 'ESRCH') descendants = true; }
      if (descendants) { kill('SIGKILL'); reason ??= 'orphaned_process_group'; }
      resolve({ exitCode, signal: exitSignal, error: error?.message ?? null, reason,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        startedAt, finishedAt: new Date().toISOString() });
    };
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      const remaining = Math.max(0, maxOutputBytes - bytes); if (remaining) chunks[stream].push(chunk.subarray(0, remaining)); bytes += Math.min(remaining, chunk.length);
      if (chunk.length > remaining) cancel('output_limit');
    });
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, exitSignal) => finish(code, exitSignal, null));
  });
}

// Trusted host configuration only. This primitive is not yet wired into the simulation reducer.
// Executables/profiles/oracle files must be approved by the caller, not extracted from worker text.
export async function runLocalGate({ gate, repoRoots, executables, envProfiles, oracleBundles,
  expectedCandidate, runId, taskId, dispatchId, maxOutputBytes = 1024 * 1024, signal }) {
  gate = structuredClone(gate);
  validateGate(gate); [runId, taskId, dispatchId].forEach(id);
  requireThat(!signal?.aborted, 'CANCELLED', 'Gate was cancelled before dispatch');
  requireThat(process.platform !== 'win32', 'CAPABILITY_MISSING', 'POSIX process groups required');
  requireThat(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 16 * 1024 * 1024, 'INVALID_SPEC', 'Invalid output cap');
  requireThat(Object.hasOwn(repoRoots, gate.repoId) && Object.hasOwn(executables, gate.executableRef.id)
    && Object.hasOwn(envProfiles, gate.envProfileId) && Object.hasOwn(oracleBundles, gate.oracleBundleRef.id), 'UNKNOWN_REFERENCE', 'Missing trusted gate binding');
  const root = realpathSync(repoRoots[gate.repoId]);
  const executable = realpathSync(executables[gate.executableRef.id]);
  requireThat(statSync(executable).isFile() && bytesDigest(readFileSync(executable)) === gate.executableRef.digest, 'INVALID_SPEC', 'Executable digest mismatch');
  const env = envProfiles[gate.envProfileId];
  requireThat(env && !Array.isArray(env) && typeof env === 'object' && Object.entries(env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && !v.includes('\0')), 'INVALID_SPEC', 'Invalid explicit environment');
  const oracle = structuredClone(oracleBundles[gate.oracleBundleRef.id]);
  requireThat(Array.isArray(oracle) && oracle.length > 0 && digest(oracle) === gate.oracleBundleRef.digest, 'INVALID_SPEC', 'Oracle bundle digest mismatch');
  for (const entry of oracle) { fields(entry, ['path', 'digest'], 'Oracle entry'); requireThat(bytesDigest(readFileSync(resolveContained(root, entry.path))) === entry.digest, 'STALE_EVIDENCE', 'Oracle input changed'); }
  const before = snapshotRepository({ root, repoId: gate.repoId });
  requireThat(digest(before) === expectedCandidate, 'STALE_EVIDENCE', 'Candidate differs from approved snapshot');
  const cwd = resolveContained(root, gate.cwd.relativePath);
  requireThat(statSync(cwd).isDirectory(), 'INVALID_SPEC', 'Gate cwd must be directory');
  const transcript = await execute(executable, gate.argv, cwd, { ...env }, gate.timeoutMs, maxOutputBytes, signal);
  let unchanged = false, postSnapshotError = null;
  try { unchanged = snapshotRepository({ root, repoId: gate.repoId }).treeDigest === before.treeDigest;
    for (const entry of oracle) unchanged &&= bytesDigest(readFileSync(resolveContained(root, entry.path))) === entry.digest;
  } catch (e) { unchanged = false; postSnapshotError = e.code ?? e.message; }
  const result = !unchanged || transcript.error ? 'error' : transcript.reason === 'timeout' ? 'timeout'
    : transcript.reason || transcript.signal ? 'error' : gate.successExitCodes.includes(transcript.exitCode) ? 'pass' : 'fail';
  const scopeAttestation = { unchanged, postSnapshotError, before: before.treeDigest, networkPolicy: gate.networkPolicyId, trustTier: 'local-attended',
    recoveryRequired: ['cleanup_unknown', 'cancel_error', 'orphaned_process_group'].includes(transcript.reason) };
  const evidence = { schemaVersion: 1, id: `evidence-${digest({ runId, dispatchId, transcript }).slice(7, 39)}`, runId, taskId, dispatchId,
    candidateSnapshotRef: { id: before.id, digest: digest(before) }, gateRef: { id: gate.id, digest: gate.specDigest }, producerIdentity: 'host-local-gate',
    result, exitCode: transcript.exitCode, startedAt: transcript.startedAt, finishedAt: transcript.finishedAt,
    transcriptRef: { id: 'transcript', digest: digest(transcript) }, scopeAttestationRef: { id: 'scope-attestation', digest: digest(scopeAttestation) } };
  return { evidence, transcript, scopeAttestation };
}
