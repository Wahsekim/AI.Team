import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../src/loop/store.mjs';
import { openEvidenceArchive } from '../../src/loop/evidence.mjs';
import { openFixtureAdapter } from '../../src/loop/adapters/fixture-process.mjs';
import { createFixtureDriver } from '../../src/loop/fixture-driver.mjs';
import { acquireExecutionOwner } from '../../src/loop/execution-owner.mjs';
import { TERMINAL } from '../../src/loop/reducer.mjs';

// Disposable host running the real fixture driver. Test-only boundary hooks wrap the
// injected store and reuse the adapter's onBoundary; production modules are unchanged.
const [directory, boundary] = process.argv.slice(2);
const { root, gate, oracle, request } = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
const emit = event => writeSync(1, `${JSON.stringify(event)}\n`);
// The parent SIGKILLs this actual process at the boundary. Self-exit bounds an unkilled host.
const pause = event => {
  emit({ ...event, boundary, paused: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  process.exit(9);
};

const runId = 'run';
const store = await openStore(join(directory, 'loop.sqlite'));
const owner = await acquireExecutionOwner({ store, target: root });
emit({ source: 'owner', ownerId: owner.ownerId });
const archive = await openEvidenceArchive(join(directory, 'evidence.sqlite'));
const adapter = await openFixtureAdapter({ filename: join(directory, 'fixture.sqlite'), runId, workspace: directory, onBoundary(event) {
  emit({ source: 'adapter', ...event });
  if (boundary === 'receipt-before-settle' && event.phase === 'result-stored') pause(event);
  // Yield once so the PID row commits (same synchronous call) while the worker still runs.
  if (boundary === 'process-before-receipt' && event.phase === 'spawned-before-pid-save') setImmediate(() => pause(event));
} });
// Pre-commit pauses leave the action undone; post-commit pauses leave it durable.
const preCommit = { 'gate-receipt-before-settle': (a, p) => a === 'settle-evidence' && p.dispatchId === 'd-2', 'projection-before-ack': a => a === 'projected' };
const postCommit = { 'claim-before-start': (a, p) => a === 'claim' && p.effectId === 'd-1' };
const hooked = { ...store, apply(action, command, now, fence) {
  if (preCommit[boundary]?.(action, command.payload)) pause({ source: 'store', action, committed: false });
  const reply = store.apply(action, command, now, fence);
  emit({ source: 'store', action, stateVersion: reply.stateVersion });
  if (postCommit[boundary]?.(action, command.payload)) pause({ source: 'store', action, committed: true });
  return reply;
} };
const driver = createFixtureDriver({ store: hooked, owner, adapter, archive, runId, root, projectionDirectory: directory, request,
  gateConfigs: { test: { gate, repoRoots: { product: root }, executables: { node: process.execPath }, envProfiles: { empty: {} }, oracleBundles: { oracle } } } });
for (let steps = 0; steps < 8 && !TERMINAL.has(driver.status().state.status); steps++) await driver.step();
await driver.close(); await adapter.close(); owner.release(); archive.close(); store.close();
throw new Error(`Requested driver boundary ${boundary} was not reached`);
