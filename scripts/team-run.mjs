#!/usr/bin/env node
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openStore, openStoreReadOnly } from '../src/loop/store.mjs';
import { inspectRun } from '../src/loop/inspect.mjs';
import { demoBundle, driveDemo } from '../src/loop/demo.mjs';
import { id, requireThat } from '../src/loop/contracts.mjs';
import { publishProjection } from '../src/loop/projector.mjs';
import { renderRunSummary, stopView } from '../src/loop/display.mjs';
import { runFixtureDemo } from '../src/loop/fixture-demo.mjs';
import { acquireExecutionOwner, bindDriver } from '../src/loop/execution-owner.mjs';

const usage = 'node scripts/team-run.mjs <demo|fixture|status|events|audit|stop|show|inspect> <state-directory> <run-id> [--graceful|--hard (stop only)]';
const STOP_FLAGS = { '--graceful': 'graceful', '--hard': 'hard' };
// R05a: inspection opens the store read-only and never creates it; stop writes but never creates.
const READ_ONLY = new Set(['status', 'events', 'audit', 'show', 'inspect']);
let store, owner;
const EXCLUSION = new Set(['EXECUTION_OWNER_ACTIVE', 'EXECUTION_OPEN', 'OWNER_LOST', 'STORE_MISMATCH', 'TARGET_MISMATCH', 'TARGET_NOT_ISOLATED']);
try {
  const [action, directory, runId, ...extra] = process.argv.slice(2);
  requireThat(['demo', 'fixture', 'stop', ...READ_ONLY].includes(action) && directory && runId
    && (!extra.length || action === 'stop' && extra.length === 1 && Object.hasOwn(STOP_FLAGS, extra[0])), 'INVALID_SPEC', usage);
  id(runId);
  if (action === 'demo') mkdirSync(resolve(directory), { recursive: true, mode: 0o700 });
  const filename = resolve(directory, 'loop.sqlite');
  if (READ_ONLY.has(action)) store = await openStoreReadOnly(filename);
  else if (action !== 'fixture') store = await openStore(filename, { create: action === 'demo' });
  let value, text = null;
  if (action === 'fixture') value = await runFixtureDemo({ directory, runId });
  else if (action === 'demo') {
    owner = await acquireExecutionOwner({ store });
    const bundle = demoBundle(runId, { schemaVersion: 2 }); store.create(bundle.spec, bundle.artifacts, { simulation: true });
    value = driveDemo(bindDriver(owner, store).store, runId, () => Date.now(), effect => publishProjection({ directory: resolve(directory), runId, effect }));
  }
  else if (action === 'show') text = renderRunSummary(store.status(runId), { inspection: await inspectRun({ store, directory: resolve(directory), runId }) });
  else if (action === 'inspect') value = await inspectRun({ store, directory: resolve(directory), runId });
  else if (action === 'status') { const current = store.status(runId); value = { ...current, stop: stopView(current.state) }; }
  else if (action === 'events') value = store.events(runId);
  else if (action === 'audit') value = store.verify(runId);
  // ADR 0004: a durable record only; the active driver polls and observes it (R04b). No lock, no process signal.
  else value = store.requestStop(runId, { kind: STOP_FLAGS[extra[0] ?? '--graceful'], requestedBy: 'cli' });
  process.stdout.write(text ?? `${JSON.stringify({ ok: true, simulation: true, value })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? 'INTERNAL_ERROR', message: error.message })}\n`);
  process.exitCode = error.code === 'CAPABILITY_MISSING' ? 7 : error.code === 'STALE_STATE' ? 3 : EXCLUSION.has(error.code) ? 4 : 2;
} finally { try { owner?.release(); } finally { store?.close(); } }
