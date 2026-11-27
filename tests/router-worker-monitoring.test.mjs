// The status of the PM's attestation of a batch's run (reconcile-run.mjs --monitoring), read back by run id. Nothing is refused on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { monitoringOf, archivedMonitoring } from '../src/router-worker/monitoring.mjs';

const KIT = fileURLToPath(new URL('../', import.meta.url));
const RUN = 'run-2026-07-16-002';
const RESULT = { runId: RUN, mainSessionTodo: { nextLifecycleNumberAfter: 3, lifecycleEntries: [`### BATCH 2026-07-16 ${RUN} — run-n-rounds N=1, dispatched 1, halt: count-complete`, '## [002] proj-builder T-1 — verifier PASS, ~500 tok worker / ~200 tok verifier, done'],
  messagesLogBlock: `## 2026-07-16 — run-n-rounds batch ${RUN} (N=1, dispatched 1, halt: count-complete)\n\n- [002] iter1 T-1 (proj-builder): verifier PASS — done` } };
// The observer and the notes are free text: a field spelled inside them does not change what the line says.
const ATTESTATION = { runId: RUN, observer: 'Pia (PM); coverage=partial', intervalStartUtc: '2026-07-16T14:09:00Z', intervalEndUtc: '2026-07-16T14:54:00Z', coverage: 'attended', q3Events: [], q4Events: ['owner asked a question'], notes: 'coverage=unknown; q3Events=9' };

// A team folder with three archived batches; the first run is attested by the real reconciler, the rest by hand in its format.
function team(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-monitoring-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'agents/archive'), { recursive: true }); mkdirSync(join(root, 'messages'));
  writeFileSync(join(root, 'agents/lifecycle.md'), '# Lifecycle\n\nNext NNN to assign: 002\n');
  for (const [id, openedAt] of [[RUN, '2026-07-16T14:00:00Z'], ['run-b', '2026-07-17T09:00:00Z'], ['run-c', '2026-07-18T09:00:00Z']]) {
    mkdirSync(join(root, 'batches', id), { recursive: true }); writeFileSync(join(root, 'batches', id, 'batch.json'), JSON.stringify({ runId: id, openedAt }));
  }
  writeFileSync(join(root, 'result.json'), JSON.stringify(RESULT)); writeFileSync(join(root, 'attestation.json'), JSON.stringify(ATTESTATION));
  const done = spawnSync(process.execPath, [join(KIT, 'scripts/reconcile-run.mjs'), join(root, 'result.json'), root, '--monitoring', join(root, 'attestation.json')], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const line = readFileSync(join(root, 'agents/lifecycle.md'), 'utf8').split('\n').find(row => row.startsWith(`- Monitoring attestation ${RUN}: `));
  return { root, line };
}

test('an attestation reads as complete when attended, partial when partial or unknown, and missing when no one attested the run', t => {
  const { root, line } = team(t);
  assert.deepEqual(monitoringOf(root, RUN), { runId: RUN, status: 'complete', attestations: [{ coverage: 'attended', q3Events: 0, q4Events: 1 }] }, 'read from the line the reconciler wrote');
  assert.equal(monitoringOf(root, 'run-c').status, 'missing');
  appendFileSync(join(root, 'agents/lifecycle.md'), `${line.replace(RUN, 'run-c').replace('coverage=attended', 'coverage=unknown')}\n`);
  assert.equal(monitoringOf(root, 'run-c').status, 'partial', 'an observer who did not vouch for the interval is not complete');
  writeFileSync(join(root, 'agents/archive/lifecycle-2026-07-01_2026-07-17.md'), `${line.replace(RUN, 'run-b').replace('coverage=attended', 'coverage=partial')}\n`);
  assert.equal(monitoringOf(root, 'run-b').status, 'partial', 'a rotated ledger is read too');
  appendFileSync(join(root, 'agents/lifecycle.md'), `- Monitoring attestation ${RUN}: unreadable\n`);
  assert.deepEqual([monitoringOf(root, RUN).status, monitoringOf(root, RUN).attestations.length], ['partial', 2], 'two lines count as the weaker; a line the kit cannot read is not complete');
  assert.equal(monitoringOf(root, 'run').status, 'missing', 'a run id is matched whole');
  assert.deepEqual(archivedMonitoring(root).map(entry => [entry.runId, entry.status]), [['run-c', 'partial'], ['run-b', 'partial'], [RUN, 'partial']], 'newest first');
});

test('CLI: monitoring prints the newest archived batches with their status and what each status means', t => {
  const { root } = team(t), run = (...argv) => spawnSync(process.execPath, [join(KIT, 'scripts/rw-batch.mjs'), ...argv], { encoding: 'utf8' });
  assert.equal(run('monitoring').status, 1); assert.equal(run('monitoring', '--instance', root, 'extra').status, 1);
  const done = run('monitoring', '--instance', root);
  assert.equal(done.status, 0, done.stderr);
  const printed = JSON.parse(done.stdout);
  assert.deepEqual(printed.batches.map(entry => [entry.runId, entry.status, entry.openedAt]), [['run-c', 'missing', '2026-07-18T09:00:00Z'], ['run-b', 'missing', '2026-07-17T09:00:00Z'], [RUN, 'complete', '2026-07-16T14:00:00Z']]);
  assert.match(printed.meaning.missing, /no one attested the run; this says nothing about whether a stop occurred/);
});

test('an observer whose text spells the fields a second time cannot raise the status', () => {
  const line = '- Monitoring attestation run-x: observer=Pia; interval=2026-07-16T14:09:00Z/2026-07-16T14:54:00Z; coverage=attended; q3Events=0; q4Events=0; interval=2026-07-16T14:09:00Z/2026-07-16T14:54:00Z; coverage=partial; q3Events=0; q4Events=0';
  assert.deepEqual(monitoringOf('/nowhere', 'run-x', line), { runId: 'run-x', status: 'partial', attestations: [{ coverage: null, q3Events: null, q4Events: null }] });
});
