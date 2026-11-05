import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../src/loop/store.mjs';
import { openEvidenceArchive } from '../../src/loop/evidence.mjs';
import { openFixtureAdapter } from '../../src/loop/adapters/fixture-process.mjs';
import { createFixtureDriver } from '../../src/loop/fixture-driver.mjs';
import { acquireExecutionOwner } from '../../src/loop/execution-owner.mjs';
import { TERMINAL } from '../../src/loop/reducer.mjs';

// Disposable host running the real fixture driver until terminal; a second process records the stop.
// Lifetime bound: self-exit after 20 s; fixture workers self-exit within 5 s, test gates within 3 s.
setTimeout(() => process.exit(9), 20000).unref();
const [directory] = process.argv.slice(2);
const { root, gate, oracle, request, pollMs } = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
const emit = event => writeSync(1, `${JSON.stringify({ ...event, at: Date.now() })}\n`);
const runId = 'run';
const store = await openStore(join(directory, 'loop.sqlite'));
const owner = await acquireExecutionOwner({ store, target: root });
const archive = await openEvidenceArchive(join(directory, 'evidence.sqlite'));
const inner = await openFixtureAdapter({ filename: join(directory, 'fixture.sqlite'), runId, workspace: directory,
  onBoundary: event => emit({ source: 'adapter', ...event }) });
const adapter = { ...inner, cancel(handle) { const result = inner.cancel(handle); emit({ source: 'cancel', cancelled: result.cancelled, status: result.status }); return result; } };
let lastSeq = 0;
const observed = { ...store,
  readStopRequest(id) { const record = store.readStopRequest(id); if ((record?.seq ?? 0) !== lastSeq) { lastSeq = record?.seq ?? 0; emit({ source: 'poll', seq: lastSeq }); } return record; },
  apply(action, command, now, fence) { const reply = store.apply(action, command, now, fence); emit({ source: 'store', action, payload: command.payload }); return reply; } };
const driver = createFixtureDriver({ store: observed, owner, adapter, archive, runId, root, projectionDirectory: directory, request, pollMs,
  gateConfigs: { test: { gate, repoRoots: { product: root }, executables: { node: process.execPath }, envProfiles: { empty: {} }, oracleBundles: { oracle } } } });
emit({ source: 'ready' });
try {
  for (let steps = 0; steps < 8 && !TERMINAL.has(driver.status().state.status); steps++) await driver.step();
} catch (error) { emit({ source: 'error', code: error.code ?? 'INTERNAL_ERROR' }); }
emit({ source: 'done', status: driver.status().state.status });
await driver.close(); await adapter.close(); owner.release(); archive.close(); store.close();
