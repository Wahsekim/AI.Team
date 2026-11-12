import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { canonical, parseJSON, digest, bytesDigest } from '../loop/contracts.mjs';
import { instanceOf } from './roots.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOWS = Array.from({ length: 32 }, (_, i) => `WF-${String(i).padStart(2, '0')}`);
const INVARIANTS = [...Array.from({ length: 8 }, (_, i) => `H${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `M${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `Q${i + 1}`)];

export function loadCoverage(root = ROOT, { instanceRoot } = {}) {
  if (realpathSync(root) !== root.replace(/\/$/, '')) throw Error('Canonical coverage root required');
  const instance = instanceOf(root, instanceRoot);
  const read = (path, base = root) => {
    let full = base;
    for (const part of path.split('/')) {
      full = join(full, part);
      if (lstatSync(full).isSymbolicLink()) throw Error('Symlink in coverage source');
    }
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Invalid coverage source file');
    return readFileSync(full);
  };
  const bytes = read('config/router-worker/coverage.json');
  const coverage = parseJSON(bytes.toString('utf8'));
  if (coverage.schemaVersion !== 1 || coverage.status !== 'ratified-topology-deployment-pending'
    || canonical(coverage.workflows?.map(w => w.id)) !== canonical(WORKFLOWS)
    || canonical(coverage.invariants?.map(w => w.id)) !== canonical(INVARIANTS)) throw Error('Incomplete coverage inventory');
  const catalog = read('docs/workflow-catalog.md');
  const sourceIds = [...catalog.toString('utf8').matchAll(/^### (WF-\d\d) /gm)].map(m => m[1]);
  if (canonical(sourceIds) !== canonical(WORKFLOWS)) throw Error('Workflow source inventory changed; review the coverage map');
  const charter = instance ? read('charter.md', instance) : read('charter.template.md'), meta = read('agents/_shared/meta-rules.md');
  const harness = charter.toString('utf8').split('## Harness Rules\n')[1]?.split('\n## ')[0] ?? '';
  const actualInvariants = [...harness.matchAll(/^(\d+)\. /gm)].map(m => `H${m[1]}`)
    .concat([...meta.toString('utf8').matchAll(/^## (M\d+) - /gm)].map(m => m[1]))
    .concat([...new Set(charter.toString('utf8').match(/\bQ\d+\b/g))].sort());
  if (canonical(actualInvariants) !== canonical(INVARIANTS)) throw Error('Harness/meta/Q inventory changed; review the coverage map');
  for (const row of coverage.workflows) {
    if (row.source !== 'docs/workflow-catalog.md' || !Array.isArray(row.duties) || !row.duties.length
      || new Set(row.duties).size !== row.duties.length || row.duties.some(d => !Object.hasOwn(coverage.duties, d))
      || typeof row.requirement !== 'string' || !row.requirement.trim()
      || row.firstRelease !== (row.id === 'WF-16' ? 'unsupported-parallel' : 'mapping-required')) throw Error('Invalid workflow mapping');
  }
  for (const row of coverage.invariants) {
    if (row.source !== (row.id.startsWith('M') ? 'agents/_shared/meta-rules.md' : 'charter.template.md')
      || typeof row.runtimeOwner !== 'string' || !row.runtimeOwner
      || !['always', 'trigger-preserved', 'count-directed'].includes(row.scope)) throw Error('Invalid invariant mapping');
  }
  return { coverage, digest: bytesDigest(bytes), workflowCatalogDigest: bytesDigest(catalog),
    invariantSourceDigests: { charter: bytesDigest(charter), metaRules: bytesDigest(meta),
      topologyDecision: bytesDigest(read('decisions/0008-router-worker-topology.md')) } };
}

export function coverageReport(workflowStates, loaded) {
  const states = parseJSON(canonical(workflowStates));
  if (!states || Array.isArray(states) || canonical(Object.keys(states).sort()) !== canonical(WORKFLOWS))
    throw Error('Every workflow needs an explicit status; no implicit opt-outs');
  const rows = loaded.coverage.workflows.map(row => {
    const state = states[row.id];
    if (!state || Object.keys(state).length !== 3 || !['status', 'reason', 'decisionRef'].every(k => Object.hasOwn(state, k))
      || !['enabled', 'deferred', 'profile-bound', 'disabled'].includes(state.status)
      || typeof state.reason !== 'string' || !state.reason.trim() || state.reason.length > 1000
      || (state.decisionRef !== null && !/^sha256:[a-f0-9]{64}$/.test(state.decisionRef))) throw Error(`Invalid workflow status: ${row.id}`);
    if (state.status === 'disabled' && state.decisionRef === null) throw Error(`Disabled workflow requires an owner decision reference: ${row.id}`);
    return { ...row, ...state, mappingStatus: state.status === 'enabled'
      ? row.firstRelease === 'unsupported-parallel' ? 'unsupported-in-first-release' : 'pending-deployment-and-runtime-evidence'
      : 'trigger-preserved-not-active' };
  });
  const requiredDuties = [...new Set(rows.filter(r => r.status === 'enabled').flatMap(r => r.duties))].sort();
  return {
    schemaVersion: 1, stage: 'coverage-planning', activationAllowed: false,
    hardRulePolicy: 'workflow-status-does-not-waive-charter-or-meta-rules',
    coverageDigest: loaded.digest, workflowCatalogDigest: loaded.workflowCatalogDigest,
    invariantSourceDigests: loaded.invariantSourceDigests,
    statesDigest: digest(states), requiredDuties, rows, invariants: loaded.coverage.invariants,
    blockers: rows.filter(r => r.status === 'enabled').map(r => ({ workflow: r.id, reason: r.mappingStatus })),
  };
}
