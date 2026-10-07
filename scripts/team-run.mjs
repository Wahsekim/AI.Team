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
import { abandonRun, closeExecutionMarker, ingestReceipt, recoverJournals } from '../src/loop/recovery.mjs';

const usage = `node scripts/team-run.mjs <demo|fixture|status|events|audit|stop|show|inspect> <state-directory> <run-id> [--graceful|--hard (stop only)]
  ingest-receipt <state-directory> <run-id> <dispatch-id>
  abandon <state-directory> <run-id> --note <text> --confirm <run-id>
  close-execution-marker <state-directory> --owner <owner-id> --note <text>
  recover-journal <state-directory> --note <text> [--all]`;
const STOP_FLAGS = { '--graceful': 'graceful', '--hard': 'hard' };
// R05a: inspection opens the store read-only and never creates it; stop writes but never creates.
const READ_ONLY = new Set(['status', 'events', 'audit', 'show', 'inspect']);
// R05b (ADR 0005): positional arguments after the state directory, and the flags each recovery command takes.
const RECOVERY = { 'ingest-receipt': { positional: 2, flags: [] }, abandon: { positional: 1, flags: ['--note', '--confirm'] },
  'close-execution-marker': { positional: 0, flags: ['--owner', '--note'] }, 'recover-journal': { positional: 0, flags: ['--note'], switches: ['--all'] } };
let store, owner;
const EXCLUSION = new Set(['EXECUTION_OWNER_ACTIVE', 'EXECUTION_OPEN', 'OWNER_LOST', 'STORE_MISMATCH', 'TARGET_MISMATCH', 'TARGET_NOT_ISOLATED']);

function recoveryArgs(action, rest) {
  const spec = RECOVERY[action], positional = rest.slice(0, spec.positional), options = {};
  for (let i = spec.positional; i < rest.length; i++) {
    const flag = rest[i];
    requireThat(!Object.hasOwn(options, flag), 'INVALID_SPEC', `Repeated ${flag}`);
    if (spec.switches?.includes(flag)) options[flag] = true;
    else { requireThat(spec.flags.includes(flag) && i + 1 < rest.length, 'INVALID_SPEC', usage); options[flag] = rest[++i]; }
  }
  requireThat(positional.length === spec.positional && positional.every(Boolean) && spec.flags.every(f => typeof options[f] === 'string'), 'INVALID_SPEC', usage);
  return { positional, options };
}

async function recover(action, directory, rest) {
  const { positional: [runId, dispatchId], options } = recoveryArgs(action, rest);
  if (action === 'ingest-receipt') return ingestReceipt({ directory, runId, dispatchId });
  if (action === 'abandon') return abandonRun({ directory, runId, note: options['--note'], confirm: options['--confirm'] });
  if (action === 'close-execution-marker') return closeExecutionMarker({ directory, ownerId: options['--owner'], note: options['--note'] });
  return recoverJournals({ directory, all: options['--all'] === true, note: options['--note'] });
}

try {
  const [action, directory, runId, ...extra] = process.argv.slice(2);
  const recovery = Object.hasOwn(RECOVERY, action);
  requireThat(recovery ? directory : ['demo', 'fixture', 'stop', ...READ_ONLY].includes(action) && directory && runId
    && (!extra.length || action === 'stop' && extra.length === 1 && Object.hasOwn(STOP_FLAGS, extra[0])), 'INVALID_SPEC', usage);
  if (!recovery) id(runId);
  if (action === 'demo') mkdirSync(resolve(directory), { recursive: true, mode: 0o700 });
  const filename = resolve(directory, 'loop.sqlite');
  if (recovery) { /* recovery commands open and close their own store */ }
  else if (READ_ONLY.has(action)) store = await openStoreReadOnly(filename, { snapshot: true });
  else if (action !== 'fixture') store = await openStore(filename, { create: action === 'demo' });
  let value, text = null;
  if (recovery) value = await recover(action, directory, process.argv.slice(4));
  else if (action === 'fixture') value = await runFixtureDemo({ directory, runId });
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
  // R05b: a hot-journal snapshot read is labelled; the originals were only copied.
  const source = store?.source ? { source: store.source } : {};
  process.stdout.write(text !== null ? `${source.source ? `${source.source}\n` : ''}${text}` : `${JSON.stringify({ ok: true, simulation: true, ...source, value })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? 'INTERNAL_ERROR', message: error.message })}\n`);
  process.exitCode = error.code === 'CAPABILITY_MISSING' ? 7 : error.code === 'STALE_STATE' ? 3 : EXCLUSION.has(error.code) ? 4 : 2;
} finally { try { owner?.release(); } finally { store?.close(); } }
