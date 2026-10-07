import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { bytesDigest, digest, id, requireThat, specDigest } from './contracts.mjs';
import { demoBundle } from './demo.mjs';
import { openStore } from './store.mjs';
import { openEvidenceArchive } from './evidence.mjs';
import { openFixtureAdapter } from './adapters/fixture-process.mjs';
import { createFixtureDriver } from './fixture-driver.mjs';
import { acquireExecutionOwner } from './execution-owner.mjs';
import { snapshotRepository } from './snapshots.mjs';
import { gateDigest } from './gates.mjs';
import { TERMINAL } from './reducer.mjs';

// Creates its own disposable product, never takes a user product/command as input.
// Fresh directory is an atomic one-shot boundary, not a resumable execution lock.
export async function runFixtureDemo({ directory, runId }) {
  id(runId);
  requireThat(Number(process.versions.node.split('.')[0]) >= 24 && process.platform !== 'win32',
    'CAPABILITY_MISSING', 'Fixture CLI requires Node 24+ and POSIX process groups');
  directory = resolve(directory);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') requireThat(false, 'IDEMPOTENCY_CONFLICT', 'Fixture requires a new state directory; existing data is preserved');
    throw error;
  }
  directory = realpathSync.native(directory);
  const root = join(directory, 'product'); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/check.cjs'), 'process.stdout.write("isolated fixture gate passed\\n");\n', { flag: 'wx' });
  const git = args => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
    timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  git(['init', '-q', '--template=']); git(['add', '--', 'src/check.cjs']);
  git(['-c', 'user.name=AI.Team fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Isolated simulation fixture']);
  const executable = realpathSync(process.execPath), oracle = [{ path: 'src/check.cjs', digest: bytesDigest(readFileSync(join(root, 'src/check.cjs'))) }];
  const gate = { id: 'test', repoId: 'product', executableRef: { id: 'node', digest: bytesDigest(readFileSync(executable)) },
    argv: ['check.cjs'], cwd: { repoId: 'product', relativePath: 'src' }, envProfileId: 'empty', timeoutMs: 1000,
    successExitCodes: [0], oracleBundleRef: { id: 'oracle', digest: digest(oracle) }, networkPolicyId: 'local-attended-inherit' };
  gate.specDigest = gateDigest(gate);
  const { spec, artifacts } = demoBundle(runId, { schemaVersion: 2 });
  spec.objective = 'SIMULATION: run an isolated fixture worker, real local checks and durable closeout';
  spec.criteria[0].description = 'Isolated task and final local checks pass';
  spec.tasks[0].display = { ticket: 'FIXTURE-1', title: 'Verify the isolated execution pipeline', workKind: 'test', layers: ['simulation'] };
  artifacts.snapshot = snapshotRepository({ root }); artifacts.gate = gate;
  artifacts.manifest.gates[0].artifactRef.digest = digest(gate);
  spec.manifestRef.digest = digest(artifacts.manifest); spec.initialSnapshotRef.digest = digest(artifacts.snapshot);
  spec.approvedSpecDigest = specDigest(spec);
  let store, owner, archive, adapter, driver, signalError;
  const stop = signal => {
    try { driver.stop({ mode: 'hard', reason: `Fixture CLI received ${signal}` }); } catch (error) { signalError = error; }
  };
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  try {
    store = await openStore(join(directory, 'loop.sqlite'));
    owner = await acquireExecutionOwner({ store, target: root }); store.create(spec, artifacts, { simulation: true });
    archive = await openEvidenceArchive(join(directory, 'evidence.sqlite'));
    adapter = await openFixtureAdapter({ filename: join(directory, 'fixture.sqlite'), runId, workspace: directory });
    driver = createFixtureDriver({ store, owner, archive, adapter, runId, root, projectionDirectory: directory,
      gateConfigs: { test: { gate, repoRoots: { product: root }, executables: { node: executable }, envProfiles: { empty: {} }, oracleBundles: { oracle } } } });
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    for (let steps = 0; steps < 8 && !TERMINAL.has(driver.status().state.status); steps++) {
      await driver.step(); if (signalError) throw signalError;
    }
    const status = driver.status();
    requireThat(TERMINAL.has(status.state.status), 'LIMIT_REACHED', 'Fixture step bound reached; inspect preserved state');
    store.verify(runId);
    return status;
  } finally {
    try { await driver?.close(); }
    finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
      try { await adapter?.close(); } finally { try { owner?.release(); } finally { archive?.close(); store?.close(); } }
    }
  }
}
