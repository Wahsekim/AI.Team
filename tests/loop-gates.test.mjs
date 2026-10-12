import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesDigest, digest } from '../src/loop/contracts.mjs';
import { assertWriteScope, changedPaths, resolveContained, snapshotRepository } from '../src/loop/snapshots.mjs';
import { gateDigest, runLocalGate } from '../src/loop/gates.mjs';

const executableDigest = bytesDigest(readFileSync(process.execPath));
const realSetTimeout = globalThis.setTimeout;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ai-loop-gate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'src/input.txt'), 'input'); writeFileSync(join(root, 'oracle.txt'), 'trusted oracle');
  writeFileSync(join(root, '.gitignore'), '*.ignored\n');
  git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  return root;
}
function config(root, source = 'process.stdout.write("ok")', overrides = {}) {
  const oracle = [{ path: 'oracle.txt', digest: bytesDigest(readFileSync(join(root, 'oracle.txt'))) }];
  const gate = { id: 'local-test', repoId: 'product', executableRef: { id: 'node', digest: executableDigest },
    argv: ['-e', source], cwd: { repoId: 'product', relativePath: 'src' }, envProfileId: 'empty', timeoutMs: 1000,
    successExitCodes: [0], oracleBundleRef: { id: 'oracle', digest: digest(oracle) }, networkPolicyId: 'local-attended-inherit', ...overrides };
  gate.specDigest = gateDigest(gate);
  return { gate, repoRoots: { product: root }, executables: { node: process.execPath }, envProfiles: { empty: {} }, oracleBundles: { oracle },
    expectedCandidate: digest(snapshotRepository({ root })), runId: 'run', taskId: 'task', dispatchId: 'd-1' };
}
test('snapshot inventories untracked assets, tracked deletions, content and executable mode', t => {
  const root = fixture(t), a = snapshotRepository({ root });
  writeFileSync(join(root, 'assets/new.png'), Buffer.from([0, 1, 255])); unlinkSync(join(root, 'src/input.txt'));
  const b = snapshotRepository({ root }); assert.notEqual(a.treeDigest, b.treeDigest);
  assert.deepEqual(changedPaths(a, b), ['assets/new.png', 'src/input.txt']);
  assert.equal(b.inventory.find(e => e.path === 'src/input.txt').kind, 'deleted');
  assert.throws(() => assertWriteScope(a, b, ['src']), e => e.code === 'SCOPE_DENIED');
  assert.deepEqual(assertWriteScope(a, b, ['src', 'assets']), ['assets/new.png', 'src/input.txt']);
  chmodSync(join(root, 'assets/new.png'), 0o755); assert.notEqual(snapshotRepository({ root }).treeDigest, b.treeDigest);
});
test('scope boundary is path-based, symlinks cannot escape and byte caps fail closed', t => {
  const root = fixture(t); const a = snapshotRepository({ root });
  writeFileSync(join(root, 'src-other.txt'), 'outside');
  assert.throws(() => assertWriteScope(a, snapshotRepository({ root }), ['src']), e => e.code === 'SCOPE_DENIED');
  symlinkSync(tmpdir(), join(root, 'src/link'));
  assert.throws(() => resolveContained(root, 'src/link/test'), e => e.code === 'SCOPE_DENIED');
  assert.throws(() => snapshotRepository({ root }), e => e.code === 'SCOPE_DENIED');
  unlinkSync(join(root, 'src/link'));
  assert.throws(() => snapshotRepository({ root, maxFileBytes: 2 }), e => e.code === 'LIMIT_REACHED');
});
test('local gate binds candidate/oracle/executable and records real pass/failure', async t => {
  const root = fixture(t); const c = config(root);
  const pass = await runLocalGate(c); assert.equal(pass.evidence.result, 'pass'); assert.equal(pass.transcript.stdout, 'ok');
  assert.equal(pass.evidence.candidateSnapshotRef.digest, c.expectedCandidate);
  assert.equal(pass.scopeAttestation.unchanged, true);
  const fail = await runLocalGate(config(root, 'process.exit(7)')); assert.equal(fail.evidence.result, 'fail'); assert.equal(fail.evidence.exitCode, 7);
  c.expectedCandidate = digest('wrong'); await assert.rejects(runLocalGate(c), e => e.code === 'STALE_EVIDENCE');
});
test('oracle edits cannot turn an exit-zero gate into passing evidence', async t => {
  const root = fixture(t);
  const value = await runLocalGate(config(root, 'require("node:fs").writeFileSync("../oracle.txt", "tampered")'));
  assert.equal(value.evidence.exitCode, 0); assert.equal(value.evidence.result, 'error'); assert.equal(value.scopeAttestation.unchanged, false);
});
test('preflight rejects stale oracle, unavailable network isolation and pre-cancelled dispatch', async t => {
  const root = fixture(t); const c = config(root);
  writeFileSync(join(root, 'oracle.txt'), 'changed');
  await assert.rejects(runLocalGate(c), e => e.code === 'STALE_EVIDENCE');
  await assert.rejects(runLocalGate(config(root, '', { networkPolicyId: 'deny' })), e => e.code === 'CAPABILITY_MISSING');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runLocalGate({ ...config(root), signal: controller.signal }), e => e.code === 'CANCELLED');
});
test('real timeout, signals, cancellation and output flood never pass', { timeout: 10000 }, async t => {
  const root = fixture(t);
  const timeout = await runLocalGate(config(root, 'setInterval(() => {}, 1000)', { timeoutMs: 50 })); assert.equal(timeout.evidence.result, 'timeout');
  // The runner's clock is mocked so a slow child start cannot let the timeout outrank the signal/flood outcome.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signal = await runLocalGate(config(root, 'process.kill(process.pid, "SIGTERM")')); assert.equal(signal.evidence.result, 'error');
  const flood = await runLocalGate({ ...config(root, 'process.stdout.write("x".repeat(100000))'), maxOutputBytes: 100 });
  assert.equal(flood.evidence.result, 'error'); assert.equal(Buffer.byteLength(flood.transcript.stdout), 100);
  t.mock.timers.reset();
  const controller = new AbortController(); const promise = runLocalGate({ ...config(root, 'setInterval(() => {}, 1000)'), signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  try { assert.equal((await promise).transcript.reason, 'cancelled'); } finally { clearTimeout(timer); }
});
test('argv is passed literally without shell expansion and environment is explicit', async t => {
  const root = fixture(t); const literal = '$(touch injected) ; echo shell';
  const c = config(root, 'process.stdout.write(JSON.stringify({arg:process.argv[1],secret:process.env.HOME??null}))');
  c.gate.argv.push(literal); c.gate.specDigest = gateDigest(c.gate);
  const value = await runLocalGate(c);
  assert.equal(value.evidence.result, 'pass'); assert.deepEqual(JSON.parse(value.transcript.stdout), { arg: literal, secret: null });
});
test('caller configuration changes during execution cannot alter evidence or success policy', async t => {
  const root = fixture(t); const c = config(root, 'setTimeout(() => process.exit(7), 50)');
  const originalDigest = c.gate.specDigest; const promise = runLocalGate(c);
  c.gate.successExitCodes = [7]; c.gate.specDigest = gateDigest(c.gate);
  const result = await promise;
  assert.equal(result.evidence.result, 'fail'); assert.equal(result.evidence.gateRef.digest, originalDigest);
});
test('REV-2-001: deleting an explicitly bound ignored oracle fails closed', async t => {
  const root = fixture(t); writeFileSync(join(root, 'oracle.ignored'), 'explicitly protected');
  const c = config(root, 'require("node:fs").unlinkSync("../oracle.ignored")');
  c.oracleBundles.oracle = [{ path: 'oracle.ignored', digest: bytesDigest(readFileSync(join(root, 'oracle.ignored'))) }];
  c.gate.oracleBundleRef.digest = digest(c.oracleBundles.oracle); c.gate.specDigest = gateDigest(c.gate);
  const result = await runLocalGate(c);
  assert.equal(result.evidence.exitCode, 0); assert.equal(result.evidence.result, 'error');
  assert.equal(result.scopeAttestation.unchanged, false); assert.equal(result.scopeAttestation.postSnapshotError, 'ENOENT');
});
test('escaped descendant retaining pipes bounds host wait and requires recovery', { timeout: 10000 }, async t => {
  const root = fixture(t), dir = mkdtempSync(join(tmpdir(), 'ai-loop-escaped-')), readyFile = join(dir, 'pid');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = `const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},3000)"],{detached:true,stdio:["ignore",1,2]});process.stdout.write(String(c.pid));require("node:fs").writeFileSync(${JSON.stringify(readyFile)},String(process.pid));c.unref();`;
  // The runner's clock is mocked so timeout and drain deadline fire only after the gate child has exited
  // and been reaped while its escaped descendant still holds the pipes.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const promise = runLocalGate(config(root, source, { timeoutMs: 200 }));
  const deadline = Date.now() + 2000;
  const reaped = () => { try { process.kill(Number(readFileSync(readyFile, 'utf8')), 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
  while (!(existsSync(readyFile) && reaped()) && Date.now() < deadline) await new Promise(resolve => realSetTimeout(resolve, 10));
  assert.ok(existsSync(readyFile) && reaped(), 'gate child must spawn the escaped descendant and exit before the timeout');
  t.mock.timers.tick(200 + 1000);
  const result = await promise;
  const pid = Number(result.transcript.stdout);
  if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  assert.equal(result.evidence.result, 'error'); assert.equal(result.scopeAttestation.recoveryRequired, true);
  assert.equal(result.transcript.reason, 'cleanup_unknown');
});
