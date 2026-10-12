import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesDigest, digest } from '../src/loop/contracts.mjs';
import { snapshotRepository } from '../src/loop/snapshots.mjs';
import { gateDigest, runLocalGate } from '../src/loop/gates.mjs';
import { openEvidenceArchive, validateGateRecord } from '../src/loop/evidence.mjs';

const sqlite = { skip: Number(process.versions.node.split('.')[0]) < 24 ? 'Archive requires Node 24+' : false };
const executableDigest = bytesDigest(readFileSync(process.execPath));
function fixture(t, source = 'process.stdout.write("verified")') {
  const dir = mkdtempSync(join(tmpdir(), 'ai-evidence-')), root = join(dir, 'product'); mkdirSync(root); mkdirSync(join(root, 'src'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(root, 'src/check.cjs'), source);
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const oracle = [{ path: 'src/check.cjs', digest: bytesDigest(readFileSync(join(root, 'src/check.cjs'))) }];
  const gate = { id: 'test', repoId: 'product', executableRef: { id: 'node', digest: executableDigest }, argv: ['check.cjs'],
    cwd: { repoId: 'product', relativePath: 'src' }, envProfileId: 'empty', timeoutMs: 1000, successExitCodes: [0],
    oracleBundleRef: { id: 'oracle', digest: digest(oracle) }, networkPolicyId: 'local-attended-inherit' };
  gate.specDigest = gateDigest(gate);
  return { dir, config: { gate, repoRoots: { product: root }, executables: { node: process.execPath }, envProfiles: { empty: {} },
    oracleBundles: { oracle }, expectedCandidate: digest(snapshotRepository({ root })), runId: 'run', taskId: 'task', dispatchId: 'd-1' } };
}

test('host gate record binds inventory, invocation, oracle, transcript and outcome', async t => {
  const { config } = fixture(t); const record = await runLocalGate(config);
  const reference = validateGateRecord(record);
  assert.equal(reference.digest, digest(record)); assert.equal(record.evidence.schemaVersion, 2);
  assert.equal(record.evidence.result, 'pass'); assert.equal(record.invocation.environmentDigest, digest({}));
  for (const edit of [r => { r.transcript.stdout += 'tampered'; }, r => { r.snapshot.inventory[0].bytes++; },
    r => { r.evidence.result = 'fail'; }, r => { r.gate.argv.push('extra'); }, r => { r.oracle[0].path = 'other'; },
    r => { r.invocation.environmentDigest = digest({ changed: true }); }, r => { r.evidence.exitCode = 7; }]) {
    const changed = structuredClone(record); edit(changed);
    assert.throws(() => validateGateRecord(changed));
  }
});

test('environment binding is frozen before execution and stores no environment values', async t => {
  const { config } = fixture(t, 'setTimeout(() => process.stdout.write("ok"), 40)');
  config.envProfiles.empty = { PRIVATE_VALUE: 'test-only-value' };
  const promise = runLocalGate(config); config.envProfiles.empty.PRIVATE_VALUE = 'changed';
  const record = await promise; validateGateRecord(record);
  assert.equal(record.invocation.environmentDigest, digest({ PRIVATE_VALUE: 'test-only-value' }));
  assert.equal(JSON.stringify(record).includes('test-only-value'), false);
});

test('nonzero host exits cannot be relabelled passing by rehashing just the transcript', async t => {
  const { config } = fixture(t, 'process.exit(7)'); const record = await runLocalGate(config);
  validateGateRecord(record); assert.equal(record.evidence.result, 'fail');
  record.evidence.result = 'pass'; assert.throws(() => validateGateRecord(record), e => e.code === 'STALE_EVIDENCE');
});

test('archive is immutable, idempotent and survives close/reopen', sqlite, async t => {
  const { dir, config } = fixture(t); const file = join(dir, 'evidence.sqlite');
  const record = await runLocalGate(config); let archive = await openEvidenceArchive(file);
  try {
    const reference = archive.put(record); assert.deepEqual(archive.put(structuredClone(record)), reference);
    archive.close(); archive = await openEvidenceArchive(file);
    assert.deepEqual(archive.get('run', 'd-1', reference).record, record);
    assert.throws(() => archive.get('run', 'missing'), e => e.code === 'UNKNOWN_REFERENCE');
    assert.throws(() => archive.get('run', 'd-1', { ...reference, digest: digest('wrong') }), e => e.code === 'STALE_EVIDENCE');
    const other = await runLocalGate(config);
    // Keep the same dispatch but alter a valid invocation timestamp if clocks coincide.
    if (digest(other) === reference.digest) await new Promise(resolve => setTimeout(resolve, 2));
    const conflicting = digest(other) === reference.digest ? await runLocalGate(config) : other;
    assert.throws(() => archive.put(conflicting), e => e.code === 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(archive.get('run', 'd-1').reference, reference);
  } finally { archive.close(); }
});

test('archive detects disk tampering and rejects a symlink database', sqlite, async t => {
  const { dir, config } = fixture(t), file = join(dir, 'evidence.sqlite');
  let archive = await openEvidenceArchive(file);
  archive.put(await runLocalGate(config)); archive.close();
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(file);
  db.prepare('UPDATE gate_records SET digest=?').run(digest('tampered')); db.close();
  archive = await openEvidenceArchive(file);
  try { assert.throws(() => archive.get('run', 'd-1'), e => e.code === 'STALE_EVIDENCE'); }
  finally { archive.close(); }
  const link = join(dir, 'link.sqlite'); symlinkSync(file, link);
  await assert.rejects(openEvidenceArchive(link), e => e.code === 'SCOPE_DENIED');
});
