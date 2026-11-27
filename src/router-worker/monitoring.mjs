import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE, RUN_ID } from './batch.mjs';

// The PM's attestation of who watched a run for owner and hardware stops (reconcile-run.mjs --monitoring), read back by
// run id from agents/lifecycle.md and its rotated archives. Nothing is refused on it: it is reported.
const LIFECYCLE = 'agents/lifecycle.md', ROTATED = 'agents/archive';
// The attestation's own coverage: `unknown` is an observer who signed without vouching for the interval, so it is not complete.
const STATUS = { attended: 'complete', partial: 'partial', unknown: 'partial' }, RANK = ['missing', 'partial', 'complete'];
export const MEANING = {
  complete: 'the PM attested the run as attended over its interval',
  partial: 'the PM attested the run, with partial or unknown coverage: a stop may have gone unseen',
  missing: 'no one attested the run; this says nothing about whether a stop occurred' };
// The fields as reconcile-run.mjs writes them. The line is the PM's own word: the kit reads it and does not vouch for it.
const FIELDS = /; interval=\d{4}-[^;/]*Z\/\d{4}-[^;/]*Z; coverage=([a-z]+); q3Events=(\d+); q4Events=(\d+)(?=; |$)/g;

const read = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const ledgersOf = instance => {
  let rotated = []; try { rotated = readdirSync(join(instance, ROTATED)).filter(name => /^lifecycle-.*\.md$/.test(name)).sort(); } catch { /* none rotated */ }
  return [...rotated.map(name => join(instance, ROTATED, name)), join(instance, LIFECYCLE)].map(read).join('\n');
};

export function monitoringOf(instance, runId, text = ledgersOf(instance)) {
  const prefix = `- Monitoring attestation ${runId}: `;
  const found = text.split('\n').filter(line => line.startsWith(prefix)).map(line => [...line.matchAll(FIELDS)]).map(all => all.length === 1 ? all[0] : null).map(match => ({ coverage: match?.[1] ?? null, q3Events: match ? Number(match[2]) : null, q4Events: match ? Number(match[3]) : null }));
  // A line the kit cannot parse, or whose free text spells the fields a second time, still shows someone attested; several lines count as the weakest of them.
  const status = found.length ? RANK[Math.min(...found.map(entry => RANK.indexOf(STATUS[entry.coverage] ?? 'partial')))] : 'missing';
  return { runId, status, attestations: found };
}

// The newest archived batches, by their opening, each with its attestation status.
export function archivedMonitoring(instance, count = 10) {
  let ids = []; try { ids = readdirSync(join(instance, ARCHIVE), { withFileTypes: true }).filter(entry => entry.isDirectory() && RUN_ID.test(entry.name)).map(entry => entry.name); } catch { /* none archived */ }
  const openedAt = id => { try { return JSON.parse(readFileSync(join(instance, ARCHIVE, id, 'batch.json'), 'utf8')).openedAt ?? null; } catch { return null; } };
  const text = ledgersOf(instance);
  return ids.map(id => ({ id, openedAt: openedAt(id) })).sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? '') || b.id.localeCompare(a.id)).slice(0, count)
    .map(({ id, openedAt: at }) => ({ ...monitoringOf(instance, id, text), openedAt: at }));
}
