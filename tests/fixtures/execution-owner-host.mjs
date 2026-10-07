import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../src/loop/store.mjs';
import { command } from '../../src/loop/demo.mjs';

// Disposable second process for ADR 0002 tests. Every mode self-exits within 8 s.
// try  <store-file> [win32]: one acquire attempt, then an unfenced tick; reports codes.
// hold <store-file>:         acquire, report, release on a stdin line.
// drive <directory>:         real fixture driver; pauses after its first step until a stdin line.
const [mode, target, flag] = process.argv.slice(2);
const emit = event => writeSync(1, `${JSON.stringify(event)}\n`);
const bound = setTimeout(() => process.exit(9), 8000);
const nextLine = () => new Promise(resolve => process.stdin.once('data', resolve));
const attempt = async fn => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, code: error.code ?? error.message }; } };
if (flag === 'win32') Object.defineProperty(process, 'platform', { value: 'win32' });
const { acquireExecutionOwner } = await import('../../src/loop/execution-owner.mjs');

if (mode === 'try') {
  const store = await openStore(target);
  const started = performance.now();
  const acquired = await attempt(() => acquireExecutionOwner({ store }));
  const ms = performance.now() - started;
  const tick = await attempt(() => store.apply('tick', command(store, 'run', { reservation: { agentCalls: 1, tokens: 0, costMicroUsd: 0 }, quota: null })));
  if (acquired.ok) acquired.value.release();
  store.close();
  emit({ acquire: { ok: acquired.ok, code: acquired.code ?? null, ms }, tick: { ok: tick.ok, code: tick.code ?? null } });
} else if (mode === 'hold') {
  const store = await openStore(target), owner = await acquireExecutionOwner({ store });
  emit({ held: true, ownerId: owner.ownerId });
  await nextLine();
  emit({ released: owner.release() }); store.close();
} else if (mode === 'drive') {
  const { openEvidenceArchive } = await import('../../src/loop/evidence.mjs');
  const { openFixtureAdapter } = await import('../../src/loop/adapters/fixture-process.mjs');
  const { createFixtureDriver } = await import('../../src/loop/fixture-driver.mjs');
  const { TERMINAL } = await import('../../src/loop/reducer.mjs');
  const { root, gate, oracle, request } = JSON.parse(readFileSync(join(target, 'config.json'), 'utf8'));
  const store = await openStore(join(target, 'loop.sqlite')), owner = await acquireExecutionOwner({ store });
  const archive = await openEvidenceArchive(join(target, 'evidence.sqlite'));
  const adapter = await openFixtureAdapter({ filename: join(target, 'fixture.sqlite'), runId: 'run', workspace: target,
    onBoundary(event) { if (event.phase === 'spawned-before-pid-save') emit({ source: 'adapter', ...event }); } });
  const driver = createFixtureDriver({ store, owner, adapter, archive, runId: 'run', root, projectionDirectory: target, request,
    gateConfigs: { test: { gate, repoRoots: { product: root }, executables: { node: process.execPath }, envProfiles: { empty: {} }, oracleBundles: { oracle } } } });
  await driver.step();
  emit({ paused: true, ownerId: owner.ownerId, status: driver.status().state.status });
  await nextLine();
  for (let steps = 0; steps < 8 && !TERMINAL.has(driver.status().state.status); steps++) await driver.step();
  const status = driver.status().state.status;
  await driver.close(); await adapter.close();
  emit({ done: true, status, released: owner.release() });
  archive.close(); store.close();
}
clearTimeout(bound);
process.exit(0);
