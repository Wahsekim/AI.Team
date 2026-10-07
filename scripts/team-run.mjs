#!/usr/bin/env node
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openStore } from '../src/loop/store.mjs';
import { command, demoBundle, driveDemo } from '../src/loop/demo.mjs';
import { id, requireThat } from '../src/loop/contracts.mjs';
import { publishProjection } from '../src/loop/projector.mjs';
import { renderRunSummary } from '../src/loop/display.mjs';
import { runFixtureDemo } from '../src/loop/fixture-demo.mjs';
import { acquireExecutionOwner, bindDriver } from '../src/loop/execution-owner.mjs';

const usage = 'node scripts/team-run.mjs <demo|fixture|status|events|audit|stop|show> <state-directory> <run-id>';
let store, owner;
const EXCLUSION = new Set(['EXECUTION_OWNER_ACTIVE', 'EXECUTION_OPEN', 'OWNER_LOST', 'STORE_MISMATCH']);
try {
  const [action, directory, runId, ...extra] = process.argv.slice(2);
  requireThat(['demo', 'fixture', 'status', 'events', 'audit', 'stop', 'show'].includes(action) && directory && runId && !extra.length, 'INVALID_SPEC', usage);
  id(runId);
  if (action === 'demo') mkdirSync(resolve(directory), { recursive: true, mode: 0o700 });
  if (action !== 'fixture') store = await openStore(resolve(directory, 'loop.sqlite'));
  let value, text = null;
  if (action === 'fixture') value = await runFixtureDemo({ directory, runId });
  else if (action === 'demo') {
    owner = await acquireExecutionOwner({ store });
    const bundle = demoBundle(runId, { schemaVersion: 2 }); store.create(bundle.spec, bundle.artifacts, { simulation: true });
    value = driveDemo(bindDriver(owner, store).store, runId, () => Date.now(), effect => publishProjection({ directory: resolve(directory), runId, effect }));
  }
  else if (action === 'show') text = renderRunSummary(store.status(runId));
  else if (action === 'status') value = store.status(runId);
  else if (action === 'events') value = store.events(runId);
  else if (action === 'audit') value = store.verify(runId);
  else value = store.apply('stop', command(store, runId, { mode: 'graceful', reason: 'CLI operator stop' }));
  process.stdout.write(text ?? `${JSON.stringify({ ok: true, simulation: true, value })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? 'INTERNAL_ERROR', message: error.message })}\n`);
  process.exitCode = error.code === 'CAPABILITY_MISSING' ? 7 : error.code === 'STALE_STATE' ? 3 : EXCLUSION.has(error.code) ? 4 : 2;
} finally { try { owner?.release(); } finally { store?.close(); } }
